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

// The backup file's envelope (Phase B1.2b).
//
// A backup contains every provider key, every team key and every TOTP secret in the gateway. It is
// the most valuable file the product produces, and it leaves the machine.
//
// ── One file key, wrapped for several recipients ──────────────────────────────────────────────
//
// The body is encrypted once, with a random FILE KEY generated per backup. That key is then
// encrypted — "wrapped" — separately for each way the file is allowed to be opened, and the wrapped
// copies live in the header. The same design as LUKS, age and GPG, and it exists because the obvious
// alternative forces a choice between two failures:
//
//   passphrase only   an unattended nightly job cannot run without a passphrase stored somewhere,
//                     and an operator who never wrote theirs down has lost every backup they own.
//   master key only   the backups die with the machine, which is the moment they were for.
//
// With recipients there is no choice to make. A scheduled backup is wrapped for BOTH the operator's
// passphrase and the gateway itself: lose the machine and the passphrase still opens it; forget the
// passphrase and the gateway still does. Two independent losses are needed to lose a backup, and
// adding a recipient costs about a hundred bytes rather than a second copy of the database.
//
//   passphrase   scrypt over what the operator types, supplied at the moment of export.
//   gateway      a subkey of this deployment's MASTER_ENCRYPTION_KEY, for unattended work.
//   recovery     X25519 to the operator's recovery key, set once at install (C6).
//
// ── Why the recovery recipient exists, when a passphrase one already does ─────────────────────
//
// To put a passphrase lock on a backup taken at 3am, something has to KNOW the passphrase at 3am.
// Either the gateway stores it — in which case it is not secret from the gateway, and whoever
// breaks in has it — or a person is woken up. Both are unacceptable, and the gateway recipient only
// half-solves it: it lets the job run, but a backup openable by the gateway's own key is openable
// by anyone holding the .env, and dies with the machine if that is all it has.
//
// Public-key wrapping removes the choice. Think of a mailbox: anyone walking past can drop mail in
// the slot, and only the key opens it. The gateway keeps the slot — the PUBLIC half, useless on its
// own — and can therefore wrap every nightly backup for the operator without ever holding anything
// that opens one. The private half is derived from the operator's passphrase and is not on the
// server at all, so a stolen gateway yields no way in.
//
// ── Every file must be openable by something that outlives the machine ────────────────────────
//
// Enforced at write time. A gateway-only file is unopenable the moment the machine it came from is
// gone, which is precisely the disaster this feature exists to prevent. A passphrase recipient
// satisfies this, and so does a recovery recipient — both ultimately reduce to something the
// operator knows rather than something the server holds. The gateway recipient never does, and is
// always an addition rather than a substitute.
//
// ── The header is plaintext, minimal, and authenticated ───────────────────────────────────────
//
//   line 1   the header, plain JSON, newline-terminated
//   then     the ciphertext, raw bytes
//   last 16  the GCM authentication tag over the body
//
// Plaintext because it must be: the salts and wrapped keys are what make opening possible at all. So
// it carries that and NOTHING else — no gateway version, no row counts, no timestamp. Those describe
// the deployment and live inside the ciphertext, where a stolen file cannot give them up.
//
// The header bytes are the body's additional authenticated data. That is what stops a recipient
// being stripped, a KDF cost being lowered to make offline guessing cheap, or any other edit: the
// body stops authenticating. Adding a recipient is impossible for a different reason — wrapping
// requires the file key, which an attacker does not have.

import {
  randomBytes, scrypt, createCipheriv, createDecipheriv, createPublicKey, createPrivateKey,
  generateKeyPairSync, diffieHellman, hkdfSync, type KeyObject, type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';
import { deriveSubKey } from '../encryption';

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

/** The label that makes the gateway's wrapping key independent of its field-encryption key. */
export const GATEWAY_KEY_INFO = 'alayra-nexus/backup/gateway-recipient/v1';

/** The same separation for the recovery recipient's derived wrapping key. */
export const RECOVERY_KEY_INFO = 'alayra-nexus/backup/recovery-recipient/v1';

/**
 * An X25519 public key in DER SPKI form is exactly 44 bytes, always.
 *
 * Stored and carried as DER rather than the raw 32-byte point so Node can import it directly.
 * Hand-assembling an SPKI wrapper around a raw key is twelve bytes of prefix that everyone gets
 * right until they do not, and the failure would be a backup that cannot be opened.
 */
export const X25519_DER_BYTES = 44;

// Matching lib/password.ts: ~32 MB and ~100 ms per derivation.
const KDF_N = 32768;
const KDF_R = 8;
const KDF_P = 1;

/**
 * The ceiling on memory a FILE may ask us to allocate.
 *
 * These parameters are read from an untrusted document. Passing them to scrypt unchecked would let a
 * malicious backup name an N that allocates gigabytes and take the gateway down — a denial of
 * service triggered by nothing more than an operator opening a file someone sent them.
 */
const MAX_KDF_MEM = 256 * KDF_N * KDF_R;

/**
 * How many recipients a file may list.
 *
 * The SECOND denial-of-service guard, and a less obvious one: opening a file tries each passphrase
 * recipient in turn, and every attempt is a deliberately expensive ~100 ms scrypt. A file listing
 * five thousand recipients would occupy the gateway for eight minutes on a single upload. Eight is
 * far above any real use — an operator, a colleague, a break-glass key, the gateway — and bounds the
 * work at under a second.
 */
export const MAX_RECIPIENTS = 8;

export interface PassphraseRecipient {
  type: 'passphrase';
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string; wrapped: string; tag: string;
}

export interface GatewayRecipient {
  type: 'gateway';
  iv: string; wrapped: string; tag: string;
}

export interface RecoveryRecipient {
  type: 'recovery';
  /**
   * The EPHEMERAL public key for this one file, DER SPKI, hex.
   *
   * New for every backup. Reusing one would make two backups to the same recovery key share a
   * wrapping key, so cracking one would open the other.
   */
  epk: string;
  /**
   * The operator's recovery PRIVATE key, sealed with their passphrase — carried in the file.
   *
   * Without this the design deadlocks, and the deadlock is exactly the disaster it was built to
   * prevent: a nightly backup wrapped for [gateway, recovery], the server gone, the operator
   * holding their passphrase — and the private key needed to open the file sitting in AppSettings
   * INSIDE that same unopenable file.
   *
   * Publishing it costs nothing. It is sealed with the same scrypt parameters as a passphrase
   * recipient, so an attacker holding the file faces exactly the work they already faced. And the
   * gateway can copy this blob into a 3am backup without being able to open it, which is the entire
   * property that makes an unattended backup possible without storing a passphrase anywhere.
   */
  sealedPrivate: SealedBlob;
  iv: string; wrapped: string; tag: string;
}

export type Recipient = PassphraseRecipient | GatewayRecipient | RecoveryRecipient;

/**
 * Recipients that survive the machine.
 *
 * Both reduce to something the operator knows rather than something the server holds. The gateway
 * recipient does not, which is why it can never be the only one.
 */
export const survivesTheMachine = (r: Recipient): boolean => r.type === 'passphrase' || r.type === 'recovery';

export interface BackupHeader {
  format: string;
  version: number;
  cipher: { name: string; iv: string };
  recipients: Recipient[];
}

/** A fresh file key. One per backup, never derived from anything, never reused. */
export function newFileKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Encrypt the file key with a key-encryption key. */
function wrap(fileKey: Buffer, kek: Buffer): { iv: string; wrapped: string; tag: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, kek, iv);
  const wrapped = Buffer.concat([cipher.update(fileKey), cipher.final()]);
  return { iv: iv.toString('hex'), wrapped: wrapped.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

/** Recover the file key. Throws when the key-encryption key is wrong — GCM refuses to guess. */
function unwrap(kek: Buffer, r: { iv: string; wrapped: string; tag: string }): Buffer {
  const decipher = createDecipheriv(CIPHER, kek, Buffer.from(r.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(r.tag, 'hex'));
  const key = Buffer.concat([decipher.update(Buffer.from(r.wrapped, 'hex')), decipher.final()]);
  if (key.length !== KEY_BYTES) throw new Error('Unwrapped a file key of the wrong size.');
  return key;
}

/** Wrap the file key for whoever knows this passphrase. */
export async function wrapForPassphrase(fileKey: Buffer, passphrase: string): Promise<PassphraseRecipient> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await scryptAsync(passphrase, salt, KEY_BYTES, { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: MAX_KDF_MEM });
  return {
    type: 'passphrase',
    kdf: { name: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt: salt.toString('hex') },
    ...wrap(fileKey, kek),
  };
}

/** Wrap the file key for this gateway, so an unattended job can open it without a passphrase. */
export function wrapForGateway(fileKey: Buffer): GatewayRecipient {
  return { type: 'gateway', ...wrap(fileKey, deriveSubKey(GATEWAY_KEY_INFO)) };
}

/**
 * The wrapping key both sides of a recovery recipient arrive at independently.
 *
 * The shared secret alone is not used as a key: X25519 output is a curve point, not uniform key
 * material, and HKDF is what turns it into a key. Both public keys go in as salt so the derived key
 * is bound to this exact pairing — substituting an ephemeral key from another file produces a
 * different wrapping key rather than a valid one.
 */
function recoveryKek(shared: Buffer, epkDer: Buffer, recipientDer: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([epkDer, recipientDer]), RECOVERY_KEY_INFO, KEY_BYTES),
  );
}

/**
 * Wrap the file key for the operator's recovery key, knowing only its PUBLIC half.
 *
 * This is what lets a 3am backup be locked to something the server cannot open. No secret of the
 * operator's is needed, or present, or derivable from anything on the machine.
 */
export function wrapForRecovery(
  fileKey: Buffer, recipientPublicDer: Buffer, sealedPrivate: SealedBlob,
): RecoveryRecipient {
  const recipient = createPublicKey({ key: recipientPublicDer, format: 'der', type: 'spki' });
  // Ephemeral, per file. The private half is never stored and goes out of scope immediately.
  const ephemeral = generateKeyPairSync('x25519');
  const epkDer = ephemeral.publicKey.export({ format: 'der', type: 'spki' });

  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const kek = recoveryKek(shared, epkDer, recipientPublicDer);

  return { type: 'recovery', epk: epkDer.toString('hex'), sealedPrivate, ...wrap(fileKey, kek) };
}

/**
 * Open a recovery recipient with the operator's passphrase alone.
 *
 * Two steps, both from the file: unseal the private key that travelled with it, then use it. This
 * is what makes a recovery-wrapped backup self-sufficient — a passphrase and the file are enough,
 * with no surviving gateway and nothing else to have kept.
 */
export async function unwrapRecoveryWithPassphrase(r: RecoveryRecipient, passphrase: string): Promise<Buffer> {
  const privateDer = await openWithPassphrase(r.sealedPrivate, passphrase);
  return unwrapWithRecovery(r, createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' }));
}

/** Recover the file key from a recovery recipient, given the operator's unsealed private key. */
export function unwrapWithRecovery(r: RecoveryRecipient, recipientPrivate: KeyObject): Buffer {
  const epkDer = Buffer.from(r.epk, 'hex');
  const ephemeralPublic = createPublicKey({ key: epkDer, format: 'der', type: 'spki' });
  const recipientDer = createPublicKey(recipientPrivate).export({ format: 'der', type: 'spki' });

  const shared = diffieHellman({ privateKey: recipientPrivate, publicKey: ephemeralPublic });
  return unwrap(recoveryKek(shared, epkDer, recipientDer), r);
}

/**
 * Arbitrary bytes locked with a passphrase — used for the recovery private key at rest (C6).
 *
 * NOT `encrypt()` from lib/encryption. That would seal the operator's private key with the
 * gateway's MASTER_ENCRYPTION_KEY, which would mean the server could open it, which would undo the
 * entire reason the recovery key exists. It would also — correctly — trip the drift guard in
 * secrets.ts, which scans for exactly that call and demands the site be acknowledged.
 *
 * The same scrypt parameters as a passphrase recipient, so the cost of guessing is identical
 * wherever the operator's passphrase is the thing standing in the way.
 */
export interface SealedBlob {
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string; ciphertext: string; tag: string;
}

export async function sealWithPassphrase(plaintext: Buffer, passphrase: string): Promise<SealedBlob> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(passphrase, salt, KEY_BYTES, { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: MAX_KDF_MEM });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    kdf: { name: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt: salt.toString('hex') },
    iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex'),
  };
}

/** Throws on the wrong passphrase — GCM authenticates, so a near miss is not a partial answer. */
export async function openWithPassphrase(blob: SealedBlob, passphrase: string): Promise<Buffer> {
  if (blob?.kdf?.name !== 'scrypt') throw new Error('This recovery key is stored in a format this gateway does not understand.');
  const { N, r, p } = blob.kdf;
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || 128 * N * r > MAX_KDF_MEM) {
    throw new Error('This recovery key names invalid key-derivation parameters.');
  }
  const key = await scryptAsync(passphrase, Buffer.from(blob.kdf.salt, 'hex'), KEY_BYTES,
    { N, r, p, maxmem: MAX_KDF_MEM });
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'hex')), decipher.final()]);
}

/**
 * Assemble the header.
 *
 * Refuses a set of recipients with no passphrase in it. A gateway-only backup is unopenable once the
 * machine that wrote it is gone, and this is the last point at which that can be prevented.
 */
export function buildHeader(recipients: Recipient[]): BackupHeader {
  if (!recipients.some(survivesTheMachine)) {
    throw new Error('A backup must always be openable by something other than this gateway, or it dies with the machine that wrote it.');
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(`A backup may have at most ${MAX_RECIPIENTS} recipients.`);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    cipher: { name: CIPHER, iv: randomBytes(IV_BYTES).toString('hex') },
    recipients,
  };
}

/**
 * The header's exact bytes, which are both written to the file and fed to GCM as AAD.
 *
 * The SAME buffer must be used for both, which is why this is one function rather than a
 * `JSON.stringify` at each site: two stringifications differing by a single space would produce a
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

const hex = (v: unknown, bytes: number): string => {
  if (typeof v !== 'string') throw new Error('This backup file has a malformed header.');
  const b = Buffer.from(v, 'hex');
  if (b.length !== bytes) throw new Error('This backup file has a malformed header.');
  return b.toString('hex');
};

/**
 * Validate a sealed blob arriving from a file.
 *
 * The same memory ceiling as a passphrase recipient, for the same reason: these parameters decide
 * how much this process allocates, and they were written by whoever produced the file.
 */
function parseSealedBlob(raw: unknown): SealedBlob {
  if (typeof raw !== 'object' || raw === null) throw new Error('This backup file has a malformed recovery recipient.');
  const b = raw as Record<string, unknown>;
  const kdf = b.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.name !== 'scrypt') throw new Error(`Unsupported key derivation "${String(kdf?.name)}".`);

  const N = Number(kdf.N), r = Number(kdf.r), p = Number(kdf.p);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 2 || r < 1 || p < 1) {
    throw new Error('This backup file has invalid key-derivation parameters.');
  }
  if (128 * N * r > MAX_KDF_MEM) {
    throw new Error('This backup file asks for more memory than is allowed to derive its key. Refusing to open it.');
  }
  if (typeof b.ciphertext !== 'string' || b.ciphertext.length > 4096) {
    throw new Error('This backup file has a malformed recovery recipient.');
  }

  return {
    kdf: { name: 'scrypt', N, r, p, salt: hex(kdf.salt, SALT_BYTES) },
    iv: hex(b.iv, IV_BYTES), ciphertext: b.ciphertext, tag: hex(b.tag, TAG_BYTES),
  };
}

/** Validate one recipient from an untrusted file. */
function parseRecipient(raw: unknown): Recipient {
  if (typeof raw !== 'object' || raw === null) throw new Error('This backup file has a malformed recipient.');
  const r = raw as Record<string, unknown>;

  const common = {
    iv: hex(r.iv, IV_BYTES),
    wrapped: hex(r.wrapped, KEY_BYTES),
    tag: hex(r.tag, TAG_BYTES),
  };

  if (r.type === 'gateway') return { type: 'gateway', ...common };

  // Length-checked like every other field from an untrusted file: createPublicKey on arbitrary
  // bytes is a parser, and handing one 40 megabytes because a header said so is not a decision this
  // code gets to make.
  if (r.type === 'recovery') {
    return {
      type: 'recovery',
      epk: hex(r.epk, X25519_DER_BYTES),
      // Validated here rather than trusted at unseal time: its KDF parameters are read from the
      // same untrusted document as everything else, and are the same denial-of-service lever.
      sealedPrivate: parseSealedBlob(r.sealedPrivate),
      ...common,
    };
  }

  if (r.type !== 'passphrase') throw new Error(`This backup names a recipient this gateway does not understand: "${String(r.type)}".`);

  const kdf = r.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.name !== 'scrypt') throw new Error(`Unsupported key derivation "${String(kdf?.name)}".`);

  const N = Number(kdf.N), rr = Number(kdf.r), p = Number(kdf.p);
  if (!Number.isInteger(N) || !Number.isInteger(rr) || !Number.isInteger(p) || N < 2 || rr < 1 || p < 1) {
    throw new Error('This backup file has invalid key-derivation parameters.');
  }
  // The memory guard. A file does not get to choose how much this process allocates.
  if (128 * N * rr > MAX_KDF_MEM) {
    throw new Error('This backup file asks for more memory than is allowed to derive its key. Refusing to open it.');
  }

  return { type: 'passphrase', kdf: { name: 'scrypt', N, r: rr, p, salt: hex(kdf.salt, SALT_BYTES) }, ...common };
}

/**
 * Read and validate a header line.
 *
 * Everything is checked before anything derived from it is used. This function's whole job is to
 * decide whether a document from outside is safe to act on — a wrong shape is a clear refusal, never
 * a crash and never a value passed onward.
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
    // Named rather than attempted: a newer file may hold fields this build would drop on restore,
    // and losing part of a backup silently is worse than refusing the whole of it.
    throw new Error(
      `This backup was written in format version ${String(h.version)}, and this gateway reads ` +
      `version ${BACKUP_VERSION}. Restore it with a matching version of Alayra Nexus.`);
  }

  const cipher = h.cipher as Record<string, unknown> | undefined;
  if (!cipher) throw new Error('This backup file is missing its encryption parameters.');
  if (cipher.name !== CIPHER) throw new Error(`Unsupported cipher "${String(cipher.name)}".`);

  if (!Array.isArray(h.recipients) || h.recipients.length === 0) {
    throw new Error('This backup file lists no way to open it.');
  }
  // Checked BEFORE parsing them, so a file cannot make us do the work of validating thousands.
  if (h.recipients.length > MAX_RECIPIENTS) {
    throw new Error(`This backup lists ${h.recipients.length} recipients, more than the ${MAX_RECIPIENTS} allowed. Refusing to open it.`);
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    cipher: { name: CIPHER, iv: hex(cipher.iv, IV_BYTES) },
    recipients: h.recipients.map(parseRecipient),
  };
}

export interface OpenOptions {
  /** Tried first when present. */
  passphrase?: string;
  /** Whether this gateway may open the file with its own key. Default true. */
  allowGateway?: boolean;
  /**
   * The operator's recovery private key, already unsealed with their passphrase.
   *
   * Supplied by the caller rather than loaded here, because unsealing it needs the database and
   * this module deliberately touches nothing but the bytes it is given.
   */
  recoveryKey?: KeyObject;
}

/**
 * Recover the file key using whichever recipient the caller can satisfy.
 *
 * The passphrase is tried first, because a caller who supplied one meant to use it and the resulting
 * error should be about the passphrase rather than about a gateway key they never mentioned.
 *
 * Every failure arrives here identically — GCM says only "did not authenticate" — so the message
 * describes what was tried instead of guessing why. A wrong passphrase, a file from a different
 * gateway and a corrupted wrap are genuinely indistinguishable at this point, and pretending
 * otherwise would mislead.
 */
export async function unwrapFileKey(header: BackupHeader, opts: OpenOptions): Promise<Buffer> {
  const tried: string[] = [];

  if (opts.passphrase) {
    for (const r of header.recipients) {
      if (r.type !== 'passphrase') continue;
      tried.push('passphrase');
      const kek = await scryptAsync(opts.passphrase, Buffer.from(r.kdf.salt, 'hex'), KEY_BYTES,
        { N: r.kdf.N, r: r.kdf.r, p: r.kdf.p, maxmem: MAX_KDF_MEM });
      try { return unwrap(kek, r); } catch { /* try the next recipient */ }
    }

    // The same passphrase also opens a recovery recipient, because the sealed private key travels
    // in the file. The operator types one thing and it works whichever way the backup was wrapped —
    // they should never have to know that a scheduled backup and a manual one were locked
    // differently.
    for (const r of header.recipients) {
      if (r.type !== 'recovery') continue;
      tried.push('recovery key');
      try { return await unwrapRecoveryWithPassphrase(r, opts.passphrase); } catch { /* next */ }
    }
  }

  // For a caller that already holds the unsealed key and has no passphrase to offer.
  if (opts.recoveryKey) {
    for (const r of header.recipients) {
      if (r.type !== 'recovery') continue;
      tried.push('recovery key');
      try { return unwrapWithRecovery(r, opts.recoveryKey); } catch { /* try the next recipient */ }
    }
  }

  if (opts.allowGateway !== false) {
    for (const r of header.recipients) {
      if (r.type !== 'gateway') continue;
      tried.push('this gateway’s own key');
      try { return unwrap(deriveSubKey(GATEWAY_KEY_INFO), r); } catch { /* try the next recipient */ }
    }
  }

  if (tried.length === 0) {
    throw new Error(
      'No passphrase was given, and this backup cannot be opened by this gateway. Supply the ' +
      'passphrase it was created with.');
  }
  throw new Error(
    `This backup could not be opened with ${[...new Set(tried)].join(' or ')}. The passphrase may be ` +
    'wrong, the file may be damaged, or it may have been written by a different gateway.');
}
