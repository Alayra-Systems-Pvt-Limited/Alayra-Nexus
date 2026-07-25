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

// A stand-in for the settings store, so these tests are about the key's lifecycle rather than
// Redis caching or Prisma.
const { settings, deleted } = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  deleted: [] as string[],
}));

vi.mock('./settings.service', () => ({
  getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => { settings.set(k, v); }),
}));
vi.mock('../lib/prisma', () => ({ dbEngine: 'postgres',
  prisma: {
    appSettings: {
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        deleted.push(where.key);
        settings.delete(where.key);
        return { count: 1 };
      }),
    },
  },
}));

import {
  hashApiKey, maskApiKey, verifyMasterApiKey, getApiKeyInfo, rotateApiKey, convertLegacyApiKey, ensureApiKey,
} from './apiKey.service';

beforeEach(() => {
  settings.clear();
  deleted.length = 0;
  vi.clearAllMocks();
});

describe('maskApiKey', () => {
  it('identifies a key without opening it', () => {
    const masked = maskApiKey('abcdefgh12345678ijklmnop');
    expect(masked).toBe('abcdefgh••••mnop');
    expect(masked).not.toContain('12345678');
    // Too short to mask meaningfully: reveal nothing rather than most of it.
    expect(maskApiKey('short')).toBe('••••');
  });
});

describe('rotateApiKey', () => {
  it('returns the key once and stores only its hash', async () => {
    const { key, masked } = await rotateApiKey();

    expect(key).toHaveLength(64);
    expect(settings.get('NEXUS_API_KEY_HASH')).toBe(hashApiKey(key));
    // The plaintext is nowhere in the store — which is the entire point of the change.
    expect([...settings.values()]).not.toContain(key);
    expect(settings.get('NEXUS_API_KEY_MASK')).toBe(masked);
  });

  it('invalidates the previous key immediately', async () => {
    const first = await rotateApiKey();
    expect(await verifyMasterApiKey(first.key)).toBe(true);

    const second = await rotateApiKey();
    expect(await verifyMasterApiKey(second.key)).toBe(true);
    expect(await verifyMasterApiKey(first.key)).toBe(false);
  });

  it('mints a different key every time', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) keys.add((await rotateApiKey()).key);
    expect(keys.size).toBe(5);
  });
});

describe('verifyMasterApiKey', () => {
  it('accepts the live key and refuses everything else', async () => {
    const { key } = await rotateApiKey();
    expect(await verifyMasterApiKey(key)).toBe(true);
    expect(await verifyMasterApiKey(key + 'x')).toBe(false);
    expect(await verifyMasterApiKey(key.slice(0, -1))).toBe(false);
    expect(await verifyMasterApiKey('')).toBe(false);
  });

  it('refuses everything when no key is set, including an empty candidate', async () => {
    expect(await verifyMasterApiKey('anything')).toBe(false);
    expect(await verifyMasterApiKey('')).toBe(false);
  });
});

describe('getApiKeyInfo', () => {
  it('reports the hint, never the key', async () => {
    expect(await getApiKeyInfo()).toEqual({ set: false, masked: null });

    const { key, masked } = await rotateApiKey();
    const info = await getApiKeyInfo();
    expect(info).toEqual({ set: true, masked });
    expect(JSON.stringify(info)).not.toContain(key);
  });
});

describe('convertLegacyApiKey — the upgrade path', () => {
  const LEGACY = 'legacykey0000000000000000000000000000000000000000000000000000abcd';

  it('keeps the existing key WORKING while removing the plaintext', async () => {
    // The property the whole conversion rests on: every client, script and IDE pointed at this
    // gateway keeps working. What changes is that the dashboard can no longer read the key back.
    settings.set('NEXUS_API_KEY', LEGACY);

    expect(await convertLegacyApiKey()).toBe(true);
    expect(await verifyMasterApiKey(LEGACY)).toBe(true);

    expect(settings.has('NEXUS_API_KEY')).toBe(false);
    expect(deleted).toContain('NEXUS_API_KEY'); // removed, not blanked
    expect(settings.get('NEXUS_API_KEY_HASH')).toBe(hashApiKey(LEGACY));
    expect(settings.get('NEXUS_API_KEY_MASK')).toBe(maskApiKey(LEGACY));
  });

  it('does nothing on a gateway with no plaintext key, or an uninitialised placeholder', async () => {
    expect(await convertLegacyApiKey()).toBe(false);

    settings.set('NEXUS_API_KEY', 'REPLACE_ON_INIT');
    expect(await convertLegacyApiKey()).toBe(false);
    expect(settings.has('NEXUS_API_KEY_HASH')).toBe(false);
  });

  it('is safe to run on every boot', async () => {
    settings.set('NEXUS_API_KEY', LEGACY);
    expect(await convertLegacyApiKey()).toBe(true);
    // Second boot: nothing left to convert, and the hash from the first is untouched.
    expect(await convertLegacyApiKey()).toBe(false);
    expect(await verifyMasterApiKey(LEGACY)).toBe(true);
  });
});

describe('ensureApiKey', () => {
  it('generates and returns a key on first run', async () => {
    const key = await ensureApiKey();
    expect(key).toHaveLength(64);
    expect(await verifyMasterApiKey(key as string)).toBe(true);
  });

  it('returns nothing on a later boot — there is nothing left to show', async () => {
    const key = await ensureApiKey();
    expect(await ensureApiKey()).toBeNull();
    // ...and the original still works: a later boot must never silently rotate it.
    expect(await verifyMasterApiKey(key as string)).toBe(true);
  });

  it('converts a legacy key instead of generating a new one', async () => {
    const LEGACY = 'legacykey0000000000000000000000000000000000000000000000000000abcd';
    settings.set('NEXUS_API_KEY', LEGACY);

    expect(await ensureApiKey()).toBeNull(); // nothing NEW was generated
    expect(await verifyMasterApiKey(LEGACY)).toBe(true);
  });
});
