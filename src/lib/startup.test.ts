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
import { redactUrl, formatStartupFailure } from './startup';

describe('redactUrl', () => {
  it('reduces a URL to host:port', () => {
    expect(redactUrl('redis://localhost:6379')).toBe('localhost:6379');
    expect(redactUrl('postgresql://nexus:nexus@localhost:5432/nexus')).toBe('localhost:5432');
  });

  it('omits the port when the URL has none', () => {
    expect(redactUrl('redis://cache.internal')).toBe('cache.internal');
  });

  // This string is printed to stdout and scraped into log aggregators.
  it('never leaks a password', () => {
    expect(redactUrl('redis://:sup3rs3cret@cache.internal:6379')).not.toContain('sup3rs3cret');
    expect(redactUrl('postgresql://admin:hunter2@db:5432/nexus')).not.toContain('hunter2');
    expect(redactUrl('postgresql://admin:hunter2@db:5432/nexus')).not.toContain('admin');
  });

  it('does not echo an unparseable value back', () => {
    expect(redactUrl('redis//:secret@nope')).toBe('(unparseable URL)');
    expect(redactUrl(undefined)).toBe('(not set)');
    expect(redactUrl('')).toBe('(not set)');
  });
});

describe('formatStartupFailure', () => {
  it('names the service, the setting, and the command that starts it', () => {
    const msg = formatStartupFailure('redis', 'redis://localhost:6379', new Error('connect ECONNREFUSED'));
    expect(msg).toContain('Cannot reach Redis at localhost:6379');
    expect(msg).toContain('REDIS_URL=localhost:6379');
    expect(msg).toContain('connect ECONNREFUSED');
    expect(msg).toContain('docker compose up -d redis');
  });

  it('tells the database case to run migrations too', () => {
    const msg = formatStartupFailure('database', 'postgresql://nexus:nexus@localhost:5432/nexus', new Error('ECONNREFUSED'));
    expect(msg).toContain('Cannot reach PostgreSQL at localhost:5432');
    expect(msg).toContain('docker compose up -d postgres');
    expect(msg).toContain('npm run migrate');
  });

  it('keeps credentials out of the rendered message', () => {
    const msg = formatStartupFailure('database', 'postgresql://admin:hunter2@db:5432/nexus', new Error('nope'));
    expect(msg).not.toContain('hunter2');
  });

  it('survives a non-Error rejection', () => {
    expect(formatStartupFailure('redis', 'redis://h:1', 'plain string')).toContain('plain string');
  });
});

describe('formatStartupFailure — on SQLite, where every Postgres word is wrong', () => {
  const msg = () => formatStartupFailure('database', 'file:/app/.nexus/nexus.db', new Error('unable to open the database file'));

  it('names SQLite, not PostgreSQL', () => {
    expect(msg()).toContain('Cannot reach SQLite');
    expect(msg()).not.toContain('PostgreSQL');
  });

  it('prints the file it could not open, instead of an empty address', () => {
    // A file: URL has no hostname, so the host:port reduction rendered this as nothing at all.
    expect(msg()).toContain('/app/.nexus/nexus.db');
  });

  it('does not tell the operator to start a server that does not exist', () => {
    expect(msg()).not.toContain('docker compose up -d postgres');
    expect(msg()).not.toContain('npm run migrate');
  });

  it('points at the real cause — a directory it cannot write', () => {
    expect(msg()).toContain('writable');
    expect(msg()).toContain('NEXUS_DATA_DIR');
  });

  it('leaves the PostgreSQL case exactly as it was', () => {
    const pg = formatStartupFailure('database', 'postgresql://u:p@db:5432/nexus', new Error('ECONNREFUSED'));
    expect(pg).toContain('Cannot reach PostgreSQL at db:5432');
    expect(pg).toContain('npm run migrate');
    expect(pg).not.toContain('hunter2');
  });
});

describe('redactUrl — SQLite', () => {
  it('shows the path rather than an empty host', () => {
    expect(redactUrl('file:/app/.nexus/nexus.db')).toBe('/app/.nexus/nexus.db');
  });

  it('still reduces a server URL to host:port', () => {
    expect(redactUrl('postgresql://admin:hunter2@db:5432/nexus')).toBe('db:5432');
  });
});
