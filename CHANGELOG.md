# Changelog

All notable changes to Alayra Nexus™ are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `model: "alayra-nexus-1"` routing contract is the public API surface covered by
semver. The legacy ids `kinetic-nexus-1` and `nexus` remain accepted as aliases.

## [Unreleased]

## [1.0.0] - 2026-07-09

First tagged release and first published container image
(`ghcr.io/kinetic-ide/alayra-nexus`).

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

[Unreleased]: https://github.com/Kinetic-Ide/alayra-nexus/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Kinetic-Ide/alayra-nexus/releases/tag/v1.0.0
