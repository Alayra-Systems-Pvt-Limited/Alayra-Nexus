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

import { getSetting, setSetting } from './settings.service';
import { clampCostWeight } from '../lib/routing';

// Live routing configuration, resolved from a dashboard-editable setting with an
// environment seed. Cost-aware routing is OFF by default (weight 0) so existing
// deployments keep their current provider ordering until an operator opts in.
//
//   ROUTING_COST_WEIGHT — 0..1; 0 ignores cost, 1 is strict cheapest-first.

export const SETTING_COST_WEIGHT = 'ROUTING_COST_WEIGHT';

export async function getCostWeight(): Promise<number> {
  const setting = await getSetting(SETTING_COST_WEIGHT);
  const raw = setting === null ? process.env[SETTING_COST_WEIGHT] : setting;
  return clampCostWeight(raw ?? 0);
}

export async function getRoutingConfigForUI(): Promise<{ costWeight: number }> {
  return { costWeight: await getCostWeight() };
}

export async function setCostWeight(weight: number): Promise<void> {
  await setSetting(SETTING_COST_WEIGHT, String(clampCostWeight(weight)));
}
