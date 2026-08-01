/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The order in modelOrder.ts is hand-written so it can be reviewed. This is what makes that safe:
// the schema is parsed and the list is checked against it, so neither a new model nor a new relation
// can slip past. Without these, the failure is a foreign-key error partway through a restore.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODEL_ORDER, DELETE_ORDER, EXCLUDED_MODELS, delegateName, modelName } from './modelOrder';
import { dmmfModels } from './provenance';

const schema = readFileSync(resolve(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Every `model X { … }` in the schema, PascalCase. */
function schemaModels(): string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

/**
 * Every foreign key, as `{ child, parent }`.
 *
 * A relation that declares `fields:` is the side holding the column — the child. The referenced
 * model is the field's own type, with any `?` stripped.
 */
function relations(): { child: string; parent: string }[] {
  const out: { child: string; parent: string }[] = [];

  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const child = block[1];
    for (const line of block[2].split('\n')) {
      if (!/@relation\s*\(\s*fields\s*:/.test(line)) continue;
      const m = /^\s*\w+\s+(\w+)\??\s/.exec(line);
      if (m) out.push({ child, parent: m[1] });
    }
  }
  return out;
}

describe('the write order covers the schema', () => {
  it('lists every model exactly once, except the ones deliberately excluded', () => {
    // The failure: a model ships, nobody adds it here, and it is silently absent from every backup
    // taken from that day on — discovered only by someone restoring and finding it empty.
    const expected = schemaModels()
      .map(delegateName)
      .filter((m) => !EXCLUDED_MODELS.includes(m))
      .sort();
    expect([...MODEL_ORDER].sort()).toEqual(expected);
  });

  it('excludes only models that actually exist in the schema', () => {
    // Without this, renaming or dropping an excluded model leaves a dead string in EXCLUDED_MODELS
    // and the exclusion quietly stops matching anything. The completeness test above would then go
    // red for a reason that points nowhere near the cause.
    const known = new Set(schemaModels().map(delegateName));
    for (const excluded of EXCLUDED_MODELS) expect(known).toContain(excluded);
  });

  it('never lets an excluded model appear in the write order', () => {
    // Belt and braces against the tempting repair: someone hits the completeness failure, adds
    // `backup` to MODEL_ORDER, every test goes green, and backups start containing backups.
    for (const excluded of EXCLUDED_MODELS) expect(MODEL_ORDER).not.toContain(excluded);
  });

  it('contains no duplicates', () => {
    expect(new Set(MODEL_ORDER).size).toBe(MODEL_ORDER.length);
  });

  it('found a believable number of models, so the parse is not returning nothing', () => {
    expect(schemaModels().length).toBeGreaterThan(10);
    expect(relations().length).toBeGreaterThan(5);
  });
});

describe('the write order satisfies every foreign key', () => {
  it('never writes a child before its parent', () => {
    const position = new Map(MODEL_ORDER.map((m, i) => [m, i]));
    const broken: string[] = [];

    for (const { child, parent } of relations()) {
      // A self-reference orders fine within one table's own insert batch.
      if (child === parent) continue;

      const c = position.get(delegateName(child));
      const p = position.get(delegateName(parent));
      if (c === undefined || p === undefined) continue;   // covered by the completeness test above
      if (p > c) broken.push(`${child} is written before its parent ${parent}`);
    }

    expect(
      broken,
      `${broken.join('; ')}.\nReorder MODEL_ORDER in src/lib/backup/modelOrder.ts — a restore ` +
      'inserts in this order, and a child row whose parent is not there yet fails the foreign key.',
    ).toEqual([]);
  });

  it('really is checking the relations it claims to', () => {
    // Guards the regex. If the parse silently returned [], the test above would pass while
    // checking nothing — the exact way an order guard stops guarding.
    const rels = relations();
    expect(rels).toContainEqual({ child: 'NexusKey', parent: 'NexusProvider' });
    expect(rels).toContainEqual({ child: 'TokenUsage', parent: 'NexusTeamKey' });
    expect(rels).toContainEqual({ child: 'DomainAlias', parent: 'Team' });
  });

  it('puts the largest table last, so a partial restore is diagnosable', () => {
    expect(MODEL_ORDER[MODEL_ORDER.length - 1]).toBe('tokenUsage');
  });
});

describe('every backed-up model can actually be paged (C3)', () => {
  // export.ts hardcodes `orderBy: { id: 'asc' }` and `cursor: { id }`. A model whose key is not a
  // single scalar `id` would satisfy every other test here, ship, and then fail at the first backup
  // any operator took — with a Prisma error about an unknown argument rather than anything that
  // points at this decision.
  //
  // Checked against the DMMF rather than by parsing the schema text, because `@@id([a, b])` is a
  // block attribute that a field-line regex does not see at all.
  const models = dmmfModels();

  it('found the models it claims to be checking', () => {
    // The DMMF carries every model in the schema, including the excluded ones — so the count this
    // compares against is the write order PLUS the exclusions, not the write order alone.
    expect(models.length).toBe(MODEL_ORDER.length + EXCLUDED_MODELS.length);
  });

  it('gives every model exactly one id field, named id', () => {
    for (const model of models) {
      const ids = model.fields.filter((f) => f.isId);
      expect(ids.map((f) => f.name), `${model.name} must be keyed by a single scalar "id"`).toEqual(['id']);
    }
  });

  it('gives no model a composite primary key', () => {
    // `@@id([teamId, day])` leaves `primaryKey` non-null and no field marked isId, so a composite
    // would slip past the check above on its own.
    const composite = models.filter((m) => m.primaryKey !== null).map((m) => m.name);
    expect(
      composite,
      `${composite.join(', ')} use a composite key. export.ts pages on a single "id" column — ` +
      'teach it the composite cursor shape before removing this assertion.',
    ).toEqual([]);
  });

  it('keys every model on a scalar, not a relation', () => {
    for (const model of models) {
      const id = model.fields.find((f) => f.isId);
      expect(id?.kind, `${model.name}.id must be a scalar`).toBe('scalar');
    }
  });
});

describe('DELETE_ORDER', () => {
  it('is the exact reverse, so children go before parents', () => {
    expect(DELETE_ORDER).toEqual([...MODEL_ORDER].reverse());
  });

  it('did not alias and reverse the original in place', () => {
    // `[...x].reverse()` is correct; `x.reverse()` would have mutated MODEL_ORDER at import and
    // broken every write. Cheap to assert, and silent if wrong.
    expect(MODEL_ORDER[0]).toBe('nexusProvider');
    expect(DELETE_ORDER[0]).toBe('tokenUsage');
  });
});

describe('name conversion', () => {
  it('round-trips between schema and delegate names', () => {
    for (const m of schemaModels()) expect(modelName(delegateName(m))).toBe(m);
  });

  it('handles the acronym-leading names in this schema', () => {
    expect(delegateName('AiModelRegistry')).toBe('aiModelRegistry');
    expect(delegateName('SsoProvider')).toBe('ssoProvider');
    expect(modelName('nexusTeamKey')).toBe('NexusTeamKey');
  });
});
