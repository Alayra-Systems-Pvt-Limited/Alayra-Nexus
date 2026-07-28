/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// Restore's behaviour is proven end to end against real databases in
// src/lib/parity/backup.parity.test.ts, which is where a genuine unique index and a genuine
// transaction live. What is left here is the one guard that suite CANNOT reach.
//
// `assertNothingDropped` fires when a `replace` restore writes fewer rows than it read. That is
// impossible through readBackup — every table was emptied moments earlier inside the same
// transaction, so there is nothing left to collide with — and being unreachable is exactly the
// point of it. It is a check on OUR code being wrong, not on the operator's file being wrong.
//
// Which leaves the problem this file solves: an assertion that has never been observed to fire is
// indistinguishable from one that does not work. So it is called directly, both ways.

import { describe, it, expect } from 'vitest';
import { assertNothingDropped } from './restore';
import { MODEL_ORDER } from './modelOrder';

/** Per-model counts, defaulting every other model to zero the way readBackup does. */
function counts(over: Record<string, number> = {}): Record<string, number> {
  return { ...Object.fromEntries(MODEL_ORDER.map((m) => [m, 0])), ...over };
}

describe('assertNothingDropped', () => {
  it('passes when every row landed', () => {
    expect(() => assertNothingDropped(counts({ appSettings: 3 }), counts({ appSettings: 3 }))).not.toThrow();
  });

  it('passes when the file was empty', () => {
    expect(() => assertNothingDropped(counts(), counts())).not.toThrow();
  });

  it('throws when a row went missing', () => {
    expect(() => assertNothingDropped(counts({ appSettings: 3 }), counts({ appSettings: 2 })))
      .toThrow(/appSettings \(1 of 3 missing\)/);
  });

  it('names every model that lost rows, not just the first', () => {
    // A restore that dropped rows from three tables and named one would send somebody looking in
    // the wrong place.
    const before = counts({ appSettings: 3, adminUser: 2, tokenUsage: 10 });
    const after = counts({ appSettings: 1, adminUser: 0, tokenUsage: 10 });

    try {
      assertNothingDropped(before, after);
      throw new Error('should have thrown');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('appSettings (2 of 3 missing)');
      expect(message).toContain('adminUser (2 of 2 missing)');
      expect(message).not.toContain('tokenUsage');   // this one was fine
    }
  });

  it('says the gateway is unchanged, because it is', () => {
    // It throws from inside the transaction, so the rollback is what makes this true. An operator
    // reading a restore failure needs to know whether they are now holding half a gateway.
    expect(() => assertNothingDropped(counts({ appSettings: 1 }), counts({ appSettings: 0 })))
      .toThrow(/Nothing has been changed/);
  });

  it('does not fire when MORE rows were written than read', () => {
    // Nonsense input rather than a real case, but the guard is about a SHORTFALL. Treating "more"
    // as a failure would turn a counting bug of ours into a refusal to restore.
    expect(() => assertNothingDropped(counts({ appSettings: 1 }), counts({ appSettings: 2 }))).not.toThrow();
  });
});
