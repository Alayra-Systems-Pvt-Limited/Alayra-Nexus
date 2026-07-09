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

import { prisma } from '../lib/prisma';

// ── Async analytics pipeline ──────────────────────────────────────────────────
// Usage events are buffered in-process and flushed to Postgres in a single batched
// createMany, on a short interval or when the buffer hits a size threshold — so the
// request path never waits on an analytics write, and thousands of requests/minute
// don't turn into thousands of individual INSERTs competing with the transactional
// key-lookup queries on the same database.
//
// The public surface is a single `emit(event)` call. Swapping the in-process buffer
// for a real queue later (BullMQ, Kafka → ClickHouse, …) is a change to this module
// only — every caller keeps calling emit(). That is the point of the seam.

export interface UsageEvent {
  id:             string;
  sessionId:      string;
  modelId:        string;
  modelName:      string;
  provider:       string;
  inputTokens:    number;
  outputTokens:   number;
  totalTokens:    number;
  estimatedUsd:   number;
  nexusTeamKeyId: string | null;
  createdAt:      Date;
}

export interface UsagePipelineOptions {
  /** Flush cadence in ms (also the maximum analytics lag). */
  intervalMs?: number;
  /** Flush immediately once this many events are buffered. */
  maxBatch?:   number;
  /** Hard cap on buffered events; beyond it, new events are shed to bound memory. */
  cap?:        number;
  /** The sink. Defaults to a chunked, idempotent Prisma createMany. */
  insert?:     (rows: UsageEvent[]) => Promise<void>;
  /** Start the interval timer on first emit. Off in tests for determinism. */
  autoStart?:  boolean;
}

// Postgres caps parameters per statement (~65535); chunk so a large drain can't
// blow past it. skipDuplicates makes a re-queued retry idempotent (ids are UUIDs).
const INSERT_CHUNK = 500;
const defaultInsert = async (rows: UsageEvent[]): Promise<void> => {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await prisma.tokenUsage.createMany({ data: rows.slice(i, i + INSERT_CHUNK), skipDuplicates: true });
  }
};

export function createUsagePipeline(options: UsagePipelineOptions = {}) {
  const intervalMs = options.intervalMs ?? parseInt(process.env.USAGE_FLUSH_INTERVAL_MS ?? '1500', 10);
  const maxBatch   = options.maxBatch   ?? parseInt(process.env.USAGE_FLUSH_MAX ?? '100', 10);
  const cap        = options.cap        ?? parseInt(process.env.USAGE_BUFFER_CAP ?? '10000', 10);
  const insert     = options.insert     ?? defaultInsert;
  const autoStart  = options.autoStart  ?? true;

  let buffer:   UsageEvent[] = [];
  let timer:    ReturnType<typeof setInterval> | null = null;
  let flushing = false;
  let dropped  = 0;

  function start(): void {
    if (timer) return;
    timer = setInterval(() => { void flush(); }, intervalMs);
    // Don't let the flush timer keep the process alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function emit(event: UsageEvent): void {
    // Shed load rather than grow without bound if the sink is stuck (DB down).
    if (buffer.length >= cap) { dropped++; return; }
    buffer.push(event);
    if (autoStart) start();
    if (buffer.length >= maxBatch) void flush();
  }

  async function flush(): Promise<number> {
    if (flushing || buffer.length === 0) return 0;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      await insert(batch);
      return batch.length;
    } catch {
      // Re-queue oldest-first so a transient DB failure doesn't lose usage, but
      // never exceed the cap — bounded memory beats perfect durability here.
      buffer = batch.concat(buffer).slice(0, cap);
      return 0;
    } finally {
      flushing = false;
    }
  }

  /** Flush everything and stop the timer — for graceful shutdown. */
  async function drain(): Promise<void> {
    stop();
    // A backlog larger than one batch may remain after a failed flush re-queues;
    // loop until the buffer is empty or a flush makes no progress.
    let guard = 0;
    while (buffer.length > 0 && guard++ < 100) {
      const n = await flush();
      if (n === 0) break;
    }
  }

  return {
    emit,
    flush,
    drain,
    start,
    stop,
    size:    () => buffer.length,
    dropped: () => dropped,
  };
}

// Process-wide singleton used by the app; tests build isolated instances.
export const usagePipeline = createUsagePipeline();
export const emit        = (event: UsageEvent): void   => usagePipeline.emit(event);
export const drainUsage  = (): Promise<void>           => usagePipeline.drain();
