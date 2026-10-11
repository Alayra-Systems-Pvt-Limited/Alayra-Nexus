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

// ── Core key cipher registry (P1.1, #196) ─────────────────────────────────────────────────────
// Where the request path finds the cipher that opens stored provider keys. Same contract as
// `configureCoreKv()`: the cipher is chosen on FIRST USE — the host's, when one was installed,
// otherwise the open-source AES-256-GCM cipher from lib/encryption. Installing one after the core
// has already decrypted a key, or installing twice, throws: two ciphers behind one name would mean
// some requests were served with keys opened one way and some the other.

import { decrypt as aesDecrypt } from '../lib/encryption';
import type { KeyCipher } from './ports/keyCipher';

/** The open-source cipher: keys sealed under MASTER_ENCRYPTION_KEY. The key is checked on first use. */
const defaultCipher: KeyCipher = { decrypt: (ciphertext) => aesDecrypt(ciphertext) };

let chosen: KeyCipher | undefined;

/**
 * Install the host's key cipher. Call it once, at boot, before the first request or any other
 * core call. The open-source server never calls it and keeps the AES default.
 */
export function configureCoreCipher(cipher: KeyCipher): void {
  if (chosen) {
    throw new Error(
      'The Nexus core key cipher is already in use: call configureCoreCipher() once, at boot, '
      + 'before the first request or any other core call.',
    );
  }
  if (!cipher || typeof cipher.decrypt !== 'function') {
    throw new Error('configureCoreCipher() needs an object with a decrypt(ciphertext, context) method.');
  }
  chosen = cipher;
}

/** The cipher in use, choosing the default now if the host installed none. */
export function coreCipher(): KeyCipher {
  if (!chosen) chosen = defaultCipher;
  return chosen;
}

/** Test-only: forget the chosen cipher so the next use chooses again. */
export function resetCoreCipherForTests(): void {
  chosen = undefined;
}
