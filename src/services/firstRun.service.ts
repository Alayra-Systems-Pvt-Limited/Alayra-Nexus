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

import { prisma, dbEngine } from '../lib/prisma';
import { emptyEveryTable } from '../lib/resetTables';
import { safeEqual } from '../lib/timingSafe';
import { createUser, isUnclaimed, AdminUserError, type AdminUserView } from './adminUsers.service';
import { deleteKeys } from '../lib/redisScan';
import { drainAudit } from './audit.service';
import { drainUsage } from './usagePipeline';

// ── First run: claiming the gateway (Phase 7.13a) ─────────────────────────────
//
// A gateway with accounts has a bootstrap problem: somebody has to become the first owner, and
// until they do there is no account to authorise creating one. Whoever reaches an unclaimed
// gateway first would otherwise own it — the land-grab that anyone who can route to the port wins.
//
// ADMIN_PASSWORD is the answer, and this is its new job. It is in the deployer's .env and nowhere
// else, so it is proof of the one thing that matters here: you are the person who installed this.
// It is a CLAIM TICKET, not a credential — spent once, and refused as a sign-in forever after (see
// adminAuth.service). Whoever controls the environment controls the box anyway, so gating on it
// gives away nothing that was not already theirs.

export interface ClaimStatus {
  /** True while no active owner exists. The dashboard shows the claim screen on this alone. */
  unclaimed: boolean;
  /**
   * True when a second factor confirmed BEFORE accounts existed will be carried onto the new owner.
   * The claim screen says so, because an operator needs to know their authenticator survives —
   * otherwise the honest assumption is that claiming resets it and they lose access to their codes.
   */
  carriesExistingTwoFactor: boolean;
}

export async function getClaimStatus(): Promise<ClaimStatus> {
  const unclaimed = await isUnclaimed();
  const legacy = unclaimed ? await prisma.adminAuth.findUnique({ where: { id: 'singleton' } }) : null;
  return {
    unclaimed,
    carriesExistingTwoFactor: !!legacy?.totpSecret && !!legacy.confirmedAt,
  };
}

export interface ClaimInput {
  /** The deployment secret from .env — the proof that you are the person who installed this. */
  masterPassword: string;
  name: string;
  email: string;
  password: string;
}

export interface ClaimResult {
  user: AdminUserView;
  recoveryKey: string;
  /** True when the operator's existing authenticator was carried across and still works. */
  twoFactorCarriedOver: boolean;
}

/**
 * Create the first owner and hand the gateway to them.
 *
 * The second factor is carried across rather than reset. An operator who enrolled an authenticator
 * in Phase 6 has it configured on a phone and their recovery codes in a safe; claiming must not
 * quietly invalidate either. So the singleton secret moves onto the account, the orphaned recovery
 * codes are adopted, and the original is then NULLED — a live TOTP secret must exist in exactly one
 * place, and a copy left behind in a deprecated table is a copy an attacker can still use.
 *
 * All of it in one transaction: a claim that half-succeeded would leave an owner who cannot sign in.
 */
export async function claimGateway(input: ClaimInput): Promise<ClaimResult> {
  if (!(await isUnclaimed())) {
    throw new AdminUserError('This gateway has already been set up. Sign in with your account.', 409);
  }

  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    throw new AdminUserError(
      'ADMIN_PASSWORD is not set on the server, so there is no way to prove you installed this gateway. Set it in the environment and restart.',
      500,
    );
  }
  // Constant-time: `===` would leak how many leading bytes were right, one request at a time.
  if (!safeEqual(input.masterPassword, expected)) {
    throw new AdminUserError('That is not the administrator password from your server’s environment.', 401);
  }

  // Created outside the transaction: hashing the password is deliberately slow (~100ms) and holding
  // a database transaction open across it would pin a connection for no reason.
  const { user, recoveryKey } = await createUser({
    email: input.email,
    name: input.name,
    password: input.password,
    role: 'owner',
    source: 'local',
  });

  const legacy = await prisma.adminAuth.findUnique({ where: { id: 'singleton' } });
  const carryOver = !!legacy?.totpSecret && !!legacy.confirmedAt;

  if (carryOver) {
    await prisma.$transaction([
      // The same encrypted secret, moved — not re-enrolled. The authenticator on their phone keeps
      // producing valid codes.
      prisma.adminUser.update({
        where: { id: user.id },
        data:  { totpSecret: legacy!.totpSecret, totpConfirmedAt: legacy!.confirmedAt },
      }),
      // Adopt the codes that were minted before anyone existed to own them. Unused ones only: a
      // spent code must not come back to life as somebody's.
      prisma.adminRecoveryCode.updateMany({
        where: { userId: null, usedAt: null },
        data:  { userId: user.id },
      }),
      // And now there is exactly one copy of the secret.
      prisma.adminAuth.update({
        where: { id: 'singleton' },
        data:  { totpSecret: null, confirmedAt: null },
      }),
    ]);
  }

  return { user, recoveryKey: recoveryKey as string, twoFactorCarriedOver: carryOver };
}

// ── Factory reset (Phase 7.13b) ───────────────────────────────────────────────

/** The phrase the operator must type, verbatim. Exported so the dashboard and the check agree. */
export const RESET_CONFIRM_PHRASE = 'RESET THIS GATEWAY';


/**
 * Return the gateway to the moment after first install: every table emptied, every Redis key
 * of ours gone — pools, keys, teams, usage, audit, accounts, invites, settings, sessions. The
 * next visitor sees the claim screen.
 *
 * Authorisation is the caller's problem (owner session + the master password + the typed
 * phrase, enforced at the route); this function only destroys.
 *
 * This is the one action that CANNOT leave an audit record of itself — it destroys the table
 * the record would live in. It logs to stdout instead, which is the honest alternative: the
 * server's own log outlives the database. Both pipelines are drained FIRST, so no buffered
 * pre-reset entry can flush after the wipe and rise from the dead into the empty tables.
 */
export async function factoryReset(): Promise<{ tablesCleared: number; redisKeysCleared: number }> {
  await Promise.all([drainAudit(), drainUsage()]);

  const tablesCleared = await emptyEveryTable(prisma, dbEngine);

  // Sessions, rate-limit counters, breaker state, budgets, cache — and the caller's own
  // session with them: the person who pressed the button lands on the claim screen too.
  const redisKeysCleared = await deleteKeys('nexus:*');

  console.log('\n🧨  FACTORY RESET performed by an owner with the master password.');
  console.log(`    ${tablesCleared} tables emptied, ${redisKeysCleared} Redis keys cleared.`);
  console.log('    This event cannot appear in the audit trail — the reset empties the very table');
  console.log('    the record would be written to — so this log line is its only witness.\n');

  return { tablesCleared, redisKeysCleared };
}
