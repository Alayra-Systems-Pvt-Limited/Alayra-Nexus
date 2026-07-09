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

import 'fastify';

// The auth middleware resolves a team key and attaches its id to the request so
// downstream handlers (proxy route, usage attribution) can read it. Declaring it
// here gives it a real type instead of the `as Record<string, unknown>` casts
// that were used before.
declare module 'fastify' {
  interface FastifyRequest {
    teamKeyId?: string;
  }
}
