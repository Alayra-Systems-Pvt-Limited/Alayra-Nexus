/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// The redaction is the security-relevant half of this module, and it is pure, so it is tested
// directly. `migrateDeploy` itself needs a database and is covered by the parity suite.

import { describe, it, expect } from 'vitest';
import { resolvePrismaCli, scrubUrls } from './prismaCli';

describe('scrubbing connection strings out of anything shown to a human', () => {
  it('removes a Postgres URL entirely, password and all', () => {
    const scrubbed = scrubUrls('Error: could not connect to postgresql://nexus:s3cret@db.example.com:5432/nexusdb');
    expect(scrubbed).not.toContain('s3cret');
    expect(scrubbed).not.toContain('db.example.com');
    expect(scrubbed).toContain('<connection string hidden>');
  });

  it('removes every one when the output repeats it', () => {
    // Prisma echoes the datasource on more than one line of a failure, and a redaction that caught
    // only the first would leak on the second.
    const scrubbed = scrubUrls([
      'datasource: postgresql://u:p@a.example.com/db',
      'retrying postgresql://u:p@a.example.com/db',
    ].join('\n'));
    expect(scrubbed).not.toContain('u:p');
    expect(scrubbed.match(/<connection string hidden>/g)).toHaveLength(2);
  });

  it('catches schemes other than postgres, because the operator may paste anything', () => {
    expect(scrubUrls('tried mysql://root:hunter2@localhost/x')).not.toContain('hunter2');
    expect(scrubUrls('tried file:///home/someone/private/nexus.db')).not.toContain('someone');
  });

  it('leaves ordinary prose alone, so a failure is still diagnosable', () => {
    const text = 'P3009: migrate found failed migrations in the target database.';
    expect(scrubUrls(text)).toBe(text);
  });

  it('does not mangle a bare host or a version string', () => {
    expect(scrubUrls('PostgreSQL 16.2 on x86_64-pc-linux-gnu')).toContain('16.2');
  });
});

describe('finding Prisma’s own entry point', () => {
  it('resolves the CLI installed alongside this package', () => {
    // The whole feature rests on this: `prisma` is a runtime dependency and the CLI ships, which is
    // what makes creating a schema in someone else's database possible at all. If this ever stops
    // being true, every migration fails at the same step and this names the reason.
    expect(resolvePrismaCli()).toMatch(/prisma[\\/]build[\\/]index\.js$/);
  });
});
