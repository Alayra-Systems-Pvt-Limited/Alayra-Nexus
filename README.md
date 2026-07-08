<div align="center">

<br>

# ⚡ Kinetic Nexus

### The Enterprise AI Gateway

**One OpenAI-compatible endpoint. Every model. Zero key chaos.**

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-6d28d9.svg?style=for-the-badge)](./LICENSE)
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

> Built and maintained by **[Alayra Systems Pvt. Limited](https://github.com/Kinetic-Ide)** · Islamabad, Pakistan

<br>

</div>

---

## Why Kinetic Nexus?

Most teams hit the same wall: multiple AI providers, API keys scattered across engineers, no visibility into who spent what, and a hard-coded provider string that makes switching models painful.

Kinetic Nexus is the infrastructure layer that sits between your application and every AI provider. Change **one URL**. Get load balancing, automatic failover, team-level access control, and a live cost dashboard — without touching your application code.

---

## Features

| Capability | Details |
|---|---|
| **Key Pool Management** | Store unlimited API keys per provider, encrypted at rest with AES-256-GCM |
| **Intelligent Load Balancing** | Automatic rotation across active keys; cooling and banned keys are automatically bypassed |
| **Tiered Failover** | Premium → Standard → Fast chains; when the best key fails the next tier fires instantly |
| **OpenAI-Compatible API** | Drop-in `/v1/chat/completions` — change one base URL, nothing else |
| **Team Key Issuance** | Create scoped access tokens per team, each with an independently configurable RPM limit |
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
  │                   Kinetic Nexus Gateway                  │
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
    Token usage logged → PostgreSQL
    Real-time metrics  → Redis
    Analytics          → Admin Dashboard
```

---

## Quick Start

### Option A — Docker Compose (recommended)

```bash
git clone https://github.com/Kinetic-Ide/kinetic-nexus.git
cd kinetic-nexus

cp .env.example .env
# Edit .env — set MASTER_ENCRYPTION_KEY, ADMIN_PASSWORD, and DB/Redis URLs

docker compose up -d
```

Dashboard is live at `http://localhost:3000/dashboard`

---

### Option B — Manual Setup

**Prerequisites:** Node.js 20+, PostgreSQL 15+, Redis 7+

```bash
git clone https://github.com/Kinetic-Ide/kinetic-nexus.git
cd kinetic-nexus

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

> [!IMPORTANT]
> Generate `MASTER_ENCRYPTION_KEY` with:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> This key encrypts every provider API key stored in your database. Keep it secret. Keep a backup. Never reuse it across deployments.

---

## Rate limits, explained

Kinetic Nexus has **two independent limits**, and it's important not to confuse them:

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
    "model": "kinetic-nexus-1",
    "messages": [{ "role": "user", "content": "Hello" }],
    "stream": true
  }'
```

`kinetic-nexus-1` routes to your highest-priority active pool. You can also specify an exact model string (`claude-3-5-sonnet-20241022`, `gpt-4o`, etc.) to target a specific provider directly.

**Streaming** (`"stream": true`) is fully supported — server-sent events pass through from the upstream provider with no buffering.

### Admin Routes

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/nexus/summary` | Provider pool overview (active / cooling / banned counts) |
| `GET` | `/admin/providers` | Full list of provider pools |
| `POST` | `/admin/providers` | Create a provider pool |
| `POST` | `/admin/providers/:providerId/keys` | Add an API key to a pool |
| `POST` | `/admin/keys/:id/test` | Test a key and check latency |
| `POST` | `/admin/keys/:id/ban` | Ban a key from rotation |
| `GET` | `/admin/keys/:id/metrics` | Live RPM and status for a key |
| `GET` | `/admin/models` | List model registry |
| `PUT` | `/admin/models` | Add or update a model in the registry |
| `GET` | `/admin/team-keys` | List team keys |
| `POST` | `/admin/team-keys` | Issue a new team key |
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

## Security Model

| Layer | Implementation |
|---|---|
| **Key encryption** | AES-256-GCM with a per-deployment `MASTER_ENCRYPTION_KEY`; plaintext keys never touch the database |
| **Admin authentication** | bcrypt-hashed admin password on every protected route |
| **Team key hashing** | SHA-256; plaintext shown once at creation, never stored |
| **HTTP hardening** | Fastify Helmet — `X-Frame-Options`, `X-Content-Type-Options`, HSTS, CSP headers |
| **CORS** | Configurable origin allowlist |
| **No telemetry** | Zero outbound calls to Alayra Systems or any third party. All data stays in your infrastructure |

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
- [ ] Per-key TPM enforcement (limits are configurable today; enforcement upcoming)
- [ ] Atomic pre-admission rate limiting with real token accounting
- [ ] Webhook and email alerts on key failure or budget threshold
- [ ] Custom domain / CNAME support
- [ ] Per-team budget caps with automatic cutoff
- [ ] Integration test suite
- [ ] Kubernetes Helm chart

---

## Contributing

Pull requests are welcome. For major changes, open an issue first to discuss the approach.

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

[MIT](./LICENSE) © 2026 Alayra Systems Pvt. Limited

---

<div align="center">

**Kinetic Nexus** is part of the [Kinetic IDE](https://github.com/Kinetic-Ide) ecosystem —  
sovereign AI infrastructure built for teams who refuse to depend on someone else's cloud.

</div>
