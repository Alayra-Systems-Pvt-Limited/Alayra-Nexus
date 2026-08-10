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

// ── The body a route sends when the caller's body did not validate ────────────────────────────
//
// Eleven admin routes used to call `schema.parse(request.body)` and let the ZodError escape into
// Fastify's handler, which has no idea what a ZodError is and answers 500. A caller's typo was
// reported as a server fault: counted as one on every error dashboard, retried by clients that
// (correctly) retry 5xx, and shown to an operator as a wall of serialised zod internals with no
// hint that the fix was theirs to make. Every other admin route in this codebase already used
// `safeParse` and answered 400; these eleven were the exception, not the rule.
//
// ── Why this is not a global ZodError → 400 rule ───────────────────────────────────────────────
//
// The tempting fix is one line in the error handler: catch ZodError, answer 400, done. It is the
// wrong fix, for the same reason `lib/kvUnavailable.ts` refuses to widen its own predicate. A
// ZodError says "this data did not match this schema" — it does NOT say whose data it was. The
// day someone validates a database row, an upstream provider's response, or a config file with
// zod, a global rule would answer the caller "your request is invalid" about data the caller never
// sent, and the real fault would be filed under their mistake.
//
// So a ZodError reaching the error handler keeps its 500 on purpose. It means a route forgot to
// validate, which is a defect in this codebase, and a loud 500 with a stack is the correct report
// of that. What stops it happening is a source-level guard — see the drift test in
// `routes/admin/malformedBody.test.ts`, which fails the build if any route reintroduces a bare
// `.parse(request.…)`.
//
// ── What may be told to the caller ────────────────────────────────────────────────────────────
//
// These routes accept credentials: `apiKey` on a provider key, `resendApiKey` on notifications.
// So the detail this returns is a deliberate projection, not a pass-through — the field's path and
// zod's own generated message, and nothing else. Zod's messages describe the *type* that arrived
// ("expected string, received number"), never the value, and the raw issue objects that would
// carry more are dropped. The projection is asserted, not assumed: `invalidBody.test.ts` checks a
// submitted secret cannot appear in the result.

import { z } from 'zod';

/** One field the caller got wrong. `field` is the dotted path; `''` means the body itself. */
export interface FieldProblem {
  field:   string;
  message: string;
}

/**
 * The 400 body. `error` is the sentence a person reads; `details` is what a client acts on.
 *
 * Note what is NOT here: `statusCode`. The dashboard tells our errors apart from Fastify's by its
 * presence (see `web/src/api.ts` → `errorText`), and adding it would make every one of these
 * render as the two useless words Fastify puts in its `error` field.
 */
export interface InvalidBody {
  error:    string;
  details:  FieldProblem[];
  /** Present only when `details` was truncated, so a cap is never a silent one. */
  omitted?: number;
}

/**
 * How many field problems to return.
 *
 * Capped because a schema can produce one issue per field per element: the guardrails schema
 * accepts 100 rules of 6 fields each, so a body of the wrong shape could ask us to serialise 600
 * problems and mail them back. Five is enough to fix a body by hand, and the count of what was
 * left out is returned alongside so the cap is visible rather than silent.
 */
export const MAX_DETAILS = 5;

/**
 * Turn a failed parse into the 400 body to send.
 *
 * `sentence` is the route's own words — what this body was supposed to be — because zod's messages
 * are about fields and a person reading a toast needs to know which form they broke.
 */
export function invalidBody(error: z.ZodError, sentence: string): InvalidBody {
  const problems: FieldProblem[] = error.issues.map((issue) => ({
    // A number in the path is an array index; joining with '.' keeps `rules.0.action` readable and
    // matches how the dashboard names its own fields.
    field:   issue.path.join('.'),
    message: issue.message,
  }));

  const body: InvalidBody = { error: sentence, details: problems.slice(0, MAX_DETAILS) };
  if (problems.length > MAX_DETAILS) body.omitted = problems.length - MAX_DETAILS;
  return body;
}
