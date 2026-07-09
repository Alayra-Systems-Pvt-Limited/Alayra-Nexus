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

import { createHash } from 'crypto';
import { redis } from './redis';

// ── Cache-aware sticky routing ────────────────────────────────────────────────
// Multi-turn conversations are pinned to the key that last served them, so the
// upstream provider's prompt cache is reused across turns instead of being thrown
// away by LRU round-robin. The mapping lives in Redis with a short TTL that tracks
// provider prompt-cache lifetimes; a new or expired session simply falls back to
// normal tier/LRU selection.

// How long a session stays pinned to its last-successful key (seconds). Roughly
// matches provider prompt-cache windows — long enough to catch follow-up turns,
// short enough that an idle session releases its key.
export const STICKY_TTL_SECONDS = 300;

// Number of leading messages hashed to identify a conversation when the client
// does not pass an explicit session id. The system prompt + first user turn stay
// stable across a conversation, so they make a durable fingerprint.
const FINGERPRINT_MESSAGES = 2;

export function stickyRedisKey(hash: string): string { return `nexus:sticky:${hash}`; }

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('');
  }
  return '';
}

/**
 * Derive a stable session identity for a request. Prefers an explicit client
 * signal — the `x-nexus-session` header or the OpenAI `user` body field — and
 * otherwise fingerprints the first messages of the conversation. Returns null
 * when there is nothing to key on (e.g. an empty request), meaning "do not stick".
 */
export function sessionHash(
  body: { messages?: unknown[]; user?: unknown },
  headers: Record<string, unknown> = {},
): string | null {
  const headerId = headers['x-nexus-session'];
  if (typeof headerId === 'string' && headerId.trim()) {
    return createHash('sha256').update(`id:${headerId.trim()}`).digest('hex');
  }
  if (typeof body.user === 'string' && body.user.trim()) {
    return createHash('sha256').update(`user:${body.user.trim()}`).digest('hex');
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts: string[] = [];
  let hasContent = false;
  for (const m of messages.slice(0, FINGERPRINT_MESSAGES)) {
    if (m && typeof m === 'object') {
      const role = 'role' in m && typeof (m as { role: unknown }).role === 'string' ? (m as { role: string }).role : '';
      const text = extractText((m as { content?: unknown }).content);
      if (text.trim()) hasContent = true;
      parts.push(`${role}:${text}`);
    } else {
      parts.push('');
    }
  }

  if (!hasContent) return null;
  return createHash('sha256').update(`msg:${parts.join(' ')}`).digest('hex');
}

export async function getStickyKeyId(hash: string): Promise<string | null> {
  return redis.get(stickyRedisKey(hash));
}

export async function setStickyKeyId(hash: string, keyId: string): Promise<void> {
  await redis.set(stickyRedisKey(hash), keyId, 'EX', STICKY_TTL_SECONDS);
}
