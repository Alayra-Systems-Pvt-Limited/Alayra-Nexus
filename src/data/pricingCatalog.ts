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

import type { Capability } from '../lib/modelSelect';

// ── Pricing catalog (Phase 7.4c) ──────────────────────────────────────────────
// A curated, bundled starting reference so an operator can auto-fill a model's price and limits
// instead of typing them by hand — the same idea as LiteLLM's price map, but shipped in-repo so it
// works air-gapped (no network lookup). Prices are USD and INDICATIVE: providers change them, so the
// auto-fill pre-fills the editor and the operator confirms/overrides before saving. `match` is a
// prefix, so a dated variant (claude-3-5-sonnet-20241022) inherits its base entry; the longest
// matching prefix wins. All token prices are per 1,000,000 tokens.

export interface PricingCatalogEntry {
  match:                  string;      // exact model string or a prefix
  provider:               string;
  displayName:            string;
  capabilities:           Capability[];
  inputCostPer1M?:        number;
  outputCostPer1M?:       number;
  imagePrice?:            number;
  speechPricePer1MChars?: number;
  transcriptionPrice?:    number;
  audioInputPer1M?:       number;
  audioOutputPer1M?:      number;
  contextWindow?:         number;
  maxTokens?:             number;
  hasVision?:             boolean;
  hasToolCalling?:        boolean;
}

export const PRICING_CATALOG: PricingCatalogEntry[] = [
  // ── OpenAI ──
  { match: 'gpt-4o-mini', provider: 'openai', displayName: 'GPT-4o mini', capabilities: ['chat'], inputCostPer1M: 0.15, outputCostPer1M: 0.6, contextWindow: 128000, maxTokens: 16384, hasVision: true, hasToolCalling: true },
  { match: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o', capabilities: ['chat'], inputCostPer1M: 2.5, outputCostPer1M: 10, contextWindow: 128000, maxTokens: 16384, hasVision: true, hasToolCalling: true },
  { match: 'gpt-4.1-mini', provider: 'openai', displayName: 'GPT-4.1 mini', capabilities: ['chat'], inputCostPer1M: 0.4, outputCostPer1M: 1.6, contextWindow: 1000000, maxTokens: 32768, hasVision: true, hasToolCalling: true },
  { match: 'gpt-4.1', provider: 'openai', displayName: 'GPT-4.1', capabilities: ['chat'], inputCostPer1M: 2, outputCostPer1M: 8, contextWindow: 1000000, maxTokens: 32768, hasVision: true, hasToolCalling: true },
  { match: 'o3-mini', provider: 'openai', displayName: 'o3-mini', capabilities: ['chat'], inputCostPer1M: 1.1, outputCostPer1M: 4.4, contextWindow: 200000, maxTokens: 100000, hasToolCalling: true },
  { match: 'gpt-4o-realtime', provider: 'openai', displayName: 'GPT-4o Realtime', capabilities: ['chat', 'speech'], inputCostPer1M: 5, outputCostPer1M: 20, audioInputPer1M: 40, audioOutputPer1M: 80, contextWindow: 128000, maxTokens: 4096, hasToolCalling: true },
  { match: 'text-embedding-3-large', provider: 'openai', displayName: 'Embedding 3 large', capabilities: ['embedding'], inputCostPer1M: 0.13, contextWindow: 8191 },
  { match: 'text-embedding-3-small', provider: 'openai', displayName: 'Embedding 3 small', capabilities: ['embedding'], inputCostPer1M: 0.02, contextWindow: 8191 },
  { match: 'tts-1-hd', provider: 'openai', displayName: 'TTS-1 HD', capabilities: ['speech'], speechPricePer1MChars: 30 },
  { match: 'tts-1', provider: 'openai', displayName: 'TTS-1', capabilities: ['speech'], speechPricePer1MChars: 15 },
  { match: 'whisper-1', provider: 'openai', displayName: 'Whisper', capabilities: ['transcription'], transcriptionPrice: 0.006 },

  // ── Anthropic ──
  { match: 'claude-opus-4', provider: 'anthropic', displayName: 'Claude Opus 4', capabilities: ['chat'], inputCostPer1M: 15, outputCostPer1M: 75, contextWindow: 200000, maxTokens: 32000, hasVision: true, hasToolCalling: true },
  { match: 'claude-sonnet-4', provider: 'anthropic', displayName: 'Claude Sonnet 4', capabilities: ['chat'], inputCostPer1M: 3, outputCostPer1M: 15, contextWindow: 200000, maxTokens: 64000, hasVision: true, hasToolCalling: true },
  { match: 'claude-3-5-sonnet', provider: 'anthropic', displayName: 'Claude 3.5 Sonnet', capabilities: ['chat'], inputCostPer1M: 3, outputCostPer1M: 15, contextWindow: 200000, maxTokens: 8192, hasVision: true, hasToolCalling: true },
  { match: 'claude-3-5-haiku', provider: 'anthropic', displayName: 'Claude 3.5 Haiku', capabilities: ['chat'], inputCostPer1M: 0.8, outputCostPer1M: 4, contextWindow: 200000, maxTokens: 8192, hasToolCalling: true },
  { match: 'claude-3-haiku', provider: 'anthropic', displayName: 'Claude 3 Haiku', capabilities: ['chat'], inputCostPer1M: 0.25, outputCostPer1M: 1.25, contextWindow: 200000, maxTokens: 4096, hasVision: true },

  // ── Google ──
  // Google's OpenAI-compatible /models lists ids like `gemini-flash-lite-latest` alongside the
  // dated ones, and its response carries no pricing at all — so the alias entries below are the
  // only way a Google model gets a price without the operator typing one.
  { match: 'gemini-2.5-pro', provider: 'google', displayName: 'Gemini 2.5 Pro', capabilities: ['chat'], inputCostPer1M: 1.25, outputCostPer1M: 10, contextWindow: 1048576, maxTokens: 65536, hasVision: true, hasToolCalling: true },
  { match: 'gemini-2.5-flash-lite', provider: 'google', displayName: 'Gemini 2.5 Flash-Lite', capabilities: ['chat'], inputCostPer1M: 0.1, outputCostPer1M: 0.4, contextWindow: 1048576, maxTokens: 65536, hasVision: true, hasToolCalling: true },
  { match: 'gemini-2.5-flash', provider: 'google', displayName: 'Gemini 2.5 Flash', capabilities: ['chat'], inputCostPer1M: 0.3, outputCostPer1M: 2.5, contextWindow: 1048576, maxTokens: 65536, hasVision: true, hasToolCalling: true },
  { match: 'gemini-flash-lite-latest', provider: 'google', displayName: 'Gemini Flash-Lite (latest)', capabilities: ['chat'], inputCostPer1M: 0.1, outputCostPer1M: 0.4, contextWindow: 1048576, maxTokens: 65536, hasVision: true, hasToolCalling: true },
  { match: 'gemini-flash-latest', provider: 'google', displayName: 'Gemini Flash (latest)', capabilities: ['chat'], inputCostPer1M: 0.3, outputCostPer1M: 2.5, contextWindow: 1048576, maxTokens: 65536, hasVision: true, hasToolCalling: true },
  { match: 'gemini-2.0-flash', provider: 'google', displayName: 'Gemini 2.0 Flash', capabilities: ['chat'], inputCostPer1M: 0.1, outputCostPer1M: 0.4, contextWindow: 1000000, maxTokens: 8192, hasVision: true, hasToolCalling: true },
  { match: 'gemini-1.5-pro', provider: 'google', displayName: 'Gemini 1.5 Pro', capabilities: ['chat'], inputCostPer1M: 1.25, outputCostPer1M: 5, contextWindow: 2000000, maxTokens: 8192, hasVision: true, hasToolCalling: true },
  { match: 'gemini-1.5-flash', provider: 'google', displayName: 'Gemini 1.5 Flash', capabilities: ['chat'], inputCostPer1M: 0.075, outputCostPer1M: 0.3, contextWindow: 1000000, maxTokens: 8192, hasVision: true },

  // ── Groq ──
  // Groq publishes per-model pricing in its own /models response, so a pool fetched through the
  // dashboard is priced from the provider itself and never reaches these entries. They are the
  // fallback for a model added by hand.
  { match: 'llama-3.3-70b', provider: 'groq', displayName: 'Llama 3.3 70B', capabilities: ['chat'], inputCostPer1M: 0.59, outputCostPer1M: 0.79, contextWindow: 128000, maxTokens: 32768, hasToolCalling: true },
  { match: 'llama-3.1-8b', provider: 'groq', displayName: 'Llama 3.1 8B', capabilities: ['chat'], inputCostPer1M: 0.05, outputCostPer1M: 0.08, contextWindow: 128000, maxTokens: 8192 },

  // ── Mistral ──
  { match: 'mistral-large', provider: 'mistral', displayName: 'Mistral Large', capabilities: ['chat'], inputCostPer1M: 2, outputCostPer1M: 6, contextWindow: 128000, maxTokens: 8192, hasToolCalling: true },
  { match: 'mistral-small', provider: 'mistral', displayName: 'Mistral Small', capabilities: ['chat'], inputCostPer1M: 0.1, outputCostPer1M: 0.3, contextWindow: 128000, maxTokens: 8192, hasToolCalling: true },
  { match: 'ministral-8b', provider: 'mistral', displayName: 'Ministral 8B', capabilities: ['chat'], inputCostPer1M: 0.1, outputCostPer1M: 0.1, contextWindow: 128000, maxTokens: 8192 },
  { match: 'ministral-3b', provider: 'mistral', displayName: 'Ministral 3B', capabilities: ['chat'], inputCostPer1M: 0.04, outputCostPer1M: 0.04, contextWindow: 128000, maxTokens: 8192 },
  { match: 'open-mistral-7b', provider: 'mistral', displayName: 'Open Mistral 7B', capabilities: ['chat'], inputCostPer1M: 0.25, outputCostPer1M: 0.25, contextWindow: 32000, maxTokens: 8192 },
  { match: 'codestral', provider: 'mistral', displayName: 'Codestral', capabilities: ['chat', 'completion'], inputCostPer1M: 0.3, outputCostPer1M: 0.9, contextWindow: 256000, maxTokens: 8192 },
  { match: 'mistral-embed', provider: 'mistral', displayName: 'Mistral Embed', capabilities: ['embedding'], inputCostPer1M: 0.1, contextWindow: 8000 },
];

// Providers deliberately absent, and why. Adding a plausible-looking number here would put a
// figure on an invoice-facing screen that nobody has verified, which is worse than an empty field
// the operator is prompted to fill:
//
//   openrouter  — publishes exact per-model pricing in its /models response. Harvested, always
//                 authoritative, and per-model prices differ from the upstream vendor's own.
//   huggingface — the router dispatches to a third-party inference provider (Fireworks, Together,
//                 …) whose price is not knowable from the model id.
//   cloudflare  — bills in "neurons", not tokens. A token price would be a category error.
//   cerebras    — publishes no pricing and we have no verified figures.
//
// For all of these, a model with no harvested price stays `pricingSource: 'unset'` and is surfaced
// as unpriced rather than quietly guessed at.
