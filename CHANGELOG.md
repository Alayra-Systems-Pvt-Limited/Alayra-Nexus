# Changelog

All notable changes to Alayra Nexus™ are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `model: "alayra-nexus-1"` routing contract is the public API surface covered by
semver. The legacy ids `kinetic-nexus-1` and `nexus` remain accepted as aliases.

## [Unreleased]

### Added
- **Architecture docs** (`docs/architecture/`): `PROJECT-STRUCTURE.md` covers the
  layering rule and the full request path; `FILE-OVERVIEW.md` is a where-to-look
  index and a checklist for adding a feature.
- **BYOK — bring your own key (Phase 5.5):** a provider key can now be owned by a
  team (`ownerTeamId`) instead of living in the shared pool. An owned key serves only
  that team's traffic. Routing tries the team's own keys first, then — if the team's
  new `byokFallback` flag allows it — the shared pool; with fall-back disabled the
  team is hard-isolated and gets `503` rather than a credential it did not bring.
  Owned keys are a *scoped pool*, not a parallel proxy: they reuse the same admission
  control, circuit breaker, guardrails, SSRF checks, and analytics pipeline. A caller
  with no team can never be routed through an owned key. Responses carry
  `X-Nexus-BYOK: true`, and `nexus_byok_requests_total{result}` tracks
  own / fallback / isolated_block. Configure via **Pools → + Key → Owner**, or
  `POST /admin/providers/:providerId/keys`.

### Changed
- **Repository layout.** The admin dashboard moved from `public/` to `frontend/`,
  where its CSS and JavaScript are now separate files rather than one inline
  `<script>`; `frontend/js/` is a set of ES modules and is linted like the rest of
  the source. The admin API moved from `src/routes/admin.ts` to `src/routes/admin/`,
  split by resource. No endpoint, request, or response changed. If you mount or copy
  the dashboard yourself, update the path.
- **The response cache is now partitioned by routing scope.** A response produced by
  a team's private key is never replayed to another team or to the shared pool. This
  changes the cache key, so entries written by an earlier version are ignored and the
  cache repopulates naturally over one TTL after upgrade.
- **Deleting a team now also deletes the provider keys it owns.** Its *access* keys
  still survive, unassigned, losing only their budget cap. Releasing a private
  credential into the shared pool — where every other caller could route through it —
  is not an acceptable outcome of a delete. `DELETE /admin/teams/:id` returns
  `deletedOwnedKeys` so a caller can report what went with it.
- BYOK spend is costed, attributed, and counted against the team's budget cap. Set
  `budgetUsd: null` for a team that funds its own keys and should not be capped.

### Fixed
- **The admin dashboard is now present in the container image.** The runtime stage
  never copied the dashboard's static files, and `@fastify/static` only logs a
  warning for a missing root — so published images started cleanly, served the API
  correctly, and returned `404` for `/`. Affects `v1.0.0` and `v1.1.0`; if you run
  the image, pull again once the next tag is published. Source installs were never
  affected.
- **Tier-downgrade reporting.** `X-Nexus-Tier-Downgrade` was set on every request a
  non-premium tier served, including deployments that never configured a premium
  provider. It now means what it says: a higher tier existed and could not serve the
  request.
- **Dashboard:** provider base URLs, team-key names, key labels, and error text are
  escaped before reaching `innerHTML`, and copy-button values moved out of inline
  `onclick` strings into `data-` attributes read by a delegated listener. A value
  containing a quote could previously break out of the attribute it sat in.
- **Dashboard:** a failed model-registry save no longer leaves the local registry
  holding the rejected change, which the next save would have persisted.
- **Dashboard:** the key "Test" button no longer stays stuck reading `err` when the
  request itself throws. The analytics charts now index their series once instead of
  rescanning the full result set for every plotted point.

- **Response caching (Phase 4.5):** optional exact-match response cache. When enabled,
  an identical request (same model + messages + generation params) is served from
  Redis, skipping the provider entirely — a real $0 call. The cache key excludes
  `stream`/`user`, so a hit is replayed in whichever mode the client asked for; every
  hit emits a $0 usage event attributed to the team (analytics stay honest, budget is
  not consumed). Tool-call and `n > 1` responses are not cached. Off by default;
  configurable via `CACHE_ENABLED` / `CACHE_TTL_SECONDS`, the dashboard Settings tab,
  or `GET/PUT /admin/settings/cache`. Responses carry `X-Nexus-Cache: hit|miss`, and a
  `nexus_response_cache_total{result}` metric tracks hit/miss/store.

## [1.1.0] - 2026-07-09

### Added
- **Teams & budget hierarchy (Phase 5):** a `Team` entity groups scoped access keys
  and carries a per-period USD budget cap (daily / weekly / monthly). Enforcement
  runs on the admission path: over-budget teams get `429` + `Retry-After` (window
  reset), suspended teams get `403`. Spend is Redis-tracked and seeded from real
  usage history, so caps set mid-period start from actual spend and survive a Redis
  restart. New admin API: `GET/POST/PATCH/DELETE /admin/teams` (list includes live
  period spend), team assignment on key creation, and `PATCH /admin/team-keys/:id`
  to reassign. Existing keys without a team are unaffected.
- **Observability (Phase 4.6):** a Prometheus-compatible `/metrics` endpoint —
  request rate/duration, upstream TTFB, tokens, cache-hit rate, per-provider
  request/error rates, pool utilization, and standard process metrics. Auth-guarded
  by `METRICS_TOKEN` (or `ADMIN_PASSWORD`), exempt from the abuse guard's rate limit.
  Optional OpenTelemetry span for the gateway→provider call (no-op without an SDK).
- README "Connect your tools" section with copy-paste setup for Cursor, Cline / Roo
  Code, Continue.dev, the OpenAI SDK (Python + Node), and curl.

### Fixed
- **Database migrations now actually apply.** The migration files were flat SQL that
  `prisma migrate deploy` (run by the container at startup) silently ignored — a
  fresh `docker run` database got no tables, and Compose installs missed the
  post-init migration. Migrations now use the standard Prisma layout and are applied
  in order on startup; the Compose initdb mount was removed as redundant.
  **Existing deployments** whose schema was created by the old initdb path should
  baseline once before upgrading:
  `npx prisma migrate resolve --applied 0001_init && npx prisma migrate resolve --applied 0002_team_key_usage`
  (or use `npm run db:push`).

## [1.0.0] - 2026-07-09

First tagged release and first published container image
(`ghcr.io/alayra-systems-pvt-limited/alayra-nexus`).

### Added
- **OpenAI-compatible proxy** (`/v1/chat/completions`) with full streaming
  pass-through and a single virtual model, `alayra-nexus-1`.
- **Real admission control** — atomic per-key RPM/TPM enforcement via a Redis Lua
  script, a real tokenizer (`js-tiktoken`) for pre-admission estimates, TPM
  reservation with post-response reconciliation, and upstream TTFT / body /
  stream-idle timeouts.
- **Circuit breaker** — per-key escalating cooldown, a single half-open recovery
  probe, separate flat handling for 429s, and auto-ban on repeated auth failures.
- **Cache-aware sticky routing** — multi-turn conversations stay pinned to the key
  that last served them so provider prompt caches are reused.
- **Cost-aware routing** (optional) — bias toward the cheapest healthy, in-headroom
  provider within a tier, as a tiebreaker that never overrides health or cache
  affinity.
- **Content guardrails** (optional) — pluggable prompt/response filtering to redact
  PII or block banned content / injection patterns.
- **SSRF protection** — outbound provider requests are restricted to http(s) and
  blocked from private/loopback/internal hosts by default, with an opt-in allowlist.
- **Async analytics pipeline** — usage events are buffered and written to Postgres
  in batched inserts off the request path.
- **Abuse guard** — a Redis-backed, per-credential rate limiter sized as a DoS
  backstop rather than a throughput cap.
- **Admin dashboard** — provider pools, model registry, team keys, analytics, and a
  Settings tab (network security, guardrails, cost-aware routing).
- **Distribution** — multi-arch (amd64 + arm64) Docker image, `docker compose`
  quickstart, CI (lint / typecheck / test / build / security audit), and CodeQL
  scanning.

### Fixed
- Container image: install OpenSSL in the Alpine build and runtime stages so Prisma
  resolves the correct `openssl-3.0.x` engine instead of mis-guessing `1.1.x`, which
  could otherwise fail the query engine at container startup.

### Security
- Apache-2.0 licensed. Outbound SSRF blocking on by default; secrets encrypted at
  rest with AES-256-GCM.

### Known gaps (roadmap)
- Constant-time comparison and 2FA for admin auth (Phase 6) are not yet in place;
  protect the admin password and API key accordingly for now.

[Unreleased]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/releases/tag/v1.0.0
