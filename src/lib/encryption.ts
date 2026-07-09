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
