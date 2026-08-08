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

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// Hand a freshly generated secret to the operator without putting it in a log.
//
// ── Why not just print it ─────────────────────────────────────────────────────────────────────
//
// The master API key used to go straight to stdout, on first run and again when a pre-7.13a
// plaintext key was converted. On a laptop that is fine — a human is watching the terminal. In
// every deployment that matters it is not: stdout is collected by Docker, systemd, Kubernetes or a
// hosted log service, and a credential written there is a credential in a system with a different
// retention policy, a different access list and, usually, a longer memory than anyone intends.
// CodeQL calls this `js/clear-text-logging` and it is right to.
//
// Deleting the message instead is worse than either. The key is shown exactly once by design, so an
// operator who never sees it has to rotate and update every client — a self-inflicted outage during
// what was supposed to be an upgrade.
//
// So the secret goes to a file only its owner can read, and the LOG gets the path. The operator runs
// one `cat`, which is a smaller ask than reading it out of a scrollback that may already be gone,
// and the file survives a terminal that closed. Same trade the benchmark harness already makes for
// the key it provisions.

/** Mode 0600 — owner read/write, nobody else. Meaningless on Windows, applied anyway where it works. */
const OWNER_ONLY = 0o600;

/**
 * Where a secret file goes: the data directory when one is configured, else the user's
 * `~/.alayra-nexus`, else the working directory as a last resort.
 *
 * Deliberately the same place the CLI keeps its data, so an operator has one directory to secure
 * rather than a secret filed somewhere they were not told about.
 */
export function secretDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const fromEnv = env.NEXUS_DATA_DIR?.trim();
  if (fromEnv) return resolve(cwd, fromEnv);

  const home = homedir();
  return home ? join(home, '.alayra-nexus') : cwd;
}

/**
 * Write `secret` to `filename` inside the secret directory, readable only by its owner. Returns the
 * path so the caller can tell the operator where to look.
 *
 * The mode is passed to `writeFileSync` AND applied again with `chmod`, because the mode argument
 * only applies when the file is CREATED — a re-run that overwrites an existing file would otherwise
 * keep whatever permissions that file already had.
 */
export function writeSecretFile(filename: string, secret: string): string {
  const path = join(secretDir(), filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: OWNER_ONLY });
  // Windows has no POSIX mode bits and chmod there is a no-op at best, an error at worst.
  if (process.platform !== 'win32') chmodSync(path, OWNER_ONLY);
  return path;
}
