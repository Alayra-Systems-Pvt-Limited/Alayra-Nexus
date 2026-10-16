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

// ── What a native Anthropic request may send, checked field by field ──────────────────────────
//
// The input guardrails scan the translated messages, the same as on the translated path. So with
// guardrails on, the native path may send only what that path also sends: text and the text of tool
// results, which the scan reads, and tool calls, images and custom tool definitions, which the
// translated path forwards unscanned today. The check reads every field, not only the block types: a
// text block's citations, an image held as a file, a structured-output schema or a field added to a
// block later never reach the translated path, so none of them may leave natively unscanned either.
// Anything else keeps the request on the translated path.
//
// Separately, on a shared key, a block that names a file or a container upload refers to the key's
// organisation, not the caller's, and also keeps the request on the translated path, which drops it.

type Block = Record<string, unknown>;

const isBlock = (b: unknown): b is Block => !!b && typeof b === 'object' && !Array.isArray(b);
const fields = (...names: string[]): ReadonlySet<string> => new Set(names);
/** Every key of `b` is one of `allowed`. */
const only = (b: Block, allowed: ReadonlySet<string>): boolean => Object.keys(b).every((k) => allowed.has(k));

const TEXT        = fields('type', 'text', 'cache_control');
const TOOL_USE    = fields('type', 'id', 'name', 'input', 'cache_control');
const TOOL_RESULT = fields('type', 'tool_use_id', 'content', 'is_error', 'cache_control');
const IMAGE       = fields('type', 'source', 'cache_control');
/** The two image sources the translated path forwards; a file id is dropped there. */
const IMAGE_SOURCE = new Map<unknown, ReadonlySet<string>>([
  ['base64', fields('type', 'media_type', 'data')],
  ['url',    fields('type', 'url')],
]);
const MESSAGE     = fields('role', 'content');
const CUSTOM_TOOL = fields('type', 'name', 'description', 'input_schema', 'cache_control');
const METADATA    = fields('user_id');
/** Effort is a setting; a `format` schema would be content the scan never reads. */
const OUTPUT      = fields('effort');

/**
 * Request fields the translated path forwards (the scanned messages and system prompt, tools, sampling
 * and stop settings), plus settings that carry no content of their own.
 */
const GUARDED_FIELDS = fields(
  'model', 'messages', 'system', 'max_tokens', 'stream', 'stop_sequences', 'temperature', 'top_p', 'tools', 'tool_choice',
  'top_k', 'thinking', 'metadata', 'cache_control', 'diagnostics', 'output_config',
);

const textBlock = (b: unknown): boolean => isBlock(b) && b.type === 'text' && only(b, TEXT);

const imageBlock = (b: unknown): boolean => {
  if (!isBlock(b) || b.type !== 'image' || !only(b, IMAGE) || !isBlock(b.source)) return false;
  const source = IMAGE_SOURCE.get(b.source.type);
  return source !== undefined && only(b.source, source);
};

/** A tool result whose content the scan reads whole: a string, or text blocks only. */
const toolResult = (b: unknown): boolean => isBlock(b) && b.type === 'tool_result' && only(b, TOOL_RESULT)
  && (b.content === undefined || typeof b.content === 'string' || (Array.isArray(b.content) && b.content.every(textBlock)));

const blockSentToday = (b: unknown): boolean =>
  textBlock(b) || imageBlock(b) || toolResult(b) || (isBlock(b) && b.type === 'tool_use' && only(b, TOOL_USE));

const messageSentToday = (m: unknown): boolean => isBlock(m) && only(m, MESSAGE)
  && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every(blockSentToday)));

const customTool = (t: unknown): boolean => isBlock(t) && (t.type === undefined || t.type === 'custom') && only(t, CUSTOM_TOOL);

const optional = (v: unknown, ok: (v: unknown) => boolean): boolean => v === undefined || ok(v);

/** True when every part of the body is either scanned or already forwarded unscanned today. */
export function sentWholeToday(body: Block): boolean {
  if (!only(body, GUARDED_FIELDS)) return false;
  const system = (v: unknown) => typeof v === 'string' || (Array.isArray(v) && v.every(textBlock));
  return Array.isArray(body.messages) && body.messages.every(messageSentToday)
    && optional(body.system, system)
    && optional(body.tools, (v) => Array.isArray(v) && v.every(customTool))
    && optional(body.metadata, (v) => isBlock(v) && only(v, METADATA))
    && optional(body.output_config, (v) => isBlock(v) && only(v, OUTPUT));
}

/** A block, or a block nested in it, that names a file or a container upload. */
const namesOrgFile = (b: unknown): boolean => isBlock(b) && (
  b.type === 'container_upload'
  || (isBlock(b.source) && (b.source.type === 'file' || (Array.isArray(b.source.content) && b.source.content.some(namesOrgFile))))
  || (Array.isArray(b.content) && b.content.some(namesOrgFile)));

/** True when a message refers to a file or container upload held by the key's organisation. */
export function referencesOrgFiles(body: Block): boolean {
  return Array.isArray(body.messages)
    && body.messages.some((m) => isBlock(m) && Array.isArray(m.content) && m.content.some(namesOrgFile));
}
