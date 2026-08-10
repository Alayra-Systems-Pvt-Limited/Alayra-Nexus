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
import { z } from 'zod';
import { invalidBody, MAX_DETAILS } from './invalidBody';

/** Parse something that will fail, and hand back the error. */
function failure(schema: z.ZodType, value: unknown): z.ZodError {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('the fixture parsed — this test needs it to fail');
  return parsed.error;
}

describe('the sentence and the fields', () => {
  const schema = z.object({ name: z.string(), weight: z.number().int() });

  it("keeps the route's own words as the sentence", () => {
    const body = invalidBody(failure(schema, { name: 1, weight: 1 }), 'That is not a valid pool.');
    expect(body.error).toBe('That is not a valid pool.');
  });

  it('names the field that was wrong', () => {
    const body = invalidBody(failure(schema, { name: 'ok', weight: 'heavy' }), '…');
    expect(body.details).toEqual([
      { field: 'weight', message: 'Invalid input: expected number, received string' },
    ]);
  });

  it('reports every wrong field, not just the first', () => {
    const body = invalidBody(failure(schema, { name: 1, weight: 'heavy' }), '…');
    expect(body.details.map((d) => d.field)).toEqual(['name', 'weight']);
  });

  it('gives a nested field its dotted path', () => {
    const nested = z.object({ rules: z.array(z.object({ action: z.enum(['block', 'redact']) })) });
    const body   = invalidBody(failure(nested, { rules: [{ action: 'block' }, { action: 'nuke' }] }), '…');
    expect(body.details[0].field).toBe('rules.1.action');
  });

  it('uses an empty field for a body that is the wrong thing entirely', () => {
    // `payload: "hello"` — there is no field to blame, so blaming one would be a lie.
    const body = invalidBody(failure(schema, 'hello'), '…');
    expect(body.details).toEqual([
      { field: '', message: 'Invalid input: expected object, received string' },
    ]);
  });
});

describe('the cap', () => {
  const wide = z.object(Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i}`, z.string()]),
  ));

  it(`returns at most ${MAX_DETAILS} problems`, () => {
    const body = invalidBody(failure(wide, {}), '…');
    expect(body.details).toHaveLength(MAX_DETAILS);
  });

  it('says how many it left out, so the cap is never silent', () => {
    const body = invalidBody(failure(wide, {}), '…');
    expect(body.omitted).toBe(12 - MAX_DETAILS);
  });

  it('says nothing about omissions when there were none', () => {
    const body = invalidBody(failure(wide, { ...Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`f${i}`, 'ok']),
    ) }), '…');
    expect(body.details).toHaveLength(1);
    expect(body).not.toHaveProperty('omitted');
  });
});

describe('what it must never hand back', () => {
  // These routes take credentials. `apiKey` on a provider key and `resendApiKey` on notifications
  // both arrive in a body that this function turns into a response — and responses are logged,
  // shown in a browser console, and pasted into support threads.
  const SECRET = 'sk-ant-api03-REAL-LOOKING-CREDENTIAL-9f3a';

  it('does not echo a rejected secret', () => {
    const schema = z.object({ apiKey: z.string().min(200) });
    const body   = invalidBody(failure(schema, { apiKey: SECRET }), '…');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('does not echo a secret sent as the wrong type either', () => {
    // The other route into an issue: `received` describes the type, and must not become the value.
    const schema = z.object({ apiKey: z.number() });
    const body   = invalidBody(failure(schema, { apiKey: SECRET }), '…');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('does not carry zod issue internals through', () => {
    // The raw issues hold `origin`, `code`, `minimum`, `values` … — a projection, not a passthrough.
    const schema = z.object({ tier: z.enum(['standard', 'premium']) });
    const body   = invalidBody(failure(schema, { tier: 'gold' }), '…');
    expect(Object.keys(body.details[0]).sort()).toEqual(['field', 'message']);
  });

  it('does not carry a statusCode', () => {
    // web/src/api.ts tells our errors from Fastify's by this field's presence. Adding it would
    // make every one of these render as Fastify's two-word "Bad Request" instead of the sentence.
    const schema = z.object({ name: z.string() });
    expect(invalidBody(failure(schema, {}), '…')).not.toHaveProperty('statusCode');
  });
});
