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

import type { FastifyReply } from 'fastify';
import { anthropicErrorType, sseEvent } from '../../lib/anthropic';
import type { StreamFormat } from '../../lib/streamTally';
import { STREAM_IDLE_MS, STREAM_MAX_MS } from './config';

// ── Server-sent events ────────────────────────────────────────────────────────

/** Why a stream stopped before the provider said it was finished. */
export type CutReason = 'idle' | 'duration' | 'client';

/**
 * Take the response over from Fastify and open an event stream with the gateway's headers.
 * Shared by the streamed cache replay, buffered-safe guardrails, and the live stream.
 */
export function openEventStream(reply: FastifyReply, headers: Record<string, string>): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type':      'text/event-stream; charset=utf-8',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
    ...headers,
  });
}

/**
 * The frame that tells a caller their answer is incomplete.
 *
 * Without it a cut stream is indistinguishable from a finished one: the bytes simply stop, and the
 * last thing the reader saw was an ordinary token. Silence is the wrong answer here — a truncated
 * reply that looks whole is worse than an error, because it gets used.
 */
export function cutFrame(reason: Exclude<CutReason, 'client'>, format: StreamFormat = 'openai'): string {
  const message = reason === 'idle'
    ? `The provider sent nothing for ${Math.round(STREAM_IDLE_MS / 1000)}s, so this answer is incomplete.`
    : `This answer passed the ${Math.round(STREAM_MAX_MS / 60000)}-minute limit for one request and is incomplete.`;
  // Anthropic's own convention, for a stream relayed untouched: an `error` event, as Anthropic itself
  // sends when a stream fails part-way.
  if (format === 'anthropic') return sseEvent('error', { type: 'error', error: { type: anthropicErrorType(504), message } });
  // OpenAI's own mid-stream convention: an `error` object in the data frame, and no `[DONE]` —
  // a `[DONE]` after this would read to most clients as a clean finish.
  return `data: ${JSON.stringify({ error: { message, type: 'upstream_timeout', code: `stream_${reason}` } })}\n\n`;
}

/** Serialize one assistant message as a single OpenAI-style streaming chunk + DONE. */
export function toSingleSseChunk(data: Record<string, unknown>): string {
  const first  = Array.isArray(data.choices) ? data.choices[0] as { message?: { content?: unknown }; finish_reason?: string } : undefined;
  const content = first && typeof first.message?.content === 'string' ? first.message.content : '';
  const chunk = {
    id:      typeof data.id === 'string' ? data.id : `chatcmpl-${Date.now()}`,
    object:  'chat.completion.chunk',
    created: typeof data.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
    model:   typeof data.model === 'string' ? data.model : '',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: first?.finish_reason ?? 'stop' }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
