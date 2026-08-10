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

// ── Anthropic Messages ⇄ OpenAI chat-completions translation (Phase 6.2) ───────
// The gateway's core speaks OpenAI. This module is the edge adapter that lets an
// Anthropic Messages client (notably Claude Code) talk to it: an inbound request is
// translated to the canonical OpenAI shape, and the OpenAI response — streaming or
// not — is translated back. Nothing here routes, calls a provider, or touches state;
// it is pure so the fiddly parts (streaming event flow, tool calls) are unit-tested.

import { randomBytes } from 'crypto';

export const CANONICAL_MODEL = 'alayra-nexus-1';

type Json = Record<string, unknown>;

// ── Request: Anthropic → OpenAI ───────────────────────────────────────────────

/** Flatten Anthropic content (string, or an array of blocks) to plain text. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as Json).type === 'text')
    .map((b) => String((b as Json).text ?? ''))
    .join('');
}

/** Anthropic `system` is a top-level string or block array; OpenAI wants a message. */
function systemToMessage(system: unknown): Json | null {
  const text = textFromContent(system);
  return text ? { role: 'system', content: text } : null;
}

/**
 * Translate one Anthropic message to zero or more OpenAI messages. A user turn whose
 * content carries `tool_result` blocks becomes one OpenAI `tool` message per result;
 * an assistant turn carrying `tool_use` blocks becomes an assistant message with
 * `tool_calls`. Plain text passes straight through. Images become OpenAI image parts.
 */
function translateMessage(msg: Json): Json[] {
  const role = msg.role === 'assistant' ? 'assistant' : 'user';
  const content = msg.content;

  if (typeof content === 'string') return [{ role, content }];
  if (!Array.isArray(content)) return [{ role, content: '' }];

  const blocks = content as Json[];
  const out: Json[] = [];

  // tool_result blocks (only valid on a user turn) each map to their own tool message.
  const toolResults = blocks.filter((b) => b?.type === 'tool_result');
  for (const tr of toolResults) {
    out.push({ role: 'tool', tool_call_id: String(tr.tool_use_id ?? ''), content: textFromContent(tr.content) });
  }

  const toolUses = blocks.filter((b) => b?.type === 'tool_use');
  const textParts = blocks.filter((b) => b?.type === 'text');
  const imageParts = blocks.filter((b) => b?.type === 'image');

  if (role === 'assistant' && toolUses.length > 0) {
    const text = textParts.map((b) => String(b.text ?? '')).join('');
    out.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolUses.map((tu) => ({
        id: String(tu.id ?? ''),
        type: 'function',
        function: { name: String(tu.name ?? ''), arguments: JSON.stringify(tu.input ?? {}) },
      })),
    });
    return out;
  }

  if (imageParts.length > 0) {
    const parts: Json[] = textParts.map((b) => ({ type: 'text', text: String(b.text ?? '') }));
    for (const im of imageParts) {
      const src = (im.source ?? {}) as Json;
      const url = src.type === 'base64'
        ? `data:${String(src.media_type ?? 'image/png')};base64,${String(src.data ?? '')}`
        : String(src.url ?? '');
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
    out.push({ role, content: parts });
    return out;
  }

  // Plain text turn (the common case), unless it was purely tool_result blocks above.
  const text = textFromContent(content);
  if (text || out.length === 0) out.push({ role, content: text });
  return out;
}

/**
 * Translate an Anthropic Messages request body into an OpenAI chat-completions body.
 *
 * The model the client sent is CARRIED THROUGH, not overwritten. It used to be forced to
 * the canonical id here, which meant an Anthropic-SDK caller — Claude Code above all —
 * could never reach a specific model no matter what it asked for, and could not have
 * discovered one anyway, since `/v1/models` advertised a single virtual entry. Both halves
 * are fixed together: the listing now names the operator's real models, and this passes the
 * client's choice on to the same resolution the OpenAI path uses. An empty model still
 * means auto-route.
 */
export function anthropicToOpenAI(body: Json): Json {
  const messages: Json[] = [];
  const sys = systemToMessage(body.system);
  if (sys) messages.push(sys);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (m && typeof m === 'object') messages.push(...translateMessage(m as Json));
  }

  const requested = typeof body.model === 'string' ? body.model.trim() : '';
  const out: Json = { model: requested || CANONICAL_MODEL, messages, stream: body.stream === true };
  if (typeof body.max_tokens === 'number')  out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number')       out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  // tools: Anthropic {name, description, input_schema} → OpenAI {type:function, function:{...}}
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = (body.tools as Json[]).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object' } },
    }));
  }
  if (body.tool_choice) out.tool_choice = translateToolChoice(body.tool_choice as Json);
  return out;
}

function translateToolChoice(tc: Json): unknown {
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any')  return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

// ── Response: OpenAI → Anthropic (non-streaming) ──────────────────────────────

/** OpenAI finish_reason → Anthropic stop_reason. */
export function mapStopReason(finish: unknown): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' {
  switch (finish) {
    case 'length':       return 'max_tokens';
    case 'tool_calls':   return 'tool_use';
    case 'stop':         return 'end_turn';
    case 'content_filter': return 'end_turn';
    default:             return 'end_turn';
  }
}

export function newMessageId(): string { return `msg_${randomBytes(18).toString('hex')}`; }

/** Translate a full OpenAI chat.completion into an Anthropic Messages response. */
export function openAIToAnthropic(completion: Json, fallbackModel = CANONICAL_MODEL): Json {
  const choice  = (Array.isArray(completion.choices) ? completion.choices[0] : {}) as Json;
  const message = (choice.message ?? {}) as Json;
  const usage   = (completion.usage ?? {}) as Json;

  const content: Json[] = [];
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls as Json[] : []) {
    const fn = (tc.function ?? {}) as Json;
    let input: unknown;
    try { input = JSON.parse(String(fn.arguments ?? '{}')); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id ?? newMessageId(), name: fn.name ?? '', input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id:            typeof completion.id === 'string' ? completion.id : newMessageId(),
    type:          'message',
    role:          'assistant',
    model:         typeof completion.model === 'string' ? completion.model : fallbackModel,
    content,
    stop_reason:   mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens:  Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
    },
  };
}

// ── Errors ────────────────────────────────────────────────────────────────────

export function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 429: return 'rate_limit_error';
    case 529: return 'overloaded_error';
    default:  return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

export function anthropicErrorBody(status: number, message: string): Json {
  return { type: 'error', error: { type: anthropicErrorType(status), message } };
}

// ── One SSE event, Anthropic-framed ───────────────────────────────────────────
export function sseEvent(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── Streaming: OpenAI SSE → Anthropic SSE ─────────────────────────────────────
// A stateful translator, because the two formats disagree on structure, not just on
// field names. OpenAI streams flat `choices[].delta` chunks; Anthropic frames a
// message as a start event, then one *content block* per text run or tool call, each
// with its own start / delta / stop, then a message delta carrying the stop reason,
// then a stop. The translator opens and closes those blocks as the OpenAI deltas
// arrive, so the flow is emitted on the wire without ever buffering the response.
export class AnthropicStreamTranslator {
  private buffer = '';
  private started = false;
  private textIndex = -1;          // Anthropic index of the open text block, or -1
  private nextIndex = 0;           // next content-block index to assign
  private toolBlocks = new Map<number, number>(); // OpenAI tool_call index → Anthropic block index
  private stopReason: string | null = null;
  private outputTokens = 0;
  private inputTokens = 0;
  private model: string;
  private id: string;

  constructor(model = CANONICAL_MODEL) {
    this.model = model;
    this.id = newMessageId();
  }

  /**
   * Name the model Nexus routed to, as a better default than the canonical id.
   *
   * `begin()` prefers the model the upstream names in its own first chunk, which is the
   * most accurate answer available — a provider often returns a dated variant
   * (`gpt-4o-2024-08-06`) that Nexus has no way to know. This only fills the gap when a
   * provider omits `model` from its SSE chunks, where the reply used to fall back to
   * `alayra-nexus-1` and tell a client that pinned a real model nothing about what served
   * it. Routing runs after the translator is constructed, so the value arrives here rather
   * than through the constructor — see anthropicReply, which reads it off the
   * `X-Nexus-Model` header written with the response head.
   *
   * An empty value is ignored, so a missing header leaves the name intact rather than
   * blanking it.
   */
  setModel(model: string): void {
    if (model) this.model = model;
  }

  /** Feed raw bytes from the OpenAI SSE stream; return Anthropic SSE bytes to write. */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    // Process only complete lines; a partial trailing line stays buffered.
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith('data:')) out += this.consume(line.slice(5).trim());
    }
    return out;
  }

  private consume(payload: string): string {
    if (!payload || payload === '[DONE]') return '';
    let chunk: Json;
    try { chunk = JSON.parse(payload) as Json; } catch { return ''; }

    let out = '';
    if (!this.started) out += this.begin(chunk);

    const usage = chunk.usage as Json | undefined;
    if (usage) {
      this.inputTokens  = Number(usage.prompt_tokens ?? this.inputTokens);
      this.outputTokens = Number(usage.completion_tokens ?? this.outputTokens);
    }

    const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as Json | undefined;
    if (!choice) return out;
    const delta = (choice.delta ?? {}) as Json;

    // Text run.
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (this.textIndex === -1) {
        this.textIndex = this.nextIndex++;
        out += sseEvent('content_block_start', { type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } });
      }
      out += sseEvent('content_block_delta', { type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text: delta.content } });
    }

    // Tool calls. Each OpenAI tool_call index becomes its own Anthropic tool_use block.
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls as Json[] : []) {
      const oaiIdx = Number(tc.index ?? 0);
      const fn = (tc.function ?? {}) as Json;
      if (!this.toolBlocks.has(oaiIdx)) {
        // A tool call ends any open text block first.
        if (this.textIndex !== -1) { out += sseEvent('content_block_stop', { type: 'content_block_stop', index: this.textIndex }); this.textIndex = -1; }
        const idx = this.nextIndex++;
        this.toolBlocks.set(oaiIdx, idx);
        out += sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id ?? newMessageId(), name: fn.name ?? '', input: {} } });
      }
      if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
        out += sseEvent('content_block_delta', { type: 'content_block_delta', index: this.toolBlocks.get(oaiIdx)!, delta: { type: 'input_json_delta', partial_json: fn.arguments } });
      }
    }

    if (choice.finish_reason) this.stopReason = mapStopReason(choice.finish_reason);
    return out;
  }

  private begin(chunk: Json): string {
    this.started = true;
    if (typeof chunk.model === 'string') this.model = chunk.model;
    return sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.id, type: 'message', role: 'assistant', model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  /** Flush the terminal events. Idempotent-safe: always closes what it opened. */
  end(): string {
    let out = '';
    if (!this.started) {
      // An empty stream still needs a well-formed message envelope.
      out += this.begin({});
      out += sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      out += sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
    } else {
      if (this.textIndex !== -1) { out += sseEvent('content_block_stop', { type: 'content_block_stop', index: this.textIndex }); this.textIndex = -1; }
      for (const idx of this.toolBlocks.values()) out += sseEvent('content_block_stop', { type: 'content_block_stop', index: idx });
      this.toolBlocks.clear();
    }
    out += sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: this.stopReason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: this.outputTokens } });
    out += sseEvent('message_stop', { type: 'message_stop' });
    return out;
  }
}
