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

// The order rows must be written in (Phase B1.1).
//
// A restore inserts rows, and an insert with a foreign key fails unless the row it points at is
// already there. So a backup has to be written parents-first — and, just as importantly, READ
// parents-first, since the restore streams the file in the order it was written rather than holding
// the whole database in memory to sort it.
//
// ── Why this list is written out rather than derived ──────────────────────────────────────────
//
// `emptyEveryTable` deliberately takes its table list from the live schema, because a hand-written
// list there would silently spare whatever model ships next — a "reset" that leaves data behind.
// The trade-off here runs the other way. Order is not something the engine's catalogue knows; it
// has to be computed from the relation graph, and a topological sort computed at runtime is a
// silent reordering the day someone adds a relation — with no review, and a failure that surfaces
// as a foreign-key error in the middle of somebody's restore.
//
// So the order is explicit and reviewable, and the SCHEMA is what checks it: `modelOrder.test.ts`
// parses prisma/schema.prisma and fails if a model is missing from this list, or if any relation
// points forward instead of backward. Both properties, and neither depends on remembering.
//
// TokenUsage is deliberately last: it is by far the largest table, and having the small structural
// tables land first means a restore that fails partway is diagnosable rather than baffling.

/**
 * Every model, parents before children.
 *
 * Names are Prisma DELEGATE names (camelCase — `prisma[name]`), not the PascalCase model names in
 * the schema. The test converts between them.
 */
export const MODEL_ORDER: readonly string[] = [
  // ── No outbound relations. Everything below may point at these. ──────────────────────────────
  'nexusProvider',
  'team',
  'adminUser',
  'adminAuth',        // the pre-accounts singleton second factor
  'aiModelRegistry',
  'appSettings',
  'notification',
  'ssoProvider',
  // AuditLog references an actor by id but deliberately declares NO relation — an audit record must
  // outlive the account it describes. That is why it sits with the independent tables and not after
  // adminUser: it has no foreign key to satisfy.
  'auditLog',

  // ── Point at the tables above. ───────────────────────────────────────────────────────────────
  'nexusKey',           // → nexusProvider, team
  'nexusTeamKey',       // → team
  'adminInvite',        // → adminUser
  'adminRecoveryCode',  // → adminUser
  'adminApiToken',      // → adminUser
  'domainAlias',        // → team

  // ── Points at a child of the above, so it must come after it. ────────────────────────────────
  'tokenUsage',         // → nexusTeamKey
] as const;

/**
 * Models deliberately NOT backed up, and the reason, which matters more than the list.
 *
 * `Backup` and `BackupChunk` hold previous exports. Including them would put backup #1 inside
 * backup #2 and #2 inside #3, so every backup would carry the sum of every backup before it until
 * a gateway could no longer export at all. This is not a size optimisation; it is the difference
 * between a feature that works and one that destroys itself on a schedule.
 *
 * Written as a LIST rather than a silent omission, because the completeness test asserts that
 * MODEL_ORDER and the schema agree. Leaving these out quietly turns that test red, and the obvious
 * repair — adding them to MODEL_ORDER — is exactly the bug. Naming them here makes the exclusion a
 * reviewed decision instead of a puzzle for whoever hits the failure at 2am.
 *
 * The consequence, stated where someone will read it before they are surprised by it: restoring a
 * backup does not restore the list of backups. A gateway keeps its own.
 */
export const EXCLUDED_MODELS: readonly string[] = [
  'backup',
  'backupChunk',
] as const;

/** The reverse, for emptying: children before parents. */
export const DELETE_ORDER: readonly string[] = [...MODEL_ORDER].reverse();

/** PascalCase model name in schema.prisma → the camelCase delegate on the Prisma client. */
export function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** The inverse, for reading a delegate name back against the schema. */
export function modelName(delegate: string): string {
  return delegate.charAt(0).toUpperCase() + delegate.slice(1);
}
