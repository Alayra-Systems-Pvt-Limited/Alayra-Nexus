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
import { resolveMode, describeMode, ephemeralWarning, resolveDatabaseUrl, pinStorageEnv, DEFAULT_DATA_DIR, DEFAULT_DB_FILE } from './mode';
import { isAbsolute, resolve as resolvePath, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';

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
  // S1 shipped the in-memory KV and S2 shipped SQLite, so every pairing this function can resolve
  // is now one the gateway can really run. Until S2.4 the last two of these were refused at boot.
  it.each([
    ['Postgres + Redis',            { DATABASE_URL: PG, REDIS_URL: REDIS }],
    ['Postgres + memory',           { DATABASE_URL: PG }],
    ['SQLite + Redis',              { DATABASE_URL: FILE, REDIS_URL: REDIS }],
    ['standalone (SQLite + memory)', {}],
  ])('marks %s as implemented', (_label, e) => {
    expect(resolveMode(env(e)).isImplemented).toBe(true);
  });

  it('never claims a configuration is buildable when the configuration itself is an error', () => {
    // isImplemented is about which ENGINES this build supports, and errors are about whether the
    // environment makes sense. The boot guard checks errors first, so a contradiction must still
    // stop the process even though both engines named in it are supported.
    const m = resolveMode(env({ NEXUS_MODE: 'standalone', DATABASE_URL: PG }));
    expect(m.errors).not.toEqual([]);
    expect(m.isImplemented).toBe(true);
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
    // The backup caution must name the -wal sidecar (S2.5), not merely say "file copies". Standalone
    // runs in WAL, so copying nexus.db alone produces a backup that silently omits the most recent
    // writes — and a warning that leaves that out is what would talk someone into doing it.
    expect(w).toMatch(/-wal/);
    expect(w).toMatch(/loses the most recent writes/i);
  });

  it('says plainly that full standalone is not for production', () => {
    expect(ephemeralWarning(resolveMode(env()))!).toMatch(/not for production/i);
  });
});

describe('resolveDatabaseUrl', () => {
  const CWD = resolvePath('/srv/app');

  it('returns a configured DATABASE_URL untouched', () => {
    // The Postgres path must be incapable of being rewritten by anything in standalone mode.
    expect(resolveDatabaseUrl(env({ DATABASE_URL: PG }), CWD)).toBe(PG);
  });

  it('trims, because a trailing newline in a .env file is not a different database', () => {
    expect(resolveDatabaseUrl(env({ DATABASE_URL: `  ${PG}\n` }), CWD)).toBe(PG);
  });

  it('passes an explicit SQLite URL through as-is', () => {
    expect(resolveDatabaseUrl(env({ DATABASE_URL: FILE }), CWD)).toBe(FILE);
  });

  it('synthesises a file path under the data directory when nothing is configured', () => {
    const url = resolveDatabaseUrl(env(), CWD);
    expect(url.startsWith('file:')).toBe(true);
    expect(url).toContain(DEFAULT_DATA_DIR);
    expect(url).toContain(DEFAULT_DB_FILE);
  });

  it('makes that path ABSOLUTE', () => {
    // Not cosmetic. Prisma resolves a relative `file:` URL against the schema file's directory,
    // not the working directory — so a relative default would put the database inside prisma/,
    // and running the gateway from a different folder would silently open a different database
    // while appearing to work.
    const path = resolveDatabaseUrl(env(), CWD).slice('file:'.length);
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(resolvePath(CWD, DEFAULT_DATA_DIR, DEFAULT_DB_FILE));
  });

  it('honours NEXUS_DATA_DIR', () => {
    const path = resolveDatabaseUrl(env({ NEXUS_DATA_DIR: 'data' }), CWD).slice('file:'.length);
    expect(path).toBe(resolvePath(CWD, 'data', DEFAULT_DB_FILE));
  });

  it('accepts an absolute NEXUS_DATA_DIR rather than nesting it under the cwd', () => {
    const abs  = resolvePath('/var/lib/nexus');
    const path = resolveDatabaseUrl(env({ NEXUS_DATA_DIR: abs }), CWD).slice('file:'.length);
    expect(path).toBe(resolvePath(abs, DEFAULT_DB_FILE));
  });

  it('ignores a blank NEXUS_DATA_DIR instead of writing to the cwd root', () => {
    const path = resolveDatabaseUrl(env({ NEXUS_DATA_DIR: '   ' }), CWD).slice('file:'.length);
    expect(path).toBe(resolvePath(CWD, DEFAULT_DATA_DIR, DEFAULT_DB_FILE));
  });

  it('agrees with resolveMode about which engine it just named', () => {
    // The two functions read the same env separately; if they ever disagreed, the gateway would
    // build one client and point it at the other engine's URL.
    for (const e of [env({ DATABASE_URL: PG }), env({ DATABASE_URL: FILE }), env()]) {
      const expected = resolveMode(e).db === 'postgres' ? 'postgres' : 'sqlite';
      const url      = resolveDatabaseUrl(e, CWD).toLowerCase();
      expect(url.startsWith('file:') ? 'sqlite' : 'postgres').toBe(expected);
    }
  });
});

describe('pinStorageEnv — making an absent variable stay absent', () => {
  it('pins both when neither is configured', () => {
    const e = env({});
    expect(pinStorageEnv(e)).toEqual(['DATABASE_URL', 'REDIS_URL']);
    expect(e.DATABASE_URL).toBe('');
    expect(e.REDIS_URL).toBe('');
  });

  it('leaves a configured value exactly as it found it', () => {
    const e = env({ DATABASE_URL: PG, REDIS_URL: REDIS });
    expect(pinStorageEnv(e)).toEqual([]);
    expect(e.DATABASE_URL).toBe(PG);
    expect(e.REDIS_URL).toBe(REDIS);
  });

  it('pins only the one that is missing', () => {
    const e = env({ DATABASE_URL: PG });
    expect(pinStorageEnv(e)).toEqual(['REDIS_URL']);
    expect(e.DATABASE_URL).toBe(PG);
    expect(e.REDIS_URL).toBe('');
  });

  // An already-empty value is already pinned. Reporting it as newly pinned would be a lie in the
  // one place a reader would use to work out whether anything was shielded.
  it('reports nothing pinned when the caller already set an empty string', () => {
    const e = env({ DATABASE_URL: '', REDIS_URL: '' });
    expect(pinStorageEnv(e)).toEqual([]);
  });

  it('changes nothing about how the mode then resolves', () => {
    const bare = resolveMode(env({}));
    const e = env({});
    pinStorageEnv(e);
    const pinned = resolveMode(e);
    expect(pinned).toEqual(bare);
    expect(pinned.mode).toBe('standalone');
  });

  it('leaves a whitespace-only value alone, and it still reads as unconfigured', () => {
    const e = env({ REDIS_URL: '   ' });
    expect(pinStorageEnv(e)).toEqual(['DATABASE_URL']);
    expect(e.REDIS_URL).toBe('   ');
    expect(resolveMode(e).kv).toBe('memory');
  });
});

// The whole fix rests on one claim about a library we do not control: a dotenv-style loader will
// not overwrite a key that is already present. Asserting that against the real dotenv is the
// difference between a test of the fix and a test of my belief about the fix — and if a future
// dotenv ever changed that behaviour, this is the test that would say so rather than a gateway
// quietly dialling a Redis nobody asked for.
describe('pinStorageEnv — against the real dotenv', () => {
  const write = (body: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'nexus-pin-')), '.env');
    writeFileSync(file, body);
    return file;
  };

  const STRAY = 'REDIS_URL=redis://stray:6379\nDATABASE_URL=postgresql://stray/db\n';

  it('without the pin, a stray file wins — this is the bug', () => {
    const file = write(STRAY);
    const e = env({});
    dotenv.config({ path: file, processEnv: e });
    expect(e.REDIS_URL).toBe('redis://stray:6379');
    expect(resolveMode(e).kv).toBe('redis');
  });

  it('with the pin, the same file cannot get in', () => {
    const file = write(STRAY);
    const e = env({});
    pinStorageEnv(e);
    dotenv.config({ path: file, processEnv: e });
    expect(e.REDIS_URL).toBe('');
    expect(e.DATABASE_URL).toBe('');
    expect(resolveMode(e)).toMatchObject({ mode: 'standalone', db: 'sqlite', kv: 'memory' });
  });

  // The pin must not become a gag order: a variable the operator really did set has to keep
  // arriving from the file it was set in.
  it('and a variable the pin did not touch still loads normally', () => {
    const file = write(`${STRAY}MASTER_ENCRYPTION_KEY=${'a'.repeat(64)}\n`);
    const e = env({});
    pinStorageEnv(e);
    dotenv.config({ path: file, processEnv: e });
    expect(e.MASTER_ENCRYPTION_KEY).toBe('a'.repeat(64));
  });
});
