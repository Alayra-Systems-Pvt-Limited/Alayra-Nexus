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

// What a backup records about the gateway that wrote it (Phase C1, C5).
//
// ── Why the schema shape, and not a migration name ────────────────────────────────────────────
//
// The obvious answer was to write down the latest row of `_prisma_migrations`. It does not work,
// and the reason is worth stating so nobody re-proposes it: a PostgreSQL deployment applies its
// schema with `prisma migrate deploy`, while a standalone SQLite gateway is built from committed
// DDL by sqliteBootstrap.ts and has NO migrations table at all. A migration name would therefore be
// absent on one engine and meaningless on the other — in a feature whose headline capability is
// moving a backup between exactly those two.
//
// The shape itself is better anyway. A migration name can only ever say "different". A column map
// says WHICH columns differ and whether the missing ones can be filled, which is the difference
// between "this backup cannot be restored" and "this backup cannot be restored because AdminUser
// gained a required `department` column with no default".
//
// ── Where it comes from ───────────────────────────────────────────────────────────────────────
//
// Two sources, deliberately, and the split is load-bearing.
//
// WHICH columns exist, and their TYPE, come from Prisma's DMMF: the datamodel the generated client
// itself was built from. No database round trip, no SQL dialect, and it describes precisely what a
// restore will try to write — since the restore writes THROUGH this client. Both generated clients
// were measured to produce byte-identical output, and a parity test keeps it that way.
//
// Whether a column is REQUIRED, and whether the database can produce a value for it, come from
// COLUMN_FACTS — generated from prisma/schema.prisma at build time by scripts/db/columnFacts.ts.
//
// That second half used to come from the DMMF too. Prisma 7 reduces its field records to
// `{name, kind, type}` and drops `isRequired`, `hasDefaultValue` and `isUpdatedAt`. Read through the
// old code on v7 every column looked optional and defaultless, and the damage was not that a check
// went quiet: `missing-required` is blocking and says "this backup cannot be restored", while the
// value it degraded to, `missing-fillable`, says "it will take its default". A restore that could
// not succeed would have been described to the operator as safe.
//
// The DMMF was never the SOURCE of those two facts, only a relay that stopped relaying. The schema
// still states them plainly, so they are read from there instead.
//
// The two sources are cross-checked rather than trusted: a DMMF field with no entry in COLUMN_FACTS
// THROWS. It would be easy to fall back to a default and keep going, and that is exactly the shape
// of the bug above — a fingerprint that is quietly wrong is worse than one that is missing, because
// it is believed. If this throws, the artifact is stale; `npm run db:column-facts` regenerates it,
// and CI fails before that can reach anybody.

import { Prisma } from '@prisma/client';
import { EXCLUDED_MODELS, delegateName } from './modelOrder';
import { COLUMN_FACTS } from './columnFacts.generated';
import type { ColumnFact } from './columnFactsTypes';

/**
 * One model's columns, as `name:type:required:defaultable`.
 *
 * `defaultable` folds `@default(...)` and `@updatedAt` together, because for the only question that
 * matters — can a restore leave this column out and still succeed — they are the same thing.
 */
export type ModelShape = string[];

/** Every model's columns. Roughly 1.9 KB for this schema. */
export type SchemaShape = Record<string, ModelShape>;

// Only what Prisma 7 still guarantees. `isRequired` and `hasDefaultValue` were removed there, and
// declaring them optional-but-present would let this file read them again by accident on a version
// that does not have them — which is the whole failure being fixed. They are not declared at all.
interface DmmfField { name: string; kind: string; type: string }
interface DmmfModel { name: string; fields: readonly DmmfField[]; primaryKey: unknown }

/** The models this client was generated from. Exported so tests can compare two clients. */
export function dmmfModels(): readonly DmmfModel[] {
  return (Prisma.dmmf?.datamodel?.models ?? []) as unknown as readonly DmmfModel[];
}

/**
 * Raised when the DMMF has a column the generated artifact does not.
 *
 * Its own class because the fix is specific and mechanical — regenerate and commit — and because a
 * bare Error here would be indistinguishable from the backup failures around it, which are about
 * the file rather than about this build.
 */
export class StaleColumnFactsError extends Error {
  constructor(model: string, column: string) {
    super(
      `${model}.${column} exists in the Prisma client but not in columnFacts.generated.ts. ` +
      'That artifact is out of date with prisma/schema.prisma — run `npm run db:column-facts` ' +
      'and commit the result. Refusing to fingerprint a schema this gateway cannot describe ' +
      'accurately, because a wrong fingerprint is trusted and a missing one is not.');
    this.name = 'StaleColumnFactsError';
  }
}

/**
 * One column, rendered so that two schemas can be compared by string equality.
 *
 * `fact` carries the required/defaultable half; see the header for why it does not come from `f`.
 */
export function describeField(f: DmmfField, fact: ColumnFact): string {
  return `${f.name}:${f.type}:${fact}`;
}

/**
 * The shape of this gateway's schema.
 *
 * Sorted, so two gateways that agree produce identical strings regardless of the order Prisma
 * happened to list fields in — a fingerprint that changed with field ordering would report drift
 * every time somebody reordered a schema file without changing anything real.
 */
export function schemaShape(models: readonly DmmfModel[] = dmmfModels()): SchemaShape {
  const out: SchemaShape = {};
  for (const model of models) {
    // The models that STORE backups are not part of the shape a backup describes.
    //
    // They are excluded from the export (see modelOrder.ts), so a fingerprint that mentioned them
    // would be describing tables the file cannot contain. Worse, it would make every backup taken
    // before stored backups shipped report drift on restore — a real warning, raised for a change
    // that cannot affect the data being restored, in the one place an operator most needs to trust
    // what they are told. Excluded on both sides, so old and new files compare identically.
    if (EXCLUDED_MODELS.includes(delegateName(model.name))) continue;

    const facts = COLUMN_FACTS[model.name] ?? {};
    out[model.name] = model.fields
      .filter((f) => f.kind === 'scalar')
      .map((f) => {
        const fact = facts[f.name];
        if (!fact) throw new StaleColumnFactsError(model.name, f.name);
        return describeField(f, fact);
      })
      .sort();
  }
  return out;
}

// ── Environment (C5) ──────────────────────────────────────────────────────────────────────────
//
// NAMES ONLY, and never the values. The point is that a restore can say "the source had SSO
// configured and this gateway does not, so SSO will be broken after this" — the difference between
// a restore that worked and one that merely looked like it did.
//
// Deliberately not every variable in the process. Dumping the whole environment's key list would
// describe the infrastructure the gateway runs on — cloud roles, injected sidecar config, CI
// identifiers — into a file that leaves the building. The prefixes below are the gateway's own
// settings and nothing else.
//
// There is no master-key preflight here, and there does not need to be: lib/encryption.ts throws at
// import unless MASTER_ENCRYPTION_KEY is exactly 64 hex characters, so a gateway that lacks one
// cannot have started. A check for it could never fire.

/** Prefixes owned by this gateway. Anything else in the environment belongs to whoever runs it. */
export const TRACKED_ENV_PREFIXES: readonly string[] = [
  'NEXUS_', 'ADMIN_', 'SSO_', 'SMTP_', 'RESEND_', 'METRICS_',
  'DATABASE_', 'REDIS_', 'MASTER_', 'AUDIT_', 'USAGE_',
];

/** Which of this gateway's own settings are set, by name. Sorted, so files compare cleanly. */
export function configuredEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((name) => TRACKED_ENV_PREFIXES.some((p) => name.startsWith(p)))
    .filter((name) => (env[name] ?? '').trim() !== '')
    .sort();
}

/** Settings the source gateway had and this one does not. The direction that breaks things. */
export function missingEnvNames(source: readonly string[] | undefined, here = configuredEnvNames()): string[] {
  if (!source) return [];
  const present = new Set(here);
  // The opposite direction is deliberately not reported: this gateway having EXTRA settings the
  // source lacked is normal — a different deployment, a newer version — and warning about it would
  // train operators to ignore the warning that matters.
  return source.filter((name) => !present.has(name));
}
