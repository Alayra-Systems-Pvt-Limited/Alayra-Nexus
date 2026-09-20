/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root.
 */

import Redis from 'ioredis';

/** The small surface needed to arm fail-fast behaviour, separated for a deterministic unit test. */
export interface RedisFailFastTarget {
  options: { enableOfflineQueue?: boolean };
  once(event: 'ready', listener: () => void): unknown;
}

/**
 * Keep the startup queue only until Redis proves it is ready once.
 *
 * Turning the queue off in the constructor loses a race during healthy boots: commands issued in
 * the few milliseconds before the socket becomes ready are rejected. Waiting for the first
 * `ready` preserves that startup behaviour. The option then stays false through every reconnect,
 * so commands arriving during an outage reject immediately instead of joining a backlog that
 * would be replayed after recovery.
 *
 * ioredis's own reconnect is the half-open probe. It performs the handshake independently of the
 * command queue and emits `ready` only when Redis answers again; ordinary commands work from that
 * point without an application restart.
 */
export function armRedisFailFastAfterReady(client: RedisFailFastTarget): void {
  client.once('ready', () => {
    client.options.enableOfflineQueue = false;
  });
}

/**
 * Construct the production Redis client.
 *
 * `autoResendUnfulfilledCommands: false` covers the other replay path: commands already written
 * to a socket when it dies. Their promises remain bounded by `commandTimeout`, but ioredis must not
 * send them a second time after reconnecting because the caller may already have received a 503.
 *
 * ioredis 6 defaults to RESP3. Nexus deliberately retains RESP2 so upgrading the client does not
 * also change command reply shapes or break parity with the in-process store. RESP3 can be adopted
 * separately when every Redis-backed operation has an explicit cross-protocol contract.
 */
export function redisClientOptions(commandTimeoutMs: number) {
  return {
    protocol: 2 as const,
    maxRetriesPerRequest: null,
    commandTimeout: commandTimeoutMs,
    enableOfflineQueue: true,
    autoResendUnfulfilledCommands: false,
  };
}

export function createRedisClient(url: string, commandTimeoutMs: number): Redis {
  const client = new Redis(url, redisClientOptions(commandTimeoutMs));

  armRedisFailFastAfterReady(client);
  return client;
}
