# Alayra Nexus — Dashboard Plan (Phase 7)

**Status:** LIVING DOCUMENT — this is the single source of truth for Phase 7 ordering.
**Last reconciled:** 2026-07-14 (Session 47) · **Author:** Abbas · **Scope:** the Nexus operator dashboard.

> **Why this file was rewritten.** The original (2026-07-11) plan ended with *"Nothing in this plan has
> been implemented"* and numbered the phases one way; a product re-sequencing on 2026-07-12 numbered
> them another way; and the code went a third way. Three sources drifted. This file now reconciles all
> three and is authoritative. If a phase is not in §3, it is not scheduled.

The `kinetic-admin` app is **reference only** — a source of UX patterns — and is never modified.

---

## 0. THE BLOCKER: the new dashboard is not being served

**`src/server.ts` serves `frontend/` (the old vanilla dashboard). `Dockerfile` copies `frontend/` into
the runtime image. `web/dist` is never served and never packaged.**

Everything built in P7.1–P7.5 — Overview, the redesigned Nexus, model management, Analytics — is
therefore **invisible in every real deployment**, including the published container. It only appears
when a developer runs the Vite dev server.

**The cutover is blocked by a parity gap, not by laziness.** The old dashboard still owns two things
the new one does not:

| Capability | Old `frontend/` | New `web/` |
|---|---|---|
| Settings (SSRF · guardrails · routing · cache · notifications · compliance · audit viewer) | ✅ working | ❌ placeholder |
| Team keys | ✅ working | ❌ placeholder |
| Models | ✅ own tab | ✅ *better* — folded into Nexus (P7.4b) |
| Overview · Analytics · themes · pool/key/model editing | ❌ none | ✅ shipped |

Flipping the static root today would take working configuration **away** from operators — a real
regression. So the remaining phases are ordered to **close parity, then cut over.** The cutover is the
milestone that makes five phases of work real; nothing after it matters as much.

---

## 1. What is actually shipped (verified against git, 2026-07-14)

| Phase | What landed | Commit |
|---|---|---|
| **P7.1** | Vite + Preact `web/` app; slate-glass tokens; **dark + light** theme; self-hosted fonts + charts (killed the CDN bug); component kit; app shell + router; 12-section IA | — |
| **P7.2** | **Overview** landing: one `/admin/overview` aggregate, clickable stat cards, four 7-day charts, leaderboards, recent activity | — |
| **P7.3** | **Nexus** (pools/keys/health + honest routing-rules view), **Models**, **Connect** | — |
| **P7.4a** | Chart aliveness (per-metric colour, rich hover), Alayra logo wired, Nexus add-provider/add-key restored | `d5174af` |
| **P7.4b** | **Models folded INTO Nexus** (tab removed); live model discovery (`fetch-models`); per-key RPM/TPM/max-users | `8f05a7f` |
| **P7.4c** | Editable model details: capability-driven per-modality pricing (incl. realtime audio in/out) + bundled pricing catalog + auto-fill | `a102b6d` |
| **P7.4d** | Edit provider / edit key dialogs; **Max Users enforced**; per-provider extra headers (Anthropic `anthropic-version`) | `bd12911` `4ff409b` `5c695e8` |
| **P7.5** | **Analytics**: per-request outcome + latency + **cache-savings recording** (they were never written down), one aggregate endpoint, live Analytics page | `2d604ef` `7ca17db` `ed2c7b8` |

**Sections live in `web/`:** Overview · Nexus · Connect · Analytics · Security · Caching · Logs · Settings.
**Still placeholders:** Teams · Enterprise · Admin.

---

## 2. Information architecture — 11 sections (was 12)

**Models is gone** — folded into Nexus in P7.4b, where a pool now owns its own models, keys, limits
and pricing. That was the right call and the IA reflects it.

Overview · **Nexus** · Connect · Analytics · Teams · Enterprise · Security · Caching · Logs ·
Settings · Admin

---

## 3. Remaining phases — ordered by dependency, not preference

The first three phases exist to **reach parity so the cutover can happen**. Everything in them is
"surface a backend that is already built and tested" — low risk, high visibility.

### ~~P7.6 — Settings (sub-tabs) + Logs~~ ✅ **DONE** (`414baf5`)
Settings is seven sub-tabs (Routing · Cache · Guardrails · Notifications · Network · Compliance ·
Appearance), each loading and saving only what it owns; every control states its consequence. Logs is
its own filterable, read-only section. **No backend change was needed** — every endpoint already
existed. Fixed two bugs found while building: the Toggle was silently dead (a `<label>` around a
`<button>` re-dispatched the click, so every switch fired twice and no-oped), and panels re-seeded
from a prop in an effect, which could clobber an in-progress edit and left "unsaved changes" stuck
forever after a save.

### ~~P7.6b — Dashboard polish + review fixes~~ ✅ **DONE**
A finish pass over what P7.1–P7.6 shipped, no new features. Three visible defects fixed and verified
live in both themes: (1) **charts** rendered blurred and ~2× too tall — the SVG used a fixed
`320×120` viewBox with `preserveAspectRatio="none"`, so the browser stretched it ~1.9×; it now
measures its container and renders 1:1 (a 120px-tall chart measures 120px, was 223px); (2) **table
headers** on right-aligned columns drifted left of their cells — a CSS specificity bug where
`.table thead th` beat `.tRight`, fixed with `.table thead th.tRight`; (3) **dark-theme `<select>`
popups** rendered white with black hover text because the `<option>` had no styling — now themed from
tokens. Plus a review round on the edit dialogs: `PoolModels` remove no longer leaves buttons disabled
(moved to `finally`, edit disabled during removal); `EditKeyDialog` stops treating a typed `0` as
"keep old"; edit dialog Save buttons tied to their form via `form=`; `Modal` uses `aria-labelledby`;
registry id-collision suffix increments. Chart geometry locked by a regression test.

### ~~P7.7 — Security + Caching~~ ✅ **DONE**
**Security:** one home for 2FA/TOTP (enrol via manual secret + otpauth URI — no QR dependency —
confirm, one-time recovery codes, regenerate, disable), admin API tokens (mint owner/viewer,
plaintext-once, revoke), the sign-in policy facts (session TTL / lockout), and a read-only network-egress
summary linking to Settings → Network (one editor, no duplicate). All backend already existed.
**Caching:** the response-cache control **moved here** from Settings (so Settings went 7→6 tabs) and
now sits beside live stats (entries, 7-day hit rate + savings, scoped to a recent window for honesty)
and a one-click purge behind an honest confirm. New backend: `GET /admin/cache/stats` +
`POST /admin/cache/purge` (SCAN + UNLINK, non-blocking; purge is global by design — the namespace is
inside the hashed key), plus `countKeys`/`deleteKeys` in a testable `lib/redisScan.ts`. The pre-existing
`POST /admin/cache/flush` (registry-cache bust) was left untouched for parity.
*Deferred to P7.13:* real viewer role-gating in the new dashboard. Today an owner-only action a viewer
attempts is met with a plain "your session is read-only" message rather than being hidden — consistent
with how the rest of the redesigned console behaves, and cleanly fixed once the accounts primitive lands.

### ~~P7.7c — CodeQL security-scan remediation~~ ✅ **DONE**
Twelve CodeQL alerts from the P7.7 push, triaged against the code into three groups.
**Fixed (7):** per-route rate limits (`lib/routeRateLimits.ts` tiers AUTH/ADMIN_WRITE/ADMIN_READ)
on the sensitive routes — login, TOTP confirm/disable, recovery-codes, SSO login/callback, key
metrics, team-key delete, cache flush — on top of the existing global abuse guard; a test proves the
limit engages (429). **Tightened (1):** the SSRF sink now fetches the validated `URL` object
`assertSafeUrl` returns (the guard already blocked private/metadata/loopback and is tested).
**Bonus:** recovery codes widened 40→64-bit. **Documented false positives (dismissed in GitHub UI):**
sha256 on high-entropy tokens (session/API/team keys) and the constant-time-compare length-equaliser —
bcrypt is the wrong tool there and would break the O(1) lookups; reasoning captured in code comments.
No schema change, nothing on the proxy hot path.

### P7.8 — Teams  ← *the last parity blocker*
Team keys (the old dashboard's "Team Keys" tab), budget cap + period, per-team cost, BYOK fallback,
and **wire `assignedTier` into routing** — it is stored today and silently ignored, which makes the
field a lie. Members + Org are deliberately deferred to P7.13 (they need the same accounts primitive
as sub-admins; build it once).

### P7.9 — **CUTOVER** 🚩 *the milestone*
Serve `web/dist` instead of `frontend/`; build the dashboard in the Docker image and CI; verify static
serving byte-for-byte; retire `frontend/`. **This is the phase that makes P7.1–P7.8 real.** Small in
code, largest in consequence.

### P7.10 — Budgeting cascade *(depends on P7.8 — a budget cannot cascade to teams that have no UI)*
Org-total budget → pools → teams, each team knowing its limit; route X% of a team's budget to premium
vs standard; configurable threshold actions (notify admin / notify admin + team / block / route
elsewhere); team-wise email alerts; budget analytics (monthly/quarterly/annual, per team, per model).
*Backend already enforces per-team `budgetUsd` + period on admission — this extends it to a cascade.*

### P7.11 — Notifications bell + Branding
Live unread feed that deep-links to the section that raised it (needs a small notification store —
operator alerts are email/webhook only today). Company name + logo on the dashboard and login.

### P7.12 — Server health
Redis (memory, clients, ops/sec, latency), Postgres (query latency, pool usage, cache-hit ratio),
event-loop lag, active connections. Prometheus already exposes CPU/mem/event-loop-lag.
**GPU does not apply** — Nexus is a proxy gateway, not a model-hosting box.

### P7.13 — Admin (multi-user) + first-run identity
Sub-admins, role-based viewer users, invites; first-run key generation (hashed) + admin identity
(name/email/password/TOTP) + device fingerprint + recovery key + the double-confirmed reset-wipe.
The largest backend item; deliberately last, once the shell exists to present it.

### Backlog (unscheduled — pull in when they earn it)
- **Benchmarks + branded PDF** — run tests on demand, clean report, downloadable.
- **First-class provider presets** — xAI, Azure, Bedrock, Vertex, HuggingFace, Together. They work
  **today** only via the generic `custom` OpenAI-compatible path (baseUrl + auth + modelIdPath); there
  are no presets. Purely a convenience layer.
- **Enterprise/Org section** — no `Org` model exists (`Team` was shaped to take an `orgId` later).
- **Per-team analytics** — the Analytics aggregate is global; a team filter is a small extension.

---

## 4. Standing decisions (do not re-litigate)

1. **Rendering: Vite + Preact → static build.** Fastify keeps serving static files; single-container
   deployment unchanged. *(2026-07-11)*
2. **First-run reset = full database wipe.** Loud, double-confirmed, documented. An attacker who knows
   the trick gains nothing. *(2026-07-11)*
3. **Teams before Budgeting.** A budget cascade needs teams that exist in the UI. *(2026-07-14)*
4. **Parity before cutover.** Never remove working operator capability to ship a prettier shell.
   *(2026-07-14)*
5. **Models stays folded into Nexus.** A pool owns its models, keys, limits and pricing. *(P7.4b)*
6. **`kinetic-admin` is reference only.** Never modified.

## 5. Known lies in the product to fix as we pass them

- **`Team.assignedTier` is stored and silently ignored by routing.** The Nexus routing view says so
  honestly today; P7.8 must either wire it or remove it.
- **No `Org` model.** The Enterprise section cannot be honest until one exists or the scope shrinks.

---

*Every phase ends with the standing green gate — lint / typecheck / test / build / audit all clean on
**both** the gateway and the dashboard — plus a `nexus-changes.md` entry, a commit, and a push.*
