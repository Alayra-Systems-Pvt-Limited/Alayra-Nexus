/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The refusals matter more than the acceptances here. Every one of these fires while somebody is
// one click from moving their production data, so each is checked for saying what is wrong AND
// what to do about it.

import { describe, it, expect } from 'vitest';
import {
  targetUrlProblem, describeTarget, countMismatches, totalRows, readableDbError,
  MIGRATE_ORDER, NOT_MIGRATED,
} from './migrateTarget';
import { MODEL_ORDER, EXCLUDED_MODELS } from './backup/modelOrder';

const GOOD = 'postgresql://nexus:s3cret@db.example.com:5432/nexusdb';

describe('judging a destination from the text alone', () => {
  it('accepts both spellings Prisma accepts', () => {
    expect(targetUrlProblem(GOOD)).toBeNull();
    expect(targetUrlProblem('postgres://nexus:s3cret@db.example.com:5432/nexusdb')).toBeNull();
  });

  it('accepts an address with no port, because the default is a real answer', () => {
    expect(targetUrlProblem('postgresql://u:p@db.example.com/nexusdb')).toBeNull();
  });

  it('asks for something rather than complaining when nothing was typed', () => {
    expect(targetUrlProblem('')).toMatch(/paste the connection string/i);
    expect(targetUrlProblem('   ')).toMatch(/paste the connection string/i);
  });

  it('names SQLite specifically, because that is a direction not a mistake', () => {
    // Someone pasting a file: path is trying to migrate the wrong way. "Unsupported scheme" would
    // leave them guessing which of the two ends they got wrong.
    expect(targetUrlProblem('file:./nexus.db')).toMatch(/SQLite file, which is what this gateway is moving away from/i);
  });

  it('names the scheme it was actually given', () => {
    expect(targetUrlProblem('mysql://u:p@h/db')).toMatch(/that address is for mysql/i);
  });

  it('refuses an address with no database name', () => {
    // Prisma would connect to a default named after the user — almost never what was meant, and
    // very hard to notice afterwards.
    expect(targetUrlProblem('postgresql://u:p@db.example.com:5432')).toMatch(/does not name a database/i);
    expect(targetUrlProblem('postgresql://u:p@db.example.com:5432/')).toMatch(/does not name a database/i);
  });

  it('refuses an address with no username', () => {
    expect(targetUrlProblem('postgresql://db.example.com:5432/nexusdb')).toMatch(/no username/i);
  });

  it('refuses text that is not a URL at all', () => {
    expect(targetUrlProblem('my database')).toMatch(/not a connection string/i);
  });

  it('tolerates surrounding whitespace, because pasted strings carry it', () => {
    expect(targetUrlProblem(`  ${GOOD}\n`)).toBeNull();
  });
});

describe('describing a destination without leaking it', () => {
  it('keeps host, port and database, and drops the credential', () => {
    const described = describeTarget(GOOD);
    expect(described).toBe('db.example.com:5432/nexusdb');
    expect(described).not.toContain('s3cret');
    expect(described).not.toContain('nexus:');
  });

  it('drops the credential even when the password contains an encoded @', () => {
    // The failure this guards: a hand-rolled "everything after the last @" would keep part of a
    // password containing one, and provider-generated passwords frequently do. They arrive
    // percent-encoded, because an unescaped @ or / makes the string an invalid URL outright — which
    // `targetUrlProblem` is what rejects, before anything reaches here.
    const described = describeTarget('postgresql://user:p%40ssword@db.example.com:5432/nexusdb');
    expect(described).toBe('db.example.com:5432/nexusdb');
    expect(described).not.toMatch(/p(%40|@)ssword/);
  });

  it('omits the port when the address did not name one', () => {
    expect(describeTarget('postgresql://u:p@db.example.com/nexusdb')).toBe('db.example.com/nexusdb');
  });

  it('never throws on text it cannot parse, because it is used on failure paths', () => {
    expect(describeTarget('nonsense')).toBe('the database you named');
    expect(describeTarget('')).toBe('the database you named');
  });
});

describe('turning a driver error into something an operator can act on', () => {
  it('drops the invocation preamble and keeps the sentence that matters', () => {
    // Verbatim, this reads as an internal error and the operator concludes the product is broken
    // rather than that they typed the wrong host.
    const raw = [
      '',
      'Invalid `prisma.$queryRaw()` invocation:',
      '',
      '',
      "Can't reach database server at `db:5432`",
      '',
      'Please make sure your database server is running.',
    ].join('\n');
    const out = readableDbError(raw);
    expect(out).not.toMatch(/invocation/i);
    expect(out).not.toMatch(/\$queryRaw/);
    expect(out).toMatch(/^Can't reach database server/);
    expect(out).toContain('Please make sure your database server is running.');
  });

  it('collapses the blank lines Prisma pads its errors with', () => {
    const padded = ['Authentication failed', '', '', 'against database server'].join('\n');
    expect(readableDbError(padded)).toBe('Authentication failed against database server');
  });

  it('passes an ordinary message through untouched', () => {
    expect(readableDbError('database "nexusdb" does not exist')).toBe('database "nexusdb" does not exist');
  });

  it('never returns nothing, however aggressive the trimming would be', () => {
    // A message nobody predicted is still better than an empty red box.
    expect(readableDbError('Invalid `prisma.$queryRaw()` invocation:')).toBe('Invalid `prisma.$queryRaw()` invocation:');
  });
});

describe('what travels and what does not', () => {
  it('carries every model the backup does, in the same parents-first order', () => {
    // Reusing MODEL_ORDER rather than a second list is the point: it is checked against the schema
    // by modelOrder.test.ts, so a new model cannot be silently left out of a migration either.
    expect(MIGRATE_ORDER).toEqual(MODEL_ORDER);
  });

  it('leaves exactly the models the backup excludes', () => {
    expect(NOT_MIGRATED).toEqual(EXCLUDED_MODELS);
  });

  it('never carries a model it also excludes', () => {
    for (const excluded of NOT_MIGRATED) expect(MIGRATE_ORDER).not.toContain(excluded);
  });
});

describe('proving every row arrived', () => {
  it('reports nothing when both sides agree', () => {
    expect(countMismatches({ team: 3, nexusKey: 9 }, { team: 3, nexusKey: 9 })).toEqual([]);
  });

  it('names the model and both counts when they differ', () => {
    expect(countMismatches({ team: 3 }, { team: 2 })).toEqual([{ model: 'team', source: 3, target: 2 }]);
  });

  it('treats a model missing from the target as zero, not as nothing to compare', () => {
    // The most serious version of this failure is a table that did not arrive at all. Skipping it
    // for want of a value would report success for exactly the case that matters most.
    expect(countMismatches({ team: 5 }, {})).toEqual([{ model: 'team', source: 5, target: 0 }]);
  });

  it('ignores extra models on the target, which are not this migration’s business', () => {
    expect(countMismatches({ team: 1 }, { team: 1, somethingElse: 4 })).toEqual([]);
  });

  it('counts an empty source as zero rather than failing', () => {
    expect(totalRows({})).toBe(0);
    expect(totalRows({ a: 2, b: 40 })).toBe(42);
  });
});
