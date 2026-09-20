/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  armRedisFailFastAfterReady, redisClientOptions, type RedisFailFastTarget,
} from './redisClient';

describe('Redis fail-fast gate', () => {
  it('keeps the startup queue until the first ready event', () => {
    let ready: (() => void) | undefined;
    const client: RedisFailFastTarget = {
      options: { enableOfflineQueue: true },
      once: vi.fn((_event, listener) => { ready = listener; }),
    };

    armRedisFailFastAfterReady(client);

    expect(client.options.enableOfflineQueue).toBe(true);
    expect(client.once).toHaveBeenCalledWith('ready', expect.any(Function));
    ready?.();
    expect(client.options.enableOfflineQueue).toBe(false);
  });

  it('does not re-enable the queue when Redis later reconnects', () => {
    let ready: (() => void) | undefined;
    const client: RedisFailFastTarget = {
      options: { enableOfflineQueue: true },
      once: (_event, listener) => { ready = listener; },
    };

    armRedisFailFastAfterReady(client);
    ready?.();

    expect(client.options.enableOfflineQueue).toBe(false);
  });

  it('disables replay while retaining the bounded in-flight timeout', () => {
    expect(redisClientOptions(2_000)).toEqual({
      protocol: 2,
      maxRetriesPerRequest: null,
      commandTimeout: 2_000,
      enableOfflineQueue: true,
      autoResendUnfulfilledCommands: false,
    });
  });
});
