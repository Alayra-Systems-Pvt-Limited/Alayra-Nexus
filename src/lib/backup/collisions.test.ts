/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// UNIQUE_COLUMNS is hand-written so it can be reviewed. This is what keeps that honest: the schema
// is parsed and the list is checked against it, so a constraint cannot be added, removed or renamed
// without this failing. Without it, the guard silently stops covering whichever column shipped last
// — and a check that has quietly stopped checking is worse than no check, because the dry run still
// reports "no collisions".

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODEL_ORDER, delegateName } from './modelOrder';
import {
  UNIQUE_COLUMNS, MAX_EXAMPLES, MODELS_WITH_UNIQUE_COLUMNS,
  findCollisions, mergeCollisions, type Collision,
} from './collisions';

const schema = readFileSync(resolve(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Every single-column `@unique` in the schema, as delegate name + column. */
function schemaUniques(): { model: string; column: string }[] {
  const out: { model: string; column: string }[] = [];

  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const model = delegateName(block[1]);
    for (const line of block[2].split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) continue;   // a commented-out field is not a constraint
      if (trimmed.startsWith('@@')) continue;   // composite, counted separately below
      if (!/@unique\b/.test(trimmed)) continue;
      const m = /^(\w+)\s+/.exec(trimmed);
      if (m) out.push({ model, column: m[1] });
    }
  }
  return out;
}

/** Every composite `@@unique(...)`. */
function schemaCompositeUniques(): string[] {
  return [...schema.matchAll(/^\s*@@unique\s*\(([^)]*)\)/gm)].map((m) => m[1].trim());
}

const key = (c: { model: string; column: string }): string => `${c.model}.${c.column}`;

describe('the registry matches the schema', () => {
  it('covers every single-column unique constraint, and invents none', () => {
    // Both directions matter. A missing entry means a column that can silently drop rows is never
    // checked; an extra entry means a query against a column that no longer exists, which fails the
    // dry run for a reason unrelated to the operator's file.
    expect(UNIQUE_COLUMNS.map(key).sort()).toEqual(schemaUniques().map(key).sort());
  });

  it('found a believable number of constraints, so the parse is not returning nothing', () => {
    // Guards the regex. If this silently returned [], the test above would pass while comparing two
    // empty lists — the exact way a drift guard stops guarding.
    expect(schemaUniques().length).toBeGreaterThan(5);
    expect(schemaUniques().map(key)).toContain('nexusProvider.slug');
    expect(schemaUniques().map(key)).toContain('adminUser.email');
    expect(schemaUniques().map(key)).toContain('nexusTeamKey.keyHash');
  });

  it('has no composite unique constraints to worry about yet', () => {
    // findCollisions queries one column at a time. A composite needs `where: { OR: [{ a, b }, …] }`
    // instead, so if one ever appears this must be taught about it rather than silently ignoring it.
    expect(
      schemaCompositeUniques(),
      'A composite @@unique was added. findCollisions() only understands single-column constraints — ' +
      'teach it the composite query shape before removing this assertion.',
    ).toEqual([]);
  });

  it('only names models that are actually backed up', () => {
    for (const c of UNIQUE_COLUMNS) expect(MODEL_ORDER).toContain(c.model);
  });

  it('lists no model+column twice', () => {
    expect(new Set(UNIQUE_COLUMNS.map(key)).size).toBe(UNIQUE_COLUMNS.length);
  });

  it('treats every hashed credential column as sensitive', () => {
    // The naming convention is the schema's, not ours, and it is consistent: keyHash, tokenHash,
    // codeHash. Anything matching it must never have its values quoted back in a report, and this
    // is what catches the next one being added without the flag.
    for (const c of UNIQUE_COLUMNS) {
      if (/hash$/i.test(c.column)) {
        expect(c.sensitive, `${key(c)} is a hash column and must be marked sensitive`).toBe(true);
      }
    }
  });

  it('derives the model set from the registry', () => {
    expect([...MODELS_WITH_UNIQUE_COLUMNS].sort()).toEqual([...new Set(UNIQUE_COLUMNS.map((c) => c.model))].sort());
    // The big table has no unique column, which is what keeps the dry run's cost bounded.
    expect(MODELS_WITH_UNIQUE_COLUMNS.has('tokenUsage')).toBe(false);
  });
});

/** A fake client whose findMany answers from a fixed set of rows, the way Prisma's would. */
function clientWith(rows: Record<string, Record<string, unknown>[]>): Record<string, unknown> {
  const client: Record<string, unknown> = {};
  for (const model of MODEL_ORDER) {
    client[model] = {
      findMany: (args: { where: Record<string, { in: unknown[] }> }) => {
        const [column, { in: values }] = Object.entries(args.where)[0];
        return Promise.resolve((rows[model] ?? []).filter((r) => values.includes(r[column])));
      },
    };
  }
  return client;
}

describe('findCollisions', () => {
  it('flags a row whose unique value already belongs to a different row', async () => {
    // The proven defect: same slug, different id. createMany would skip it and report success.
    const client = clientWith({ nexusProvider: [{ id: 'here', slug: 'openai' }] });
    const found = await findCollisions(client, 'nexusProvider', [{ id: 'from-file', slug: 'openai' }]);

    expect(found).toEqual([{ model: 'nexusProvider', column: 'slug', count: 1, examples: ['openai'] }]);
  });

  it('does not flag the same row arriving again', async () => {
    // Same id AND same value is a plain duplicate, which is precisely what merge is for. Reporting
    // it would bury the real collisions under noise on every re-run of the same file.
    const client = clientWith({ nexusProvider: [{ id: 'same', slug: 'openai' }] });
    expect(await findCollisions(client, 'nexusProvider', [{ id: 'same', slug: 'openai' }])).toEqual([]);
  });

  it('returns nothing when the value is free', async () => {
    const client = clientWith({ nexusProvider: [{ id: 'here', slug: 'anthropic' }] });
    expect(await findCollisions(client, 'nexusProvider', [{ id: 'from-file', slug: 'openai' }])).toEqual([]);
  });

  it('returns nothing for a model with no unique columns', async () => {
    // tokenUsage is the largest table; not querying it is the point.
    const client = clientWith({ tokenUsage: [{ id: 'u1' }] });
    expect(await findCollisions(client, 'tokenUsage', [{ id: 'u2' }])).toEqual([]);
  });

  it('ignores nulls, which never violate a unique index', async () => {
    const client = clientWith({ domainAlias: [{ id: 'here', domain: null }] });
    expect(await findCollisions(client, 'domainAlias', [{ id: 'from-file', domain: null }])).toEqual([]);
  });

  it('counts collisions on a hashed column but never quotes the values', async () => {
    const client = clientWith({ nexusTeamKey: [{ id: 'here', keyHash: 'sha256-of-a-real-key' }] });
    const found = await findCollisions(client, 'nexusTeamKey', [{ id: 'from-file', keyHash: 'sha256-of-a-real-key' }]);

    expect(found[0].count).toBe(1);
    expect(found[0].examples).toEqual([]);
    expect(JSON.stringify(found)).not.toContain('sha256-of-a-real-key');
  });

  it('caps the examples it quotes', async () => {
    const many = Array.from({ length: MAX_EXAMPLES + 4 }, (_, i) => ({ id: `here-${i}`, slug: `s${i}` }));
    const fromFile = many.map((r, i) => ({ id: `file-${i}`, slug: `s${i}` }));
    const found = await findCollisions(clientWith({ nexusProvider: many }), 'nexusProvider', fromFile);

    expect(found[0].count).toBe(MAX_EXAMPLES + 4);      // the count is exact
    expect(found[0].examples).toHaveLength(MAX_EXAMPLES); // the quoting is not
  });

  it('reports each unique column of a model separately', async () => {
    // adminUser has one today; this proves the loop is per-column rather than per-model, so a model
    // that gains a second constraint is reported on both.
    const client = clientWith({ adminUser: [{ id: 'here', email: 'a@b.c' }] });
    const found = await findCollisions(client, 'adminUser', [{ id: 'from-file', email: 'a@b.c' }]);
    expect(found).toHaveLength(1);
    expect(found[0].column).toBe('email');
  });

  it('does nothing when handed no rows', async () => {
    expect(await findCollisions(clientWith({}), 'nexusProvider', [])).toEqual([]);
  });

  it('refuses a model this gateway does not have', async () => {
    await expect(findCollisions({}, 'nexusProvider', [{ id: 'x', slug: 'y' }]))
      .rejects.toThrow(/no "nexusProvider" table/);
  });
});

describe('mergeCollisions', () => {
  it('adds up counts for the same model and column across batches', () => {
    const into: Collision[] = [];
    mergeCollisions(into, [{ model: 'nexusProvider', column: 'slug', count: 2, examples: ['a', 'b'] }]);
    mergeCollisions(into, [{ model: 'nexusProvider', column: 'slug', count: 3, examples: ['c'] }]);

    expect(into).toEqual([{ model: 'nexusProvider', column: 'slug', count: 5, examples: ['a', 'b', 'c'] }]);
  });

  it('keeps different columns apart', () => {
    const into: Collision[] = [];
    mergeCollisions(into, [{ model: 'adminUser', column: 'email', count: 1, examples: ['a@b.c'] }]);
    mergeCollisions(into, [{ model: 'nexusProvider', column: 'slug', count: 1, examples: ['x'] }]);
    expect(into).toHaveLength(2);
  });

  it('still caps examples once merged', () => {
    const into: Collision[] = [];
    for (let i = 0; i < MAX_EXAMPLES + 3; i++) {
      mergeCollisions(into, [{ model: 'nexusProvider', column: 'slug', count: 1, examples: [`s${i}`] }]);
    }
    expect(into[0].count).toBe(MAX_EXAMPLES + 3);
    expect(into[0].examples).toHaveLength(MAX_EXAMPLES);
  });

  it('does not repeat an example seen in two batches', () => {
    const into: Collision[] = [];
    mergeCollisions(into, [{ model: 'nexusProvider', column: 'slug', count: 1, examples: ['same'] }]);
    mergeCollisions(into, [{ model: 'nexusProvider', column: 'slug', count: 1, examples: ['same'] }]);
    expect(into[0].examples).toEqual(['same']);
  });

  it('copies the examples array rather than aliasing the caller\'s', () => {
    const into: Collision[] = [];
    const found: Collision[] = [{ model: 'nexusProvider', column: 'slug', count: 1, examples: ['a'] }];
    mergeCollisions(into, found);
    found[0].examples.push('mutated');
    expect(into[0].examples).toEqual(['a']);
  });
});
