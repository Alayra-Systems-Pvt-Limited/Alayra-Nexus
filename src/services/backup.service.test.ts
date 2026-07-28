/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// What the gateway does AROUND a restore (Phase A2).
//
// lib/backup/restore.ts moves rows and knows nothing about this process. Everything that makes a
// restore safe on a *running* gateway lives here instead: draining the buffered writers before it
// starts, and invalidating the key-value store after it commits. Both are ordering properties, and
// ordering is exactly what a test of "did it call the function" fails to catch — so the order is
// asserted directly.
//
// The defect being guarded, precisely: `resolveSession` re-checks the database only for sessions
// carrying a user id. Sessions minted by an admin API token, by the pre-claim password, or by SSO
// with no email claim carry a bare role and are never re-validated — so without the wipe below they
// keep full rights against wholly different data until their TTL runs out, up to twelve hours.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetEnvWarnings } from '../lib/envNumber';

const { deleteKeys, drainAudit, drainUsage, readBackup, calls } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    deleteKeys: vi.fn(async () => 0),
    drainAudit: vi.fn(async () => { calls.push('drainAudit'); }),
    drainUsage: vi.fn(async () => { calls.push('drainUsage'); }),
    readBackup: vi.fn(async () => { calls.push('readBackup'); return {}; }),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: {}, dbEngine: 'postgres' }));
vi.mock('../lib/redisScan', () => ({ deleteKeys }));
vi.mock('./audit.service', () => ({ drainAudit }));
vi.mock('./usagePipeline', () => ({ drainUsage }));
vi.mock('../lib/backup/restore', () => ({ readBackup }));

import { restoreBackup, restoreTimeoutMs, KV_PRESERVED_ON_RESTORE, RESTORE_TIMEOUT_ENV } from './backup.service';

/** Only `mode` and `dryRun` matter here; the stream is never read because readBackup is mocked. */
const request = (over: Record<string, unknown> = {}) =>
  ({ input: null as never, passphrase: 'p', mode: 'replace' as const, dryRun: false, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  deleteKeys.mockResolvedValue(0);
  readBackup.mockImplementation(async () => { calls.push('readBackup'); return {}; });
});

describe('a replace restore invalidates the key-value store', () => {
  it('wipes every nexus key once the restore has committed', async () => {
    deleteKeys.mockResolvedValue(41);
    const result = await restoreBackup(request());

    expect(deleteKeys).toHaveBeenCalledWith('nexus:*', KV_PRESERVED_ON_RESTORE);
    expect(result.kvKeysCleared).toBe(41);
  });

  it('wipes AFTER the restore, never before', async () => {
    // Redis is not inside the database transaction. Clearing first would sign every operator out of
    // a restore that then rolled back and changed nothing at all.
    deleteKeys.mockImplementation(async () => { calls.push('deleteKeys'); return 0; });
    await restoreBackup(request());

    expect(calls.indexOf('readBackup')).toBeLessThan(calls.indexOf('deleteKeys'));
  });

  it('changes nothing in the store when the restore threw', async () => {
    // The transaction rolled back, so the gateway still holds the data those sessions belong to.
    // Signing everyone out would be punishing them for a file that was never applied.
    readBackup.mockRejectedValue(new Error('this backup file is truncated'));

    await expect(restoreBackup(request())).rejects.toThrow(/truncated/);
    expect(deleteKeys).not.toHaveBeenCalled();
  });

  it('spares the maintenance flag, which A4 needs to outlive the wipe', async () => {
    await restoreBackup(request());
    expect(KV_PRESERVED_ON_RESTORE).toContain('nexus:maintenance');
    expect(deleteKeys.mock.calls[0][1]).toBe(KV_PRESERVED_ON_RESTORE);
  });
});

describe('a merge restore does not sign anyone out', () => {
  it('clears only the settings cache', async () => {
    // merge inserts what is missing and removes nothing: no account disappears and no token is
    // revoked, so no session becomes wrong. The settings cache is the one genuine staleness.
    await restoreBackup(request({ mode: 'merge' }));

    expect(deleteKeys).toHaveBeenCalledTimes(1);
    expect(deleteKeys).toHaveBeenCalledWith('nexus:setting:*');
  });

  it('never touches sessions', async () => {
    await restoreBackup(request({ mode: 'merge' }));
    expect(deleteKeys).not.toHaveBeenCalledWith('nexus:*', expect.anything());
  });
});

describe('the buffered writers are drained before anything is written', () => {
  it('drains both pipelines before the restore starts', async () => {
    // usagePipeline.flush() re-queues on ANY error, so a TokenUsage row whose NexusTeamKey vanished
    // in a replace would fail its foreign key, be re-queued, and fail forever — eventually shedding
    // new usage at the buffer cap. Draining first puts those rows in the tables they belong to.
    await restoreBackup(request());

    expect(calls).toEqual(['drainAudit', 'drainUsage', 'readBackup']);
  });

  it('drains on a merge too, because a stale row lands either way', async () => {
    await restoreBackup(request({ mode: 'merge' }));
    expect(drainAudit).toHaveBeenCalled();
    expect(drainUsage).toHaveBeenCalled();
  });
});

describe('a dry run touches nothing', () => {
  it('neither drains nor clears', async () => {
    // A dry run writes nothing, so there is nothing to protect it from and nothing to invalidate.
    const result = await restoreBackup(request({ dryRun: true }));

    expect(drainAudit).not.toHaveBeenCalled();
    expect(drainUsage).not.toHaveBeenCalled();
    expect(deleteKeys).not.toHaveBeenCalled();
    expect(result.kvKeysCleared).toBe(0);
  });

  it('reports zero even in replace mode, where a real run would wipe everything', async () => {
    const result = await restoreBackup(request({ mode: 'replace', dryRun: true }));
    expect(result.kvKeysCleared).toBe(0);
    expect(deleteKeys).not.toHaveBeenCalled();
  });
});

describe('how long a restore may take (A3)', () => {
  afterEach(() => { delete process.env[RESTORE_TIMEOUT_ENV]; resetEnvWarnings(); });

  it('defaults to thirty minutes, not the two that made large restores impossible', () => {
    // Two minutes sat behind a two-gigabyte upload cap, so the gateway accepted files it could
    // never apply. These two limits now describe the same gateway.
    expect(restoreTimeoutMs()).toBe(30 * 60 * 1000);
  });

  it('honours the environment', () => {
    process.env[RESTORE_TIMEOUT_ENV] = '600000';
    expect(restoreTimeoutMs()).toBe(600_000);
  });

  it('refuses to be set below a floor, so it cannot be turned into "never"', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[RESTORE_TIMEOUT_ENV] = '0';
    expect(restoreTimeoutMs()).toBe(1_000);
  });

  it('ignores a value parseInt would have mangled', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[RESTORE_TIMEOUT_ENV] = '30m';   // parseInt reads this as 30 milliseconds
    expect(restoreTimeoutMs()).toBe(30 * 60 * 1000);
  });

  it('actually reaches the engine — without this the setting is a variable nobody reads', () => {
    process.env[RESTORE_TIMEOUT_ENV] = '600000';
    return restoreBackup(request()).then(() => {
      expect(readBackup).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 600_000 }));
    });
  });

  it('passes it on a dry run too, which needs no transaction but costs nothing to be consistent', async () => {
    await restoreBackup(request({ dryRun: true }));
    expect(readBackup).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30 * 60 * 1000 }));
  });
});

describe('the engine result is passed through intact', () => {
  it('carries the restore report and adds only the KV count', async () => {
    readBackup.mockResolvedValue({ totalWritten: 7, totalSkipped: 2, collisions: [] });
    deleteKeys.mockResolvedValue(3);

    const result = await restoreBackup(request());

    expect(result.totalWritten).toBe(7);
    expect(result.totalSkipped).toBe(2);
    expect(result.kvKeysCleared).toBe(3);
  });
});
