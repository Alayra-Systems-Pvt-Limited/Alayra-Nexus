<sub>Part of the [Alayra Nexus README](../README.md#rate-limits-explained), moved into its own page so the README stays inside npm's 64 KB render limit. The content is unchanged.</sub>

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

<details>
<summary><b>Circuit breaker</b></summary>


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

</details>

<details>
<summary><b>Cache-aware sticky routing</b></summary>


Provider prompt caching only pays off when a conversation's follow-up turns hit the **same**
upstream key. Naïve round-robin (always pick the least-recently-used key) throws that cache
away on every turn. Nexus instead pins a conversation to the key that last served it:

- A session is identified by an explicit **`X-Nexus-Session`** header or the OpenAI **`user`**
  field if you send one, and otherwise by a stable fingerprint of the opening messages.
- Follow-up turns prefer that key for a short window (matching provider cache lifetimes),
  falling back to normal tier/LRU selection only for new sessions or when the pinned key is
  cooling, banned, or out of headroom.
- Sticky-routed responses carry an **`X-Nexus-Sticky: true`** header.

</details>

<details>
<summary><b>Cost-aware routing (optional)</b></summary>


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

</details>

<details>
<summary><b>Response caching (optional)</b></summary>


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

</details>

<details>
<summary><b>When Redis is unreachable, and how the process is supposed to die</b></summary>

Nexus is **crash-only**: it never tries to nurse itself back to health in place. Failures
split in two, and they get opposite treatment.

**A dependency is down — never fatal.** Every routing decision (breaker state, rate limits,
sticky pins, budgets) lives in the key-value store, so a gateway that cannot reach it cannot
enforce a limit. It **fails closed**: proxy requests are refused with **`503` and a
`Retry-After`**, no provider is contacted, and no credit is spent with the controls switched
off. Commands are bounded by `NEXUS_KV_COMMAND_TIMEOUT_MS` (2s), so a caller is answered
rather than left holding a connection. The gateway stays up throughout and resumes on its own
within a second of Redis returning — measured, no restart and no operator action.

**A bug reached the top of the process — always fatal.** An escaped rejection means the
process state is no longer known, and code that continues on unknown state is how a
cost-control gateway starts double-charging. Nexus logs one line carrying a stable `FATAL`
token plus the stack, drains its listener and buffers under a 10s deadline
(`NEXUS_SHUTDOWN_DEADLINE_MS`), and **exits 1**. Alert on `FATAL`.

**The two probes answer different questions, so wire them differently.**

| Probe | Depends on | Use it for |
|---|---|---|
| `GET /health` | nothing external | **liveness** — restart the process |
| `GET /ready` | Redis + Postgres | **readiness** — take it out of rotation |

Pointing a liveness probe at `/ready` turns a Redis blip into a restart of every replica at
once. The bundled Docker `HEALTHCHECK` uses `/health` for exactly this reason.

**Give it a supervisor.** Exit codes are load-bearing: a signal exits 0, a crash exits 1.
Nothing in the default single-process deployment restarts the gateway on its own, so:

```bash
docker run --restart=unless-stopped ...
```

```ini
# systemd
Restart=on-failure
RestartSec=2s
```

Kubernetes restarts on a non-zero exit by default; set `terminationGracePeriodSeconds`
above 10 so the drain finishes before SIGKILL. Running `NEXUS_CLUSTER_WORKERS` > 1 adds a
second layer — the primary replaces a dead worker immediately, then backs off to a 30s
ceiling if they keep dying, so a dependency outage cannot become a fork loop.

</details>
