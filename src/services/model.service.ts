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

import { redis }                  from '../lib/redis';
import { getSetting, setSetting } from './settings.service';
import { REGISTRY_CACHE_KEY }    from '../lib/registryCacheKey';

export interface AiModel {
  id:                  string;
  displayName:         string;
  provider:            string;
  modelString:         string;
  status:              'active' | 'paused';
  isPrimary:           boolean;
  isFree:              boolean;
  priority:            number;
  supportsVision:      boolean;
  supportsToolCalling: boolean;
  contextWindow:       number;
  inputPricePer1k:     number;
  outputPricePer1k:    number;
}

export class ModelNotFoundError extends Error {
  constructor(id: string) { super(`Model not found: ${id}`); this.name = 'ModelNotFoundError'; }
}
export class ModelPausedError extends Error {
  constructor(id: string) { super(`Model paused: ${id}`); this.name = 'ModelPausedError'; }
}

const DEFAULT_REGISTRY: AiModel[] = [
  {
    id: 'gemini-2-flash', displayName: 'Gemini 2.0 Flash', provider: 'google',
    modelString: 'gemini-2.0-flash', status: 'active', isPrimary: true, isFree: true,
    priority: 1, supportsVision: true, supportsToolCalling: true,
    contextWindow: 1048576, inputPricePer1k: 0, outputPricePer1k: 0,
  },
  {
    id: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', provider: 'anthropic',
    modelString: 'claude-3-5-sonnet-20241022', status: 'active', isPrimary: false, isFree: false,
    priority: 5, supportsVision: true, supportsToolCalling: true,
    contextWindow: 200000, inputPricePer1k: 0.003, outputPricePer1k: 0.015,
  },
  {
    id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', provider: 'openai',
    modelString: 'gpt-4o-mini', status: 'active', isPrimary: false, isFree: false,
    priority: 3, supportsVision: true, supportsToolCalling: true,
    contextWindow: 128000, inputPricePer1k: 0.00015, outputPricePer1k: 0.0006,
  },
];

export async function getModelRegistry(): Promise<AiModel[]> {
  const cached = await redis.get(REGISTRY_CACHE_KEY);
  if (cached) { try { return JSON.parse(cached) as AiModel[]; } catch { /* fall through */ } }
  const raw = await getSetting('AI_MODEL_REGISTRY');
  let models: AiModel[] = DEFAULT_REGISTRY;
  if (raw && raw !== '[]') { try { models = JSON.parse(raw) as AiModel[]; } catch { /* use defaults */ } }
  await redis.set(REGISTRY_CACHE_KEY, JSON.stringify(models), 'EX', 60);
  return models;
}

export async function updateModelRegistry(models: AiModel[]): Promise<void> {
  await setSetting('AI_MODEL_REGISTRY', JSON.stringify(models));
  await redis.del(REGISTRY_CACHE_KEY);
}

export async function getModelById(id: string): Promise<AiModel> {
  const registry = await getModelRegistry();
  const model = registry.find(m => m.id === id || m.modelString === id);
  if (!model) throw new ModelNotFoundError(id);
  return model;
}

export async function getPrimaryModel(): Promise<AiModel> {
  const registry = await getModelRegistry();
  const active = registry.filter(m => m.status === 'active').sort((a, b) => a.priority - b.priority);
  const primary = active.find(m => m.isPrimary) ?? active[0];
  if (!primary) throw new ModelNotFoundError('primary');
  return primary;
}

export function calculateCost(model: AiModel, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * model.inputPricePer1k + (outputTokens / 1000) * model.outputPricePer1k;
}
