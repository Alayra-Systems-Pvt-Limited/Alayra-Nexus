# Project structure

Alayra Nexus is a Fastify + TypeScript service (`src/`) that serves a static admin
dashboard (`frontend/`). There is no build step for the dashboard — the browser loads
ES modules directly.

```
alayra-nexus/
├── src/                    # Backend. Compiled to dist/ by `npm run build`.
│   ├── server.ts           # Composition root: plugins, static root, route registration
│   ├── routes/             # HTTP surface. No business logic.
│   ├── services/           # Stateful work: DB, Redis, provider calls, config
│   ├── lib/                # Pure, unit-tested logic. No I/O, no framework imports.
│   ├── middleware/         # Auth guards
│   └── types/              # Fastify request augmentation
├── frontend/               # Admin dashboard. Served as-is at `/`.
│   ├── index.html          # Markup shell only
│   ├── css/app.css
│   └── js/                 # ES modules; main.js is the entry point
├── prisma/                 # schema.prisma + ordered migrations
├── test/setup.ts           # Test-process env bootstrap
└── docs/architecture/      # This directory
```

## The layering rule

Dependencies point one way: **`routes/` → `services/` → `lib/`**.

- **`lib/`** is pure. Given the same inputs it returns the same outputs, touches no
  database, no Redis, and no network. Every file here has a `.test.ts` beside it.
  This is where routing decisions, rate-limit arithmetic, cache keys, guardrail
  evaluation, and SSRF checks live.
- **`services/`** owns side effects: Prisma queries, Redis reads, `fetch` to
  providers, and configuration resolved from settings + environment.
- **`routes/`** parses and validates a request, calls one service, and shapes a
  response. If a route file contains an `if` that decides *policy*, it belongs in a
  service or in `lib/`.

`lib/` never imports from `services/`. That constraint is what keeps the test suite
fast and free of mocks for the parts that matter most.

## The request path

A call to `POST /v1/chat/completions` traverses, in order:

1. **`middleware/auth.middleware.ts`** — resolve the bearer token to the main API key
   or a team key. A suspended team stops here with `403`.
2. **`services/completionsProxy.service.ts`** — the single request path. Everything
   below is orchestrated from this one file.
3. **Team budget gate** (`services/budget.service.ts`) — over-budget teams get `429`
   before any provider work happens.
4. **Input guardrails** (`lib/guardrails.ts`) — block or redact.
5. **BYOK scope resolution** (`services/byok.service.ts` → `lib/scope.ts`) — resolved
   once, then used for *both* the cache namespace and key selection.
6. **Response cache** (`lib/responseCache.ts`) — an exact-match hit is replayed from
   Redis and returns here. The provider is never called.
7. **Routing** (`services/nexus.service.ts` → `discoverBestPool`):
   - a sticky session pin, re-authorized against the scope, or
   - the team's own BYOK keys, tier by tier, then
   - the shared pool, unless the team is hard-isolated.
   Each candidate passes the **circuit breaker** (`lib/breaker.ts`) and then **atomic
   RPM/TPM admission** (`lib/admission.ts`) before it can be chosen.
8. **SSRF re-check** (`lib/url.ts`) on the resolved base URL.
9. **Upstream `fetch`**, with time-to-first-byte, body, and stream-idle timeouts.
10. **Outcome reporting** — the breaker closes or escalates; the session is pinned.
11. **Output guardrails**, then the response cache is populated.
12. **Usage** (`services/token.service.ts` → `services/usagePipeline.ts`) — buffered
    and written to Postgres in batches, off the request path.

Steps 3–12 all run against BYOK and pooled keys identically. BYOK is a *scoped pool*,
not a second proxy.

## Configuration

Every optional feature reads its config through a service that merges a
dashboard-editable setting (Postgres, Redis-cached) with an environment seed, and
defaults to off or neutral. Adding a toggle means adding a service, an admin route,
and a dashboard card — never a branch on `process.env` in the request path.

## Frontend module graph

`main.js` is the only entry point. It imports every section, then publishes the
handler functions onto `window` so the inline `onclick` attributes still in
`index.html` keep working. That bridge is temporary and is removed when the dashboard
is redesigned around delegated listeners.

```
main.js
├── state.js      shared mutable state (an object, so writes cross module boundaries)
├── api.js        GET/POST/PUT/DEL/PATCH; a 401 drops the session
├── utils.js      esc, toast, copyText, modal open/close
├── auth.js       sign-in and session restore
├── app.js        status polling, tab switching, the one click delegate
├── demo.js       server-less preview mode
├── providers.js  provider display metadata shared by two tabs
└── tabs/         connect · pools · models · team · analytics · settings
```

`esc()` from `utils.js` is mandatory for any value that originates outside the
dashboard — provider base URLs, team names, key labels, upstream error text — before
it reaches `innerHTML`.
