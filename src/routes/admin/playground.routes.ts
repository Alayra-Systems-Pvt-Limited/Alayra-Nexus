/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adminGuard, adminWriteGuard } from './guard';
import { invalidBody } from '../../lib/invalidBody';
import { createCapturingReply } from '../../lib/capturingReply';
import { newTrace, type TraceRoutingStrategy } from '../../lib/requestTrace';
import { countMessageTokens } from '../../lib/tokenizer';
import { handleProxy, type CompletionsBody } from '../../services/completionsProxy.service';
import { listServableModels } from '../../services/modelCatalog.service';
import { getModelRegistry, type AiModel } from '../../services/model.service';
import { getNexusOverview, type NexusKeyHealth, type NexusPool } from '../../services/nexusOverview.service';
import { resolveRequestScope } from '../../services/byok.service';

const textPart = z.object({ type: z.literal('text'), text: z.string().min(1).max(100_000) }).strict();
const message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.array(textPart).min(1).max(32),
}).strict();
const strategy = z.enum(['fastest', 'balanced', 'cheapest']);

const requestSchema = z.object({
  model: z.string().trim().min(1).max(512).default('auto'),
  messages: z.array(message).min(1).max(200),
  temperature: z.number().finite().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(131_072).default(2048),
  strategy: strategy.default('fastest'),
  cacheMode: z.enum(['fresh', 'use']).default('fresh'),
}).strict();

const preflightSchema = requestSchema.pick({ model: true, messages: true, maxTokens: true });

type Capacity = { healthyKeys: number; totalKeys: number; configuredRpm: number; configuredTpm: number };

function keyIsHealthy(key: NexusKeyHealth, now = Date.now()): boolean {
  return key.status === 'active' && (!key.coolingUntil || Date.parse(key.coolingUntil) <= now);
}

function capacityFor(pools: NexusPool[]): Capacity {
  const keys = pools.flatMap((pool) => pool.keys);
  const healthy = keys.filter((key) => keyIsHealthy(key));
  return {
    healthyKeys: healthy.length,
    totalKeys: keys.length,
    configuredRpm: healthy.reduce((sum, key) => sum + key.rpmLimit, 0),
    configuredTpm: healthy.reduce((sum, key) => sum + key.tpmLimit, 0),
  };
}

function priced(model: AiModel | undefined): model is AiModel {
  return Boolean(model && model.pricingSource !== 'unset');
}

function estimate(model: AiModel, inputTokens: number, maxTokens: number): number {
  return (inputTokens * model.inputCostPer1M + maxTokens * model.outputCostPer1M) / 1_000_000;
}

async function playgroundCatalog() {
  const scope = await resolveRequestScope(undefined);
  const [entries, registry, overview] = await Promise.all([
    listServableModels(scope),
    getModelRegistry(),
    getNexusOverview(),
  ]);
  const pools = overview.tiers.flatMap((tier) => tier.providers);
  const registryById = new Map<string, AiModel>();
  for (const model of registry) {
    registryById.set(model.id.toLowerCase(), model);
    registryById.set(model.modelString.toLowerCase(), model);
  }

  return {
    entries: entries
      .filter((entry) => entry.auto || entry.capabilities.length === 0 || entry.capabilities.includes('chat'))
      .map((entry) => {
        const registered = registryById.get(entry.id.toLowerCase());
        const relevantPools = entry.auto ? pools : pools.filter((pool) => pool.provider === entry.provider);
        return {
          id: entry.id,
          displayName: entry.displayName,
          provider: entry.provider,
          auto: entry.auto,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          pricing: priced(registered) ? {
            inputPer1M: registered.inputCostPer1M,
            outputPer1M: registered.outputCostPer1M,
            source: registered.pricingSource,
          } : null,
          capacity: capacityFor(relevantPools),
        };
      }),
    registryById,
    pools,
  };
}

function event(reply: FastifyReply, name: string, data: unknown): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;
  return reply.raw.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

/**
 * The dashboard's proof path deliberately calls handleProxy: a separate validator would prove a
 * different path from the one applications use. Preflight is read-only and never contacts a model.
 */
export default async function adminPlaygroundRoutes(fastify: FastifyInstance) {
  fastify.get('/admin/playground/models', adminGuard, async (_request, reply) => {
    const catalog = await playgroundCatalog();
    return reply.send({ models: catalog.entries });
  });

  fastify.post('/admin/playground/preflight', adminGuard, async (request, reply) => {
    const parsed = preflightSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Provide a valid Playground estimate request.'));
    }

    const catalog = await playgroundCatalog();
    const inputTokens = countMessageTokens(parsed.data.messages);
    const selected = catalog.entries.find((entry) => entry.id === parsed.data.model);
    if (!selected) return reply.code(400).send({ error: 'The selected Playground model is not available.' });

    const candidateEntries = selected.auto ? catalog.entries.filter((entry) => !entry.auto) : [selected];
    const candidates = candidateEntries
      .map((entry) => catalog.registryById.get(entry.id.toLowerCase()))
      .filter((model): model is AiModel => Boolean(model));
    const known = candidates.filter(priced).map((model) => estimate(model, inputTokens, parsed.data.maxTokens));
    // Legacy pool models and registry models with `pricingSource: unset` both count as unpriced.
    const unpricedCandidates = candidateEntries.length - known.length;

    return reply.send({
      inputTokens,
      maxOutputTokens: parsed.data.maxTokens,
      estimate: known.length === 0 ? {
        kind: 'unpriced', minimumUsd: null, maximumUsd: null, unpricedCandidates,
      } : {
        kind: selected.auto ? 'range' : 'exact',
        minimumUsd: Math.min(...known),
        maximumUsd: Math.max(...known),
        unpricedCandidates,
      },
      capacity: selected.capacity,
      note: 'Token and cost figures are estimates. Capacity shows configured healthy-key limits, not remaining quota.',
    });
  });

  // A call spends provider capacity and money, so a viewer may inspect but cannot execute one.
  fastify.post('/admin/playground/run', adminWriteGuard, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Provide a valid Playground request.'));
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const trace = newTrace();
    const captured = createCapturingReply({
      maxSseChars: 1_000_000,
      events: reply.raw,
      onChunk: (chunk) => event(reply, 'upstream', { chunk }),
    });
    const body: CompletionsBody = {
      model: parsed.data.model,
      messages: parsed.data.messages.map((item) => ({
        role: item.role,
        content: item.content.map((part) => part.text).join('\n'),
      })),
      temperature: parsed.data.temperature,
      max_tokens: parsed.data.maxTokens,
      stream: true,
    };
    const proxyHeaders = parsed.data.cacheMode === 'fresh'
      ? { ...request.headers, 'x-nexus-cache-bypass': '1' }
      : request.headers;

    await handleProxy(
      body,
      captured.reply,
      undefined,
      proxyHeaders,
      undefined,
      trace,
      { routingStrategy: parsed.data.strategy as TraceRoutingStrategy },
    );

    event(reply, 'result', {
      response: {
        status: captured.captured.status,
        headers: captured.captured.headers,
        payload: captured.captured.payload,
        streamed: captured.captured.streamed,
        truncated: captured.captured.truncated,
      },
      trace,
    });
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  });
}
