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

// The public branding read (Phase 7.11). Deliberately unauthenticated and outside the admin router:
// the sign-in screen has to render the operator's name and logo *before* anyone has a session, and
// a branded login page is public by definition. It returns only the company name and the logo — a
// name and a picture their own users already see — and nothing about the gateway's state.
// The write lives in admin/branding.routes.ts, behind an owner credential.

import { FastifyInstance } from 'fastify';
import { getBranding }     from '../services/branding.service';

export default async function brandingRoutes(fastify: FastifyInstance) {
  fastify.get('/branding', async (_req, reply) => {
    return reply.send(await getBranding());
  });
}
