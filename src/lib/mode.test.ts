/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from 'vitest';
import { resolveMode, describeMode, ephemeralWarning } from './mode';

const PG    = 'postgresql://nexus:nexus@localhost:5432/nexus';
const REDIS = 'redis://localhost:6379';
const FILE  = 'file:./nexus.db';

/** resolveMode reads only its argument, so a test env is a plain object — no process.env mutation. */
const env = (o: Record<string, string | undefined> = {}) => o as NodeJS.ProcessEnv;

describe('resolveMode — the configuration every current deployment uses', () => {
  // The one case that must not change in any way: URLs set, NEXUS_MODE unset. Every existing
  // install is here, so a surprise error or a different engine would be a live regression.
  it('reads Postgres + Redis with no complaint', () => {
    const m = resolveMode(env({ DATABASE_URL: PG, REDIS_URL: REDIS }));
    expect(m).toMatchObject({
      mode: 'server', db: 'postgres', kv: 'redis', durable: true, isImplemented: true,
    });
    expect(m.errors).toEqual([]);
  });

  it('accepts the postgres:// spelling as well as postgresql://', () => {
    const m = resolveMode(env({ DATABASE_URL: 'postgres://u:p@h:5432/d', REDIS_URL: REDIS }));
    expect(m.db).toBe('postgres');
    expect(m.errors).toEqual([]);
  });

  it('is unbothered by surrounding whitespace', () => {
    const m = resolveMode(env({ DATABASE_URL: `  ${PG}  `, REDIS_URL: `\t${REDIS}\n` }));
    expect(m).toMatchObject({ db: 'postgres', kv: 'redis' });
    expect(m.errors).toEqual([]);
  });

  it('treats an empty-string URL as absent, not as a configured server', () => {
    const m = resolveMode(env({ DATABASE_URL: '   ', REDIS_URL: '' }));
    expect(m).toMatchObject({ db: 'sqlite', kv: 'memory' });
  });

  it('is explicitly agreeable when NEXUS_MODE=server matches the URLs', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'server', DATABASE_URL: PG, REDIS_URL: REDIS }));
    expect(m.errors).toEqual([]);
    expect(m.mode).toBe('server');
  });
});

describe('resolveMode — inference when nothing is configured', () => {
  it('infers standalone from a bare environment', () => {
    const m = resolveMode(env());
    expect(m).toMatchObject({ mode: 'standalone', db: 'sqlite', kv: 'memory', durable: false });
    expect(m.errors).toEqual([]);
  });

  it('accepts NEXUS_MODE=standalone when nothing contradicts it', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'standalone' }));
    expect(m).toMatchObject({ mode: 'standalone', db: 'sqlite', kv: 'memory' });
    expect(m.errors).toEqual([]);
  });

  it('reads a file: URL as SQLite', () => {
    const m = resolveMode(env({ DATABASE_URL: FILE }));
    expect(m).toMatchObject({ db: 'sqlite', kv: 'memory', mode: 'standalone' });
  });
});

describe('resolveMode — mixed pairings', () => {
  // Postgres with in-memory counters is coherent for a single instance: rows persist, sessions do
  // not. It is not a headline configuration but it must resolve honestly rather than be forced.
  it('allows Postgres with in-memory counters, and calls it not durable', () => {
    const m = resolveMode(env({ DATABASE_URL: PG }));
    expect(m).toMatchObject({ db: 'postgres', kv: 'memory', durable: false, mode: 'standalone' });
    expect(m.errors).toEqual([]);
  });

  it('allows SQLite with Redis, and calls it durable — a file persists', () => {
    const m = resolveMode(env({ DATABASE_URL: FILE, REDIS_URL: REDIS }));
    expect(m).toMatchObject({ db: 'sqlite', kv: 'redis', durable: true });
    expect(m.errors).toEqual([]);
  });
});

describe('resolveMode — refuses to guess a destructive ambiguity', () => {
  // Both readings of this configuration destroy something: honour the mode and an operator who meant
  // production gets a throwaway store; honour the URL and a sandbox writes into a real database.
  // There is no safe default, so it is an error naming both settings.
  it('rejects NEXUS_MODE=standalone alongside DATABASE_URL', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'standalone', DATABASE_URL: PG }));
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0]).toContain('DATABASE_URL');
    expect(m.errors[0]).toMatch(/refusing to guess/i);
  });

  it('rejects NEXUS_MODE=standalone alongside REDIS_URL', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'standalone', REDIS_URL: REDIS }));
    expect(m.errors[0]).toContain('REDIS_URL');
  });

  it('names both URLs when both contradict standalone', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'standalone', DATABASE_URL: PG, REDIS_URL: REDIS }));
    expect(m.errors[0]).toContain('DATABASE_URL');
    expect(m.errors[0]).toContain('REDIS_URL');
  });

  it('rejects NEXUS_MODE=server with no URLs, naming what is missing', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'server' }));
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0]).toContain('DATABASE_URL');
    expect(m.errors[0]).toContain('REDIS_URL');
  });

  it('rejects NEXUS_MODE=server when only Redis is missing', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'server', DATABASE_URL: PG }));
    expect(m.errors[0]).toContain('REDIS_URL');
    expect(m.errors[0]).not.toContain('DATABASE_URL is');
  });
});

describe('resolveMode — malformed input', () => {
  it('rejects an unrecognised NEXUS_MODE and lists the valid values', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'sqlite', DATABASE_URL: PG, REDIS_URL: REDIS }));
    expect(m.errors[0]).toContain('"sqlite"');
    expect(m.errors[0]).toContain('standalone');
  });

  it('accepts a differently-cased NEXUS_MODE', () => {
    const m = resolveMode(env({ NEXUS_MODE: 'ServeR', DATABASE_URL: PG, REDIS_URL: REDIS }));
    expect(m.errors).toEqual([]);
    expect(m.mode).toBe('server');
  });

  it('rejects a DATABASE_URL whose scheme is not a database it can drive', () => {
    const m = resolveMode(env({ DATABASE_URL: 'mysql://u:p@h/d', REDIS_URL: REDIS }));
    expect(m.errors[0]).toMatch(/scheme is not recognised/i);
  });

  // A rejected DATABASE_URL must not be read as "no database configured" — that would turn a typo
  // into a silent standalone boot, which is the single outcome this module exists to prevent.
  it('does not fall through to standalone when DATABASE_URL is unusable', () => {
    const m = resolveMode(env({ DATABASE_URL: 'mysql://u:p@h/d', REDIS_URL: REDIS }));
    expect(m.db).toBe('postgres');
    expect(m.mode).toBe('server');
  });
});

describe('resolveMode — what is actually buildable today', () => {
  // S1 shipped the in-memory KV, so either counter store works. SQLite is S2 and does not exist
  // yet, so a resolution naming it must still be refused at boot rather than half-run.
  it.each([
    ['Postgres + Redis',  { DATABASE_URL: PG, REDIS_URL: REDIS }],
    ['Postgres + memory', { DATABASE_URL: PG }],
  ])('marks %s as implemented', (_label, e) => {
    expect(resolveMode(env(e)).isImplemented).toBe(true);
  });

  it.each([
    ['standalone (SQLite + memory)', {}],
    ['SQLite + Redis',               { DATABASE_URL: FILE, REDIS_URL: REDIS }],
  ])('marks %s as not yet implemented — the database is what is missing', (_label, e) => {
    expect(resolveMode(env(e)).isImplemented).toBe(false);
  });
});

describe('resolveMode — provenance', () => {
  it('explains where each choice came from', () => {
    const m = resolveMode(env({ DATABASE_URL: PG, REDIS_URL: REDIS }));
    expect(m.reasons.join(' ')).toMatch(/PostgreSQL.*DATABASE_URL/);
    expect(m.reasons.join(' ')).toMatch(/Redis.*REDIS_URL/);
  });

  it('says which variable was missing when it inferred', () => {
    const m = resolveMode(env());
    expect(m.reasons.join(' ')).toMatch(/no DATABASE_URL/);
    expect(m.reasons.join(' ')).toMatch(/no REDIS_URL/);
  });
});

describe('describeMode', () => {
  it('names the pair without a caveat when durable', () => {
    expect(describeMode(resolveMode(env({ DATABASE_URL: PG, REDIS_URL: REDIS }))))
      .toBe('PostgreSQL + Redis');
  });

  it('appends the caveat when a restart would lose something', () => {
    expect(describeMode(resolveMode(env())))
      .toBe('SQLite + in-process memory (data is not durable)');
  });
});

describe('ephemeralWarning', () => {
  it('says nothing about a production pairing', () => {
    expect(ephemeralWarning(resolveMode(env({ DATABASE_URL: PG, REDIS_URL: REDIS })))).toBeNull();
  });

  it('warns about sign-out and reset windows when only the KV is in memory', () => {
    const w = ephemeralWarning(resolveMode(env({ DATABASE_URL: PG })))!;
    expect(w).toMatch(/signed out/i);
    expect(w).toMatch(/single process/i);
  });

  it('warns about single-writer and backups when only the database is SQLite', () => {
    const w = ephemeralWarning(resolveMode(env({ DATABASE_URL: FILE, REDIS_URL: REDIS })))!;
    expect(w).toMatch(/one writer/i);
    expect(w).toMatch(/pg_dump/);
  });

  it('says plainly that full standalone is not for production', () => {
    expect(ephemeralWarning(resolveMode(env()))!).toMatch(/not for production/i);
  });
});
