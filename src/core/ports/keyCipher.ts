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

// ── Key cipher port (P1.1, #196) ──────────────────────────────────────────────────────────────
// How the core turns a stored provider key (`KeyRow.encryptedKey`) into the credential it sends
// upstream. The open-source gateway seals keys with AES-256-GCM under MASTER_ENCRYPTION_KEY, and
// that is the default. A host that keeps keys another way — per-tenant keys, a KMS-wrapped vault —
// installs its own cipher with `configureCoreCipher()` and never has to re-encrypt under one
// shared master key just so the core can read them.
//
// Synchronous on purpose: it runs on every routed request, inside key selection, and an async
// cipher would ripple through the whole routing path. A host whose keys sit behind a remote KMS
// unwraps its data keys ahead of time (or caches them) and decrypts locally here.

/** Which stored key is being opened, so a host can pick the right tenant key or audit the use. */
export interface KeyCipherContext {
  /** The provider key's id (`KeyRow.id`). */
  keyId:       string;
  /** The team that owns the key (BYOK), or null for a key in the shared pool. */
  ownerTeamId: string | null;
}

export interface KeyCipher {
  /**
   * The plaintext provider credential for `ciphertext`. Throw when it cannot be opened (wrong
   * tenant key, tampered value): the request then fails rather than sending a wrong credential.
   */
  decrypt(ciphertext: string, context: KeyCipherContext): string;
}
