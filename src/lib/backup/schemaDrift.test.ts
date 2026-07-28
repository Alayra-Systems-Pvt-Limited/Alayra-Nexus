/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Which schema changes a backup survives, and which it cannot (Phase C4).
//
// The interesting half of this file is everything asserted NOT to block. A guard that refused on any
// difference would refuse every backup taken before any release — a data-loss policy wearing the
// costume of caution — and "a backup from v1.3 restores into v1.9" would stop being true the first
// time anyone added a column.

import { describe, it, expect } from 'vitest';
import { compareSchemas, blocking, assertRestorable, SchemaDriftError } from './schemaDrift';
import type { SchemaShape } from './provenance';

/** The schema as it was when the backup was taken. */
const WAS: SchemaShape = {
  NexusProvider: ['id:String:req:def', 'name:String:req:nodef', 'slug:String:req:nodef'],
  Team:          ['id:String:req:def', 'name:String:req:nodef'],
};

const only = (differences: ReturnType<typeof compareSchemas>) =>
  differences.map((d) => `${d.kind}:${d.model}${d.column ? `.${d.column}` : ''}`);

describe('changes a restore absorbs', () => {
  it('reports nothing when the schemas match', () => {
    expect(compareSchemas(WAS, WAS)).toEqual([]);
  });

  it('lets a new column with a default take its default', () => {
    const now = { ...WAS, NexusProvider: [...WAS.NexusProvider, 'tier:String:req:def'] };
    const d = compareSchemas(WAS, now);

    expect(only(d)).toEqual(['missing-fillable:NexusProvider.tier']);
    expect(blocking(d)).toEqual([]);
  });

  it('lets a new nullable column simply be null', () => {
    // Nullable IS the default. Refusing here would mean no backup survives an optional column.
    const now = { ...WAS, NexusProvider: [...WAS.NexusProvider, 'notes:String:opt:nodef'] };
    expect(blocking(compareSchemas(WAS, now))).toEqual([]);
  });

  it('leaves a model added since the backup empty rather than refusing', () => {
    const now = { ...WAS, DomainAlias: ['id:String:req:def'] };
    const d = compareSchemas(WAS, now);

    expect(only(d)).toEqual(['new-model:DomainAlias']);
    expect(blocking(d)).toEqual([]);
  });

  it('accepts a column that became optional', () => {
    // The file holds a value; a column that no longer insists on one still takes it.
    const now = { ...WAS, Team: ['id:String:req:def', 'name:String:opt:nodef'] };
    expect(blocking(compareSchemas(WAS, now))).toEqual([]);
  });

  it('accepts a column that became required but gained a default', () => {
    const was = { Team: ['id:String:req:def', 'region:String:opt:nodef'] };
    const now = { Team: ['id:String:req:def', 'region:String:req:def'] };
    expect(blocking(compareSchemas(was, now))).toEqual([]);
  });

  it('accepts a column that merely gained a default', () => {
    const now = { ...WAS, Team: ['id:String:req:def', 'name:String:req:def'] };
    expect(blocking(compareSchemas(WAS, now))).toEqual([]);
  });
});

describe('changes a restore cannot honour', () => {
  it('refuses a column the file has and this gateway no longer does', () => {
    // Prisma rejects the unknown argument. Without this the restore fails partway through, after
    // the tables have already been emptied.
    const now = { ...WAS, NexusProvider: ['id:String:req:def', 'name:String:req:nodef'] };
    const d = compareSchemas(WAS, now);

    expect(only(d)).toEqual(['unknown-column:NexusProvider.slug']);
    expect(d[0].blocking).toBe(true);
  });

  it('refuses a required column with no default that the backup predates', () => {
    const now = { ...WAS, Team: [...WAS.Team, 'department:String:req:nodef'] };
    const d = compareSchemas(WAS, now);

    expect(only(d)).toEqual(['missing-required:Team.department']);
    expect(d[0].detail).toContain('required here with no default');
  });

  it('refuses a column whose type changed', () => {
    const now = { ...WAS, Team: ['id:String:req:def', 'name:Int:req:nodef'] };
    const d = compareSchemas(WAS, now);

    expect(only(d)).toEqual(['type-changed:Team.name']);
    expect(d[0].detail).toContain('was String');
  });

  it('refuses a column that became required with no default', () => {
    // The file may legitimately hold nulls for it, and there is nothing to put in their place.
    const was = { Team: ['id:String:req:def', 'region:String:opt:nodef'] };
    const now = { Team: ['id:String:req:def', 'region:String:req:nodef'] };
    const d = compareSchemas(was, now);

    expect(only(d)).toEqual(['now-required:Team.region']);
  });

  it('refuses a model the file has and this gateway does not', () => {
    const d = compareSchemas(WAS, { Team: WAS.Team });
    expect(only(d)).toEqual(['unknown-model:NexusProvider']);
    expect(d[0].detail).toContain('nowhere to put its rows');
  });

  it('does not report a vanished model’s columns as well as the model', () => {
    // One clear line beats a model line plus one per column, which buries it.
    expect(compareSchemas(WAS, { Team: WAS.Team })).toHaveLength(1);
  });
});

describe('the report itself', () => {
  it('puts blocking differences first, because that is what gets read', () => {
    const now = {
      NexusProvider: ['id:String:req:def', 'name:String:req:nodef', 'slug:String:req:nodef', 'tier:String:req:def'],
      Team:          ['id:String:req:def', 'name:Int:req:nodef'],
    };
    const d = compareSchemas(WAS, now);

    expect(d[0].blocking).toBe(true);
    expect(d[d.length - 1].blocking).toBe(false);
  });
});

describe('assertRestorable', () => {
  it('passes when nothing blocks, returning what it saw', () => {
    const now = { ...WAS, NexusProvider: [...WAS.NexusProvider, 'tier:String:req:def'] };
    const reported = assertRestorable(WAS, now, '1.3.2');

    expect(reported).toHaveLength(1);
    expect(reported[0].blocking).toBe(false);
  });

  it('throws a SchemaDriftError naming every blocking difference', () => {
    const now = { ...WAS, Team: [...WAS.Team, 'department:String:req:nodef'] };

    try {
      assertRestorable(WAS, now, '1.3.2');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaDriftError);
      const message = (e as Error).message;
      expect(message).toContain('1.3.2');
      expect(message).toContain('Team.department');
      expect(message).toContain('Nothing was changed');
    }
  });

  it('says nothing was changed, because nothing was — this runs before the first write', () => {
    const now = { Team: WAS.Team };
    expect(() => assertRestorable(WAS, now, '1.3.2')).toThrow(/Nothing was changed/);
  });

  it('carries the differences on the error, so a UI can list them', () => {
    const now = { Team: WAS.Team };
    try {
      assertRestorable(WAS, now, '1.3.2');
    } catch (e) {
      expect((e as SchemaDriftError).differences.length).toBeGreaterThan(0);
    }
  });

  it('does NOT refuse a backup that carries no schema at all', () => {
    // Anything written before C1. A file that predates the check has not failed it, and refusing
    // every older backup would destroy exactly the archive this feature exists to protect.
    expect(assertRestorable(null, WAS, 'unknown')).toEqual([]);
  });
});
