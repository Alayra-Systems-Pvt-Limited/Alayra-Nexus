# File overview

Where to look, by responsibility. See [PROJECT-STRUCTURE.md](./PROJECT-STRUCTURE.md)
for the layering rule and the request path.

## `src/lib/` — pure logic, unit-tested, no I/O

| File | Responsibility |
|---|---|
| `admission.ts` | Atomic per-key RPM/TPM admission via a Redis Lua script; TPM reservation and post-response reconciliation |
| `breaker.ts` | Per-key circuit breaker: escalating cooldown, single half-open probe, flat 429 handling, auto-ban on repeated auth failure |
| `routing.ts` | Cost-aware ordering of providers within a tier (a tiebreaker, never an override) |
| `sticky.ts` | Session fingerprinting and the session→key pin that preserves a provider's prompt cache |
| `scope.ts` | BYOK routing scope. One value drives both key selection and the response-cache namespace |
| `responseCache.ts` | Exact-match cache key, entry shape, and SSE↔JSON replay conversion |
| `guardrails.ts` | Rule compilation and block/redact evaluation over messages and output |
| `tokenizer.ts` | `js-tiktoken` token counting and the pre-admission reserve estimate |
| `url.ts` | SSRF: `assertSafeUrl`, `isPrivateHost` |
| `encryption.ts` | AES-256-GCM encrypt/decrypt and key masking |
| `timingSafe.ts` | `safeEqual` — constant-time secret comparison, length-safe |
| `totp.ts` | RFC 6238 TOTP over RFC 4226 HOTP, base32, `otpauth://` URI. No dependencies |
| `startup.ts` | Startup-failure formatting; redacts credentials out of connection URLs |
| `metrics.ts` | Prometheus registry and every recording helper |
| `tracing.ts` | OpenTelemetry span for the upstream call; a no-op without an SDK |
| `rateLimitKey.ts` | Per-credential key for the abuse guard |
| `prisma.ts`, `redis.ts` | Client singletons |

## `src/services/` — side effects and configuration

| File | Responsibility |
|---|---|
| `completionsProxy.service.ts` | **The request path.** Budget → guardrails → scope → cache → route → upstream → outcome → usage |
| `nexus.service.ts` | Key selection: `discoverBestPool`, tier sweeps, sticky resolution, breaker outcome reporters, provider probes |
| `byok.service.ts` | Resolves a request's routing scope from its team |
| `adminAuth.service.ts` | Sessions, login lockout, TOTP enrolment, recovery codes, admin API tokens |
| `preflight.service.ts` | Verifies Postgres and Redis are reachable before the server starts |
| `budget.service.ts` | Per-team period spend, Redis-tracked and seeded from usage history |
| `token.service.ts` | Costs a request and emits a usage event; analytics queries |
| `usagePipeline.ts` | Buffers usage events and writes them in batches off the request path |
| `settings.service.ts` | Settings read/write with a Redis cache |
| `ssrf.service.ts`, `guardrails.service.ts`, `routing.service.ts`, `cache.service.ts` | Feature config: settings + env, off/neutral by default |
| `model.service.ts` | The model registry and its cache |

## `src/routes/` — HTTP surface

| File | Responsibility |
|---|---|
| `proxy.ts` | `/v1/chat/completions`, `/v1/models` |
| `admin/index.ts` | Registers the sub-routers below |
| `admin/guard.ts` | `adminGuard` — the single place admin auth is applied |
| `admin/auth.routes.ts` | `/admin/login` (the one unguarded admin route), TOTP, recovery codes, API tokens |
| `admin/system.routes.ts` | Dashboard config, health, API-key management, routing status, cache bust |
| `admin/settings.routes.ts` | SSRF, guardrails, cost routing, response cache, raw settings |
| `admin/providers.routes.ts` | Provider pools; credential and model validation probes |
| `admin/keys.routes.ts` | Provider keys: create (incl. BYOK owner), ban, unban, cool, test, live RPM |
| `admin/models.routes.ts` | The model registry |
| `admin/analytics.routes.ts` | Usage totals, per-team breakdown, daily time series |
| `admin/teams.routes.ts` | Teams, budgets, `byokFallback`, and the access keys they issue |

## `frontend/js/`

| File | Responsibility |
|---|---|
| `main.js` | Entry point; imports every module and bridges handlers onto `window` (temporary) |
| `state.js` | Shared mutable state and `logout()` |
| `api.js` | Authenticated admin API client |
| `utils.js` | `esc` (mandatory before `innerHTML`), `toast`, `copyText`, modal helpers |
| `auth.js` | Sign-in and session restore |
| `app.js` | Status polling, tab switching, the global click delegate |
| `demo.js` | Server-less preview mode |
| `providers.js` | Provider display metadata shared by the Pools and Models tabs |
| `tabs/connect.js` | Base URL, model id, API key, live routing status |
| `tabs/pools.js` | Provider cards, key tables, add/edit modals |
| `tabs/models.js` | Model registry editor |
| `tabs/team.js` | Team access keys |
| `tabs/analytics.js` | Charts, leaderboard, CSV export (Chart.js loaded on first paint) |
| `tabs/settings.js` | The five settings cards |

## Adding a feature

A new optional gateway feature normally touches five places:

1. `lib/<feature>.ts` + `lib/<feature>.test.ts` — the decision, pure.
2. `services/<feature>.service.ts` — its config, off by default.
3. `services/completionsProxy.service.ts` — one call, in the right position.
4. `routes/admin/settings.routes.ts` — `GET`/`PUT` for the config.
5. `frontend/js/tabs/settings.js` — a card.

If it needs a new column, add a migration under `prisma/migrations/` in the standard
Prisma layout. Flat SQL files outside that layout are silently ignored by
`prisma migrate deploy`, which runs at container startup.
