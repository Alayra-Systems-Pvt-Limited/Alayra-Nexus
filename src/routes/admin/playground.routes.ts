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
import { newTrace } from '../../lib/requestTrace';
import { handleProxy, type CompletionsBody } from '../../services/completionsProxy.service';
import { listServableModels } from '../../services/modelCatalog.service';
import { resolveRequestScope } from '../../services/byok.service';

const textPart = z.object({ type: z.literal('text'), text: z.string().min(1).max(100_000) }).strict();
const message = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.array(textPart).min(1).max(32),
}).strict();

const runSchema = z.object({
  model: z.string().trim().min(1).max(512).default('auto'),
  messages: z.array(message).min(1).max(200),
  temperature: z.number().finite().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(131_072).default(2048),
}).strict();

function event(reply: FastifyReply, name: string, data: unknown): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;
  return reply.raw.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

/**
 * The dashboard's one-prompt proof path. It deliberately calls handleProxy: a separate validator
 * would prove a different path from the one applications use.
 */
export default async function adminPlaygroundRoutes(fastify: FastifyInstance) {
  fastify.get('/admin/playground/models', adminGuard, async (_request, reply) => {
    const entries = await listServableModels(await resolveRequestScope(undefined));
    return reply.send({
      models: entries
        .filter((entry) => entry.auto || entry.capabilities.length === 0 || entry.capabilities.includes('chat'))
        .map((entry) => ({
          id: entry.id,
          displayName: entry.displayName,
          provider: entry.provider,
          auto: entry.auto,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
        })),
    });
  });

  // A call spends provider capacity and money, so a viewer may inspect but cannot execute one.
  fastify.post('/admin/playground/run', adminWriteGuard, async (request, reply) => {
    const parsed = runSchema.safeParse(request.body);
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
        // Text is the only reachable part in Phase 1. Keeping part arrays in the admin contract
        // lets image, tool, and file members arrive later without moving existing conversations.
        content: item.content.map((part) => part.text).join('\n'),
      })),
      temperature: parsed.data.temperature,
      max_tokens: parsed.data.maxTokens,
      stream: true,
    };

    await handleProxy(
      body,
      captured.reply,
      undefined,
      { ...request.headers, 'x-nexus-cache-bypass': '1' },
      undefined,
      trace,
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
