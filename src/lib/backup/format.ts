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

// The backup file's envelope (Phase B1.1).
//
// A backup contains every provider key, every team key and every TOTP secret in the gateway. It is
// the single most valuable file the product produces, and it leaves the machine. So it is encrypted
// with a key derived from a passphrase the operator chooses, and a stolen file is worth nothing
// without it.
//
// ── Why a passphrase and not MASTER_ENCRYPTION_KEY ────────────────────────────────────────────
//
// The tempting choice is to seal backups with the master key that is already in the environment.
// It is also the one that makes backups worthless exactly when they are needed: the server dies,
// the .env dies with it, and every backup ever taken is permanently unopenable. A passphrase lives
// in a person's password manager and outlives the machine.
//
// It also makes the file PORTABLE. Restoring re-encrypts each secret with the receiving gateway's
// own master key, so a backup can move to a new host — which a master-key-sealed file could never
// do without copying the master key alongside it, defeating the point.
//
// ── The layout ────────────────────────────────────────────────────────────────────────────────
//
//   line 1   the header, plain JSON, newline-terminated
//   then     the ciphertext, raw bytes
//   last 16  the GCM authentication tag
//
// The header is plaintext because it MUST be: the salt and KDF parameters are what turn a passphrase
// into the key, so they cannot themselves be encrypted. It therefore carries the minimum that makes
// decryption possible and NOTHING else — no gateway version, no row counts, no timestamp. All of
// that describes the deployment and belongs inside the encrypted payload, where a stolen file cannot
// give up how large the estate is or when it was taken.
//
// ── The header is authenticated, not merely present ───────────────────────────────────────────
//
// The header bytes are fed to GCM as additional authenticated data. Without that, the parameters
// that govern decryption would be the one part of the file an attacker could rewrite freely —
// dropping the scrypt cost so an offline guess is cheap, and handing the modified file back to a
// victim who would decrypt it none the wiser. Bound as AAD, any edit to the header makes the whole
// file fail to authenticate.
//
// Why not reuse lib/encryption.ts: that is `iv:tag:hex` in one string, correct for a short column
// value and wrong for a database — hex doubles the size, and the whole plaintext and ciphertext must
// be resident at once. This format streams.

import { randomBytes, scrypt, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// Same overload problem as lib/password.ts: promisify picks the signature WITHOUT options, which
// would silently use Node's defaults instead of the parameters below.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer, salt: string | Buffer, keylen: number, options: ScryptOptions,
) => Promise<Buffer>;

export const BACKUP_FORMAT = 'alayra-nexus-backup';
export const BACKUP_VERSION = 1;

export const CIPHER = 'aes-256-gcm';
export const KEY_BYTES = 32;
/** 12 bytes is the size GCM is specified for; anything else forces an extra derivation step. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const SALT_BYTES = 16;

// Matching lib/password.ts: ~32 MB and ~100 ms per derivation. Paid once per export and once per
// restore, and it is the whole cost of guessing a passphrase offline.
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;

/**
 * The ceiling on memory a FILE may ask us to allocate.
 *
 * The parameters below are read from an untrusted document. Passing them to scrypt unchecked would
 * let a malicious backup name an N that allocates gigabytes and take the gateway down — a denial of
 * service triggered by nothing more than an operator opening a file someone sent them.
 */
const MAX_KDF_MEM = 256 * KDF_N * KDF_R;

export interface BackupHeader {
  format: string;
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: string; iv: string };
}

/** A fresh header, with the random salt and IV this file will use. */
export function newHeader(): BackupHeader {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: { name: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt: randomBytes(SALT_BYTES).toString('hex') },
    cipher: { name: CIPHER, iv: randomBytes(IV_BYTES).toString('hex') },
  };
}

/**
 * The header's exact bytes, which are both written to the file and fed to GCM as AAD.
 *
 * The SAME buffer must be used for both, which is why this is one function rather than a
 * `JSON.stringify` at each site: two stringifications that differ by a single space would produce a
 * file that never authenticates, and the error would say only "authentication failed".
 */
export function headerBytes(header: BackupHeader): Buffer {
  return Buffer.from(JSON.stringify(header), 'utf8');
}

/** Why a passphrase was rejected, in words an operator can act on — or null when it is usable. */
export function passphraseProblem(passphrase: string): string | null {
  if (typeof passphrase !== 'string' || passphrase.length === 0) return 'Enter a backup passphrase.';
  if (passphrase.length < 12) {
    return 'Use at least 12 characters. This passphrase is the only thing standing between a stolen backup file and every API key in this gateway — and it is the only way to open it again, so choose something you will still have in a year.';
  }
  if (passphrase.length > 200) return 'Keep the passphrase under 200 characters.';
  return null;
}

/**
 * Read and validate a header line.
 *
 * Every field is checked before anything derived from it is used. This function's whole job is to
 * decide whether a document from outside is safe to act on — a wrong shape must be a clear refusal,
 * never a crash and never a value passed onward.
 */
export function parseHeader(line: string): BackupHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error('This is not an Alayra Nexus backup file — the first line is not readable as a header.');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('This is not an Alayra Nexus backup file.');

  const h = raw as Record<string, unknown>;
  if (h.format !== BACKUP_FORMAT) {
    throw new Error(`This is not an Alayra Nexus backup file (its format is "${String(h.format)}").`);
  }
  if (h.version !== BACKUP_VERSION) {
    // Named explicitly rather than attempted: a newer file may hold fields this build would drop on
    // restore, and losing part of a backup silently is worse than refusing the whole of it.
    throw new Error(
      `This backup was written in format version ${String(h.version)}, and this gateway reads ` +
      `version ${BACKUP_VERSION}. Restore it with a matching version of Alayra Nexus.`);
  }

  const kdf = h.kdf as Record<string, unknown> | undefined;
  const cipher = h.cipher as Record<string, unknown> | undefined;
  if (!kdf || !cipher) throw new Error('This backup file is missing its encryption parameters.');
  if (kdf.name !== 'scrypt') throw new Error(`Unsupported key derivation "${String(kdf.name)}".`);
  if (cipher.name !== CIPHER) throw new Error(`Unsupported cipher "${String(cipher.name)}".`);

  const N = Number(kdf.N), r = Number(kdf.r), p = Number(kdf.p);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1) {
    throw new Error('This backup file has invalid key-derivation parameters.');
  }
  // The denial-of-service guard. A file does not get to choose how much memory we allocate.
  if (128 * N * r > MAX_KDF_MEM) {
    throw new Error('This backup file asks for more memory than is allowed to derive its key. Refusing to open it.');
  }

  const salt = typeof kdf.salt === 'string' ? Buffer.from(kdf.salt, 'hex') : Buffer.alloc(0);
  const iv = typeof cipher.iv === 'string' ? Buffer.from(cipher.iv, 'hex') : Buffer.alloc(0);
  if (salt.length !== SALT_BYTES) throw new Error('This backup file has a malformed salt.');
  if (iv.length !== IV_BYTES) throw new Error('This backup file has a malformed initialisation vector.');

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: { name: 'scrypt', N, r, p, salt: salt.toString('hex') },
    cipher: { name: CIPHER, iv: iv.toString('hex') },
  };
}

/** Turn the operator's passphrase into the file's key, using that file's own recorded parameters. */
export async function deriveKey(passphrase: string, header: BackupHeader): Promise<Buffer> {
  const { N, r, p, salt } = header.kdf;
  return scryptAsync(passphrase, Buffer.from(salt, 'hex'), KEY_BYTES, { N, r, p, maxmem: MAX_KDF_MEM });
}
