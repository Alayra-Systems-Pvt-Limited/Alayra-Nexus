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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toSqliteSchema, SQLITE_CLIENT_OUTPUT } from './sqliteSchema';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, 'prisma', p), 'utf8');

describe('toSqliteSchema', () => {
  it('switches the datasource provider and nothing else about it', () => {
    const out = toSqliteSchema(read('schema.prisma'));
    expect(out).toMatch(/datasource\s+db\s*\{[^}]*provider\s*=\s*"sqlite"/);
    expect(out).not.toMatch(/provider\s*=\s*"postgresql"/);
    // No `url` in either schema since Prisma 7 removed it from the datasource block. The CLI reads
    // it from prisma.config.ts and the runtime hands it to a driver adapter; a hardcoded path here
    // would make every CLI command write to it regardless.
    expect(out).not.toMatch(/\burl\s*=/);
  });

  it('sends the client somewhere other than the default, so it cannot clobber the Postgres one', () => {
    const out = toSqliteSchema(read('schema.prisma'));
    expect(out).toContain(`output   = "${SQLITE_CLIENT_OUTPUT}"`);
    expect(SQLITE_CLIENT_OUTPUT).not.toBe('');
    // The default client lives in node_modules/.prisma/client. Landing on it would leave a
    // Postgres deployment running a SQLite client — broken at the first query, not at boot.
    expect(SQLITE_CLIENT_OUTPUT.endsWith('/.prisma/client')).toBe(false);
  });

  it('carries every model across untouched', () => {
    const source = read('schema.prisma');
    const out    = toSqliteSchema(source);
    const models = [...source.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);

    expect(models.length).toBeGreaterThan(10);   // guards the regex itself, not just the result
    for (const m of models) expect(out).toMatch(new RegExp(`^model\\s+${m}\\s*\\{`, 'm'));
  });

  it('changes exactly two lines', () => {
    const source = read('schema.prisma');
    const out    = toSqliteSchema(source).split('\n').slice(7).join('\n');  // drop the generated banner
    const a = source.split('\n');
    const b = out.split('\n');

    // One line edited (the provider) and one inserted (the output), so the line count grows by 1.
    expect(b.length).toBe(a.length + 1);
    const differing = b.filter((line) => !a.includes(line));
    expect(differing.map((l) => l.trim()).sort()).toEqual([
      `output   = "${SQLITE_CLIENT_OUTPUT}"`,
      'provider = "sqlite"',
    ]);
  });

  it('leaves exactly one output line, and only on the SQLite side', () => {
    // schema.prisma must NOT carry an `output`: Prisma writes the default client into whichever
    // `@prisma/client` node resolution finds, and that is the only rule that survives npm hoisting.
    // A second output line here would also make Prisma take the last one — the Postgres path —
    // generating the SQLite client straight over the Postgres one.
    expect(read('schema.prisma')).not.toMatch(/^\s*output\s*=/m);
    const out = toSqliteSchema(read('schema.prisma'));
    expect([...out.matchAll(/^\s*output\s*=/gm)]).toHaveLength(1);
    expect(out).toContain(`output   = "${SQLITE_CLIENT_OUTPUT}"`);
  });

  it('refuses rather than silently producing a Postgres schema if the datasource moves', () => {
    expect(() => toSqliteSchema('generator client {\n}\ndatasource db {\n  provider = "mysql"\n}'))
      .toThrow(/provider = "postgresql"/);
  });

  it('refuses if the generator block moves', () => {
    expect(() => toSqliteSchema('datasource db {\n  provider = "postgresql"\n}'))
      .toThrow(/generator client/);
  });
});

describe('the committed prisma/schema.sqlite.prisma', () => {
  it('is current — run `npm run db:sqlite-schema` if this fails', () => {
    expect(read('schema.sqlite.prisma')).toBe(toSqliteSchema(read('schema.prisma')));
  });

  it('warns a reader not to edit it', () => {
    expect(read('schema.sqlite.prisma')).toMatch(/GENERATED FILE — DO NOT EDIT/);
  });
});
