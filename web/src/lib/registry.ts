import { GET, PUT, DEL, type AiModel } from '../api';

// The "Fetch Models feeds the registry" bridge (P7.4b). Model selection now happens inside Nexus,
// per provider, but routing still runs off the rich global registry — so adding/removing a model
// here reads the current registry, edits it, and writes the whole thing back through the validated
// PUT /admin/models. Kept out of api.ts because it composes two calls with real merge logic.

const sanitizeId = (provider: string, modelString: string) =>
  `${provider}-${modelString}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

/** Every registry model that belongs to a provider slug. */
export function modelsForProvider(models: AiModel[], provider: string): AiModel[] {
  return models.filter((m) => m.provider === provider);
}

/** What the picker hands over per selected model: the string plus any harvested metadata. */
export interface RegistryModelInput {
  modelString: string;
  displayName?: string;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  contextWindow?: number;
}

/** A harvested value may refresh a stored one only when it is real (defined, > 0) and actually
 *  different — so a provider that publishes no pricing can never zero out prices the operator set
 *  by hand or via the catalog auto-fill. */
const priceWins = (incoming: number | undefined, stored: number): incoming is number =>
  incoming !== undefined && incoming > 0 && incoming !== stored;

/**
 * Merge the chosen models into the registry under a provider. New entries (matched on
 * provider + modelString) default to chat capability and the pool's tier, carrying any harvested
 * pricing/context. Entries already present get ONLY their pricing/context refreshed, and only by
 * real values — tier, status, capabilities and display name stay operator-owned. A no-op (no PUT)
 * when nothing is new and nothing changed.
 */
export async function addModelsToRegistry(
  provider: string, tier: string, inputs: RegistryModelInput[],
): Promise<{ added: number; updated: number }> {
  const { models } = await GET<{ models: AiModel[] }>('/admin/models');
  const mine = new Map(models.filter((m) => m.provider === provider).map((m) => [m.modelString, m]));
  const existingIds = new Set(models.map((m) => m.id));

  const additions: Partial<AiModel>[] = [];
  let updated = 0;
  for (const input of inputs) {
    const modelString = input.modelString.trim();
    if (!modelString) continue;

    const existing = mine.get(modelString);
    if (existing) {
      let changed = false;
      if (priceWins(input.inputCostPer1M, existing.inputCostPer1M))  { existing.inputCostPer1M  = input.inputCostPer1M;  changed = true; }
      if (priceWins(input.outputCostPer1M, existing.outputCostPer1M)) { existing.outputCostPer1M = input.outputCostPer1M; changed = true; }
      if (priceWins(input.contextWindow, existing.contextWindow))     { existing.contextWindow   = input.contextWindow;   changed = true; }
      if (changed) updated += 1;
      continue;
    }

    // Disambiguate an id collision with an incrementing suffix (-2, -3, …) rather than repeatedly
    // appending "-2", which would only ever grow the string into "…-2-2-2".
    const baseId = sanitizeId(provider, modelString);
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) { id = `${baseId}-${suffix}`; suffix += 1; }
    existingIds.add(id);
    const entry: Partial<AiModel> = {
      id, provider: provider as AiModel['provider'], modelString,
      displayName: input.displayName?.trim() || modelString,
      tier, status: 'active', capabilities: ['chat'],
    };
    if (input.inputCostPer1M !== undefined)  entry.inputCostPer1M  = input.inputCostPer1M;
    if (input.outputCostPer1M !== undefined) entry.outputCostPer1M = input.outputCostPer1M;
    if (input.contextWindow !== undefined)   entry.contextWindow   = input.contextWindow;
    additions.push(entry);
    mine.set(modelString, entry as AiModel);
  }

  if (additions.length === 0 && updated === 0) return { added: 0, updated: 0 };
  await PUT('/admin/models', { models: [...models, ...additions] });
  return { added: additions.length, updated };
}

/** Remove one model from the registry. Goes through the dedicated DELETE so the audit trail records
 *  a deletion as `models.delete` rather than the `models.update` a whole-registry PUT produced. */
export async function removeModelFromRegistry(id: string): Promise<void> {
  await DEL(`/admin/models/${encodeURIComponent(id)}`);
}

/** Replace one model (matched by id) with an edited copy, writing the registry back. */
export async function updateModelInRegistry(edited: AiModel): Promise<void> {
  const { models } = await GET<{ models: AiModel[] }>('/admin/models');
  await PUT('/admin/models', { models: models.map((m) => (m.id === edited.id ? edited : m)) });
}
