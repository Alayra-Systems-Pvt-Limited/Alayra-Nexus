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

import { FastifyInstance } from 'fastify';

import adminSystemRoutes    from './system.routes';
import adminSettingsRoutes  from './settings.routes';
import adminProvidersRoutes from './providers.routes';
import adminKeysRoutes      from './keys.routes';
import adminModelsRoutes    from './models.routes';
import adminAnalyticsRoutes from './analytics.routes';
import adminTeamsRoutes     from './teams.routes';

/**
 * The admin API, grouped by resource. Each sub-router declares its own absolute
 * `/admin/...` paths and applies `adminGuard` per route, so registration order is
 * irrelevant and no prefix is inherited.
 */
export default async function adminRoutes(fastify: FastifyInstance) {
  await fastify.register(adminSystemRoutes);
  await fastify.register(adminSettingsRoutes);
  await fastify.register(adminProvidersRoutes);
  await fastify.register(adminKeysRoutes);
  await fastify.register(adminModelsRoutes);
  await fastify.register(adminAnalyticsRoutes);
  await fastify.register(adminTeamsRoutes);
}
