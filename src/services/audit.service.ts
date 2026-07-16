/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Alayra Nexus™ is a trademark of Alayra Systems. Use of the name or logo
 * is not granted by the software license below.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF
 * ANY KIND, either express or implied. See the License for details.
 */

// Audit & compliance service (Phase 6.7): the side-effecting half. An append-only writer
// that buffers audit entries in-process and flushes them in a batched createMany — the same
// off-the-request-path pattern as the Phase 4 usage pipeline, so recording an admin action
// never delays the response and a burst of activity is one insert, not many. Also holds the
// compliance configuration (retention windows + the anonymization flag), the retention prune,
// and the filtered read the dashboard uses.

import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getSetting, setSetting } from './settings.service';
import { pruneNotifications } from './notificationFeed.service';
import { anonymizeIp, clampRetentionDays, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS } from '../lib/audit';

export const SETTING_AUDIT_RETENTION = 'AUDIT_RETENTION_DAYS';
export const SETTING_USAGE_RETENTION = 'USAGE_RETENTION_DAYS';
export const SETTING_ANONYMIZE_USAGE = 'ANONYMIZE_USAGE';
export const SETTING_NOTIFICATION_RETENTION = 'NOTIFICATION_RETENTION_DAYS';

// The alert feed is operational noise, not a record: a months-old "a key was banned" is stale, and
// the audit trail is what actually testifies to what happened. So it defaults to a shorter window
// than audit/usage rather than inheriting their 90 days.
export const DEFAULT_NOTIFICATION_RETENTION_DAYS = 30;

// ── The entry a caller records ────────────────────────────────────────────────

export interface AuditEntry {
  action:     string;
  method:     string;
  actorRole:  string;
  actor?:     string | null;
  target?:    string | null;
  ip?:        string | null;
  status:     number;
  detail?:    string | null;
  /** When the action happened. Defaults to now, so ordering reflects the event, not the flush. */
  createdAt?: Date;
}

// ── Compliance configuration ──────────────────────────────────────────────────

export interface ComplianceConfig {
  auditRetentionDays: number;
  usageRetentionDays: number;
  /** How long the in-app alert feed is kept (Phase 7.11). 0 = keep forever, like the others. */
  notificationRetentionDays: number;
  anonymizeUsage:     boolean;
  maxDays:            number;
}

const isOn = (v: string | null): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim());

// The anonymization flag is read on the usage hot path (per request, to decide whether to hash
// a session id), so it is memoized in-process for a few seconds on top of the Redis-cached
// setting — a config change still takes effect promptly, but a request never blocks on it.
let anonMemo = { value: false, at: 0 };
const ANON_MEMO_MS = 30_000;

/** Whether usage records should be de-identified. Cheap enough to call per request. */
export async function isUsageAnonymized(): Promise<boolean> {
  const now = Date.now();
  if (now - anonMemo.at < ANON_MEMO_MS) return anonMemo.value;
  anonMemo = { value: isOn(await getSetting(SETTING_ANONYMIZE_USAGE)), at: now };
  return anonMemo.value;
}

export async function getComplianceConfig(): Promise<ComplianceConfig> {
  const [audit, usage, notif, anon] = await Promise.all([
    getSetting(SETTING_AUDIT_RETENTION),
    getSetting(SETTING_USAGE_RETENTION),
    getSetting(SETTING_NOTIFICATION_RETENTION),
    getSetting(SETTING_ANONYMIZE_USAGE),
  ]);
  return {
    auditRetentionDays: audit === null ? DEFAULT_RETENTION_DAYS : clampRetentionDays(audit),
    usageRetentionDays: usage === null ? DEFAULT_RETENTION_DAYS : clampRetentionDays(usage),
    notificationRetentionDays: notif === null ? DEFAULT_NOTIFICATION_RETENTION_DAYS : clampRetentionDays(notif),
    anonymizeUsage:     isOn(anon),
    maxDays:            MAX_RETENTION_DAYS,
  };
}

export async function setComplianceConfig(input: {
  auditRetentionDays: number; usageRetentionDays: number; anonymizeUsage: boolean;
  notificationRetentionDays?: number;
}): Promise<void> {
  await Promise.all([
    setSetting(SETTING_AUDIT_RETENTION, String(clampRetentionDays(input.auditRetentionDays))),
    setSetting(SETTING_USAGE_RETENTION, String(clampRetentionDays(input.usageRetentionDays))),
    setSetting(SETTING_ANONYMIZE_USAGE, input.anonymizeUsage ? 'true' : 'false'),
    // Optional so a caller that predates the alert feed keeps the default rather than being forced
    // to send a window it has never heard of.
    ...(input.notificationRetentionDays === undefined ? [] : [
      setSetting(SETTING_NOTIFICATION_RETENTION, String(clampRetentionDays(input.notificationRetentionDays))),
    ]),
  ]);
  anonMemo = { value: input.anonymizeUsage, at: Date.now() }; // reflect the change at once
}

// ── Buffered append-only writer ───────────────────────────────────────────────

const FLUSH_INTERVAL_MS = parseInt(process.env.AUDIT_FLUSH_INTERVAL_MS ?? '2000', 10);
const FLUSH_MAX         = parseInt(process.env.AUDIT_FLUSH_MAX ?? '50', 10);
const BUFFER_CAP        = parseInt(process.env.AUDIT_BUFFER_CAP ?? '5000', 10);

let buffer: Prisma.AuditLogCreateManyInput[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

function start(): void {
  if (timer) return;
  timer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Record an admin action. Fire-and-forget and synchronous from the caller's view: the entry
 * is buffered and written by the background flush, so a response is never delayed and an
 * audit failure can never turn into a request failure. Load is shed if the sink is stuck.
 */
export function recordAudit(entry: AuditEntry): void {
  if (buffer.length >= BUFFER_CAP) return; // bounded memory beats unbounded growth if DB is down
  buffer.push({
    id:        randomUUID(),
    action:    entry.action,
    method:    entry.method,
    actorRole: entry.actorRole,
    actor:     entry.actor  ?? null,
    target:    entry.target ?? null,
    ip:        entry.ip     ?? null,
    status:    entry.status,
    detail:    entry.detail ?? null,
    createdAt: entry.createdAt ?? new Date(),
  });
  start();
  if (buffer.length >= FLUSH_MAX) void flush();
}

/** Drain the buffer to Postgres in one batched insert. Applies IP anonymization when enabled. */
export async function flush(): Promise<number> {
  if (flushing || buffer.length === 0) return 0;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    if (await isUsageAnonymized()) {
      for (const row of batch) row.ip = anonymizeIp(row.ip ?? null);
    }
    await prisma.auditLog.createMany({ data: batch, skipDuplicates: true });
    return batch.length;
  } catch {
    buffer = batch.concat(buffer).slice(0, BUFFER_CAP); // re-queue, still bounded
    return 0;
  } finally {
    flushing = false;
  }
}

/** Flush everything and stop the timer — for graceful shutdown. */
export async function drainAudit(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  let guard = 0;
  while (buffer.length > 0 && guard++ < 100) {
    if (await flush() === 0) break;
  }
}

/** Test/introspection helper. */
export const pendingAuditCount = (): number => buffer.length;

// ── Read surface ──────────────────────────────────────────────────────────────

export interface AuditQuery {
  action?:    string;
  actorRole?: string;
  since?:     Date;
  until?:     Date;
  before?:    Date; // cursor for "load older": entries strictly before this time
  limit?:     number;
}

/** Newest-first, filtered admin-action history for the dashboard. Bounded page size. */
export async function queryAuditLogs(q: AuditQuery = {}) {
  const where: Prisma.AuditLogWhereInput = {};
  if (q.action)    where.action    = { contains: q.action };
  if (q.actorRole) where.actorRole = q.actorRole;

  const createdAt: Prisma.DateTimeFilter = {};
  if (q.since)  createdAt.gte = q.since;
  if (q.until)  createdAt.lte = q.until;
  if (q.before) createdAt.lt  = q.before;
  if (Object.keys(createdAt).length) where.createdAt = createdAt;

  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  return prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take });
}

// ── Retention ─────────────────────────────────────────────────────────────────

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** Delete audit entries older than `days`. `days <= 0` means keep forever — a no-op. */
export async function pruneAuditLogs(days: number): Promise<number> {
  if (days <= 0) return 0;
  const { count } = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff(days) } } });
  return count;
}

/** Delete usage rows older than `days`. This trims analytics history — `days <= 0` keeps all. */
export async function pruneUsage(days: number): Promise<number> {
  if (days <= 0) return 0;
  const { count } = await prisma.tokenUsage.deleteMany({ where: { createdAt: { lt: cutoff(days) } } });
  return count;
}

/**
 * Apply every retention window. Best-effort: a failure to prune must never crash the
 * scheduler that calls this. Returns how many rows each window removed.
 */
export async function runRetention(): Promise<{ audit: number; usage: number; notifications: number }> {
  const cfg = await getComplianceConfig();
  const [audit, usage, notifications] = await Promise.all([
    pruneAuditLogs(cfg.auditRetentionDays).catch(() => 0),
    pruneUsage(cfg.usageRetentionDays).catch(() => 0),
    pruneNotifications(cfg.notificationRetentionDays).catch(() => 0),
  ]);
  return { audit, usage, notifications };
}
