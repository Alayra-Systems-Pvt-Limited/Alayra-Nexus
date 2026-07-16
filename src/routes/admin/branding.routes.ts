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

// Changing the operator's branding (Phase 7.11). Owner-only, and inside the admin router so the
// audit hook records the change like every other mutation. The read is public and lives in
// routes/branding.routes.ts — the sign-in screen needs it before a session exists.

import { FastifyInstance } from 'fastify';
import { z }               from 'zod';
import { setBranding }     from '../../services/branding.service';
import { validateLogoDataUri, MAX_COMPANY_NAME } from '../../lib/branding';
import { adminOwnerGuard } from './guard';

const brandingSchema = z.object({
  companyName: z.string().max(MAX_COMPANY_NAME).optional(),
  // Validated for shape and size below rather than by a regex here, so the operator gets the
  // specific reason ("wrong format" vs "too big") instead of one flat "invalid".
  logoDataUri: z.string().optional(),
});

export default async function adminBrandingRoutes(fastify: FastifyInstance) {
  fastify.put('/admin/branding', adminOwnerGuard, async (request, reply) => {
    const parsed = brandingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: `The company name must be ${MAX_COMPANY_NAME} characters or fewer.` });
    }
    if (parsed.data.logoDataUri !== undefined) {
      const check = validateLogoDataUri(parsed.data.logoDataUri);
      if (!check.ok) return reply.code(400).send({ error: check.error });
    }
    return reply.send(await setBranding(parsed.data));
  });
}
