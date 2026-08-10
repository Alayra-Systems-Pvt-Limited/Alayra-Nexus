<div align="center">

<br>

<img src="./brand/png/alayra-nexus-banner-readme.png" alt="Alayra Nexus — The Enterprise AI Gateway" width="100%"/>

<br>

**One OpenAI-compatible endpoint. Every model. Zero key chaos.**

<br>

[![CI](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-6d28d9.svg?style=for-the-badge)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Alayra-Systems-Pvt-Limited/Alayra-Nexus?style=for-the-badge&color=0e7490)](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/releases)
[![npm](https://img.shields.io/npm/v/%40alayrasystems%2Fnexus?style=for-the-badge&logo=npm&logoColor=white&color=cb0000)](https://www.npmjs.com/package/@alayrasystems/nexus)
[![npm downloads](https://img.shields.io/npm/dm/%40alayrasystems%2Fnexus?style=for-the-badge&logo=npm&logoColor=white&color=cb0000&label=npm%20installs)](https://www.npmjs.com/package/@alayrasystems/nexus)
[![Docker Pulls](https://img.shields.io/docker/pulls/alayrasystems/nexus?style=for-the-badge&logo=docker&logoColor=white&color=2496ed)](https://hub.docker.com/r/alayrasystems/nexus)
[![Container](https://img.shields.io/badge/ghcr.io-alayra--nexus-2496ed.svg?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/pkgs/container/alayra-nexus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3b82f6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-v5-22c55e.svg?style=for-the-badge)](https://fastify.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-f59e0b.svg?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma-0ea5e9.svg?style=for-the-badge&logo=postgresql&logoColor=white)](https://prisma.io/)
[![CLI](https://img.shields.io/badge/CLI-coming_soon-64748b.svg?style=for-the-badge&logo=gnubash&logoColor=white)](#contents)

<br>

Route **Anthropic**, **OpenAI**, **Google Gemini**, **Groq**, **OpenRouter**, **Mistral**,
**HuggingFace**, **Cloudflare Workers AI** — or anything OpenAI-compatible —  
through a single hardened proxy. Pool multiple API keys per provider, load-balance  
across them, auto-failover between tiers, and give every team their own scoped key —  
with full usage analytics and cost tracking built in.

<br>

<a href="https://alayra-systems-pvt-limited.github.io/Alayra-Nexus/demo/" target="_blank" rel="noopener"><img src="https://img.shields.io/badge/▶%20Live%20demo-open%20the%20dashboard-6d28d9?style=for-the-badge" alt="Open the live demo"/></a>

**[Quick start](#quick-start)** · [How it compares](#how-it-compares) · [Screens](#screens) · [Connect your tools](#connect-your-tools) · [API](#api-reference)

<sub>The demo is the real dashboard, signed in as a viewer, reading a frozen snapshot of a gateway
seeded with synthetic traffic. No sign-up, nothing to install, and nothing you do there is saved.</sub>

**Running, from nothing:**

```bash
curl -O https://raw.githubusercontent.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/main/docker-compose.yml
printf 'MASTER_ENCRYPTION_KEY=%s\nADMIN_PASSWORD=change-me\n' "$(openssl rand -hex 32)" > .env
docker compose up -d
```

Dashboard on **localhost:3000** · OpenAI-compatible API on **localhost:3000/v1**

<sub>Three lines, not one: the gateway will not start without an encryption key, and generating
one for you silently would mean every install shared a key we published.</sub>

<br>

> Built and maintained by **[Alayra Systems Pvt. Limited](https://github.com/Alayra-Systems-Pvt-Limited)** · Islamabad, Pakistan

<br>

<img src="./docs/assets/dashboard-overview.png" alt="The Alayra Nexus overview — request volume, token and cost trends, top models, and the audit trail" width="100%"/>

<sub>The overview after 90 days of traffic across five teams and ten models.</sub>

<br>

</div>

---

## Contents

**Get started** · [Live demo](https://alayra-systems-pvt-limited.github.io/Alayra-Nexus/demo/) · [Why Alayra Nexus?](#why-alayra-nexus) · [Features](#features) · [Screens](#screens) · [How it compares](#how-it-compares) · [Supported providers](#supported-providers) · [Architecture](#architecture) · [Quick start](#quick-start) · [Standalone mode](#standalone-mode--no-postgres-no-redis) · [Backup & restore](#backup--restore) · [Connect your tools](#connect-your-tools) · [Environment variables](#environment-variables)

**How it works** · [Rate limits, explained](#rate-limits-explained) · [Resilience & routing](#resilience--routing) · [Teams & budgets](#teams--budgets) · [BYOK](#byok--bring-your-own-key) · [API reference](#api-reference) · [Dashboard](#dashboard) · [Observability](#observability)

**Operate & contribute** · [Security model](#security-model) · [Accounts and roles](#accounts-and-roles) · [Roadmap](#roadmap) · [Contributing](#contributing) · [License](#license)

> [!NOTE]
> **A command-line interface is coming soon** — everything the dashboard does is
> already an HTTP API today, so the CLI is a convenience layer over endpoints that
> exist, not new capability. Until it lands, the [admin API](#api-reference) and the
> web dashboard cover every operation.

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
| **Anthropic-Compatible API** | `/v1/messages` too, so **Claude Code** and the Anthropic SDKs route through the same pool — streaming, tools, and all |
| **Team Key Issuance** | Create scoped access tokens per team, each with an independently configurable RPM limit |
| **BYOK (Bring Your Own Key)** | A team can register its own provider keys, encrypted at rest and routed only for that team's traffic — with optional fall-back to the shared pool, or hard isolation |
| **Real-Time Rate Limiting** | Per-key RPM **and TPM** enforced atomically before admission, with token reservation and post-response reconciliation, plus live utilization meters |
| **Cost Tracking** | Per-request USD cost computed from model pricing, attributed to the requesting team |
| **Full Analytics Dashboard** | Request trends, token breakdowns, team leaderboard, provider split — powered by Chart.js |
| **Custom Date Ranges** | Analytics filterable by today / 7d / 30d / 90d or any custom from→to window |
| **CSV Export** | One-click export of all analytics data for finance or reporting |
| **Model Registry** | Manage which models are available, their tier, capabilities, and per-1M token pricing |
| **Encrypted Backup & Restore** | One encrypted file for the whole gateway. Secrets are re-keyed on the way in, so a backup restores onto a *different* gateway with a different master key — PostgreSQL ⇄ SQLite included. Every restore is dry-run first |
| **Standalone Mode** | No Postgres, no Redis — a SQLite file and in-process memory. One process, one directory, nothing to provision |
| **Web Admin Dashboard** | Full browser UI — no CLI required for day-to-day operations |
| **Two-Factor Admin Auth** | Optional TOTP second factor with single-use recovery codes, session tokens, per-source login lockout, and revocable API tokens for scripts |
| **Security Hardened** | Fastify Helmet, CORS, constant-time secret comparison, AES-256-GCM key encryption, zero plaintext secrets at rest |

---

## Screens

<table>
<tr>
<td width="50%">

<img src="./docs/assets/dashboard-analytics.png" alt="Analytics — success rate, latency percentiles, spend, cache savings, and a per-provider breakdown"/>

**Analytics** — reliability, speed, spend and savings over any window, with a
per-model and per-provider breakdown and a plain-English account of what failed.

</td>
<td width="50%">

<img src="./docs/assets/dashboard-teams.png" alt="Team detail — budget consumption, per-key spend share, and busiest models"/>

**Teams** — each team's budget against its cap, what every access key inside it
spent, and the models it leans on.

</td>
</tr>
<tr>
<td width="50%">

<img src="./docs/assets/dashboard-nexus.png" alt="Provider pools grouped by routing tier, each key showing its limits and status"/>

**Pools & routing** — provider pools by tier, every key with its own limits,
status and controls: test, cool, ban.

</td>
<td width="50%">

<img src="./docs/assets/dashboard-logs.png" alt="The audit trail — every state-changing action with actor, role, target, result and source IP"/>

**Audit trail** — every state-changing action with who did it, from where, and
what the server answered. Read-only over the API.

</td>
</tr>
<tr>
<td width="50%">

<img src="./docs/assets/dashboard-add-provider.png" alt="The add-provider dialog, covering base URL, auth header, model id path and extra headers"/>

**Any OpenAI-compatible endpoint** — base URL, auth header, model-id path and
per-provider headers, without touching a config file.

</td>
<td width="50%">

<img src="./docs/assets/health.png" alt="The health page — live probes for Redis, Postgres and provider reachability"/>

**Health** — live probes for every dependency, so an outage names itself
instead of arriving as a wall of failed requests.

</td>
</tr>
</table>

<div align="center">
<img src="./docs/assets/dashboard-mobile.png" alt="The dashboard on a phone, with the navigation drawer open" width="300"/>

<sub>The console works on a phone — the sidebar becomes a drawer below 820px.</sub>
</div>

---

## How it compares

[LiteLLM](https://github.com/BerriAI/litellm) is the closest well-known project, so
here is an honest side-by-side. It wins on reach and ecosystem; Nexus wins on what
you get without paying, and on depth of the operator console.

| | Alayra Nexus | LiteLLM |
|---|---|---|
| **Providers** | 5 first-class + any OpenAI-compatible endpoint | **100+ built in** |
| **Admin dashboard** | Built in — analytics, teams, pools, audit, health | Built in |
| **Scoped team keys** | Yes | Yes (virtual keys) |
| **Team budgets** | Yes, with block / notify / downgrade at the cap | Yes |
| **Key pooling & failover** | Per-provider pools, tiered failover, circuit breaker | Load balancing, retries, fallbacks |
| **Audit trail** | Append-only, per-action, no delete endpoint | Logging integrations |
| **SSO** | **Included, Apache-2.0** | Commercial licence |
| **Two-factor auth** | **Included** | — |
| **CLI** | *Coming soon* | **Mature** |
| **SDK** | *Not yet* | **Python SDK** |
| **Language** | TypeScript / Node | Python (Rust core) |
| **Licence** | Apache-2.0, every feature included | Open source + commercial tier |

**Choose LiteLLM** if you need breadth of providers today, a mature CLI and SDK, or
its ecosystem of integrations.

**Choose Alayra Nexus** if you want a self-hosted gateway whose enterprise controls —
SSO, two-factor, audit trail, team budgets — are in the open-source licence rather
than behind a sales call, and a console your finance team can read without help.

<sub>Compared against LiteLLM's public documentation, July 2026. If anything here has
gone out of date, please open an issue — we would rather fix it than win on a stale fact.</sub>

---

## Supported Providers

Nexus ships a preset for each of these — base URL, auth header, model-list endpoint and model-id
path already filled in. **The list is not a whitelist**: a provider slug is free text, so a pool
pointed at anything OpenAI-compatible is a first-class pool whether or not it appears below. A
preset only saves you typing.

<!-- BEGIN GENERATED PROVIDER TABLE — npm run docs:providers -->

**6 providers have served a real completion through these presets** — measured 2026-08-10.

| Provider | Verified | Endpoint | Publishes prices? |
|---|---|---|---|
| **Groq** | ✅ Completion · 2026-08-10 | `api.groq.com/openai/v1` | ✅ Yes, per model |
| **OpenRouter** | ✅ Completion · 2026-08-10 | `openrouter.ai/api/v1` | ✅ Yes, per model |
| **Google** | ✅ Completion · 2026-08-10 | `generativelanguage.googleapis.com/v1beta/openai` | ❌ Set prices yourself |
| **Mistral** | ✅ Completion · 2026-08-10 | `api.mistral.ai/v1` | ❌ Set prices yourself |
| **HuggingFace** | ✅ Completion · 2026-08-10 | `router.huggingface.co/v1` | ❌ Set prices yourself |
| **Cloudflare Workers AI** | ✅ Completion · 2026-08-10 | `api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` | ❌ Set prices yourself — bills in *neurons*, not tokens |
| **Cerebras** | ⚠️ Model list only · 2026-08-10 — completions answered 402 until the account is funded | `api.cerebras.ai/v1` | ❌ Set prices yourself |
| **OpenAI** | ⚪ Preset only | `api.openai.com/v1` | ❌ Set prices yourself |
| **Anthropic** | ⚪ Preset only | `api.anthropic.com/v1` | ❌ Set prices yourself |
| **Custom** | ⚪ You configure it | whatever you point it at | Depends on the endpoint |
| Azure OpenAI · Bedrock · Vertex | ⚪ Via **Custom** | your endpoint | Reachable today through a Custom pool if the endpoint speaks OpenAI's schema; first-class presets are on the [roadmap](#roadmap) |

<sub>**Verified** is measured, never asserted. ✅ Completion means `npm run verify:providers` listed that provider's models, sent a real request against a live key and got usage back, on the date shown. ⚪ Preset only means never probed — an absence of evidence, not a claim that it is broken. The dated evidence is committed under [`docs/provider-verification/`](docs/provider-verification/), and this table is generated from it by `npm run docs:providers`. Editing it by hand is undone by the next run, and CI fails if it drifts.</sub>

<sub>**Publishes prices** decides whether Nexus can cost a request without you. Only **Groq** and **OpenRouter** return per-model prices in their own API; everywhere else a model arrives with no price, which Nexus flags rather than assuming zero — on the model row, when you add the pool, and on the Analytics page.</sub>

<!-- END GENERATED PROVIDER TABLE -->

Anthropic additionally gets a native `/v1/messages` endpoint, so Claude Code and the Anthropic SDKs
work unchanged.

---

## Architecture

<div align="center">

<img src="./docs/assets/architecture.svg" alt="Alayra Nexus request path — client to gateway (team auth, rate limiter, tiered router) to providers to telemetry" width="100%"/>

</div>

One request enters authenticated and budget-checked, the router picks a healthy key by
tier and cache affinity, the circuit breaker keeps a failing provider out of rotation, and
usage is batched to PostgreSQL while live metrics land in Redis — all behind a single
OpenAI-compatible URL.

Only the two stores at the bottom are swappable: configure neither and the same request path runs
against a local SQLite file and in-process counters instead — see
[Standalone mode](#standalone-mode--no-postgres-no-redis). Everything between the client and the
providers is identical either way.

<details>
<summary>Same diagram as plain text</summary>

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
  │   …and any other OpenAI-compatible endpoint you point at  │
  └──────────────────────────────────────────────────────────┘
           │
           ▼
    Token usage → async buffer → batched PostgreSQL write
    Real-time metrics  → Redis
    Analytics          → Admin Dashboard
```

</details>

---

## Quick Start

### Option A — One command, nothing to provision

```bash
npx @alayrasystems/nexus
```

**That single command downloads it and starts it.** There is no install step before it, and nothing
to clean up after. The first run takes about a minute — most of it fetching the database engine —
and npm shows only a spinner while it does, so give it that minute before deciding it has hung.
Every run after the first starts in seconds.

That is the whole thing. No clone, no build, no Postgres, no Redis, no Docker. It creates
`~/.alayra-nexus`, generates its own encryption key and admin password, builds a SQLite database,
and serves the **full dashboard** — provider pools, team keys, budgets, analytics, backup. Nothing
is disabled because there is no database server; the engines underneath are different, the product
is the same.

```
  Alayra Nexus 1.6.0 — first run

  Data directory   /home/you/.alayra-nexus
  Encryption key   /home/you/.alayra-nexus/secret.key  (generated)

  ⚠  Back that key file up, somewhere other than this machine.
     Without it the provider keys stored here can never be decrypted again.

  Admin password   7Kq2vFm9Rt4xLn8p
  Dashboard        http://127.0.0.1:3000
```

Open the dashboard, claim it with that password, add a provider key, and point your app at
`http://127.0.0.1:3000/v1`.

| | |
|---|---|
| `--port 3001` | listen somewhere else |
| `--host 0.0.0.0` | reachable from other machines (loopback only by default) |
| `--data-dir ./nexus` | keep data somewhere other than your home directory |
| `--env-file ./.env` | read configuration from a file you name |

> [!NOTE]
> **A `.env` in the current directory is not read.** It belongs to the project in that directory,
> not to Nexus — and ten of the variables Nexus reads (`DATABASE_URL`, `ADMIN_PASSWORD`, `PORT`…)
> have names common enough to appear in someone else's. If one is found, the gateway says so and
> ignores it. Name the file with `--env-file` to use it deliberately.

To keep it around, install it instead of fetching it each time — the command it installs is short:

```bash
npm install -g @alayrasystems/nexus
```

```bash
alayra-nexus
```

Standalone is for evaluation, local development and CI — one process, one machine, and a restart
clears sessions and rate-limit windows. When you outgrow it, [Backup & restore](#backup--restore)
carries everything into a Postgres deployment, provider keys included. See
[Standalone mode](#standalone-mode--no-postgres-no-redis) for what you give up.

### Option B — Published image (no clone, brings your own Postgres)

A multi-arch image (amd64 + arm64) is published to **Docker Hub** and the **GitHub Container
Registry** from the same build, so the two are byte-identical — use whichever you prefer. If
you already have Postgres and Redis, run the gateway with one command:

```bash
docker run -d --name alayra-nexus -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/nexus" \
  -e REDIS_URL="redis://host:6379" \
  -e MASTER_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -e ADMIN_PASSWORD="change-me" \
  alayrasystems/nexus:latest
```

| Registry | Image |
|---|---|
| Docker Hub | `alayrasystems/nexus` |
| GHCR | `ghcr.io/alayra-systems-pvt-limited/alayra-nexus` |

Pin a version for production (e.g. `:1.6.0`) rather than `:latest`.

<details>
<summary><b>Option C — Docker Compose (brings its own Postgres + Redis)</b></summary>


Nothing to clone and nothing to compile: Compose downloads the published image and
starts Postgres and Redis alongside it.

```bash
curl -O https://raw.githubusercontent.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/main/docker-compose.yml

</details>

# Two secrets. Keep MASTER_ENCRYPTION_KEY safe — without it your stored
# provider keys can never be decrypted again.
cat > .env <<EOF
MASTER_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ADMIN_PASSWORD=change-me
NEXUS_VERSION=1.6.0
EOF

docker compose up -d
```

Dashboard is live at `http://localhost:3000`. The container applies its own database
migrations on startup, and prints your generated Nexus API key on first run —
`docker compose logs nexus` to see it. **Save it then: the key is stored as a hash, so it is shown
once and never again** (lost it? rotate for a new one from **Connect**).

Open the dashboard and it will ask you to create your owner account, using the `ADMIN_PASSWORD` you
set above — see [Accounts and roles](#accounts-and-roles).

`DATABASE_URL` and `REDIS_URL` are set by Compose; you do not need to supply them.
Omit `NEXUS_VERSION` to track `latest`, but pin it in production.

<details>
<summary>Building from source instead (contributors)</summary>

```bash
git clone https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus.git
cd alayra-nexus
cp .env.example .env   # set MASTER_ENCRYPTION_KEY and ADMIN_PASSWORD

docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

</details>

---

<details>
<summary><b>Option D — Railway (managed cloud, no server to run)</b></summary>


The gateway builds from the repo and serves the dashboard from a single service, so a
managed deploy is three plugins and four variables:

1. **New Project → Deploy from GitHub repo** → pick this repository. Railway builds the image.
2. Add the **PostgreSQL** and **Redis** plugins to the project.
3. On the gateway service → **Variables**, set (use each plugin's **private** connection URL):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `MASTER_ENCRYPTION_KEY` = 64 hex chars — generate fresh, never reuse:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ADMIN_PASSWORD` = a strong install secret (claims the first owner account)
4. **Settings → Networking → Generate Domain** for a public `https://…up.railway.app` URL.

Railway's proxy sets `X-Forwarded-Proto`, so the dashboard's **Connect** page prints the
correct `https://` base URL with no extra config. Behind a proxy that doesn't, pin it with
[`PUBLIC_URL`](#environment-variables). The container runs its own migrations on boot; open
the domain and it greets you with the owner-account setup screen.

</details>

<details>
<summary><b>Option D — Manual setup (from source)</b></summary>


**Prerequisites:** Node.js 20+, PostgreSQL 15+, Redis 7+

```bash
git clone https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus.git
cd alayra-nexus

npm install

cp .env.example .env

</details>

# Edit .env with your values

# Generate a secure MASTER_ENCRYPTION_KEY (run this once and save it):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Postgres and Redis must be running. Don't have them locally? Start just the
# two dependencies with Compose and run the gateway from source:
docker compose up -d postgres redis

# Run database migrations
npm run migrate

# Start
npm run dev          # development — hot reload via tsx
npm run build && npm start   # production
```

Dashboard is live at `http://localhost:3000`

> [!TIP]
> **`Cannot reach Redis` / `Cannot reach PostgreSQL` on startup?** In server mode both are hard
> dependencies — Redis holds rate-limit counters, circuit-breaker state, sticky
> routing, budgets and the response cache; Postgres holds everything else. The
> startup error names the one that's missing and the command that starts it.
>
> A gateway is only ever demoted to the local substitutes when you configure **neither** — never as
> a reaction to an outage. If you set `DATABASE_URL` and it is unreachable, the gateway refuses to
> start rather than quietly accepting traffic it is going to lose. See
> [Standalone mode](#standalone-mode--no-postgres-no-redis).
>
> The dashboard is a Vite + Preact app in `web/`, built to static assets that the
> gateway serves at `/` — there is no separate web server to run. To work on the
> dashboard with hot reload, `cd web && npm run dev` (it proxies API calls to a
> gateway running on `:3000`).

---

## Standalone mode — no Postgres, no Redis

One command and one SQLite file, with no services to provision — the honest list of what you give up by running it that way, where the data lives, how to tell which mode you are actually in, and when to move to server mode.

**→ [docs/standalone.md](docs/standalone.md)**

---

## Backup & restore

What a backup contains and what it deliberately leaves out, plus exporting and restoring from the dashboard and over the API.

**→ [docs/backup.md](docs/backup.md)**

---

## Connect your tools

Alayra Nexus speaks both the **OpenAI** API (`/v1/chat/completions`) and the
**Anthropic Messages** API (`/v1/messages`), so almost any tool that lets you set a
custom base URL works — including Claude Code. You only need three values:

- **Base URL:** `http://<your-host>:3000/v1`
- **API key:** a team key from the dashboard (sent as `Authorization: Bearer <key>`, or `x-api-key: <key>`)
- **Model:** `alayra-nexus-1`

> [!NOTE]
> **Cursor** (and some other cloud tools) route requests through their own servers, so
> they cannot reach `http://localhost:3000` — they need a **publicly reachable HTTPS**
> base URL. Local tools such as Cline, Continue.dev, and Claude Code call your gateway
> directly and work against localhost. This is a Cursor constraint, not a Nexus one —
> LiteLLM has the same requirement.

### Claude Code
Claude Code speaks the Anthropic Messages API. Point it at the gateway:

```bash
export ANTHROPIC_BASE_URL="http://<your-host>:3000"
export ANTHROPIC_AUTH_TOKEN="<your-team-key>"
claude
```

Requests route through the same pool, failover, budgets, and analytics as everything
else. On startup Claude Code reads `GET /v1/models` to populate its model picker — which
now lists **your** configured models alongside the `alayra-nexus-1` auto-route entry, so
you can pick a specific one from inside the client or leave it on auto and let Nexus
choose.

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
| `DATABASE_URL` | Server mode | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`). Leave unset for a local SQLite file — see [Standalone mode](#standalone-mode--no-postgres-no-redis) |
| `REDIS_URL` | Server mode | Redis connection string (`redis://localhost:6379`). Leave unset for in-process counters |
| `MASTER_ENCRYPTION_KEY` | Yes | 64 hex characters (32 bytes) — encrypts all stored API keys. Required in **both** modes |
| `ADMIN_PASSWORD` | Yes | The gateway's deployment secret. Claims the first owner account on first run, and authorises a full reset. **Not** a day-to-day login once an owner exists — see [Accounts and roles](#accounts-and-roles). |
| `NEXUS_MODE` | No | `server` or `standalone`. Normally unset — the mode is inferred from whether `DATABASE_URL` / `REDIS_URL` are set. Setting it makes the intent explicit, and the gateway **refuses to start** if it contradicts what you configured, rather than guessing which you meant |
| `NEXUS_DATA_DIR` | No | Where standalone keeps its SQLite database (default: `.nexus` in the working directory). Ignored in server mode |
| `PORT` | No | HTTP port (default: `3000`) |
| `PUBLIC_URL` | No | The address the outside world reaches this gateway at — pins what the **Connect** page, quick-start snippets, and SSO `redirect_uri` print. Leave unset and the gateway infers it from the proxy's `X-Forwarded-Proto` / `X-Forwarded-Host` headers, or the Host header. Set it (e.g. `https://gateway.example.com`) when a proxy forwards the host but not the scheme, so a TLS deployment would otherwise print `http://`. |
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

How RPM and TPM are counted, what a request meets at the ceiling, and why the limit belongs to a key rather than a pool.

**→ [docs/routing.md](docs/routing.md#rate-limits-explained)**

---

## Resilience & routing

The circuit breaker, cache-aware sticky routing, cost-aware routing, response caching, and what the gateway does — and does not — survive when Redis is unreachable.

**→ [docs/routing.md](docs/routing.md#resilience--routing)**

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

Manage teams from the dashboard's **Teams** tab — create and budget teams, issue and
assign scoped access keys, and read per-team usage — or drive the same operations over
the admin API (`/admin/teams`).

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

Every proxy and admin endpoint, with the request and response shapes.

**→ [docs/api.md](docs/api.md)**

---

## Dashboard

The built-in web dashboard (served at `/`, a Vite + Preact app) gives you full operational
control — no CLI required for day-to-day work:

<div align="center">

<img src="./docs/assets/health.png" alt="Alayra Nexus Health dashboard — gateway process, Redis and PostgreSQL vitals, and readiness checks" width="100%"/>

<sub><i>The <b>Health</b> tab — the gateway's own vitals: process, Redis, and PostgreSQL latency, cache-hit rates, and the readiness checks your load balancer sees.</i></sub>

</div>


- **Overview** — live gateway telemetry: request/token/cost trends, active keys and models, top teams, and recent admin activity by name
- **Nexus** — provider pools and the model registry: per-key RPM utilization meters, add/test/ban keys, and each model's tier, capability flags, context window, and per-1M token pricing
- **Connect** — the base URL (verified against your browser's own address bar), the API-key hint with one-click rotation, endpoint reference, and filled-in quick-start snippets
- **Analytics** — request and token trend charts, stacked model breakdown, cost area chart, input/output comparison, team leaderboard, response-cache savings, CSV export, and a custom date-range picker
- **Teams** — teams with budgets and routing tier, scoped access keys, and per-team usage stats
- **Enterprise** — operator branding / white-labelling and per-company controls
- **Security** — your sign-in security (password, TOTP two-factor with QR enrolment, active sessions) and admin API tokens
- **Caching** — the optional exact-match response cache: toggle, TTL, and live hit-rate
- **Health** — the gateway's own vitals: process, Redis, and PostgreSQL latency and readiness checks
- **Logs** — the read-only audit trail: every state-changing action, who did it, and the result
- **Settings** — system configuration: routing weights, guardrails, network/SSRF policy, notifications, and compliance/retention
- **Admin** — people and roles (owner / admin / viewer), invites, single sign-on, and the factory reset

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

<details>
<summary><b>Distributed tracing (optional)</b></summary>


The gateway → provider call is wrapped in an OpenTelemetry span. It's a **no-op by
default** (zero overhead); to collect traces, run the app with a standard OTel SDK and
point it at your collector — nothing to change in the code:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-collector:4318 \
node --require @opentelemetry/auto-instrumentations-node/register dist/server.js
```

</details>

## Security Model

| Layer | Implementation |
|---|---|
| **Key encryption** | AES-256-GCM with a per-deployment `MASTER_ENCRYPTION_KEY`; plaintext keys never touch the database |
| **Admin authentication** | Per-person accounts; email and password exchanged at `/admin/login` for a short-lived session token; optional per-user TOTP second factor; per-source lockout after repeated failures ([details](docs/security.md)) |
| **Password hashing** | scrypt (memory-hard), per-user salt, cost parameters stored with the digest. The only human-chosen secret the gateway stores |
| **Constant-time secrets** | The admin password and the metrics token are compared with `crypto.timingSafeEqual` over fixed-width digests, so rejection latency reveals nothing about the secret |
| **Nexus API key hashing** | SHA-256; shown once when generated or rotated, never stored in the clear and never displayable again |
| **Team key hashing** | SHA-256; plaintext shown once at creation, never stored |
| **Audit attribution** | Every state-changing admin action records the account that performed it, by name — copied onto the record, so it outlives the account |
| **HTTP hardening** | Fastify Helmet — `X-Frame-Options`, `X-Content-Type-Options`, HSTS, CSP headers |
| **CORS** | Configurable origin allowlist |
| **SSRF protection** | Outbound provider requests are restricted to http(s) **and** blocked from private/loopback/internal hosts by default ([details](docs/security.md)) |
| **No telemetry** | Zero outbound calls to Alayra Systems or any third party. All data stays in your infrastructure |

### Accounts and roles

Accounts, the three roles, invites, single sign-on, recovery, two-factor authentication and lockout — plus SSRF protection and the optional content guardrails.

**→ [docs/security.md](docs/security.md)**

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
- [x] Admin auth hardening — constant-time compare, login lockout, TOTP 2FA
- [x] Standalone mode — SQLite and in-process memory, no Postgres and no Redis
- [x] Encrypted backup and restore, portable across gateways and across engines
- [x] A static, read-only live demo of the console
- [ ] **CLI — coming soon.** A command-line interface over the existing admin API
- [x] `npx @alayrasystems/nexus` — a published package that starts a gateway with no clone and no Docker
- [ ] Scheduled backups, and writing them off-box (S3, GCS, a mounted volume)
- [ ] Webhook and email alerts on key failure or budget threshold
- [ ] Custom domain / CNAME support
- [ ] Integration test suite
- [ ] Kubernetes Helm chart

---

## Contributing

Pull requests are welcome. For major changes, open an issue first to discuss the approach.

Please read [**CONTRIBUTING.md**](./CONTRIBUTING.md) for setup, the quality bar, and the PR
process, and [**CODE_OF_CONDUCT.md**](./CODE_OF_CONDUCT.md) — participation is governed by the
Contributor Covenant. Security issues go to [SECURITY.md](./SECURITY.md), **not** a public issue.

**Start here:** [`docs/architecture/PROJECT-STRUCTURE.md`](docs/architecture/PROJECT-STRUCTURE.md)
explains the layering rule and walks the full request path;
[`docs/architecture/FILE-OVERVIEW.md`](docs/architecture/FILE-OVERVIEW.md) is a
where-to-look index and a checklist for adding a feature.

The backend lives in `src/`, the admin dashboard in `web/` (Vite + Preact), and the
end-to-end suite in `e2e/` (Playwright).

```bash
# Development
npm run dev

# Type check
npx tsc --noEmit

# Unit tests (backend, then dashboard)
npm test
cd web && npm test

# End-to-end: builds both packages, then drives the COMPILED gateway against a real
# Postgres + Redis (docker compose up -d postgres redis) and a real browser. Uses its
# own databases and Redis DBs — your local gateway's data is never touched.
cd e2e && npm install && npx playwright install chromium && npx playwright test

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
