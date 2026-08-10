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

// ── The schema a PATCH body is parsed with ────────────────────────────────────────────────────
//
// `schema.partial()` is the obvious way to say "every field is optional here", and under zod 3 it
// was also correct: a field the caller omitted came out absent, and absent fields are the ones a
// PATCH must not write.
//
// **Zod 4 changed that.** `.partial()` now leaves `.default()` in place, so an omitted field comes
// back carrying its default — and a route that forwards the parsed body straight to
// `prisma.update()` writes that default over whatever the operator had configured.
//
//     zod 3   teamSchema.partial().parse({ name: 'Renamed' })
//             → { name: 'Renamed' }
//     zod 4   teamSchema.partial().parse({ name: 'Renamed' })
//             → { name: 'Renamed', status: 'active', budgetPeriod: 'monthly',
//                 overBudgetAction: 'block', byokFallback: true }
//
// Renaming a **suspended** team would have reactivated it. Renaming an Anthropic provider pool
// would have reset `authHeader` from `x-api-key` to `Authorization` and stopped it authenticating.
// Nothing in the suite would have said a word: the request still returns 200, the response still
// echoes a valid row, and the corrupted fields are exactly the ones nobody was looking at.
//
// So a patch schema strips the defaults first. A default answers "what should this be when it is
// created?" — a question a PATCH is not asking.
//
// Scope is deliberately the top level of the object, which is where route schemas put defaults. A
// default nested inside an array or a sub-object is not unwrapped; if one ever appears, it needs a
// decision of its own rather than a silent recursion.

import { z } from 'zod';

/**
 * The same object with every field optional and no field carrying a default.
 *
 * Returned as a `ZodType` over `Partial<…>` rather than a `ZodObject`: callers parse with it, and
 * narrowing the surface keeps the internals this has to reach for from spreading.
 */
export function patchSchema<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodType<Partial<z.infer<z.ZodObject<T>>>> {
  // Two casts, both at the zod boundary and both for the same reason: zod 4 types `.shape` as
  // readonly, and both `.shape` and `ZodDefault.unwrap()` are declared over the internal
  // `$ZodType` rather than the public `ZodType`. Saying so here keeps every call site clean.
  const shape    = schema.shape as unknown as Record<string, z.ZodType>;
  const stripped: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) {
    stripped[key] = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field;
  }
  return z.object(stripped).partial() as unknown as z.ZodType<Partial<z.infer<z.ZodObject<T>>>>;
}
