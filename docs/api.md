<sub>Part of the [Alayra Nexus README](../README.md#api-reference), moved into its own page so the README stays inside npm's 64 KB render limit. The content is unchanged.</sub>

## API Reference

<details>
<summary><b>Proxy endpoints</b></summary>


```
POST /v1/chat/completions   OpenAI Chat Completions (streaming + non-streaming)
POST /v1/messages           Anthropic Messages (streaming + non-streaming)
POST /v1/embeddings         OpenAI Embeddings — for RAG / vector search
POST /v1/completions        OpenAI legacy completions — fill-in-the-middle / autocomplete
POST /v1/images/generations OpenAI Images — billed per image, not per token
POST /v1/audio/speech       OpenAI TTS — returns audio, billed per character
POST /v1/audio/transcriptions  OpenAI STT — multipart upload, billed per file
GET  /v1/models             Model discovery (OpenAI + Anthropic shape)
```

Every proxy endpoint runs through the same model-first routing, failover, circuit
breaker, budgets, and analytics — the non-chat endpoints are a thin transport over the
same core, not a separate path. Each selects a model by **capability**: `/v1/embeddings`
needs a model with the `embedding` capability, `/v1/completions` one with `completion`,
and so on. If none is configured the endpoint answers `503` naming the missing
capability rather than failing obscurely. Authenticate with `Authorization: Bearer
<key>` or, for Anthropic clients, `x-api-key: <key>`.

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

**Choosing a model.** There are two ways to send `model`, and `GET /v1/models` lists both:

| Send | What happens |
| --- | --- |
| `alayra-nexus-1`, `auto`, `default`, or nothing | Nexus routes for you — tier, then priority, then cost — and fails over across every configured model and key. This is what the gateway is for. |
| A model id or model string from `/v1/models` (`gpt-4o`, `claude-sonnet-4-5`, …) | Pinned to that model. Nexus still rotates and fails over across **that provider's keys**, but will not answer with a different model. |

Anything else is a `400` that names the models this gateway does serve. Nexus never
substitutes a model you did not ask for: a wrong answer that looks like a right one is
invisible in the response, in your logs, and in the bill.

`GET /v1/models` returns exactly what the caller can reach — your registry, minus models
you have paused and models whose provider pool is gone. A team isolated from the shared
pool sees only the providers it brought keys for. The list is derived from the same code
that routes, so it can never advertise a model the gateway would refuse.

`kinetic-nexus-1` and `nexus` remain accepted aliases for the auto-route entry.

**Streaming** (`"stream": true`) is fully supported — server-sent events pass through from the upstream provider with no buffering.

</details>

<details>
<summary><b>Admin routes</b></summary>


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

All admin routes require `Authorization: Bearer <token>` — a session token from `POST /admin/login`,
or an admin API token for scripts and CI. On a gateway that has not been claimed yet, the raw
`ADMIN_PASSWORD` is still accepted, exactly as it was before Phase 7.13a; creating an owner account
closes that door. See [Accounts and roles](../README.md#accounts-and-roles).

</details>
