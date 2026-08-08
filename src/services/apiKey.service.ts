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

import { createHash, randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { getSetting, setSetting } from './settings.service';
import { writeSecretFile } from '../lib/secretFile';

// ── The master API key (Phase 7.13a) ──────────────────────────────────────────
//
// This key is what every client presents to use the gateway. Until now it was the ONLY credential
// stored in plain text: provider keys are AES-encrypted, team keys are hashed, and the master key —
// the one that opens everything — sat readable in the database.
//
// It is hashed now, like the team keys it sits beside, and shown exactly once when it is generated
// or rotated. That is the trade Stripe, OpenAI and GitHub all make, and it is the honest one: a key
// the dashboard can show you again is a key a stolen database can show an attacker. What you get
// instead is a masked hint (enough to tell which key is live) and a Rotate button.
//
// sha256, not scrypt: this is a 256-bit value we generate, not a human-chosen password, so it is
// unguessable regardless — and the fast digest is what keeps verification a single cached read on
// the proxy hot path, where a memory-hard hash would be a self-inflicted denial of service.

/** The hash of the live key. The key itself is not stored anywhere, by design. */
const KEY_HASH = 'NEXUS_API_KEY_HASH';
/** A display hint like `a1b2c3d4••••7f8e`. Not a secret: it identifies a key, it does not open it. */
const KEY_MASK = 'NEXUS_API_KEY_MASK';
/** The pre-7.13a plaintext key. Read once at boot by `convertLegacyApiKey`, then deleted. */
const LEGACY_KEY = 'NEXUS_API_KEY';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Enough to recognise a key, not enough to use one. */
export function maskApiKey(key: string): string {
  if (key.length < 12) return '••••';
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}

function generate(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}

/**
 * Is this the gateway's master key? A constant-time compare is unnecessary and would be slower:
 * the candidate is hashed first, so the comparison is between two fixed-width digests of values an
 * attacker cannot control the digest of — there is no prefix to walk.
 */
export async function verifyMasterApiKey(candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const stored = await getSetting(KEY_HASH);
  if (!stored) return false;
  return stored === hashApiKey(candidate);
}

/** What the dashboard may know: whether a key exists, and which one it is. Never the key. */
export async function getApiKeyInfo(): Promise<{ set: boolean; masked: string | null }> {
  const [hash, mask] = await Promise.all([getSetting(KEY_HASH), getSetting(KEY_MASK)]);
  return { set: !!hash, masked: hash ? (mask ?? '••••') : null };
}

/** Mint a new key, invalidating the old one immediately. Returned once — this is the only sight of it. */
export async function rotateApiKey(): Promise<{ key: string; masked: string }> {
  const key = generate();
  const masked = maskApiKey(key);
  await setSetting(KEY_HASH, hashApiKey(key));
  await setSetting(KEY_MASK, masked);
  return { key, masked };
}

/**
 * Bring an existing deployment across, at boot.
 *
 * Deliberately code and not SQL: hashing inside a migration would mean adding the pgcrypto
 * extension to everyone's database for one statement, and a gateway should not demand a Postgres
 * extension to upgrade.
 *
 * The operator's CURRENT KEY KEEPS WORKING — every client, script and IDE pointed at this gateway is
 * unaffected. What changes is that they can no longer read it back out of the dashboard. So it is
 * handed over one final time here, written to a file only its owner can read, which is the last
 * honest chance to save it.
 */
export async function convertLegacyApiKey(): Promise<boolean> {
  const plaintext = await getSetting(LEGACY_KEY);
  if (!plaintext || plaintext === 'REPLACE_ON_INIT') return false;

  await setSetting(KEY_HASH, hashApiKey(plaintext));
  await setSetting(KEY_MASK, maskApiKey(plaintext));
  // The plaintext row is REMOVED, not blanked: leaving it as an empty string would keep the column
  // that once held a live credential, and the point is that it is gone.
  await prisma.appSettings.deleteMany({ where: { key: LEGACY_KEY } });

  // Written to a 0600 file rather than printed. The key itself must not reach stdout, because
  // stdout is collected — see lib/secretFile.ts. The operator still gets exactly one chance at it,
  // and a file outlives the terminal that would have shown it.
  const path = writeSecretFile('api-key.txt', plaintext);

  console.log('\n🔐  Your Nexus API key is now stored as a hash, not in plain text.');
  console.log('    Your existing key is unchanged — every client using it keeps working — but this');
  console.log('    is the LAST time it can be retrieved. It has been written to:\n');
  console.log(`    ${path}\n`);
  console.log('    Read it with `cat`, save it somewhere safe, then delete that file.');
  console.log('    From now on the dashboard shows only a hint. Lost it? Rotate for a new one.\n');
  return true;
}

/**
 * Ensure the gateway has a key, generating one on first run. Returns the plaintext ONLY when it was
 * just created — there is nothing to return on any later boot, and that is the point.
 */
export async function ensureApiKey(): Promise<string | null> {
  await convertLegacyApiKey();
  if (await getSetting(KEY_HASH)) return null;

  const { key } = await rotateApiKey();
  return key;
}
