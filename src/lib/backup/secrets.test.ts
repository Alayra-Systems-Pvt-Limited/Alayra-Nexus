/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { encrypt, decrypt } from '../encryption';
import {
  SECRET_LOCATIONS, MODELS_WITH_SECRETS, NEVER_REKEY, rekeyRow, hasSecrets, countSecrets,
} from './secrets';

const SRC = resolve(__dirname, '..', '..');
const SCHEMA = resolve(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');

// ── The drift guard ───────────────────────────────────────────────────────────────────────────
//
// Every place in the codebase that seals a value. Adding an `encrypt()` call without adding the
// field it writes to SECRET_LOCATIONS produces a backup that carries one secret as ciphertext no
// other gateway can open — and nothing else fails, so it would be found only by someone restoring.
//
// Listed as file:symbol rather than file:line so ordinary edits above a call site do not fail this.
const ACKNOWLEDGED_ENCRYPT_SITES: readonly string[] = [
  'routes/admin/keys.routes.ts',      // NexusKey.encryptedKey (create + replace)
  'routes/admin/teams.routes.ts',     // NexusTeamKey.encryptedKey
  'services/adminAuth.service.ts',    // AdminUser.totpSecret
  'services/notifications.service.ts',// AppSettings NOTIFICATIONS_CONFIG → resendApiKey
  'services/sso.service.ts',          // SsoProvider.clientSecret
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('the secret registry covers every encrypted field', () => {
  it('finds no encrypt() call site that has not been accounted for', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      // encryption.ts DEFINES encrypt; backup/ CONSUMES it generically through the registry.
      if (rel === 'lib/encryption.ts' || rel.startsWith('lib/backup/')) continue;

      const body = readFileSync(file, 'utf8');
      // A call, not a mention: `encrypt(` preceded by a non-identifier character, so `decrypt(`
      // and `rekeyRow(... encrypt)` do not match.
      if (!/(?<![A-Za-z0-9_.])encrypt\s*\(/.test(body)) continue;
      if (!ACKNOWLEDGED_ENCRYPT_SITES.includes(rel)) offenders.push(rel);
    }

    expect(
      offenders,
      `New encrypt() call site(s): ${offenders.join(', ')}.\n` +
      'Add the model+field being written to SECRET_LOCATIONS in src/lib/backup/secrets.ts, then ' +
      'list the file in ACKNOWLEDGED_ENCRYPT_SITES here. A secret that is encrypted but not ' +
      'registered restores onto another gateway as an undecryptable blob.',
    ).toEqual([]);
  });

  it('still sees every site it claims to — the guard is not matching nothing', () => {
    // Without this, deleting the regex or pointing SRC at an empty directory would make the test
    // above pass vacuously, which is the classic way a guard stops guarding.
    const found = sourceFiles(SRC)
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .filter((rel) => rel !== 'lib/encryption.ts' && !rel.startsWith('lib/backup/'))
      .filter((rel) => /(?<![A-Za-z0-9_.])encrypt\s*\(/.test(readFileSync(join(SRC, rel), 'utf8')));

    expect(found.sort()).toEqual([...ACKNOWLEDGED_ENCRYPT_SITES].sort());
  });
});

describe('the registry matches the schema', () => {
  const schema = readFileSync(SCHEMA, 'utf8');

  /** model NexusKey { … } → the field names inside it. */
  function fieldsOf(modelPascal: string): string[] {
    const block = new RegExp(`model\\s+${modelPascal}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema);
    if (!block) return [];
    return block[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
      .map((l) => l.split(/\s+/)[0]);
  }

  const pascal = (delegate: string) => delegate.charAt(0).toUpperCase() + delegate.slice(1);

  it('every registered model exists in schema.prisma', () => {
    for (const loc of SECRET_LOCATIONS) {
      expect(fieldsOf(pascal(loc.model)), `model ${pascal(loc.model)} not found`).not.toEqual([]);
    }
  });

  it('every registered field exists on its model', () => {
    // The failure this catches: a field is renamed, the registry keeps the old name, rekeyRow finds
    // nothing to do, and secrets quietly stop being re-keyed while every test still passes.
    for (const loc of SECRET_LOCATIONS) {
      expect(fieldsOf(pascal(loc.model)), `${pascal(loc.model)}.${loc.field}`).toContain(loc.field);
    }
  });

  it('registers no field that is a hash rather than a ciphertext', () => {
    for (const loc of SECRET_LOCATIONS) {
      expect(NEVER_REKEY).not.toContain(loc.field);
      expect(loc.field.toLowerCase()).not.toContain('hash');
    }
  });

  it('names six locations across six models, so a silent deletion is visible', () => {
    expect(SECRET_LOCATIONS).toHaveLength(6);
    expect(MODELS_WITH_SECRETS).toHaveLength(6);
  });
});

describe('rekeyRow', () => {
  it('rewrites a plain ciphertext column', () => {
    const row = { id: 'k1', encryptedKey: encrypt('sk-real-provider-key') };
    const out = rekeyRow('nexusKey', row, decrypt);

    expect(out.encryptedKey).toBe('sk-real-provider-key');
    expect(out.id).toBe('k1');
  });

  it('round-trips through decrypt and back to encrypt', () => {
    // The actual journey: sealed on gateway A, opened for the backup, resealed on gateway B.
    const original = 'sk-a-real-looking-secret';
    const onA = { id: 'k1', encryptedKey: encrypt(original) };

    const inBackup = rekeyRow('nexusKey', onA, decrypt);
    const onB = rekeyRow('nexusKey', inBackup, encrypt);

    expect(onB.encryptedKey).not.toBe(onA.encryptedKey);   // a fresh IV, so never byte-identical
    expect(decrypt(onB.encryptedKey as string)).toBe(original);
  });

  it('does not mutate the row it was given', () => {
    // An export that altered the database it is reading would be a backup with side effects.
    const sealed = encrypt('secret');
    const row = { id: 'k1', encryptedKey: sealed };
    rekeyRow('nexusKey', row, decrypt);

    expect(row.encryptedKey).toBe(sealed);
  });

  it('leaves a model with no secrets completely alone', () => {
    const row = { id: 't1', modelName: 'gpt-4', provider: 'openai' };
    expect(rekeyRow('tokenUsage', row, () => 'TOUCHED')).toEqual(row);
  });

  it('skips null and empty rather than manufacturing a secret', () => {
    // SsoProvider.clientSecret defaults to "" when unset, and totpSecret is null before enrolment.
    // Encrypting either would turn "no secret" into a ciphertext that decrypts to nothing useful.
    expect(rekeyRow('adminUser', { id: 'u1', totpSecret: null }, () => 'X').totpSecret).toBeNull();
    expect(rekeyRow('ssoProvider', { id: 's1', clientSecret: '' }, () => 'X').clientSecret).toBe('');
  });

  it('never touches the hash fields sitting beside a secret', () => {
    // NexusTeamKey carries encryptedKey AND keyHash. Re-keying the hash would invalidate the key
    // it authenticates — a restore that reports success and locks every team out.
    const row = { id: 'tk1', encryptedKey: encrypt('nx-team-key'), keyHash: 'sha256-digest', maskedKey: 'nx-…-4f2a' };
    const out = rekeyRow('nexusTeamKey', row, decrypt);

    expect(out.keyHash).toBe('sha256-digest');
    expect(out.maskedKey).toBe('nx-…-4f2a');
    expect(out.encryptedKey).toBe('nx-team-key');
  });
});

describe('rekeyRow on the JSON settings blob', () => {
  const config = (over: Record<string, unknown> = {}) => JSON.stringify({
    enabled: true, resendApiKey: encrypt('re_live_abc123'), from: 'a@b.c', to: ['x@y.z'], ...over,
  });

  it('rewrites the key nested inside the notifications blob', () => {
    const row = { key: 'NOTIFICATIONS_CONFIG', value: config() };
    const out = rekeyRow('appSettings', row, decrypt);

    const blob = JSON.parse(out.value as string);
    expect(blob.resendApiKey).toBe('re_live_abc123');
    expect(blob.enabled).toBe(true);          // everything else survives the round trip
    expect(blob.to).toEqual(['x@y.z']);
  });

  it('leaves every other settings row untouched', () => {
    // AI_MODEL_REGISTRY and BRANDING_CONFIG are plain configuration. Running a decrypt over them
    // would throw, and a transform that "helpfully" caught it would corrupt them instead.
    for (const key of ['AI_MODEL_REGISTRY', 'BRANDING_CONFIG']) {
      const row = { key, value: JSON.stringify({ resendApiKey: 'not-really-a-secret' }) };
      expect(rekeyRow('appSettings', row, () => 'TOUCHED')).toEqual(row);
    }
  });

  it('passes a malformed blob through rather than destroying it', () => {
    const row = { key: 'NOTIFICATIONS_CONFIG', value: 'not json at all' };
    expect(rekeyRow('appSettings', row, () => 'TOUCHED').value).toBe('not json at all');
  });

  it('handles a blob with no key configured', () => {
    const row = { key: 'NOTIFICATIONS_CONFIG', value: JSON.stringify({ enabled: false, resendApiKey: '' }) };
    expect(JSON.parse(rekeyRow('appSettings', row, () => 'TOUCHED').value as string).resendApiKey).toBe('');
  });

  it('propagates a decryption failure instead of silently dropping the secret', () => {
    // A wrong key fails GCM authentication. That must reach the caller: a restore that swallowed it
    // would write a row whose secret had quietly become nothing.
    const row = { key: 'NOTIFICATIONS_CONFIG', value: config({ resendApiKey: 'garbage-not-ciphertext' }) };
    expect(() => rekeyRow('appSettings', row, decrypt)).toThrow();
  });
});

describe('the helpers used by the restore summary', () => {
  it('hasSecrets answers for both kinds of model', () => {
    expect(hasSecrets('nexusKey')).toBe(true);
    expect(hasSecrets('appSettings')).toBe(true);
    expect(hasSecrets('tokenUsage')).toBe(false);
  });

  it('countSecrets counts what is really there, not what a row could hold', () => {
    expect(countSecrets('nexusKey', { encryptedKey: encrypt('a') })).toBe(1);
    expect(countSecrets('adminUser', { totpSecret: null })).toBe(0);
    expect(countSecrets('appSettings', { key: 'AI_MODEL_REGISTRY', value: '{}' })).toBe(0);
    expect(countSecrets('tokenUsage', { id: 'x' })).toBe(0);
  });
});
