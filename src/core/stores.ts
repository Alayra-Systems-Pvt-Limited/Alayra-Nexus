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

// ── Core store registry ───────────────────────────────────────────────────────
// The one place the core finds its storage. A host installs a LOADER at boot; the loader runs on
// the first storage call and its result is reused for the life of the process.
//
// Why a loader rather than the stores themselves: the loader lets the host pull its adapters in
// lazily (a dynamic import). That keeps a host's database client out of the module graph until the
// first query, which is what lets a unit test's mock of that client reach the adapters, and what
// keeps the core free of any static dependency on a particular database.

import type { CoreStores } from './ports';

export type CoreStoresLoader = () => CoreStores | Promise<CoreStores>;

let loader:   CoreStoresLoader | undefined;
let resolved: Promise<CoreStores> | undefined;

/** Install (or replace) the host's storage. Replacing drops the cached stores. */
export function configureCoreStores(next: CoreStoresLoader): void {
  loader   = next;
  resolved = undefined;
}

/**
 * The installed stores. Rejects with a clear message when the host never installed any, rather
 * than failing later on an undefined property deep inside routing.
 */
export function coreStores(): Promise<CoreStores> {
  if (!loader) {
    return Promise.reject(new Error(
      'Nexus core storage is not configured: call configureCoreStores() at boot '
      + '(the open-source server does this through installPrismaCoreStores()).',
    ));
  }
  if (!resolved) {
    const attempt = Promise.resolve().then(loader);
    // A failed load is not cached, so a transient failure (a dynamic import racing a restart) is
    // retried on the next call instead of poisoning every later request.
    attempt.catch(() => { if (resolved === attempt) resolved = undefined; });
    resolved = attempt;
  }
  return resolved;
}

/** Test-only: forget the installed stores so a test can install its own. */
export function resetCoreStoresForTests(): void {
  loader   = undefined;
  resolved = undefined;
}
