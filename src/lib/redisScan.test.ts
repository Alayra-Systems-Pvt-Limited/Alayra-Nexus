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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// redisScan imports the real ioredis client, which connects at module load. These are pure cursor-loop
// tests, so the Redis module is mocked — no connection is attempted, and the SCAN paging is exercised
// against queued fake pages.
const { scan, unlink } = vi.hoisted(() => ({ scan: vi.fn(), unlink: vi.fn() }));
vi.mock('./redis', () => ({ redis: { scan, unlink } }));

import { countKeys, deleteKeys } from './redisScan';

beforeEach(() => { scan.mockReset(); unlink.mockReset(); });

describe('countKeys', () => {
  it('walks every page until the cursor returns to 0', async () => {
    scan
      .mockResolvedValueOnce(['12', ['a', 'b']])
      .mockResolvedValueOnce(['0', ['c']]);
    expect(await countKeys('nexus:respcache:*')).toBe(3);
    expect(scan).toHaveBeenCalledTimes(2);
    // The second page must resume from the cursor the first returned.
    expect(scan).toHaveBeenLastCalledWith('12', 'MATCH', 'nexus:respcache:*', 'COUNT', 1000);
  });

  it('counts nothing when the keyspace is empty', async () => {
    scan.mockResolvedValueOnce(['0', []]);
    expect(await countKeys('x:*')).toBe(0);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('tolerates an empty page while the walk continues', async () => {
    scan
      .mockResolvedValueOnce(['5', []])
      .mockResolvedValueOnce(['0', ['a']]);
    expect(await countKeys('x:*')).toBe(1);
    expect(scan).toHaveBeenCalledTimes(2);
  });
});

describe('deleteKeys', () => {
  it('unlinks each page and sums the deletions', async () => {
    scan
      .mockResolvedValueOnce(['7', ['a', 'b']])
      .mockResolvedValueOnce(['0', ['c']]);
    unlink.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    expect(await deleteKeys('x:*')).toBe(3);
    expect(unlink).toHaveBeenNthCalledWith(1, 'a', 'b');
    expect(unlink).toHaveBeenNthCalledWith(2, 'c');
  });

  it('never calls unlink on an empty page', async () => {
    scan.mockResolvedValueOnce(['0', []]);
    expect(await deleteKeys('x:*')).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe('deleteKeys with keys to spare (A2)', () => {
  // A restore wipes `nexus:*` after it commits, which would take the maintenance flag with it and
  // drop the gateway back into service partway through the operation the flag exists to announce.
  it('leaves a spared key alone and deletes the rest of the page', async () => {
    scan.mockResolvedValueOnce(['0', ['nexus:adminsession:a', 'nexus:maintenance', 'nexus:budget:t1']]);
    unlink.mockResolvedValueOnce(2);

    expect(await deleteKeys('nexus:*', ['nexus:maintenance'])).toBe(2);
    expect(unlink).toHaveBeenCalledWith('nexus:adminsession:a', 'nexus:budget:t1');
  });

  it('spares across every page, not just the first', async () => {
    scan
      .mockResolvedValueOnce(['9', ['nexus:maintenance', 'a']])
      .mockResolvedValueOnce(['0', ['nexus:maintenance', 'b']]);
    unlink.mockResolvedValue(1);

    expect(await deleteKeys('nexus:*', ['nexus:maintenance'])).toBe(2);
    expect(unlink).toHaveBeenNthCalledWith(1, 'a');
    expect(unlink).toHaveBeenNthCalledWith(2, 'b');
  });

  it('does not call unlink when a page held nothing but spared keys', async () => {
    scan.mockResolvedValueOnce(['0', ['nexus:maintenance']]);
    expect(await deleteKeys('nexus:*', ['nexus:maintenance'])).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('matches by exact name, never as a prefix', async () => {
    // `nexus:maintenance:history` is a different key. Sparing it too would be a matcher that is
    // quietly too generous — the mirror of the glob problem, and just as silent.
    scan.mockResolvedValueOnce(['0', ['nexus:maintenance', 'nexus:maintenance:history']]);
    unlink.mockResolvedValueOnce(1);

    expect(await deleteKeys('nexus:*', ['nexus:maintenance'])).toBe(1);
    expect(unlink).toHaveBeenCalledWith('nexus:maintenance:history');
  });

  it('behaves exactly as before when nothing is spared', async () => {
    scan.mockResolvedValueOnce(['0', ['a', 'b']]);
    unlink.mockResolvedValueOnce(2);
    expect(await deleteKeys('x:*')).toBe(2);
    expect(unlink).toHaveBeenCalledWith('a', 'b');
  });
});
