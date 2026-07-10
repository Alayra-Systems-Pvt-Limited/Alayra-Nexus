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

// The model registry.
import { FastifyInstance }      from 'fastify';
import { z }                    from 'zod';
import { getModelRegistry, updateModelRegistry, normalizeModel } from '../../services/model.service';
import { CAPABILITIES }         from '../../lib/modelSelect';
import { adminGuard }           from './guard';

// The registry is a JSON blob, so it is the one admin write with no database schema
// behind it — validate it here, or a malformed PUT corrupts routing for every request.
const modelSchema = z.object({
  id:              z.string().min(1),
  displayName:     z.string().default(''),
  provider:        z.enum(['anthropic', 'openai', 'google', 'groq', 'openrouter', 'custom']),
  modelString:     z.string().min(1),
  tier:            z.enum(['premium', 'standard', 'fast']).default('standard'),
  status:          z.enum(['active', 'paused', 'retired']).default('active'),
  priority:        z.number().int().min(1).default(1),
  capabilities:    z.array(z.enum(CAPABILITIES)).default(['chat']),
  hasVision:       z.boolean().default(false),
  hasFIM:          z.boolean().default(false),
  hasToolCalling:  z.boolean().default(false),
  inputCostPer1M:  z.number().min(0).default(0),
  outputCostPer1M: z.number().min(0).default(0),
  contextWindow:   z.number().int().min(0).default(0),
  maxTokens:       z.number().int().min(0).default(0),
}).passthrough();

const registrySchema = z.object({ models: z.array(modelSchema) });

export default async function adminModelsRoutes(fastify: FastifyInstance) {
  // ── Model Registry ────────────────────────────────────────────────

  fastify.get('/admin/models', adminGuard, async (_req, reply) => {
    const models = await getModelRegistry();
    return reply.send({ models, capabilities: CAPABILITIES });
  });

  fastify.put('/admin/models', adminGuard, async (request, reply) => {
    const parsed = registrySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid model registry', details: parsed.error.issues.slice(0, 5) });
    }
    // Reject duplicate ids and duplicate provider+modelString pairs — either would make
    // selection non-deterministic.
    const ids = new Set<string>();
    const pairs = new Set<string>();
    for (const m of parsed.data.models) {
      if (ids.has(m.id)) return reply.code(400).send({ error: `Duplicate model id: ${m.id}` });
      const pair = `${m.provider}::${m.modelString}`;
      if (pairs.has(pair)) return reply.code(400).send({ error: `Duplicate model for provider: ${pair}` });
      ids.add(m.id); pairs.add(pair);
    }
    await updateModelRegistry(parsed.data.models.map((m) => normalizeModel(m)));
    return reply.send({ success: true });
  });
}
