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
import type { RequestTrace } from '../lib/requestTrace';
import { anthropicToOpenAI } from '../lib/anthropic';
import { createAnthropicReply } from '../lib/anthropicReply';
import { handleProxy, type CompletionsBody, type TeamContext } from './completionsProxy.service';
import { pickNativeHeaders } from './proxy/anthropicNative';

/**
 * Serve one Anthropic Messages request (`POST /v1/messages`).
 *
 * The request runs through the same pipeline as `/v1/chat/completions`, in its translated form, and a
 * reply wrapper translates the answer back. When routing lands on Anthropic itself, the caller's own
 * request goes there instead and the answer is relayed untouched, so prompt caching, thinking,
 * documents and server tools keep working (see proxy/anthropicNative.ts). One entry point, so every
 * host serving `/v1/messages` gets both behaviours the same way.
 */
export async function handleAnthropicMessages(
  body: Record<string, unknown>,
  reply: FastifyReply,
  teamKeyId?: string,
  reqHeaders: Record<string, unknown> = {},
  team?: TeamContext,
  trace?: RequestTrace,
): Promise<FastifyReply | void> {
  const translated = anthropicToOpenAI(body) as unknown as CompletionsBody;
  const { reply: anthropicReply, passThrough } = createAnthropicReply(reply);
  return handleProxy(translated, anthropicReply, teamKeyId, reqHeaders, team, trace, {
    anthropicNative: { body, headers: pickNativeHeaders(reqHeaders), passThrough },
  });
}
