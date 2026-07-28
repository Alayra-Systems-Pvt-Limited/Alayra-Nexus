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

import crypto from 'crypto';

const MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || '';
const ALGORITHM = 'aes-256-gcm';

// 64 hex characters == 32 bytes
if (MASTER_ENCRYPTION_KEY.length !== 64) {
  throw new Error('CRITICAL FATAL: MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
}

/**
 * A key derived from the master key for one specific purpose (Phase B1.2b).
 *
 * The master key stays inside this module — it is never exported, and nothing outside here should
 * ever hold it. Callers that need key material for something OTHER than field encryption ask for a
 * subkey instead, naming what it is for.
 *
 * HKDF, not the master key directly. Reusing one key for two jobs is the kind of shortcut that is
 * harmless until the day one of them turns out to leak something about the key, at which point it
 * has compromised the other as well. Distinct `info` strings produce independent keys from the same
 * master, so the backup wrapping key cannot be used to read a stored provider credential and vice
 * versa. The label is versioned so a future scheme can coexist rather than silently reinterpret an
 * existing one.
 *
 * @param info a stable, descriptive label — e.g. "alayra-nexus/backup/gateway-recipient/v1".
 */
export function deriveSubKey(info: string, bytes = 32): Buffer {
  if (!info) throw new Error('deriveSubKey needs a purpose label.');
  // Empty salt: HKDF is defined for it, and the master key is already 32 bytes of full-entropy
  // random rather than a password, so the extract step has nothing to strengthen. The `info` label
  // is what separates one subkey from another.
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(MASTER_ENCRYPTION_KEY, 'hex'), Buffer.alloc(0), info, bytes),
  );
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(MASTER_ENCRYPTION_KEY, 'hex');
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format. Expected iv:authTag:encrypted');
  }
  
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = Buffer.from(MASTER_ENCRYPTION_KEY, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

export function maskKey(key: string): string {
  if (!key || key.length < 4) return '●●●●';
  const visibleLength = 4;
  const lastFour = key.slice(-visibleLength);
  const hiddenPart = '●'.repeat(key.length - visibleLength);
  return `${hiddenPart}${lastFour}`;
}
