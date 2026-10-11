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

// ── Chat proxy limits ─────────────────────────────────────────────────────────
// Read once, when the proxy is first imported, exactly as they were when they lived at the top of
// completionsProxy.service — tests that tighten them set the environment before that import.

// Output tokens to reserve when the caller does not set max_tokens. Reconciliation
// corrects the reservation to real usage once the response completes.
export const DEFAULT_MAX_TOKENS_RESERVE = parseInt(process.env.NEXUS_DEFAULT_MAX_TOKENS ?? '2048', 10);
// Time to first byte: upstream must return response headers within this window.
export const UPSTREAM_TTFT_MS = parseInt(process.env.UPSTREAM_TTFT_MS ?? '20000', 10);
// Non-streaming: full response body must be read within this window.
export const UPSTREAM_BODY_MS = parseInt(process.env.UPSTREAM_BODY_MS ?? '60000', 10);
// Streaming: maximum gap allowed between two chunks (an idle/hung stream is aborted;
// legitimate long streams keep running as long as chunks keep arriving).
export const STREAM_IDLE_MS   = parseInt(process.env.UPSTREAM_STREAM_IDLE_MS ?? '30000', 10);
// Streaming: the ceiling on one whole request. The idle guard restarts on every chunk, so it
// bounds silence and nothing else — an upstream dripping one byte every 29 seconds holds a
// connection, a slot and a token reservation for as long as it cares to. Ten minutes clears the
// slowest legitimate case (a reasoning model on a very long answer) with room to spare; past that
// a request is not slow, it is stuck.
export const STREAM_MAX_MS    = parseInt(process.env.UPSTREAM_STREAM_MAX_MS ?? '600000', 10);
