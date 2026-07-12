import { GET, PUT, type AiModel } from '../api';

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

/**
 * Add the chosen model strings to the registry under a provider, skipping any already present
 * (matched on provider + modelString). New entries default to chat capability and the pool's tier;
 * capabilities and pricing stay editable afterwards. A no-op (no PUT) when nothing is new.
 */
export async function addModelsToRegistry(provider: string, tier: string, modelStrings: string[]): Promise<number> {
  const { models } = await GET<{ models: AiModel[] }>('/admin/models');
  const have = new Set(models.filter((m) => m.provider === provider).map((m) => m.modelString));
  const existingIds = new Set(models.map((m) => m.id));

  const additions: Partial<AiModel>[] = [];
  for (const raw of modelStrings) {
    const modelString = raw.trim();
    if (!modelString || have.has(modelString)) continue;
    have.add(modelString);
    let id = sanitizeId(provider, modelString);
    while (existingIds.has(id)) id = `${id}-2`;
    existingIds.add(id);
    additions.push({ id, provider: provider as AiModel['provider'], modelString, displayName: modelString, tier, status: 'active', capabilities: ['chat'] });
  }

  if (additions.length === 0) return 0;
  await PUT('/admin/models', { models: [...models, ...additions] });
  return additions.length;
}

/** Remove one model from the registry by its id, writing the trimmed registry back. */
export async function removeModelFromRegistry(id: string): Promise<void> {
  const { models } = await GET<{ models: AiModel[] }>('/admin/models');
  await PUT('/admin/models', { models: models.filter((m) => m.id !== id) });
}
