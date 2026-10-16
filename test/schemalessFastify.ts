/*
 * Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan)
 * & Alayra Systems LLC (USA).
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * A copy of the License is in the LICENSE file at the repository root,
 * or at http://www.apache.org/licenses/LICENSE-2.0
 */

// A Fastify instance for tests that mount a handler on a real loopback socket and declare no schema.
//
// Building a Fastify instance loads its two schema compilers (ajv and fast-json-stringify) whether
// or not any route has a schema: 110 modules, 449 KB, measured. Those tests build the instance in a
// `beforeAll`, and the first files in a full run to do so are also the first to read those modules
// from disk. On a Windows machine with the checkout on a spinning disk, under a full run (disk queue
// about 12, 64ms per uncached read), four such hooks ran past their 10s limit at once; the same
// hooks take 180ms on a warm cache. Supplying the compilers here loads one module instead of 111
// (32ms warm), and nothing a request does changes: a route with no schema never compiles one, and a
// reply with no schema is serialised with JSON.stringify either way.
//
// The compilers throw if anything ever asks for one, so a schema added to such a test later fails
// with this explanation rather than being silently skipped.

import Fastify, { type FastifyInstance } from 'fastify';

const refuse = (): never => {
  throw new Error('This test server was built without schema compilers (see test/schemalessFastify.ts); use Fastify() for a route with a schema.');
};

export function schemalessFastify(): FastifyInstance {
  return Fastify({ schemaController: { compilersFactory: { buildValidator: refuse, buildSerializer: refuse } } });
}
