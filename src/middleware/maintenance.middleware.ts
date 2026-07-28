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

// Refusing proxy traffic while the gateway is being restored (Phase A4).
//
// ── Why this is an onRequest hook and not a preHandler ────────────────────────────────────────
//
// Fastify runs onRequest before preValidation and preHandler, and `verifyApiKey` is a preHandler.
// That ordering is the entire point rather than a detail: verifyApiKey resolves the caller's key
// against the DATABASE, and during a `replace` restore the key table is held under ACCESS
// EXCLUSIVE. A gate placed after authentication would block inside authentication — hanging in
// precisely the situation it was added to stop hanging in.
//
// So the check must happen before anything touches Postgres, and it reads only the key-value store.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { readMaintenance } from '../services/maintenance.service';

/**
 * Answer 503 with a live countdown while a restore is in progress.
 *
 * The body carries the same numbers the dashboard shows, because a caller staring at a failing
 * integration deserves the same answer as the operator watching it — and because this information
 * is unavoidably public anyway: any 503 with a Retry-After already says "down, come back in N".
 */
export async function refuseDuringMaintenance(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const state = await readMaintenance();
  if (!state) return;

  await reply
    .code(503)
    .header('Retry-After', String(state.retryAfterSeconds))
    // Never cached: a 503 that a proxy remembers outlives the restore it describes.
    .header('cache-control', 'no-store')
    .send({
      error: `The gateway is temporarily unavailable: ${state.reason}. Retry in ${state.retryAfterSeconds}s.`,
      maintenance: {
        reason: state.reason,
        percent: state.percent,
        etaSeconds: state.etaSeconds,
        retryAfterSeconds: state.retryAfterSeconds,
      },
    });
}
