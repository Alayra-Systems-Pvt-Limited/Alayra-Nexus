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

// Which stores this gateway is running on, and why.
//
// Phase S0 of standalone mode. This module only RESOLVES and REPORTS — it swaps nothing. The
// substitutes it names arrive later (in-memory KV in S1, SQLite in S2), and until then a resolution
// of `standalone` is a description of intent, not a working configuration. `isImplemented` below is
// what keeps this module from claiming otherwise.
//
// Deliberately free of imports: no prisma, no redis, no config module. Two reasons. It has to be
// callable before either client is constructed (lib/redis.ts throws at import time when REDIS_URL is
// unset, so anything importing it inherits that), and a pure function of its input is a function the
// whole decision matrix can be tested against without touching a process env.

/** The durable store — where rows live. */
export type DbEngine = 'postgres' | 'sqlite';

/** The ephemeral store — counters, sessions, breaker state, response cache. */
export type KvEngine = 'redis' | 'memory';

/**
 * `server` = real Postgres + real Redis; survives restarts, scales horizontally.
 * `standalone` = SQLite file + in-process memory; single machine, single process.
 */
export type NexusMode = 'server' | 'standalone';

export interface ResolvedMode {
  mode: NexusMode;
  db: DbEngine;
  kv: KvEngine;
  /**
   * True when a restart loses nothing. Both database engines persist, so in practice this tracks the
   * KV: in-process counters are the only store that forgets. SQLite's single-writer and no-replication
   * caveats are reported by `ephemeralWarning()`, not here.
   */
  durable: boolean;
  /**
   * False while the resolved combination is not yet buildable — the S1/S2 substitutes are not in
   * place. Callers must refuse to boot rather than pretend, and the banner must not announce a mode
   * the process cannot actually run.
   */
  isImplemented: boolean;
  /** Where each decision came from, in operator-readable words. Printed at boot, shown in Health. */
  reasons: string[];
  /** Fatal configuration problems. A non-empty array must stop the boot. */
  errors: string[];
}

/** Prisma names a SQLite database with a `file:` URL; everything else here is a Postgres DSN. */
function engineFromDatabaseUrl(url: string): DbEngine | null {
  const u = url.trim().toLowerCase();
  if (u.startsWith('file:')) return 'sqlite';
  if (u.startsWith('postgres://') || u.startsWith('postgresql://')) return 'postgres';
  return null;
}

function readMode(raw: string | undefined): { value: NexusMode | null; invalid: string | null } {
  const v = raw?.trim().toLowerCase();
  if (!v) return { value: null, invalid: null };
  if (v === 'server' || v === 'standalone') return { value: v, invalid: null };
  return { value: null, invalid: raw!.trim() };
}

/**
 * Work out which stores to use from the environment alone.
 *
 * Precedence, and the reasoning behind it:
 *
 * 1. **A configured URL is always honoured.** If DATABASE_URL names a Postgres, we use that Postgres
 *    — and if it is unreachable, preflight still fails loudly exactly as it does today. This is the
 *    single most important property here: a gateway must never react to a database outage by quietly
 *    demoting itself to an ephemeral store and accepting traffic it is going to lose.
 *
 * 2. **A contradiction is fatal, never guessed.** `NEXUS_MODE=standalone` alongside a DATABASE_URL is
 *    ambiguous, and both readings destroy something: honour the mode and an operator who meant
 *    production silently gets a throwaway store; honour the URL and someone who meant a sandbox
 *    writes into a real database. There is no safe default, so we refuse and say which two settings
 *    disagree.
 *
 * 3. **Absent everything, infer standalone.** This is the zero-config path — `npx`, a bare
 *    `docker run` — and the only case where nothing was asked for, so nothing can be contradicted.
 */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): ResolvedMode {
  const reasons: string[] = [];
  const errors:  string[] = [];

  const dbUrl    = env.DATABASE_URL?.trim() || '';
  const redisUrl = env.REDIS_URL?.trim() || '';
  const { value: asked, invalid } = readMode(env.NEXUS_MODE);

  if (invalid) {
    errors.push(`NEXUS_MODE is "${invalid}" — it must be "server" or "standalone" (or unset to infer from DATABASE_URL / REDIS_URL).`);
  }

  // ── Durable store ────────────────────────────────────────────────────────────
  let db: DbEngine;
  if (dbUrl) {
    const fromUrl = engineFromDatabaseUrl(dbUrl);
    if (!fromUrl) {
      errors.push('DATABASE_URL is set but its scheme is not recognised — expected "postgresql://…", "postgres://…" or "file:…".');
      db = 'postgres';   // assume the production engine so nothing downstream treats this as standalone
    } else {
      db = fromUrl;
      reasons.push(`Database: ${db === 'postgres' ? 'PostgreSQL' : 'SQLite'} — from DATABASE_URL.`);
    }
  } else {
    db = 'sqlite';
    reasons.push('Database: SQLite — no DATABASE_URL is set.');
  }

  // ── Ephemeral store ──────────────────────────────────────────────────────────
  let kv: KvEngine;
  if (redisUrl) {
    kv = 'redis';
    reasons.push('Counters and sessions: Redis — from REDIS_URL.');
  } else {
    kv = 'memory';
    reasons.push('Counters and sessions: in-process memory — no REDIS_URL is set.');
  }

  // ── Contradictions (rule 2) ──────────────────────────────────────────────────
  if (asked === 'standalone') {
    const configured = [dbUrl && 'DATABASE_URL', redisUrl && 'REDIS_URL'].filter(Boolean);
    if (configured.length > 0) {
      errors.push(
        `NEXUS_MODE=standalone contradicts ${configured.join(' and ')}. Standalone means a local SQLite file and ` +
        `in-process counters; a configured URL means a real server. Refusing to guess which you meant — unset ` +
        `${configured.join('/')} for a throwaway gateway, or drop NEXUS_MODE to use the server(s) you configured.`,
      );
    }
  }
  if (asked === 'server') {
    const missing = [!dbUrl && 'DATABASE_URL', !redisUrl && 'REDIS_URL'].filter(Boolean);
    if (missing.length > 0) {
      errors.push(
        `NEXUS_MODE=server but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. Server mode ` +
        `runs on PostgreSQL and Redis; set ${missing.join(' and ')}, or drop NEXUS_MODE to run standalone.`,
      );
    }
  }

  const mode: NexusMode = db === 'postgres' && kv === 'redis' ? 'server' : 'standalone';

  // Durability is strictly "does a restart lose rows", and by that measure BOTH database engines
  // qualify — a SQLite file persists just as a Postgres table does. Only the in-memory KV genuinely
  // forgets. SQLite's real trade-offs are single-writer and no replication, which are not durability
  // and are reported separately by ephemeralWarning(); folding them in here would have the Health
  // panel call a perfectly persistent file "not durable".
  const durable = kv !== 'memory';

  // The in-memory KV shipped in S1, so either KV is buildable. SQLite is S2 and is not, so a
  // resolution naming it must still be an honest refusal rather than a broken boot.
  const isImplemented = db === 'postgres';

  return { mode, db, kv, durable, isImplemented, reasons, errors };
}

/** What the Health panel and the boot banner call each store. */
export const DB_LABEL: Record<DbEngine, string> = { postgres: 'PostgreSQL', sqlite: 'SQLite' };
export const KV_LABEL: Record<KvEngine, string> = { redis: 'Redis', memory: 'In-process memory' };

/**
 * The one-line summary printed at boot and shown in the dashboard.
 * Example: `PostgreSQL + Redis` / `SQLite + in-process memory (data is not durable)`.
 */
export function describeMode(m: ResolvedMode): string {
  const pair = `${DB_LABEL[m.db]} + ${m.kv === 'redis' ? 'Redis' : 'in-process memory'}`;
  return m.durable ? pair : `${pair} (data is not durable)`;
}

/**
 * The caution shown wherever the mode is displayed, or null when there is nothing to warn about.
 * Split by which half is ephemeral, because the consequences differ: losing the KV costs sessions
 * and counters, losing the database costs everything.
 */
export function ephemeralWarning(m: ResolvedMode): string | null {
  if (m.db === 'sqlite' && m.kv === 'memory') {
    return 'Standalone mode: the database is a local file and counters live in memory. Sessions and rate-limit windows reset when the gateway restarts, and nothing is replicated. Not for production.';
  }
  if (m.kv === 'memory') {
    return 'Counters and sessions are held in memory: everyone is signed out and rate-limit windows reset when the gateway restarts. A single process only — a second instance would enforce its own separate limits.';
  }
  if (m.db === 'sqlite') {
    return 'The database is a local SQLite file: one writer at a time, no replication, and backups are file copies rather than pg_dump.';
  }
  return null;
}
