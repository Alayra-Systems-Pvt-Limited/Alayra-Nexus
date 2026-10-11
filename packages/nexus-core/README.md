# @alayrasystems/nexus-core

The request-handling core of [Alayra Nexus](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus):
the OpenAI- and Anthropic-compatible proxy, key routing and failover, rate windows, budgets and usage
accounting. **You** supply the storage and the HTTP server. The open-source gateway
(`@alayrasystems/nexus`) is built on exactly this code, with Prisma storage and its own routes.

Most people want the gateway, not this package: `npx @alayrasystems/nexus`. Use the core when you
are embedding Nexus routing in your own service and need it to use your own storage.

## What a host provides

| What | How | Notes |
|---|---|---|
| **Storage** | `configureCoreStores(() => stores)` | Five small interfaces: `keys`, `providers`, `usage`, `settings`, `notifications`. Call it once at boot. |
| **Key-value store** | `configureCoreKv(redisClient)` | An `ioredis` client, installed once at boot **before any other core call**. Installing it later throws. Without it, the core uses `REDIS_URL`, or an in-process store when that is unset. |
| **The caller** | `TeamContext` / `CallerContext` | The core never authenticates. Your server checks the API key and passes the resolved team. |
| **HTTP** | a Fastify 5 `reply` | `handleProxy(body, reply, teamKeyId, headers, team)` writes the response, streaming included. |
| **`MASTER_ENCRYPTION_KEY`** | environment | 64 hex characters (32 bytes). `KeyRow.encryptedKey` is decrypted with it (AES-256-GCM, as the open-source gateway stores keys). **The core refuses to load without it.** |

Give the core its **own Redis database** (for example `redis://host:6379/1`). Its keys carry no
prefix of yours, and an `ioredis` `keyPrefix` is not applied to the `SCAN` patterns the response-cache
purge uses.

## Minimal host

```ts
import Fastify from 'fastify';
import Redis from 'ioredis';
import { configureCoreKv, configureCoreStores, handleProxy, type TeamContext } from '@alayrasystems/nexus-core';
import { myStores } from './stores';           // your five ports
import { authenticate } from './auth';         // your API keys -> TeamContext

configureCoreKv(new Redis(process.env.CORE_REDIS_URL!));
configureCoreStores(() => myStores);

const app = Fastify();
app.post('/v1/chat/completions', async (req, reply) => {
  const caller: { teamKeyId: string; team: TeamContext } = await authenticate(req);
  return handleProxy(req.body as object, reply, caller.teamKeyId, req.headers, caller.team);
});
await app.listen({ port: 8080 });
```

## Proving your storage: `@alayrasystems/nexus-core/testing`

Every storage adapter must pass the same conformance checks. That includes the open-source Prisma
adapters, which run them on SQLite and PostgreSQL in CI. The checks use `node:assert` only, so they
run under any test runner:

```ts
import { test } from 'node:test';
import { coreStoresConformance, type CoreStoresHarness } from '@alayrasystems/nexus-core/testing';

const harness: CoreStoresHarness = {
  setup: async (fixture) => { await resetAndSeed(fixture); return myStores; },  // fresh storage holding exactly the fixture
  notifications: async () => readStoredNotifications(),                       // the sink port is write-only
};

for (const c of coreStoresConformance) test(c.name, () => c.run(harness));
```

`createMemoryCoreStores(fixture)` is an in-memory reference implementation. Use it in your own tests
or demos, never in production: nothing is shared between processes.

## Versions

This package is released together with `@alayrasystems/nexus` and carries the same version number.
Every version is published from the repository's release workflow, with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).

## Licence

Apache-2.0. "Alayra Nexus" is a trademark of Alayra Systems, and the licence does not grant use of
the name or logo. See `LICENSE` and `NOTICE`.
