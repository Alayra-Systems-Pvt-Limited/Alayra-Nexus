/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// What a backup records about the gateway that wrote it (Phase C1, C5).

import { describe, it, expect } from 'vitest';
import {
  dmmfModels, schemaShape, describeField, configuredEnvNames, missingEnvNames, TRACKED_ENV_PREFIXES,
  StaleColumnFactsError,
} from './provenance';
import { MODEL_ORDER } from './modelOrder';
import { COLUMN_FACTS } from './columnFacts.generated';

describe('the schema shape', () => {
  it('covers every model that gets backed up', () => {
    // A shape that silently omitted a model would report "no drift" for the one table that changed.
    expect(Object.keys(schemaShape()).length).toBe(MODEL_ORDER.length);
  });

  it('is small enough to sit in every manifest', () => {
    // It rides in every backup ever taken. Two kilobytes is free; two megabytes would not be.
    expect(JSON.stringify(schemaShape()).length).toBeLessThan(8 * 1024);
  });

  it('is stable across calls', () => {
    expect(JSON.stringify(schemaShape())).toBe(JSON.stringify(schemaShape()));
  });

  it('sorts columns, so reordering a schema file is not reported as drift', () => {
    for (const columns of Object.values(schemaShape())) {
      expect(columns).toEqual([...columns].sort());
    }
  });

  it('records the four facts a drift check needs', () => {
    const provider = schemaShape().NexusProvider;
    expect(provider).toContain('slug:String:req:nodef');
    expect(provider).toContain('baseUrl:String:opt:nodef');
    expect(provider).toContain('isActive:Boolean:req:def');
  });

  it('treats an @updatedAt column as defaultable, because Prisma fills it', () => {
    // Otherwise a restore would refuse a file missing `updatedAt` — a column no backup needs to
    // carry and no gateway needs supplied.
    expect(schemaShape().NexusProvider).toContain('updatedAt:DateTime:req:def');
  });

  it('leaves relations out, since only columns are written', () => {
    // NexusProvider.keys is a relation, not a column. Including it would make the shape disagree
    // with what a restore actually inserts.
    expect(schemaShape().NexusProvider.some((c) => c.startsWith('keys:'))).toBe(false);
  });

  it('describes a field as name:type:required:defaultable', () => {
    expect(describeField({ name: 'slug', kind: 'scalar', type: 'String' }, 'req:nodef'))
      .toBe('slug:String:req:nodef');
  });

  it('reads a believable model list, so an empty DMMF cannot pass silently', () => {
    expect(dmmfModels().length).toBeGreaterThan(10);
  });
});

describe('the required/defaultable half, which no longer comes from Prisma', () => {
  // Prisma 7 reduces a DMMF field to {name, kind, type}. Everything below is what stands between
  // that and a drift check that calls an impossible restore safe. See provenance.ts's header.

  it('supplies both facts for every scalar column the client has', () => {
    // The real assertion is that schemaShape() does not throw — but stating the count makes a
    // silently-empty artifact fail here rather than pass by describing nothing.
    let columns = 0;
    for (const model of dmmfModels()) {
      const facts = COLUMN_FACTS[model.name];
      expect(facts, `no entry for model ${model.name}`).toBeDefined();
      for (const f of model.fields) {
        if (f.kind !== 'scalar') continue;
        expect(facts[f.name], `no entry for ${model.name}.${f.name}`).toMatch(/^(req|opt):(def|nodef)$/);
        columns++;
      }
    }
    expect(columns).toBeGreaterThan(100);
  });

  it('THROWS on a column it has no facts for, rather than guessing', () => {
    // The whole point, and the reason this is a throw and not a fallback. A guessed `opt:nodef`
    // turns `missing-required` (blocking, "cannot be restored") into `missing-fillable` ("it will
    // take its default") — the check does not go quiet, it starts lying, and the operator is told a
    // restore that cannot succeed is safe. Verified by breaking it on purpose: a model whose column
    // the artifact does not describe.
    const invented = [{
      name: 'NexusProvider',
      fields: [{ name: 'columnAddedWithoutRegenerating', kind: 'scalar', type: 'String' }],
      primaryKey: null,
    }];
    expect(() => schemaShape(invented)).toThrow(StaleColumnFactsError);
    expect(() => schemaShape(invented)).toThrow(/npm run db:column-facts/);
  });

  it('names the model and column, so the fix does not need a debugger', () => {
    const invented = [{
      name: 'NexusProvider', fields: [{ name: 'ghost', kind: 'scalar', type: 'String' }], primaryKey: null,
    }];
    expect(() => schemaShape(invented)).toThrow(/NexusProvider\.ghost/);
  });

  it('does not throw for a model missing entirely — that is new-model drift, not staleness', () => {
    // A model absent from the artifact AND from the schema is a different situation from a column
    // the artifact forgot: there is nothing to describe, and compareSchemas already handles it.
    expect(() => schemaShape([{ name: 'ModelWithNoColumns', fields: [], primaryKey: null }])).not.toThrow();
  });
});

describe('both generated clients describe the same schema', () => {
  // THE loophole this whole approach stands or falls on. The shape is read from the PostgreSQL
  // client's DMMF, but a restore may be running on SQLite — and the flagship capability of this
  // feature is carrying a backup between exactly those two. If the two clients ever disagreed, the
  // drift guard would refuse every cross-engine restore, blaming the operator's file.
  //
  // They agree today by construction: prisma/schema.sqlite.prisma is GENERATED from schema.prisma
  // by scripts/db/sqliteSchema.ts. This is what notices if that stops being true — a generator
  // change, a native type mapping, a hand-edit somebody made anyway.
  let sqliteModels: ReturnType<typeof dmmfModels> | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('.prisma/client-sqlite') as { Prisma: { dmmf: { datamodel: { models: unknown[] } } } };
    sqliteModels = mod.Prisma.dmmf.datamodel.models as unknown as ReturnType<typeof dmmfModels>;
  } catch {
    // Not generated in this checkout (`npm run db:generate`). Skipped rather than failed: a missing
    // build artefact is not a broken schema, and CI generates both.
    sqliteModels = null;
  }

  it.skipIf(!sqliteModels)('produces a byte-identical shape on both engines', () => {
    expect(JSON.stringify(schemaShape(sqliteModels!))).toBe(JSON.stringify(schemaShape()));
  });

  it.skipIf(!sqliteModels)('really compared two clients, not one twice', () => {
    // Guards the require above: if it silently returned the PostgreSQL client, the assertion would
    // pass while proving nothing.
    expect(sqliteModels).not.toBe(dmmfModels());
    expect(sqliteModels!.length).toBe(dmmfModels().length);
  });
});

describe('the configured settings, by name', () => {
  const env = {
    NEXUS_MODE: 'standalone',
    SSO_CLIENT_ID: 'a-real-client-id',
    ADMIN_PASSWORD: 'hunter2',
    DATABASE_URL: 'postgresql://user:password@host/db',
    AWS_SECRET_ACCESS_KEY: 'not ours',
    PATH: '/usr/bin',
    KUBERNETES_SERVICE_HOST: '10.0.0.1',
    NEXUS_EMPTY: '   ',
  };

  it('records only the gateway’s own settings', () => {
    // Dumping every key in the environment would describe the infrastructure the gateway runs on —
    // cloud roles, injected sidecar config — into a file that leaves the building.
    const names = configuredEnvNames(env);
    expect(names).toContain('NEXUS_MODE');
    expect(names).toContain('SSO_CLIENT_ID');
    expect(names).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(names).not.toContain('PATH');
    expect(names).not.toContain('KUBERNETES_SERVICE_HOST');
  });

  it('never records a value, only a name', () => {
    // The whole point. A backup carrying DATABASE_URL's value would put a database password in a
    // file whose entire purpose is to be copied somewhere else.
    const serialised = JSON.stringify(configuredEnvNames(env));
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('a-real-client-id');
    expect(serialised).not.toContain('password@host');
  });

  it('ignores a variable that is set but empty', () => {
    expect(configuredEnvNames(env)).not.toContain('NEXUS_EMPTY');
  });

  it('sorts, so two backups compare cleanly', () => {
    const names = configuredEnvNames(env);
    expect(names).toEqual([...names].sort());
  });

  it('covers the prefixes it claims to', () => {
    expect(TRACKED_ENV_PREFIXES).toContain('SSO_');
    expect(TRACKED_ENV_PREFIXES).toContain('NEXUS_');
  });
});

describe('what the destination is missing', () => {
  it('names a setting the source had and this gateway does not', () => {
    expect(missingEnvNames(['SSO_CLIENT_ID', 'NEXUS_MODE'], ['NEXUS_MODE'])).toEqual(['SSO_CLIENT_ID']);
  });

  it('says nothing when the destination has everything', () => {
    expect(missingEnvNames(['NEXUS_MODE'], ['NEXUS_MODE', 'SSO_CLIENT_ID'])).toEqual([]);
  });

  it('does not report the destination having MORE than the source', () => {
    // A newer or differently-deployed gateway legitimately has extra settings. Warning about those
    // would train an operator to ignore the warning that matters.
    expect(missingEnvNames(['NEXUS_MODE'], ['NEXUS_MODE', 'SSO_CLIENT_ID', 'METRICS_TOKEN'])).toEqual([]);
  });

  it('says nothing for a backup written before this was recorded', () => {
    // Older files carry no `env` at all. Treating absent as "everything is missing" would make
    // every pre-C5 backup look catastrophic.
    expect(missingEnvNames(undefined, ['NEXUS_MODE'])).toEqual([]);
  });
});
