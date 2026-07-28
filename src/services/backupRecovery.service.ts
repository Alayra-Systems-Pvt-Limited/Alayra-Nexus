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

// The operator's recovery key: created once at install, used forever after (Phase C6).
//
// ── What it buys ──────────────────────────────────────────────────────────────────────────────
//
// Unattended backups that the server itself cannot open. The gateway keeps the PUBLIC half and
// wraps every nightly backup for it; the private half is derived from the operator's passphrase and
// is not on the machine in any usable form. Steal the whole server and the backups stay shut.
//
// ── Why it lives in AppSettings and not its own table ─────────────────────────────────────────
//
// Three reasons, and the third is the one that decided it. A new model would need a PostgreSQL
// migration AND a regenerated prisma/sqlite-schema.sql. It would change the schema shape recorded
// by C1, so every backup taken before it would show drift. And AppSettings is already backed up —
// which means restoring a backup restores the ability to open FUTURE backups, instead of leaving an
// operator with a restored gateway and an archive it can no longer read.
//
// ── What is safe to have in a backup ──────────────────────────────────────────────────────────
//
// Both halves travel inside the .nxb, and that is fine. The public half is public. The private half
// is sealed with the operator's passphrase — the same passphrase that opens the file it is sitting
// inside — so it grants an attacker nothing they did not already need.
//
// It is deliberately NOT re-keyed by secrets.ts on restore: that machinery re-encrypts things held
// under MASTER_ENCRYPTION_KEY so a backup can move between gateways, and this is held under the
// operator's passphrase precisely so that no gateway's master key can open it.

import { generateKeyPairSync, createPrivateKey, type KeyObject } from 'node:crypto';
import { prisma } from '../lib/prisma';
import {
  sealWithPassphrase, openWithPassphrase, passphraseProblem, X25519_DER_BYTES, type SealedBlob,
} from '../lib/backup/format';

/** AppSettings keys. Read by the export path on every backup, so both are cheap lookups. */
export const RECOVERY_PUBLIC_KEY = 'BACKUP_RECOVERY_PUBLIC';
export const RECOVERY_PRIVATE_KEY = 'BACKUP_RECOVERY_PRIVATE';

export interface NewRecoveryKey {
  /** DER SPKI, base64. Stored in the clear — a public key is public. */
  publicDer: string;
  sealed: SealedBlob;
}

/**
 * Mint a recovery key for a passphrase. Pure: stores nothing, so a caller can show the operator the
 * passphrase and only persist once they have confirmed they saved it.
 */
export async function createRecoveryKey(passphrase: string): Promise<NewRecoveryKey> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);

  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });

  return {
    publicDer: publicDer.toString('base64'),
    // The private half never touches storage unsealed, not even for an instant.
    sealed: await sealWithPassphrase(privateDer, passphrase),
  };
}

/** Persist a minted key. Both rows are written together, since one without the other is useless. */
export async function saveRecoveryKey(key: NewRecoveryKey): Promise<void> {
  await prisma.$transaction([
    prisma.appSettings.upsert({
      where: { key: RECOVERY_PUBLIC_KEY },
      create: { key: RECOVERY_PUBLIC_KEY, value: key.publicDer },
      update: { value: key.publicDer },
    }),
    prisma.appSettings.upsert({
      where: { key: RECOVERY_PRIVATE_KEY },
      create: { key: RECOVERY_PRIVATE_KEY, value: JSON.stringify(key.sealed) },
      update: { value: JSON.stringify(key.sealed) },
    }),
  ]);
}

/**
 * The public half, for wrapping a backup. Null when no recovery key was ever set — an upgraded
 * gateway that predates C6, which must keep taking backups rather than refusing to.
 */
export async function recoveryPublicKey(): Promise<Buffer | null> {
  const row = await prisma.appSettings.findUnique({ where: { key: RECOVERY_PUBLIC_KEY } });
  if (!row?.value) return null;

  const der = Buffer.from(row.value, 'base64');
  // A wrong-length key here would fail later inside createPublicKey, during an export, with a
  // message about DER. Better to notice it while there is still something useful to say.
  if (der.length !== X25519_DER_BYTES) {
    console.warn(`⚠️  ${RECOVERY_PUBLIC_KEY} is ${der.length} bytes, expected ${X25519_DER_BYTES}. Ignoring it.`);
    return null;
  }
  return der;
}

/** Whether this gateway has a recovery key at all. */
export async function hasRecoveryKey(): Promise<boolean> {
  return (await recoveryPublicKey()) !== null;
}

/**
 * Everything an export needs to add a recovery recipient, or null if none was ever set.
 *
 * Both halves, because the sealed private key travels IN the file — without it a backup wrapped
 * only for [gateway, recovery] would need a key stored on a server that no longer exists in order
 * to be opened, which is the one situation the recovery key exists to survive.
 */
export async function recoveryMaterial(): Promise<{ der: Buffer; sealed: SealedBlob } | null> {
  const der = await recoveryPublicKey();
  if (!der) return null;

  const row = await prisma.appSettings.findUnique({ where: { key: RECOVERY_PRIVATE_KEY } });
  if (!row?.value) {
    // Half a recovery key is not a recovery key. Wrapping for a public half whose sealed private
    // half is missing would produce backups nobody can ever open.
    console.warn(`⚠️  ${RECOVERY_PUBLIC_KEY} is set but ${RECOVERY_PRIVATE_KEY} is missing. No recovery recipient will be added.`);
    return null;
  }

  try {
    return { der, sealed: JSON.parse(row.value) as SealedBlob };
  } catch {
    console.warn(`⚠️  ${RECOVERY_PRIVATE_KEY} is unreadable. No recovery recipient will be added.`);
    return null;
  }
}

/**
 * Unseal the private half with the operator's passphrase.
 *
 * Throws when the passphrase is wrong — GCM authenticates, so there is no partial answer and no way
 * to distinguish a wrong passphrase from a damaged blob. Both mean the same thing to the caller.
 */
export async function unsealRecoveryKey(passphrase: string): Promise<KeyObject> {
  const row = await prisma.appSettings.findUnique({ where: { key: RECOVERY_PRIVATE_KEY } });
  if (!row?.value) throw new Error('This gateway has no recovery key.');

  let blob: SealedBlob;
  try {
    blob = JSON.parse(row.value) as SealedBlob;
  } catch {
    throw new Error('This gateway’s recovery key is stored in a form it cannot read.');
  }

  const privateDer = await openWithPassphrase(blob, passphrase);
  return createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
}
