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

// The model registry as this process reads it, and the lists every request derives from it.
//
// ── Parsed when it changes, not whenever it is read ───────────────────────────────────────────
//
// The registry is one JSON document. A deployment that discovers models from OpenRouter-style
// providers holds thousands of entries in it, and every few seconds each process used to read it,
// parse it and normalise every entry again: about 15 ms of parsing alone at 5,000 models, on the
// request that happened to find the memo expired, for a document that had not changed.
//
// So the text read last time is kept beside what it parsed to, and a read that returns the same
// text returns the same models. Comparing two strings of that size costs well under a millisecond
// (hashing them costs more than that, and still needs the text in memory first). The price is the
// last text held in memory, about 2 MB at 5,000 models.
//
// Reusing the parse also keeps the registry the SAME array until it really changes, which is what
// lets the lists below be built once per version rather than once per request.
//
// ── Built once per registry version ───────────────────────────────────────────────────────────
//
// Routing and the model listing derive lists from the registry on every request: the models a
// caller can be routed to, their catalogue entries, each model's price. Each is a pass over the
// whole registry. They are kept per registry array (a WeakMap, so a replaced registry takes its
// lists with it) and, where they also depend on which providers have a pool, per that set too. A
// list is never older than the registry and pools it is handed: it is looked up by them.
//
// Nothing returned from here may be modified by the caller. Every caller filters, maps or reads.

import type { AiModel } from './model.service';
import type { CatalogEntry } from './modelCatalog.service';
import { redis } from '../lib/redis';
import { REGISTRY_CACHE_KEY } from '../lib/registryCacheKey';
import { effectivePrice } from '../lib/routing';
import { readSettingFresh } from './settings.service';

/** The setting the registry is stored in. */
const REGISTRY_SETTING = 'AI_MODEL_REGISTRY';

/** The shared copy's lifetime in Redis: a backstop for writes that bypass the update path. */
const SHARED_COPY_TTL_SECONDS = 60;

/** One stored entry made into a well-formed model (model.service's `normalizeModel`). */
type Normalize = (raw: Record<string, unknown>) => AiModel;

/** The last text parsed from one source, and what it parsed to. */
class LastParse<T> {
  private last: { text: string; value: T } | null = null;

  /** `parse(text)`, or the earlier result when `text` is exactly the text parsed last time. */
  read(text: string, parse: (text: string) => T): T {
    if (this.last !== null && this.last.text === text) return this.last.value;
    const value = parse(text);
    this.last = { text, value };
    return value;
  }

  /** Record what `text` parses to, when this process has just produced both. */
  remember(text: string, value: T): void {
    this.last = { text, value };
  }
}

/** The shared copy in Redis: already-normalised models, written by whichever process built it. */
const sharedCopy = new LastParse<AiModel[] | null>();
/** The stored setting, and the shared copy built from it. */
const storedCopy = new LastParse<{ models: AiModel[]; text: string }>();

function parseShared(text: string, normalize: Normalize): AiModel[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    // Normalised here too, not just on the setting path. The shared copy is whatever some process
    // serialised earlier — including one running the PREVIOUS release, which knew nothing about
    // fields added since. Returned raw, a pre-upgrade copy has no `pricingSource`, so unpriced
    // models would be treated as free by cost routing until the copy expired.
    return Array.isArray(parsed) ? parsed.map((m) => normalize(m as Record<string, unknown>)) : null;
  } catch {
    return null;
  }
}

function parseStored(text: string, normalize: Normalize): { models: AiModel[]; text: string } {
  // The registry starts empty and is populated from the operator's pools on first boot (see
  // reconcilePoolsToRegistry). Shipping phantom default models would route requests to providers
  // the operator never configured.
  let stored: unknown[] = [];
  if (text && text !== '[]') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) stored = parsed;
    } catch { /* an unreadable registry is an empty one */ }
  }
  const models = stored.map((m) => normalize(m as Record<string, unknown>));
  return { models, text: JSON.stringify(models) };
}

/**
 * Read the registry: the shared copy, else the stored setting (which then refills the shared copy).
 *
 * The setting is read past the settings memo on purpose (see `readSettingFresh`): what is built
 * here becomes the copy every instance reads, so it must come from the shared value, not from
 * whatever this process last remembered of it. For the same reason the refill is skipped once
 * `current()` says a local registry update overtook this read, and never replaces a copy that is
 * already there: either would put the registry from before the update back for a minute.
 */
export async function loadRegistry(normalize: Normalize, current: () => boolean = () => true): Promise<AiModel[]> {
  const cached = await redis.get(REGISTRY_CACHE_KEY);
  if (cached) {
    const models = sharedCopy.read(cached, (text) => parseShared(text, normalize));
    if (models !== null) return models;
  }

  const raw = await readSettingFresh(REGISTRY_SETTING);
  const built = storedCopy.read(raw ?? '', (text) => parseStored(text, normalize));
  if (current()) await redis.set(REGISTRY_CACHE_KEY, built.text, 'EX', SHARED_COPY_TTL_SECONDS, 'NX');
  // The next read of the shared copy returns exactly this text: no need to parse it back.
  sharedCopy.remember(built.text, built.models);
  return built.models;
}

// ── Lists derived from one registry version ──────────────────────────────────────────────────

/** Registry models a caller may be routed to, and the same models as catalogue entries. */
export interface ServableSnapshot {
  /** Active models whose provider has a pool, in registry order. */
  models: readonly AiModel[];
  /** `models`, one entry each, in the same order. */
  entries: readonly CatalogEntry[];
}

interface Derived {
  prices?: ReadonlyMap<string, number | null>;
  servable?: { pools: string; snapshot: ServableSnapshot };
}

const derived = new WeakMap<readonly AiModel[], Derived>();

function derivedFrom(registry: readonly AiModel[]): Derived {
  let found = derived.get(registry);
  if (found === undefined) {
    found = {};
    derived.set(registry, found);
  }
  return found;
}

/** Each model's effective price (lib/routing `effectivePrice`), by id; built once per registry. */
export function registryPrices(registry: readonly AiModel[]): ReadonlyMap<string, number | null> {
  const from = derivedFrom(registry);
  if (from.prices === undefined) {
    const prices = new Map<string, number | null>();
    for (const m of registry) prices.set(m.id, effectivePrice(m as unknown as Record<string, unknown>));
    from.prices = prices;
  }
  return from.prices;
}

/**
 * The active models of `registry` whose provider is in `pooled`, with their catalogue entries.
 *
 * Built once per registry and set of pooled providers. The set is compared by content, not by
 * identity, so a pool added or removed rebuilds it on the very next call.
 */
export function servableSnapshot(
  registry: readonly AiModel[],
  pooled: ReadonlySet<string>,
  toEntry: (model: AiModel) => CatalogEntry,
): ServableSnapshot {
  const from = derivedFrom(registry);
  const pools = JSON.stringify([...pooled].sort());
  if (from.servable?.pools !== pools) {
    const models = registry.filter((m) => m.status === 'active' && pooled.has(m.provider));
    from.servable = { pools, snapshot: { models, entries: models.map(toEntry) } };
  }
  return from.servable.snapshot;
}
