import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { patchSchema } from './patchSchema';

// The regression this file exists for is silent by construction: the request still returns 200, the
// response still echoes a valid row, and the fields that were overwritten are exactly the ones
// nobody was looking at. It reached us through a dependency bump, not a code change.

const team = z.object({
  name:             z.string().min(1).max(80),
  status:           z.enum(['active', 'suspended']).default('active'),
  assignedTier:     z.enum(['premium', 'standard', 'fast']).nullish(),
  budgetPeriod:     z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
  overBudgetAction: z.enum(['block', 'notify', 'downgrade']).default('block'),
  byokFallback:     z.boolean().default(true),
});

describe('a PATCH body carries only what the caller sent', () => {
  it('leaves out every field the caller omitted', () => {
    expect(patchSchema(team).parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('produces nothing at all from an empty body', () => {
    expect(patchSchema(team).parse({})).toEqual({});
  });

  it('does not reactivate a suspended team that was merely renamed', () => {
    // The concrete harm. `.partial()` under zod 4 returns status:'active' here, and the route
    // forwards the parsed body straight to prisma.update — so renaming a team you had suspended
    // would put it back to work.
    const body = patchSchema(team).parse({ name: 'Renamed' }) as { status?: string };
    expect(body.status).toBeUndefined();
  });

  it('still writes a default-bearing field when the caller names it', () => {
    // Stripping the default must not make the field unsettable — an operator suspending a team
    // sends exactly this.
    expect(patchSchema(team).parse({ status: 'suspended' })).toEqual({ status: 'suspended' });
  });

  it('still rejects a value the schema forbids', () => {
    // The point is to drop defaults, not validation. A patch that skipped the enum check would
    // write an unroutable tier straight into the database.
    expect(patchSchema(team).safeParse({ status: 'deleted' }).success).toBe(false);
    expect(patchSchema(team).safeParse({ name: '' }).success).toBe(false);
  });

  it('keeps fields that never had a default exactly as they were', () => {
    expect(patchSchema(team).parse({ assignedTier: null })).toEqual({ assignedTier: null });
    expect(patchSchema(team).safeParse({ assignedTier: 'gold' }).success).toBe(false);
  });

  it('does not mutate the schema it was given', () => {
    // The routes build their schema once at registration and use it for POST as well. If this
    // stripped defaults in place, creating a provider would stop filling in authHeader.
    patchSchema(team);
    expect(team.parse({ name: 'New' })).toMatchObject({ status: 'active', byokFallback: true });
  });

  it('is the difference between the two, stated as an assertion', () => {
    // Kept deliberately explicit: this documents WHY the helper exists, and it fails the day zod
    // changes its mind again in either direction.
    expect(team.partial().parse({ name: 'Renamed' })).not.toEqual({ name: 'Renamed' });
    expect(patchSchema(team).parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });
});

describe('no route may go back to a bare partial', () => {
  it('is not used on a schema that carries defaults', async () => {
    // A source-level check, because the helper only protects the call sites that use it. The next
    // PATCH route someone writes will reach for `.partial()` — it is the obvious thing to write,
    // and it is wrong here.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const dir = resolve(__dirname, '..', 'routes', 'admin');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      // Comments stripped first — the call sites that were fixed each explain what they no longer
      // do, and a check that cannot tell an explanation from the thing it explains flags the fix
      // as the fault.
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\.partial\(\)/.test(code)) offenders.push(file);
    }
    expect(offenders, 'use patchSchema() instead — see src/lib/patchSchema.ts').toEqual([]);
  });
});
