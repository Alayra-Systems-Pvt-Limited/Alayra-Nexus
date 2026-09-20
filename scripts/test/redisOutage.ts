/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// Release gate for the failure mode a mock cannot prove: a real Redis accepts a command, stops,
// rejects outage traffic without queueing it, returns, and has no stale work to replay.

import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRedisClient } from '../../src/lib/redisClient';
import { isKvUnavailable } from '../../src/lib/kvUnavailable';

const CONTAINER = process.env.REDIS_OUTAGE_CONTAINER ?? 'nexus-redis-outage-test';
const URL = process.env.REDIS_OUTAGE_URL ?? 'redis://127.0.0.1:56380/0';
const KEY = `nexus:test:outage:${process.pid}`;
const COMMAND_TIMEOUT_MS = 5_000;
const FAIL_FAST_BUDGET_MS = 1_000;
const RECOVERY_BUDGET_MS = 15_000;

const docker = (args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim();

function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Unlike node:events once, this deliberately does not reject when the emitter reports an error.
 * Socket errors are expected while Redis is down; the state transition is what this gate awaits.
 */
function waitForRedisEvent(
  redis: ReturnType<typeof createRedisClient>,
  event: 'close' | 'ready',
): Promise<void> {
  return new Promise((resolve) => {
    redis.once(event, resolve);
  });
}

async function main(): Promise<void> {
  const redis = createRedisClient(URL, COMMAND_TIMEOUT_MS);
  // Reconnect errors are expected while the container is stopped. Without a listener EventEmitter
  // treats them as fatal even though ioredis is correctly retrying in the background.
  redis.on('error', () => {});

  try {
    await redis.ping();
    if (redis.options.enableOfflineQueue !== false) {
      throw new Error('fail-fast gate was not armed after the first ready event');
    }

    await redis.set(KEY, '0');
    await redis.save();

    const closed = waitForRedisEvent(redis, 'close');
    docker(['stop', '--time', '5', CONTAINER]);
    await deadline(closed, RECOVERY_BUDGET_MS, 'Redis close detection');

    const started = performance.now();
    const rejected = await deadline(Promise.all(Array.from({ length: 20 }, async () => {
      const outcome = await redis.incr(KEY).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (outcome.ok) throw new Error(`an outage command unexpectedly returned ${outcome.value}`);
      if (!isKvUnavailable(outcome.error)) {
        throw new Error(`outage rejection was not recognised: ${String(outcome.error)}`);
      }
    })), FAIL_FAST_BUDGET_MS, 'twenty outage commands');
    void rejected;
    const refusedInMs = performance.now() - started;

    const ready = waitForRedisEvent(redis, 'ready');
    docker(['start', CONTAINER]);
    await deadline(ready, RECOVERY_BUDGET_MS, 'Redis recovery');

    const afterRecovery = await redis.get(KEY);
    if (afterRecovery !== '0') {
      throw new Error(`stale outage commands replayed after recovery; expected 0, received ${afterRecovery}`);
    }
    const fresh = await redis.incr(KEY);
    if (fresh !== 1) throw new Error(`fresh command after recovery returned ${fresh}, expected 1`);

    await redis.del(KEY);
    console.log(`ok: 20 outage commands were refused in ${refusedInMs.toFixed(1)}ms`);
    console.log('ok: no stale command replayed after Redis restarted');
    console.log('ok: a fresh command succeeded after automatic recovery');
  } finally {
    try { docker(['start', CONTAINER]); } catch { /* CI cleanup reports the container state. */ }
    redis.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
