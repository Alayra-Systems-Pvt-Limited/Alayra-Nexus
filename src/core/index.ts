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

// ── The gateway core's public surface (P0.5a) ─────────────────────────────────────────────────
// Everything a host needs to serve the OpenAI- and Anthropic-compatible API with its own storage:
// the storage ports, the caller context, and the request handlers. These are the same handlers the
// open-source server's routes call; this list becomes the `@alayrasystems/nexus-core` entry.
//
// `npm run check:core-boundary` walks every runtime import reachable from this file and fails if
// one reaches a database client, a host adapter, a route or the server. It is an entry for hosts;
// modules inside src/ import what they need from its source files directly.

// ── Storage: the ports a host implements, and where it installs them ──
export type {
  CoreStores,
  KeyStore, KeyRow, KeyAlertFacts, KeyStateRow, KeyCheck,
  ProviderStore, ProviderRow, PreferredModelPool, ProviderCheckRow, ProviderCheck,
  UsageStore, UsageRow,
  SettingsStore,
  NotificationSink, NotificationRow,
} from './ports';
export { configureCoreStores, coreStores, type CoreStoresLoader } from './stores';

// ── Who is calling: resolved by the host, never by the core ──
export type { TeamContext, CallerContext } from './context';

// ── Chat completions (OpenAI shape) ──
export {
  handleProxy, ProxyError, withProviderStreamUsage,
  type CompletionsBody, type ProxyRunOptions,
} from '../services/completionsProxy.service';

// ── Embeddings, images, speech and transcription ──
export {
  dispatchProxy, extractTokenUsage,
  embeddingReserve, completionReserve, imageReserve, imageQuantity, speechReserve, speechCharacters,
  type BillingSpec, type DispatchOptions,
} from '../services/proxyDispatch.service';

// ── Anthropic Messages API, translated onto the same pipeline ──
export { anthropicToOpenAI } from '../lib/anthropic';
export { createAnthropicReply } from '../lib/anthropicReply';

// ── Model listing and the caller's routing scope ──
export { listServableModels } from '../services/modelCatalog.service';
export { resolveRequestScope } from '../services/byok.service';
