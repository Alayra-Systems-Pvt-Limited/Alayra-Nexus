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
import { verifyApiKey }   from '../middleware/auth.middleware';
import { refuseDuringMaintenance } from '../middleware/maintenance.middleware';
import { handleProxy }    from '../services/completionsProxy.service';
import type { CompletionsBody } from '../services/completionsProxy.service';
import { anthropicToOpenAI } from '../lib/anthropic';
import { createAnthropicReply } from '../lib/anthropicReply';
import { dispatchProxy, embeddingReserve, completionReserve, imageReserve, imageQuantity, speechReserve, speechCharacters } from '../services/proxyDispatch.service';
import { listServableModels } from '../services/modelCatalog.service';
import { resolveRequestScope } from '../services/byok.service';

export default async function proxyRoutes(fastify: FastifyInstance) {
  // Every route below, including any added later. onRequest runs BEFORE the verifyApiKey
  // preHandlers — which is required, not tidy: verifyApiKey reads the key table, and that table is
  // locked for the duration of a `replace` restore. A gate behind authentication would hang inside
  // authentication. Encapsulated to this plugin, so the admin API stays answerable and an operator
  // can still watch the restore they started.
  fastify.addHook('onRequest', refuseDuringMaintenance);

  fastify.post('/v1/chat/completions', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const teamKeyId = request.teamKeyId;
    return handleProxy(request.body as CompletionsBody, reply, teamKeyId, request.headers as Record<string, unknown>, request.team);
  });

  // Anthropic Messages API (Phase 6.2) — unlocks Claude Code and the Anthropic SDKs.
  // The request is translated to the canonical OpenAI shape and run through the exact
  // same pipeline as /v1/chat/completions; a wrapper reply translates the OpenAI
  // response (streaming or not) back to Anthropic on the wire. No second routing path.
  fastify.post('/v1/messages', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const openaiBody = anthropicToOpenAI(request.body as Record<string, unknown>) as unknown as CompletionsBody;
    const { reply: anthropicReply } = createAnthropicReply(reply);
    return handleProxy(openaiBody, anthropicReply, request.teamKeyId, request.headers as Record<string, unknown>, request.team);
  });

  // Embeddings (Phase 6.3) — unlocks RAG stacks (LangChain, LlamaIndex, …). Routed to a
  // model that declares the `embedding` capability, through the same resilience path.
  fastify.post('/v1/embeddings', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return dispatchProxy(body, reply, {
      capability: 'embedding', upstreamPath: '/embeddings', reserveTokens: embeddingReserve(body),
      team: request.team, teamKeyId: request.teamKeyId,
    });
  });

  // Legacy completions (Phase 6.3) — the fill-in-the-middle / autocomplete endpoint,
  // served by a model that declares the `completion` capability. One-shot (non-stream).
  fastify.post('/v1/completions', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return dispatchProxy(body, reply, {
      capability: 'completion', upstreamPath: '/completions', reserveTokens: completionReserve(body),
      team: request.team, teamKeyId: request.teamKeyId,
    });
  });

  // Image generation (Phase 6.3b) — served by a model that declares the `image`
  // capability. JSON in, JSON out, but billed per generated image rather than per token:
  // the dispatcher records the returned `data[]` count against the model's per-image
  // price. Same routing, breaker, budget and BYOK path as every other endpoint.
  fastify.post('/v1/images/generations', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return dispatchProxy(body, reply, {
      capability: 'image', upstreamPath: '/images/generations', reserveTokens: imageReserve(body),
      billing: {
        unit: 'image',
        quantityFromResponse: imageQuantity,
        quantityFromRequest: (b) => (typeof b.n === 'number' ? b.n : 1),
      },
      team: request.team, teamKeyId: request.teamKeyId,
    });
  });

  // Text-to-speech (Phase 6.3c) — served by a model with the `speech` capability. JSON
  // in, but the upstream returns audio, so the response is streamed back as raw bytes
  // with its Content-Type intact. Billed per input character (no usage block in a binary
  // reply). Same routing, breaker, budget and BYOK path as every other endpoint.
  fastify.post('/v1/audio/speech', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return dispatchProxy(body, reply, {
      capability: 'speech', upstreamPath: '/audio/speech', reserveTokens: speechReserve(body),
      responseMode: 'binary',
      billing: { unit: 'character', quantityFromRequest: speechCharacters },
      team: request.team, teamKeyId: request.teamKeyId,
    });
  });

  // Speech-to-text (Phase 6.3d) — served by a model with the `transcription` capability.
  // The audio arrives as a multipart upload; Nexus rebuilds the form with the model it
  // routed to (never the client's) and forwards it. The reply can be JSON, plain text,
  // or a subtitle format depending on the caller's `response_format`, so it is passed
  // straight through as bytes. Billed once per transcription. Same routing/breaker/budget
  // path as every other endpoint.
  fastify.post('/v1/audio/transcriptions', { preHandler: [verifyApiKey] }, async (request, reply) => {
    let fileBuf: Buffer | null = null;
    let fileName = 'audio';
    let fileType = 'application/octet-stream';
    let clientModel = '';
    const fields: Record<string, string> = {};
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        fileBuf  = await part.toBuffer();
        fileName = part.filename || fileName;
        fileType = part.mimetype || fileType;
      } else if (part.fieldname === 'model') {
        // Held back rather than forwarded — Nexus injects the model it ROUTED to when it
        // rebuilds the form. It is still handed to the dispatcher, so a caller can pin a
        // transcription model here exactly as they can on every other endpoint.
        clientModel = String(part.value);
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!fileBuf) {
      return reply.code(400).send({ error: 'multipart/form-data with a "file" part is required.' });
    }
    const audio = fileBuf;
    return dispatchProxy({ model: clientModel }, reply, {
      capability: 'transcription', upstreamPath: '/audio/transcriptions', reserveTokens: 1,
      responseMode: 'binary',
      requestBuild: (model) => {
        const fd = new FormData();
        fd.append('file', new Blob([audio], { type: fileType }), fileName);
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        fd.append('model', model);
        return fd;
      },
      billing: { unit: 'transcription', quantityFromRequest: () => 1 },
      team: request.team, teamKeyId: request.teamKeyId,
    });
  });

  // Model discovery. Returned as a superset that satisfies both an OpenAI client
  // (reads `object`/`data[].id`) and an Anthropic one such as Claude Code (reads
  // `data[].id`/`display_name` and the pagination fields), so one route serves both.
  //
  // The list is derived from the operator's registry, not hardcoded: the auto-route entry
  // first, then every model this caller can actually be routed to. See
  // modelCatalog.service — the same module resolves what a request may pin, so the listing
  // and the router can never disagree about which models exist.
  fastify.get('/v1/models', { preHandler: [verifyApiKey] }, async (request, reply) => {
    const scope   = await resolveRequestScope(request.team);
    const entries = await listServableModels(scope);
    const now     = Math.floor(Date.now() / 1000);
    const created = new Date().toISOString();

    return reply.send({
      object: 'list',
      data: entries.map((m) => ({
        id:           m.id,
        object:       'model',
        type:         'model',
        created:      now,
        created_at:   created,
        // Attribution is the provider the model is served from, so a client can see that
        // two similarly-named entries come from different pools. The auto entry is ours.
        owned_by:     m.provider,
        display_name: m.displayName,
        ...(m.capabilities.length ? { capabilities: m.capabilities } : {}),
        ...(m.contextWindow       ? { context_window: m.contextWindow } : {}),
        ...(m.maxTokens           ? { max_tokens: m.maxTokens } : {}),
      })),
      has_more: false,
      first_id: entries[0]?.id ?? null,
      last_id:  entries[entries.length - 1]?.id ?? null,
    });
  });
}
