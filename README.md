<div align="center">

<br>

<img src="./brand/png/alayra-nexus-banner-readme.png" alt="Alayra Nexus — The Enterprise AI Gateway" width="100%"/>

<br>

**One OpenAI-compatible endpoint. Every model. Zero key chaos.**

<br>

[![CI](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-6d28d9.svg?style=for-the-badge)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Alayra-Systems-Pvt-Limited/Alayra-Nexus?style=for-the-badge&color=0e7490)](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/releases)
[![Container](https://img.shields.io/badge/ghcr.io-alayra--nexus-2496ed.svg?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/pkgs/container/alayra-nexus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3b82f6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-v5-22c55e.svg?style=for-the-badge)](https://fastify.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-f59e0b.svg?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-0ea5e9.svg?style=for-the-badge&logo=postgresql&logoColor=white)](https://prisma.io/)

<br>

Route **Anthropic Claude**, **OpenAI GPT**, **Google Gemini**, **Groq**, and **OpenRouter**  
through a single hardened proxy. Pool multiple API keys per provider, load-balance  
across them, auto-failover between tiers, and give every team their own scoped key —  
with full usage analytics and cost tracking built in.

<br>

> Built and maintained by **[Alayra Systems Pvt. Limited](https://github.com/Alayra-Systems-Pvt-Limited)** · Islamabad, Pakistan

<br>

</div>

---

## Why Alayra Nexus?

Most teams hit the same wall: multiple AI providers, API keys scattered across engineers, no visibility into who spent what, and a hard-coded provider string that makes switching models painful.

Alayra Nexus is the infrastructure layer that sits between your application and every AI provider. Change **one URL**. Get load balancing, automatic failover, team-level access control, and a live cost dashboard — without touching your application code.

---

## Features

| Capability | Details |
|---|---|
| **Key Pool Management** | Store unlimited API keys per provider, encrypted at rest with AES-256-GCM |
| **Intelligent Load Balancing** | Automatic rotation across active keys; cooling and banned keys are automatically bypassed |
| **Circuit Breaker** | Per-key breaker with escalating cooldown, a single half-open recovery probe, separate 429 handling, and auto-ban on repeated auth failures |
| **Cache-Aware Sticky Routing** | Multi-turn conversations stay pinned to the same upstream so the provider's prompt cache isn't thrown away by round-robin |
| **Content Guardrails** | Optional, pluggable prompt/response filtering — redact PII or block banned content and injection patterns. Off by default |
| **Tiered Failover** | Premium → Standard → Fast chains; when the best key fails the next tier fires instantly |
| **Cost-Aware Routing** | Optional: within a tier, bias toward the cheapest healthy, in-headroom provider using registry pricing — a tiebreaker that never overrides health or cache affinity |
| **OpenAI-Compatible API** | Drop-in `/v1/chat/completions` — change one base URL, nothing else |
| **Team Key Issuance** | Create scoped access tokens per team, each with an independently configurable RPM limit |
| **BYOK (Bring Your Own Key)** | A team can register its own provider keys, encrypted at rest and routed only for that team's traffic — with optional fall-back to the shared pool, or hard isolation |
| **Real-Time Rate Limiting** | Per-key RPM enforcement via Redis with live utilization meters (per-key TPM budgets are configurable; enforcement is on the roadmap) |
| **Cost Tracking** | Per-request USD cost computed from model pricing, attributed to the requesting team |
| **Full Analytics Dashboard** | Request trends, token breakdowns, team leaderboard, provider split — powered by Chart.js |
| **Custom Date Ranges** | Analytics filterable by today / 7d / 30d / 90d or any custom from→to window |
| **CSV Export** | One-click export of all analytics data for finance or reporting |
| **Model Registry** | Manage which models are available, their tier, capabilities, and per-1M token pricing |
| **Web Admin Dashboard** | Full browser UI — no CLI required for day-to-day operations |
| **Security Hardened** | Fastify Helmet, CORS, bcrypt admin auth, AES-256-GCM key encryption, zero plaintext secrets at rest |

---

## Supported Providers

| Provider | Models |
|---|---|
| **Anthropic** | Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Haiku, and all Claude variants |
| **OpenAI** | GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo, o1, o3-mini |
| **Google** | Gemini 1.5 Pro, Gemini 1.5 Flash, Gemini 2.0 Flash |
| **Groq** | LLaMA 3.1 405B / 70B, Mixtral 8x7B, Gemma 7B |
| **OpenRouter** | Any model in OpenRouter's catalog via a single unified key |
| **Custom** | Any OpenAI-compatible endpoint via configurable base URL |

---

## Architecture

```
  Your Application / IDE / Agent / Script
           │
           │  POST /v1/chat/completions
           │  Authorization: Bearer <team-key>   ← optional, enables per-team analytics
           ▼
  ┌──────────────────────────────────────────────────────────┐
  │                   Alayra Nexus Gateway                  │
  │                                                          │
  │   ┌───────────────┐          ┌─────────────────────────┐ │
  │   │  Team Auth    │          │     Rate Limiter        │ │
  │   │  SHA-256 hash │          │   RPM / TPM via Redis   │ │
  │   └───────┬───────┘          └──────────┬──────────────┘ │
  │           └─────────────┬───────────────┘                │
  │                    ┌────▼───────┐                        │
  │                    │   Router   │                        │
  │                    │  Premium   │                        │
  │                    │  Standard  │  ← tiered failover     │
  │                    │   Fast     │                        │
  │                    └────┬───────┘                        │
  │        ┌────────────────┼──────────────┬──────────────┐  │
  │        ▼                ▼              ▼              ▼  │
  │    Anthropic          OpenAI        Google           Groq │
  │    (Claude)           (GPT)        (Gemini)      OpenRouter│
  └──────────────────────────────────────────────────────────┘
           │
           ▼
    Token usage → async buffer → batched PostgreSQL write
    Real-time metrics  → Redis
    Analytics          → Admin Dashboard
```

---

## Quick Start

### Option A — Published image (fastest, no clone)

A multi-arch image (amd64 + arm64) is published to the GitHub Container Registry. If
you already have Postgres and Redis, run the gateway with one command:

```bash
docker run -d --name alayra-nexus -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/nexus" \
  -e REDIS_URL="redis://host:6379" \
  -e MASTER_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -e ADMIN_PASSWORD="change-me" \
  ghcr.io/alayra-systems-pvt-limited/alayra-nexus:latest
```

Pin a version for production (e.g. `:1.0.0`) rather than `:latest`.

### Option B — Docker Compose (brings its own Postgres + Redis)

```bash
git clone https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus.git
cd alayra-nexus

cp .env.example .env
# Edit .env — set MASTER_ENCRYPTION_KEY, ADMIN_PASSWORD, and DB/Redis URLs

docker compose up -d
```

Dashboard is live at `http://localhost:3000/dashboard`

---

### Option C — Manual Setup

**Prerequisites:** Node.js 20+, PostgreSQL 15+, Redis 7+

```bash
git clone https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus.git
cd alayra-nexus

npm install

cp .env.example .env
# Edit .env with your values

# Generate a secure MASTER_ENCRYPTION_KEY (run this once and save it):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Run database migrations
npx prisma migrate deploy

# Start
npm run dev          # development — hot reload via tsx
npm run build && npm start   # production
```

Dashboard is live at `http://localhost:3000/dashboard`

---

## Connect your tools

Alayra Nexus speaks the OpenAI API, so **any tool that lets you set a custom base URL works.** You only need three values:

- **Base URL:** `http://<your-host>:3000/v1`
- **API key:** a team key from the dashboard, sent as `Authorization: Bearer <key>`
- **Model:** `alayra-nexus-1`

### Cursor
Settings → **Models** → enable **OpenAI API Key**, paste your team key, tick **Override OpenAI Base URL** and set it to `http://<your-host>:3000/v1`. Add a custom model named `alayra-nexus-1`.

### Cline / Roo Code (VS Code)
API Provider → **OpenAI Compatible** → Base URL `http://<your-host>:3000/v1`, API Key = your team key, Model ID `alayra-nexus-1`.

### Continue.dev
```json
{
  "models": [
    {
      "title": "Alayra Nexus",
      "provider": "openai",
      "model": "alayra-nexus-1",
      "apiBase": "http://<your-host>:3000/v1",
      "apiKey": "<your-team-key>"
    }
  ]
}
```

### OpenAI SDK — Python
```python
from openai import OpenAI

client = OpenAI(base_url="http://<your-host>:3000/v1", api_key="<your-team-key>")
resp = client.chat.completions.create(
    model="alayra-nexus-1",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

### OpenAI SDK — Node
```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://<your-host>:3000/v1",
  apiKey: "<your-team-key>",
});
const resp = await client.chat.completions.create({
  model: "alayra-nexus-1",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(resp.choices[0].message.content);
```

### curl
```bash
curl http://<your-host>:3000/v1/chat/completions \
  -H "Authorization: Bearer <your-team-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"alayra-nexus-1","messages":[{"role":"user","content":"Hello"}]}'
```

> Streaming works everywhere — add `"stream": true` (or the client's streaming flag). Running Nexus behind TLS? Use your `https://…/v1` URL instead.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`) |
| `REDIS_URL` | Yes | Redis connection string (`redis://localhost:6379`) |
| `MASTER_ENCRYPTION_KEY` | Yes | 64 hex characters (32 bytes) — encrypts all stored API keys |
| `ADMIN_PASSWORD` | Yes | Dashboard admin password |
| `PORT` | No | HTTP port (default: `3000`) |
| `LOG_LEVEL` | No | Pino log level: `info`, `debug`, `warn` (default: `info`) |
| `ABUSE_RATE_LIMIT_MAX` | No | Requests **per credential** per window before the abuse guard trips (default: `12000`). This is DoS/abuse protection, **not** a throughput cap — see [Rate limits, explained](#rate-limits-explained). |
| `ABUSE_RATE_LIMIT_WINDOW` | No | Abuse-guard window (default: `1 minute`) |
| `NEXUS_DEFAULT_MAX_TOKENS` | No | Output tokens reserved against a key's TPM budget when a request omits `max_tokens` (default: `2048`; reconciled to real usage afterward) |
| `UPSTREAM_TTFT_MS` | No | Abort if a provider doesn't return response headers within this many ms (default: `20000`) |
| `UPSTREAM_BODY_MS` | No | Non-streaming: max ms to read the full response body (default: `60000`) |
| `UPSTREAM_STREAM_IDLE_MS` | No | Streaming: max ms gap between chunks before a hung stream is aborted (default: `30000`) |

> [!IMPORTANT]
> Generate `MASTER_ENCRYPTION_KEY` with:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> This key encrypts every provider API key stored in your database. Keep it secret. Keep a backup. Never reuse it across deployments.

---

## Rate limits, explained

Alayra Nexus has **two independent limits**, and it's important not to confuse them:

| Limit | Where | What it does | Who sets it |
|---|---|---|---|
| **Per-key RPM / TPM** | Inside the pool, per provider key | The **real** throughput control. Enforced exactly against what each provider allows a given key (e.g. "this key: 60 RPM, 100K TPM"). This is what keeps you inside your providers' contracts. | Set per key in the dashboard |
| **Abuse guard** | At the server edge, per credential | A generous DoS/abuse backstop, **not** a throughput cap. Sized well above any single credential's legitimate rate so it never interferes with real traffic — it only trips on a runaway or malicious client. | `ABUSE_RATE_LIMIT_MAX` env var |

**Your gateway's real ceiling is the sum of your active keys' RPM limits** — pool more
keys and that ceiling rises. The abuse guard should always sit comfortably *above* that
number, never below it.

> [!IMPORTANT]
> Size `ABUSE_RATE_LIMIT_MAX` above the busiest **single** credential's expected rate,
> not your whole pool's. Because the guard is keyed per credential (each team key gets
> its own bucket), a fleet of team keys can collectively far exceed this number — but if
> you route most traffic through one key, give that key headroom. The default of `12000`
> per minute (200 req/s) suits most self-hosters; raise it if a single key legitimately
> drives more.

The guard is Redis-backed, so the limit stays correct even when you run multiple Nexus
replicas behind a load balancer, and it **fails open** — if Redis is briefly unreachable,
requests are allowed through rather than blocked.

---

## Resilience & routing

### Circuit breaker

Every key in the pool sits behind a per-key circuit breaker, so one failing provider
never keeps taking traffic it can't serve. The breaker state lives in Redis, so it stays
consistent across every Nexus replica.

| Failure | How the breaker reacts |
|---|---|
| **5xx / timeout / hung stream** | Counts as a strike. After **3** consecutive strikes in a 5-minute window the key trips **open** and is skipped by the router. |
| **Cooldown** | **Escalates** on each successive trip — 10s → 20s → 40s … doubling up to a 10-minute cap — so a key that keeps failing is pushed further away instead of being retried on the same fixed timer forever. |
| **Half-open recovery** | When the cooldown expires the router lets exactly **one** trial request through. Success closes the breaker and resets the streak; failure re-escalates without dumping full traffic back onto a still-dead provider. |
| **429 (rate limited)** | Handled **separately** — a flat, non-escalating cooldown. A rate limit is expected back-pressure, not an outage, so it never feeds the strike counter. |
| **401 / 403 (auth)** | A bad credential won't fix itself. **2** consecutive auth failures **ban** the key outright rather than merely cooling it. |

Any success at any point resets the streak to zero. Cooling and banned keys are reflected
live in the dashboard; the admin **unban** action clears the breaker state as well.

### Cache-aware sticky routing

Provider prompt caching only pays off when a conversation's follow-up turns hit the **same**
upstream key. Naïve round-robin (always pick the least-recently-used key) throws that cache
away on every turn. Nexus instead pins a conversation to the key that last served it:

- A session is identified by an explicit **`X-Nexus-Session`** header or the OpenAI **`user`**
  field if you send one, and otherwise by a stable fingerprint of the opening messages.
- Follow-up turns prefer that key for a short window (matching provider cache lifetimes),
  falling back to normal tier/LRU selection only for new sessions or when the pinned key is
  cooling, banned, or out of headroom.
- Sticky-routed responses carry an **`X-Nexus-Sticky: true`** header.

### Cost-aware routing (optional)

Within a tier, when several providers are healthy and in-headroom, Nexus can bias toward the
**cheaper** one using the per-token pricing already in your model registry — so "route to the
cheapest *capable, healthy, in-headroom* provider" becomes real. It is a **tiebreaker only**,
controlled by a single weight (*Settings → Cost-aware routing*, or `ROUTING_COST_WEIGHT`):

- `0` (default) — cost is ignored; provider order is unchanged.
- `1` — strict cheapest-first within a tier.
- in between — interpolates, biasing toward cheaper without ignoring your configured order.

Cost **never** overrides correctness. It is applied *after* tier priority (capability), the
circuit breaker and rate/token headroom (an ineligible cheap provider is still skipped), and
sticky cache affinity (a continuing conversation stays pinned to its cached key even if a
cheaper provider exists — a cache hit usually wins on total cost anyway). Unpriced providers
are ranked last but never dropped.

> [!NOTE]
> **Model exposure:** Nexus deliberately exposes a **single virtual model** — send
> `model: "alayra-nexus-1"` and the gateway routes across your pool by tier, health, and
> cache affinity. This keeps the client contract to one stable name; task-class dispatch to
> named virtual models (`nexus-fast`, `nexus-premium`, …) is intentionally out of scope for
> now so the routing contract stays simple for early adopters.

### Response caching (optional)

Distinct from cache-aware *routing* above (which reuses the **provider's** prompt cache),
this caches the **response itself**. When enabled, an **exact-match** request — same model,
messages, and generation params — is served straight from Redis, **skipping the provider
entirely**: a real **$0** call. Off by default; turn it on under *Settings → Response cache*
(or `CACHE_ENABLED` / `CACHE_TTL_SECONDS`).

- The cache key excludes `stream` and `user`, so a streamed and a non-streamed request with
  the same content share an entry — and a hit is **replayed in whichever mode the client
  asked for** (drop-in compatible).
- Every hit still emits a **$0 usage event** attributed to the team, so your cost and
  analytics numbers stay honest (it doesn't consume budget). Responses carry
  `X-Nexus-Cache: hit` / `miss`.
- Tool-call responses and multi-choice (`n > 1`) requests are not cached. Identical requests
  return the same cached answer until the TTL expires — enable it where that's what you want
  (deterministic prompts, repeated evals, shared boilerplate).

> [!NOTE]
> Semantic caching (nearest-neighbour on prompt embeddings) is a heavier, opt-in
> extension planned on top of this exact-match layer — not enabled today.

---

## Teams & budgets

Group your scoped access keys into **teams**, and give each team a **USD budget cap**
per day, week, or month. Enforcement happens on the admission path — before a request
ever reaches a provider:

- A key that belongs to a team over its budget gets **`429`** with the current spend,
  the cap, and a `Retry-After` for when the window resets (UTC).
- A **suspended** team's keys get **`403`** immediately.
- Spend is tracked in Redis and **seeded from your real usage history**, so setting a
  cap mid-month starts from what the team has actually spent — and budgets survive a
  Redis restart.
- Keys without a team (and teams without a cap) behave exactly as before — nothing
  changes until you opt in.

> [!NOTE]
> Cost is only knowable after a response completes (streaming), so enforcement is
> check-then-spend: requests already in flight when the cap is crossed can overshoot
> it by their own cost. That's the standard trade for budget caps on a streaming
> gateway.

Manage teams via the admin API (`/admin/teams`) — the dashboard Teams tab consumes
this in an upcoming release.

---

## BYOK — bring your own key

A provider key can be **owned by a team** instead of living in the shared pool. An
owned key serves only that team's traffic; nobody else can route through it. Set the
owner when you add the key (**Pools → + Key → Owner**), or pass `ownerTeamId` to
`POST /admin/providers/:providerId/keys`.

Routing then works in two passes:

1. **The team's own keys first**, in the usual tier order with LRU within a tier.
2. **The shared pool**, but only if the team allows it.

Per-team, `byokFallback` decides what happens when a team's own keys are all
rate-limited, cooling, or banned:

| `byokFallback` | Behaviour |
|---|---|
| `true` *(default)* | Fall back to the shared pool. Responses carry `X-Nexus-BYOK: true` only when an owned key served them |
| `false` | **Hard isolation.** The request gets `503` + `Retry-After`. It never touches a credential the team did not bring |

A BYOK key is **not a parallel proxy** — it is a scoped pool. Owned keys flow through
the exact same admission control, circuit breaker, guardrails, SSRF checks, and
analytics pipeline as pooled keys. There is one request path.

Two guarantees worth stating explicitly:

- **A caller with no team can never be routed through an owned key**, even when the
  shared pool is completely exhausted.
- **The response cache is partitioned by owner.** A response produced by one team's
  private key is never replayed to another team or to the shared pool, so an isolated
  team only ever sees responses its own keys paid for.

BYOK spend is still costed, attributed, and **counted against the team's budget cap** —
set `budgetUsd: null` for a team that funds its own keys and shouldn't be capped.

> [!WARNING]
> Deleting a team **deletes its owned provider keys** along with it. This is
> deliberate: releasing a private credential into the shared pool would let every
> other caller route through it. The team's *access* keys survive, losing only their
> budget cap.

Watch adoption with the `nexus_byok_requests_total{result}` metric — a sustained
`fallback` rate means a team is under-provisioned on its own credentials.

---

## API Reference

### Proxy Endpoint

```
POST /v1/chat/completions
```

Fully OpenAI-compatible. Send any model string registered in your model registry.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-team-key>" \
  -d '{
    "model": "alayra-nexus-1",
    "messages": [{ "role": "user", "content": "Hello" }],
    "stream": true
  }'
```

`alayra-nexus-1` routes to your highest-priority active pool. You can also specify an exact model string (`claude-3-5-sonnet-20241022`, `gpt-4o`, etc.) to target a specific provider directly.

**Streaming** (`"stream": true`) is fully supported — server-sent events pass through from the upstream provider with no buffering.

### Admin Routes

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/nexus/summary` | Provider pool overview (active / cooling / banned counts) |
| `GET` | `/admin/providers` | Full list of provider pools |
| `POST` | `/admin/providers` | Create a provider pool |
| `POST` | `/admin/providers/:providerId/keys` | Add an API key to a pool (`ownerTeamId` makes it private to a team — BYOK) |
| `POST` | `/admin/keys/:id/test` | Test a key and check latency |
| `POST` | `/admin/keys/:id/ban` | Ban a key from rotation |
| `GET` | `/admin/keys/:id/metrics` | Live RPM and status for a key |
| `GET` | `/admin/models` | List model registry |
| `PUT` | `/admin/models` | Add or update a model in the registry |
| `GET` | `/admin/teams` | List teams with key counts and current-period spend |
| `POST` | `/admin/teams` | Create a team (name, budget cap + period, status) |
| `PATCH` | `/admin/teams/:id` | Update a team (budget, status, tier, `byokFallback`) |
| `DELETE` | `/admin/teams/:id` | Delete a team (access keys survive unassigned; **owned provider keys are deleted**) |
| `GET` | `/admin/team-keys` | List team keys |
| `POST` | `/admin/team-keys` | Issue a new team key (optionally assigned to a team) |
| `PATCH` | `/admin/team-keys/:id` | Assign or unassign a key's team |
| `GET` | `/admin/usage` | Usage totals for a period |
| `GET` | `/admin/usage/by-team-key` | Usage breakdown by team key |
| `GET` | `/admin/analytics/timeseries/teams` | Daily time series by team |
| `GET` | `/admin/analytics/timeseries/models` | Daily time series by model |

All admin routes require `Authorization: Bearer <ADMIN_PASSWORD>`.

---

## Dashboard

The built-in web dashboard (`/dashboard`) gives you full operational control:

- **Connect** — server status, endpoint URL, one-click team key generator
- **Nexus** — provider pool overview with per-key RPM utilization meters; add, test, and ban keys without touching the CLI
- **Models** — model registry with tier assignment, capability flags (Primary / Fallback / Vision / FIM / Tools), context window, and per-1M token pricing
- **Team Keys** — issue scoped access tokens with configurable rate limits; view attribution in analytics
- **Analytics** — request and token trend charts, stacked model breakdown, cost area chart, input/output comparison, team leaderboard with medals, CSV export, and custom date range picker
- **Settings** — admin password management and system configuration

---

## Observability

A Prometheus-compatible **`/metrics`** endpoint exposes the gateway's operational
shape, so it drops straight into an existing ops stack.

- **Metrics:** request rate and duration (by outcome and tier), upstream time-to-first-byte,
  input/output tokens, prompt-cache (sticky) hit rate, per-provider request and error
  rates (rate-limit / auth / server / timeout), pool utilization (active / cooling /
  banned keys), plus standard Node process metrics (CPU, memory, event-loop lag, GC).
- **Auth:** `/metrics` is **not** world-readable like `/health`. Scrape it with a bearer
  token — set a dedicated **`METRICS_TOKEN`** (recommended), or it falls back to
  `ADMIN_PASSWORD`. It is exempt from the abuse guard's rate limit but never from auth.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: alayra-nexus
    authorization:
      credentials: <your METRICS_TOKEN>
    static_configs:
      - targets: ['your-host:3000']
```

### Distributed tracing (optional)

The gateway → provider call is wrapped in an OpenTelemetry span. It's a **no-op by
default** (zero overhead); to collect traces, run the app with a standard OTel SDK and
point it at your collector — nothing to change in the code:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318 \
node --require @opentelemetry/auto-instrumentations-node/register dist/server.js
```

---

## Security Model

| Layer | Implementation |
|---|---|
| **Key encryption** | AES-256-GCM with a per-deployment `MASTER_ENCRYPTION_KEY`; plaintext keys never touch the database |
| **Admin authentication** | bcrypt-hashed admin password on every protected route |
| **Team key hashing** | SHA-256; plaintext shown once at creation, never stored |
| **HTTP hardening** | Fastify Helmet — `X-Frame-Options`, `X-Content-Type-Options`, HSTS, CSP headers |
| **CORS** | Configurable origin allowlist |
| **SSRF protection** | Outbound provider requests are restricted to http(s) **and** blocked from private/loopback/internal hosts by default (see below) |
| **No telemetry** | Zero outbound calls to Alayra Systems or any third party. All data stays in your infrastructure |

### SSRF protection

Because the gateway makes outbound calls to operator-configured provider base URLs, an
unrestricted URL could be pointed at internal-only addresses — cloud metadata
(`169.254.169.254`), loopback admin panels, or private LAN hosts — turning Nexus into a
proxy into your own network. To prevent that, **Nexus blocks private, loopback, and
link-local hosts by default** on every path that adds or uses a provider URL. A blocked
URL is rejected when you save the provider, so it never reaches the request path.

Running a **local model** (Ollama, LM Studio, a private gateway)? Allow just that host:

- **In the dashboard:** *Settings → Network security* — tick "Allow private / localhost"
  to disable blocking on a trusted network, or add specific hosts (e.g. `localhost:11434`)
  to the allowlist.
- **Via environment** (baseline the dashboard builds on):
  ```bash
  # allow a specific local provider without disabling blocking:
  SSRF_ALLOWLIST=localhost:11434,127.0.0.1:11434
  # or, on a fully trusted network, disable private-host blocking entirely:
  SSRF_ALLOW_PRIVATE=true
  ```

Allowlist entries are `host` or `host:port` (a bare host permits any port). The env values
form a read-only baseline; hosts added in the dashboard are merged on top.

### Content guardrails (optional)

Guardrails are an **opt-in** content filter for prompts and responses — redact PII, or
block banned content and prompt-injection patterns. They are **off by default**; a fresh
deployment filters nothing until you enable them under *Settings → Content guardrails* (or
via `GUARDRAILS_*` env vars). Nexus hard-codes no policy — you bring the rules:

```jsonc
// each rule: name, pattern (regex), action (block|redact),
// appliesTo (input|output|both, default both), optional replacement
[
  { "name": "email", "pattern": "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}", "action": "redact", "replacement": "[REDACTED_EMAIL]" },
  { "name": "injection", "pattern": "ignore (?:all |the )?previous instructions", "action": "block", "appliesTo": "input" }
]
```

Named presets you can copy as starting points: `email`, `us-phone`, `credit-card`, `ssn`,
`api-key`, `prompt-injection`.

- **Input filtering** runs on the admission path *before* the request is forwarded — a
  `block` rule returns `400`, a `redact` rule masks the match and forwards the cleaned prompt.
- **Output filtering** applies to **non-streaming** responses (block ⇒ the content is
  withheld, redact ⇒ matches masked).
- **Streaming + output rules:** the streaming path is intentionally zero-buffer for
  latency, so a response can't be inspected mid-stream. By default streamed responses are
  **input-filtered only** and carry an explicit `X-Nexus-Guardrails-Output: skipped-streaming`
  header — never silently unfiltered. Enable **buffered-safe mode** to collect the response,
  filter it, and replay it as a single chunk, trading the streaming latency win for inspection.

> [!WARNING]
> Your `.env` file contains `MASTER_ENCRYPTION_KEY` and `ADMIN_PASSWORD`.  
> Never commit it. This repository's `.gitignore` excludes `.env` by default.

---

## Roadmap

- [x] Key pool management with AES-256-GCM encryption
- [x] Multi-provider routing with tiered failover
- [x] OpenAI-compatible proxy API with full streaming support
- [x] Team key issuance with per-key RPM limits
- [x] Admin dashboard — provider pools, model registry, team management
- [x] Analytics — cost tracking, token trends, team leaderboard, CSV export
- [x] Custom date range analytics
- [x] Automated test suite and CI (lint, typecheck, test, build, audit)
- [x] Circuit breaker (escalating cooldown, half-open probe) + cache-aware sticky routing
- [x] SSRF protection — default-on private-host blocking with an opt-in allowlist
- [x] Optional content guardrails — pluggable PII redaction and content/injection blocking
- [x] Cost-aware routing — bias toward the cheapest healthy, in-headroom provider (tiebreaker)
- [x] Atomic pre-admission rate limiting with real token accounting
- [x] Per-key TPM enforcement, with reservation and post-response reconciliation
- [x] Per-team budget caps with automatic cutoff
- [x] Optional exact-match response caching
- [x] Prometheus `/metrics` endpoint and optional OpenTelemetry tracing
- [x] BYOK — team-owned provider keys with optional hard isolation
- [ ] Admin auth hardening — constant-time compare, login lockout, TOTP 2FA
- [ ] Webhook and email alerts on key failure or budget threshold
- [ ] Custom domain / CNAME support
- [ ] Integration test suite
- [ ] Kubernetes Helm chart

---

## Contributing

Pull requests are welcome. For major changes, open an issue first to discuss the approach.

**Start here:** [`docs/architecture/PROJECT-STRUCTURE.md`](docs/architecture/PROJECT-STRUCTURE.md)
explains the layering rule and walks the full request path;
[`docs/architecture/FILE-OVERVIEW.md`](docs/architecture/FILE-OVERVIEW.md) is a
where-to-look index and a checklist for adding a feature.

The backend lives in `src/` and the admin dashboard in `frontend/` — the dashboard is
plain ES modules with no build step.

```bash
# Development
npm run dev

# Type check
npx tsc --noEmit

# Schema changes
npx prisma migrate dev --name your_migration_name
```

---

## License

[Apache License 2.0](./LICENSE) © 2026 Alayra Systems Pvt. Limited & Alayra Systems LLC.

**Alayra Nexus™** is a trademark of Alayra Systems — see [TRADEMARK.md](./TRADEMARK.md).
The Apache 2.0 license covers the code; it does not grant rights to the name or logo.

---

<div align="center">

**Alayra Nexus™** is built by [Alayra Systems](https://github.com/Alayra-Systems-Pvt-Limited) —  
sovereign AI infrastructure for teams who refuse to depend on someone else's cloud.

</div>
