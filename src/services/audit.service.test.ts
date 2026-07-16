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

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { prismaMock, settingsMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog:     { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    tokenUsage:   { deleteMany: vi.fn() },
    // The retention pass also prunes the alert feed (Phase 7.11).
    notification: { deleteMany: vi.fn() },
  },
  settingsMock: { getSetting: vi.fn(), setSetting: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('./settings.service', () => ({ getSetting: settingsMock.getSetting, setSetting: settingsMock.setSetting }));
// runRetention prunes notifications, whose module reaches Redis for the record path. This suite
// never records, so a bare stub is enough to keep the real client (which demands REDIS_URL at
// import) out of the graph.
vi.mock('../lib/redis', () => ({ redis: {} }));

import {
  recordAudit, flush, drainAudit, pendingAuditCount,
  getComplianceConfig, setComplianceConfig, isUsageAnonymized,
  queryAuditLogs, pruneAuditLogs, pruneUsage, runRetention,
} from './audit.service';

beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.auditLog.createMany.mockResolvedValue({ count: 0 });
  prismaMock.auditLog.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.auditLog.findMany.mockResolvedValue([]);
  prismaMock.tokenUsage.deleteMany.mockResolvedValue({ count: 0 });
  settingsMock.getSetting.mockResolvedValue(null);
  settingsMock.setSetting.mockResolvedValue(undefined);
  await drainAudit();                                    // clear any buffered rows from a prior test
  await setComplianceConfig({ auditRetentionDays: 0, usageRetentionDays: 0, anonymizeUsage: false }); // memo → false
  vi.clearAllMocks();
  prismaMock.auditLog.createMany.mockResolvedValue({ count: 0 });
  settingsMock.getSetting.mockResolvedValue(null);
});

describe('buffered writer', () => {
  it('buffers a recorded action and writes the batch on flush', async () => {
    recordAudit({ action: 'keys.ban', method: 'POST', actorRole: 'owner', ip: '203.0.113.7', status: 200, target: 'k1' });
    expect(pendingAuditCount()).toBe(1);

    const n = await flush();
    expect(n).toBe(1);
    const rows = prismaMock.auditLog.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({ action: 'keys.ban', actorRole: 'owner', ip: '203.0.113.7', status: 200, target: 'k1' });
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('re-queues the batch when the insert fails, losing nothing', async () => {
    prismaMock.auditLog.createMany.mockRejectedValueOnce(new Error('db down'));
    recordAudit({ action: 'settings.compliance', method: 'PUT', actorRole: 'owner', status: 200 });
    expect(await flush()).toBe(0);       // failed
    expect(pendingAuditCount()).toBe(1); // still buffered
    prismaMock.auditLog.createMany.mockResolvedValue({ count: 1 });
    expect(await flush()).toBe(1);       // retried successfully
  });

  it('anonymizes IPs at flush when anonymization is enabled', async () => {
    await setComplianceConfig({ auditRetentionDays: 0, usageRetentionDays: 0, anonymizeUsage: true });
    recordAudit({ action: 'auth.login', method: 'POST', actorRole: 'system', ip: '198.51.100.42', status: 401 });
    await flush();
    expect(prismaMock.auditLog.createMany.mock.calls[0][0].data[0].ip).toBe('198.51.100.0');
  });
});

describe('compliance config', () => {
  it('defaults the retention windows when unset (alerts are shorter-lived than the record)', async () => {
    settingsMock.getSetting.mockResolvedValue(null);
    const cfg = await getComplianceConfig();
    expect(cfg).toEqual({
      auditRetentionDays: 90, usageRetentionDays: 90,
      notificationRetentionDays: 30, // operational noise, not a record — see audit.service
      anonymizeUsage: false, maxDays: 90,
    });
  });

  it('parses and clamps stored values', async () => {
    settingsMock.getSetting.mockImplementation(async (k: string) => {
      if (k === 'AUDIT_RETENTION_DAYS')        return '30';
      if (k === 'USAGE_RETENTION_DAYS')        return '0';       // Off = keep forever
      if (k === 'NOTIFICATION_RETENTION_DAYS') return '1000';    // clamped to the max
      if (k === 'ANONYMIZE_USAGE')             return 'true';
      return null;
    });
    expect(await getComplianceConfig()).toEqual({
      auditRetentionDays: 30, usageRetentionDays: 0, notificationRetentionDays: 90,
      anonymizeUsage: true, maxDays: 90,
    });
  });

  it('leaves the notification window alone when a caller omits it', async () => {
    // A client written before the alert feed existed must not silently reset a window it has
    // never heard of.
    await setComplianceConfig({ auditRetentionDays: 30, usageRetentionDays: 30, anonymizeUsage: false });
    expect(settingsMock.setSetting).not.toHaveBeenCalledWith('NOTIFICATION_RETENTION_DAYS', expect.anything());

    await setComplianceConfig({ auditRetentionDays: 30, usageRetentionDays: 30, anonymizeUsage: false, notificationRetentionDays: 14 });
    expect(settingsMock.setSetting).toHaveBeenCalledWith('NOTIFICATION_RETENTION_DAYS', '14');
  });

  it('persists clamped values and reflects the anonymize flag immediately', async () => {
    await setComplianceConfig({ auditRetentionDays: 1000, usageRetentionDays: 45, anonymizeUsage: true });
    expect(settingsMock.setSetting).toHaveBeenCalledWith('AUDIT_RETENTION_DAYS', '90'); // clamped to max
    expect(settingsMock.setSetting).toHaveBeenCalledWith('USAGE_RETENTION_DAYS', '45');
    expect(settingsMock.setSetting).toHaveBeenCalledWith('ANONYMIZE_USAGE', 'true');
    expect(await isUsageAnonymized()).toBe(true); // memo updated without a settings read
  });
});

describe('queryAuditLogs', () => {
  it('builds a newest-first filter with a bounded page size', async () => {
    await queryAuditLogs({ action: 'keys', actorRole: 'owner', limit: 999 });
    const arg = prismaMock.auditLog.findMany.mock.calls[0][0];
    expect(arg.where.action).toEqual({ contains: 'keys' });
    expect(arg.where.actorRole).toBe('owner');
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.take).toBe(200); // clamped from 999
  });

  it('applies date bounds when provided', async () => {
    const since = new Date('2026-07-01T00:00:00Z');
    await queryAuditLogs({ since });
    expect(prismaMock.auditLog.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: since });
  });
});

describe('retention', () => {
  it('prunes nothing when the window is Off (0)', async () => {
    expect(await pruneAuditLogs(0)).toBe(0);
    expect(await pruneUsage(0)).toBe(0);
    expect(prismaMock.auditLog.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.tokenUsage.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes rows older than the window', async () => {
    prismaMock.auditLog.deleteMany.mockResolvedValue({ count: 12 });
    const removed = await pruneAuditLogs(30);
    expect(removed).toBe(12);
    const where = prismaMock.auditLog.deleteMany.mock.calls[0][0].where;
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(where.createdAt.lt.getTime()).toBeLessThan(Date.now());
  });

  it('runRetention applies every configured window, including the alert feed', async () => {
    settingsMock.getSetting.mockImplementation(async (k: string) =>
      k === 'AUDIT_RETENTION_DAYS' ? '30' : k === 'USAGE_RETENTION_DAYS' ? '90'
      : k === 'NOTIFICATION_RETENTION_DAYS' ? '30' : null);
    prismaMock.auditLog.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.tokenUsage.deleteMany.mockResolvedValue({ count: 5 });
    prismaMock.notification.deleteMany.mockResolvedValue({ count: 7 });
    expect(await runRetention()).toEqual({ audit: 3, usage: 5, notifications: 7 });
  });

  it('runRetention survives one window failing, so a bad prune cannot stall the others', async () => {
    settingsMock.getSetting.mockResolvedValue('30');
    prismaMock.auditLog.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.tokenUsage.deleteMany.mockRejectedValue(new Error('deadlock'));
    prismaMock.notification.deleteMany.mockResolvedValue({ count: 2 });
    expect(await runRetention()).toEqual({ audit: 1, usage: 0, notifications: 2 });
  });
});
