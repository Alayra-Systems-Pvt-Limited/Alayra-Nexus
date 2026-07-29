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

// Where every encrypted secret lives (Phase B1.0).
//
// A backup that is worth having must be restorable onto a DIFFERENT gateway, and every secret in
// this database is sealed with the master key of the gateway that wrote it. So a restore cannot copy
// ciphertext across: it has to decrypt with the key that sealed it and re-encrypt with the key of the
// gateway receiving it. This module is the map that makes that possible, and the single place that
// knows where those secrets are.
//
// ── Why a hand-maintained registry and not a scan ─────────────────────────────────────────────
//
// The obvious implementation is "re-key every column called encryptedKey", and it is wrong in both
// directions. It MISSES the Resend API key, which is ciphertext nested inside a JSON blob in
// AppSettings and matches no column-name rule. And it would CATCH fields that must never be touched:
// passwordHash, keyHash, codeHash, recoveryKeyHash and the token digests are hashes, not ciphertext —
// they do not depend on the master key, and "re-keying" one destroys the credential it protects.
//
// The distinction that matters is therefore not "does it look secret" but "was it produced by
// encrypt()". Only those six locations move. Everything else, hashes included, travels verbatim.
//
// ── The failure this is built to prevent ──────────────────────────────────────────────────────
//
// Someone adds a seventh encrypted field a year from now and does not add it here. Nothing breaks:
// export succeeds, restore succeeds, the dashboard looks right — and one credential silently arrives
// as ciphertext no key can open. It surfaces the day someone actually needs the backup, which is the
// worst possible day. `secrets.registry.test.ts` fails the build when an `encrypt()` call site exists
// that this list does not account for, so the drift is caught at the commit that causes it.

/** How the ciphertext is stored in the row. */
export type SecretShape =
  /** The column holds the ciphertext directly. */
  | { kind: 'column' }
  /** The column holds JSON, and one property inside it holds the ciphertext. */
  | { kind: 'json'; property: string; /** Only rows whose `key` matches carry it. */ whenKeyIs: string };

export interface SecretLocation {
  /** Prisma model name, as it appears in schema.prisma. */
  model: string;
  /** The column on that model. */
  field: string;
  shape: SecretShape;
  /** Why this is a secret, for whoever reads this list next. */
  note: string;
}

/**
 * Every location holding a value produced by `encrypt()`.
 *
 * Kept in schema order so it can be read against prisma/schema.prisma without hunting.
 */
export const SECRET_LOCATIONS: readonly SecretLocation[] = [
  {
    model: 'nexusKey',
    field: 'encryptedKey',
    shape: { kind: 'column' },
    note: 'A provider API key. The reason this feature exists, and the thing an operator most needs back.',
  },
  {
    model: 'nexusTeamKey',
    field: 'encryptedKey',
    shape: { kind: 'column' },
    note: 'A team key, kept recoverable so the dashboard can reveal it once more; the hash beside it is what authenticates.',
  },
  {
    model: 'adminUser',
    field: 'totpSecret',
    shape: { kind: 'column' },
    note: "A person's TOTP secret. Null until enrolment, so it is skipped far more often than not.",
  },
  {
    model: 'adminAuth',
    field: 'totpSecret',
    shape: { kind: 'column' },
    note: 'The pre-accounts singleton second factor. Retained for gateways upgrading from before 7.13a.',
  },
  {
    model: 'ssoProvider',
    field: 'clientSecret',
    shape: { kind: 'column' },
    note: 'The OIDC client secret. Defaults to "" rather than null when unset, which is why empty is skipped explicitly.',
  },
  {
    model: 'appSettings',
    field: 'value',
    shape: { kind: 'json', property: 'resendApiKey', whenKeyIs: 'NOTIFICATIONS_CONFIG' },
    note: 'The Resend API key, encrypted INSIDE the notifications JSON blob. The one location no column-name rule would ever find.',
  },
] as const;

/** The models that carry at least one secret — what a re-key pass has to visit. */
export const MODELS_WITH_SECRETS: readonly string[] =
  [...new Set(SECRET_LOCATIONS.map((l) => l.model))];

/**
 * Fields that look like secrets and MUST NOT be re-keyed.
 *
 * Not used by the transform — it is driven by the registry above and touches nothing else. This
 * exists so the intent is written down and testable: these are one-way digests, and running them
 * through a decrypt/encrypt cycle would not "move" them, it would destroy them, locking every
 * account and invalidating every key in a restore that reported success.
 */
export const NEVER_REKEY: readonly string[] = [
  'passwordHash', 'keyHash', 'codeHash', 'recoveryKeyHash', 'tokenHash', 'secretHash',
] as const;

/** A row as it comes back from Prisma — only the fields this module touches are constrained. */
export type Row = Record<string, unknown>;

/**
 * Rewrite every secret in one row, in whichever direction the caller needs.
 *
 * ONE function for both halves of the journey: export passes `decrypt`, restore passes `encrypt`.
 * Two functions would be two places for the AppSettings JSON case to be got subtly wrong, and the
 * failure would be invisible until a restore.
 *
 * Returns a NEW row. Mutating the caller's object would mean an export that alters the very
 * database it is reading, which is a backup with side effects.
 *
 * `transform` may throw — a wrong key fails GCM authentication, and that must surface rather than be
 * swallowed into a row that silently loses its secret.
 */
export function rekeyRow(model: string, row: Row, transform: (value: string) => string): Row {
  const locations = SECRET_LOCATIONS.filter((l) => l.model === model);
  if (locations.length === 0) return row;

  const out: Row = { ...row };

  /**
   * Run the transform, and name the row if it fails.
   *
   * Without this the whole export dies on `Invalid ciphertext format. Expected iv:authTag:encrypted`
   * — true, and useless: it names neither the table, nor the column, nor which of ten thousand rows
   * is the bad one, so an operator whose backup just failed has nowhere to start. Found running an
   * export over a database whose provider keys had been written by a fixture script as raw base64
   * rather than through encrypt(). The failure is correct; refusing to say where it happened is not.
   *
   * Still a hard failure. A row that cannot be decrypted must never be written into a backup as
   * whatever bytes happened to be sitting there — that produces a file that restores cleanly and
   * hands back a credential nothing can open.
   */
  const rekey = (value: string, field: string): string => {
    try {
      return transform(value);
    } catch (err) {
      const id = typeof row.id === 'string' ? row.id : '(unknown id)';
      throw new Error(
        `Could not re-encrypt ${model}.${field} on row ${id}: ${(err as Error).message}. ` +
        'That value is not something this gateway\'s master key produced — it was written by a ' +
        'different key, or by something that bypassed encrypt(). Nothing was exported.',
      );
    }
  };

  for (const loc of locations) {
    const current = out[loc.field];
    // Absent, null, or empty: nothing was ever sealed here. Encrypting "" would manufacture a
    // ciphertext where the code expects emptiness to mean "unset".
    if (typeof current !== 'string' || current.length === 0) continue;

    if (loc.shape.kind === 'column') {
      out[loc.field] = rekey(current, loc.field);
      continue;
    }

    // JSON: only the one settings row carries a secret; every other AppSettings row is plain config
    // and must pass through untouched.
    if (out.key !== loc.shape.whenKeyIs) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      // A malformed blob is left exactly as found. Rewriting it would turn a settings problem into
      // a backup that cannot round-trip, and the blob is still carried so nothing is lost.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const blob = parsed as Record<string, unknown>;
    const secret = blob[loc.shape.property];
    if (typeof secret !== 'string' || secret.length === 0) continue;

    out[loc.field] = JSON.stringify({
      ...blob,
      [loc.shape.property]: rekey(secret, `${loc.field}.${loc.shape.property}`),
    });
  }

  return out;
}

/** True when this model carries anything a re-key pass must visit. */
export function hasSecrets(model: string): boolean {
  return SECRET_LOCATIONS.some((l) => l.model === model);
}

/**
 * How many secrets a row actually carries, for the restore summary.
 *
 * Counted rather than assumed so the report says "re-keyed 12 secrets" from observation. A summary
 * derived from the number of ROWS would keep reporting confidently while re-keying nothing.
 */
export function countSecrets(model: string, row: Row): number {
  let n = 0;
  rekeyRow(model, row, (v) => { n++; return v; });
  return n;
}
