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

import { resolveRequestScope } from '../byok.service';
import { checkTeamBudget, type BudgetPeriod, type OverBudgetAction } from '../budget.service';
import { resolveRequestedModel, unknownModelError } from '../modelCatalog.service';
import { byokKeyRequired } from '../byokOnly.service';
import { isByok, isIsolated, type RoutingScope } from '../../lib/scope';
import type { TraceRoutingStrategy } from '../../lib/requestTrace';
import { observe, type ProxyRun } from './run';
import { answered, proceed, type ProxyRunOptions, type Stage } from './types';

// ── Admission: who is asking, for what, and may they ──────────────────────────

const ROUTING_STRATEGY_WEIGHT: Record<TraceRoutingStrategy, number> = {
  fastest: 0,
  balanced: 0.5,
  cheapest: 1,
};

export interface Admission {
  scope:               RoutingScope;
  pinnedModelId:       string | null;
  strategyWeight:      number;
  overBudgetDowngrade: boolean;
}

/** Resolve the caller's scope and model, describe the routing strategy, and apply the budget gate. */
export async function admitRequest(run: ProxyRun, options: ProxyRunOptions): Promise<Stage<Admission>> {
  const { body, reply, team, trace } = run;

  // ── BYOK scope (Phase 5.5) — resolved once, then threaded into model resolution, the
  // response cache namespace, and pool discovery. Deriving them from one value is what
  // keeps a response paid for by one team's private key out of another scope's cache, and
  // what stops an isolated team being offered a model it can never reach.
  const scope = await resolveRequestScope(team);
  if (trace) {
    trace.requestedModel = typeof body.model === 'string' ? body.model : null;
    trace.stream = body.stream === true;
    trace.scope  = { namespace: scope.namespace, byok: isByok(scope), isolated: isIsolated(scope) };
  }

  // What the caller asked for: auto-route (no model, or an alias), or a pinned model from
  // the operator's registry. An unknown id is a 400 that names the alternatives rather
  // than a silent substitution — see modelCatalog.service.
  const requestedModel = await resolveRequestedModel(body.model, 'chat', scope);
  if (trace) trace.resolution = requestedModel.kind === 'pinned' ? 'pinned'
    : requestedModel.kind === 'unknown' ? 'unknown' : 'auto';
  if (requestedModel.kind === 'unknown') {
    // A byok-only team asking for a model the gateway serves through a provider it has no key for
    // is told to add that key (P1.1); anything else unknown is the ordinary 400.
    const needsKey = await byokKeyRequired(scope, 'chat', { unknownModel: requestedModel.requested });
    if (needsKey) {
      if (trace) trace.refusal = { status: 403, reason: 'The team has no provider key of its own for this model.' };
      observe(run, 'client_error');
      return answered(reply.code(403).send(needsKey));
    }
    if (trace) trace.refusal = { status: 400, reason: 'The model asked for is not in the registry.' };
    observe(run, 'client_error');
    return answered(reply.code(400).send(unknownModelError(requestedModel)));
  }
  const pinnedModelId = requestedModel.kind === 'pinned' ? requestedModel.model.id : null;
  const requestedStrategy = options.routingStrategy ?? 'fastest';
  const strategyWeight = ROUTING_STRATEGY_WEIGHT[requestedStrategy];
  if (trace) trace.strategy = pinnedModelId ? {
    requested: requestedStrategy,
    applied: 'direct',
    costWeight: null,
    explanation: 'A specific model was selected, so Nexus routed directly to an eligible key for that model.',
  } : {
    requested: requestedStrategy,
    applied: requestedStrategy,
    costWeight: strategyWeight,
    explanation: requestedStrategy === 'cheapest'
      ? 'Cost has maximum weight after capability, health, and tier eligibility checks.'
      : requestedStrategy === 'balanced'
        ? 'Provider priority and model cost have equal routing weight after eligibility checks.'
        : 'Nexus follows provider priority and selects the first eligible capacity; this is not predictive latency routing.',
  };

  // ── Team budget gate — enforced before any provider work happens. Requests
  // already in flight when the cap is crossed may overshoot by their own cost
  // (cost is unknowable up front on a streaming gateway); see budget.service.
  // Over-budget behaviour is per-team (Phase 7.10): "block" refuses here, "notify"
  // admits silently, and "downgrade" admits but pins routing to the fast tier below.
  let overBudgetDowngrade = false;
  if (team && team.budgetUsd != null) {
    const budget = await checkTeamBudget(team.id, team.budgetUsd, team.budgetPeriod as BudgetPeriod, (team.overBudgetAction ?? 'block') as OverBudgetAction);
    if (trace) trace.budget = {
      checked: true, allowed: budget.allowed, action: team.overBudgetAction ?? 'block',
      downgraded: budget.downgrade, spendUsd: budget.spendUsd, budgetUsd: team.budgetUsd,
    };
    if (!budget.allowed) {
      if (trace) trace.refusal = { status: 429, reason: 'The team is over its budget for this period.' };
      observe(run, 'budget_blocked');
      return answered(reply
        .code(429)
        .header('Retry-After', String(budget.retryAfterSeconds))
        .send({
          error: `Team budget exhausted: $${budget.spendUsd.toFixed(4)} of $${team.budgetUsd} used this ${team.budgetPeriod === 'daily' ? 'day' : team.budgetPeriod === 'weekly' ? 'week' : 'month'}. Resets in ${budget.retryAfterSeconds}s.`,
          spendUsd:   budget.spendUsd,
          budgetUsd:  team.budgetUsd,
          retryAfter: budget.retryAfterSeconds,
        }));
    }
    overBudgetDowngrade = budget.downgrade;
  } else if (trace) {
    // Nothing to check is not the same as checked and allowed — a caller with no team, or a team
    // with no cap, has no budget state, and reporting one would invent a limit that does not exist.
    trace.budget = { checked: false, allowed: true, action: 'none', downgraded: false };
  }

  return proceed({ scope, pinnedModelId, strategyWeight, overBudgetDowngrade });
}
