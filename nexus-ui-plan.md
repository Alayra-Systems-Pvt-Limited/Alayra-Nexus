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

**Sections live in `web/`:** Overview · Nexus · Connect · Analytics · Teams · Security · Caching · Logs · Settings.
**Still placeholders:** Enterprise · Admin.

---

## 2. Information architecture — 11 sections (was 12; the removed section was Models)

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

**Follow-up (same day): CodeQL cannot see `@fastify/rate-limit` or the SSRF guard**, so the code fixes
above did not clear the alerts — it re-raised them at shifted line numbers, and manual dismissal is a
treadmill on an actively-edited codebase. Resolved durably by switching CodeQL from default to
**advanced setup** (`.github/workflows/codeql.yml` + `.github/codeql/codeql-config.yml`) and filtering
the two rules that only ever false-positive here (`js/missing-rate-limiting`, `js/insufficient-password-hash`),
each with a written justification. Every other query stays active — SSRF (`js/request-forgery`) included,
with its one finding dismissed by design. Requires a one-time GitHub toggle (disable default setup).

### ~~P7.8 — Teams~~ ✅ **DONE** — *the last parity blocker cleared*
Teams are now a first-class console section — the old dashboard only ever had a bare "Team Keys" list;
this is a genuine upgrade. Two sub-tabs: **Teams** (create/edit/delete, with budget cap + period,
status, and per-period spend shown against the cap) and **Access keys** (create, assign to a team,
reassign, copy, revoke). The BYOK fall-back flag is edited on the team form.

The headline fix: **`assignedTier` is wired into routing.** It used to be stored and silently ignored
— a lie. A team's preferred tier now leads the model-first candidate ordering (`selectModels` takes a
`preferredTier`, threaded from the team key through `discoverBestPool` on both the chat and non-chat
paths), then the normal premium→standard→fast failover follows, so a preference never becomes an
outage when that tier is momentarily exhausted. Unit-tested at the ordering layer.

Members + Org are deliberately deferred to P7.13 (they need the same accounts primitive as sub-admins;
build it once).

### ~~P7.9 — CUTOVER~~ ✅ **DONE** 🚩 *the milestone — the redesign now reaches users*
The gateway serves the redesigned dashboard (`web/dist`) instead of the old `frontend/`, which is
deleted. New this phase: a **SPA deep-link fallback** (`lib/spaFallback.ts` + a `setNotFoundHandler`
in `server.ts`) so a refresh or bookmark on a client-side route (`/teams`, `/nexus`, `/admin` …)
serves `index.html` and lets the client router resolve it — while API clients still get an honest
JSON 404. The discriminator is the `Accept` header, not a route list, so it never rots as sections are
added. Static plugin now `wildcard: false`; Vite `base` switched `'./'`→`'/'` so assets resolve from
the root at any route depth. Docker builds `web/` in the build stage and copies only `web/dist` into
the runtime image. Verified: an `inject` integration test drives the real wiring (deep link → app,
API path → JSON 404), and the built deep link serves 200 + absolute assets. **This is the phase that
makes P7.1–P7.8 real.** Small in code, largest in consequence.

### ~~P7.9b — Sign-in screen~~ ✅ **DONE** — *the cutover's missing front door*
The cutover surfaced that the redesigned dashboard never rebuilt the old dashboard's login, so it was
unreachable without a hand-set token. Backend auth (password → session token, TOTP, lockout) has
existed since Phase 6; this added only its screen. `web/src/pages/Login.tsx` (password, on-demand 2FA
code field, plain wrong-password / lockout messages); `App` gates on a session token and seeds it
synchronously so a signed-in reload never flashes login; a global 401 clears the token and fires
`nx:unauthorized` → back to sign-in; the Topbar sign-out is wired. `api.ts` gained `login()` (off the
generic path so a failed sign-in doesn't self-trigger the 401 handler) and `clearToken()`. Full basic
identity (sub-admins, first-run, recovery-key, device fingerprint) is still P7.13; this is just the
front door so the product is usable.

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

## Further changes notes (post-completion polish — DEFER until every phase is done)

> Captured 2026-07-16 from Abbas's first real click-through of the live product (Docker). These are
> **cosmetic/UX refinements, not functional gaps** — the decision is to finish all functional phases
> first, then return to these so we ship a complete product before polishing. Do NOT action these mid-phase.

1. **Content does not fill the width — too much empty space on every tab.** The main content column is
   effectively capped/narrow, so pages (Overview especially) leave a large blank area on the right and
   look under-filled on a wide screen. Audit the page/shell max-width and padding; let content breathe
   into the full width (or introduce a sensible max with better use of the space — e.g. more columns).
   Applies to **all tabs**, so it is a shell/layout fix, not a per-page one.
2. **Notifications tab is cluttered — split it up.** (a) Give **Email** its own sub-tab (Resend API
   key + From address + recipients), separate from the event list. (b) The events section should sit
   under a single master **"Enable email notifications"** toggle; when off, the whole event list is
   disabled/hidden. Right now the master "Send alerts" switch and the per-event switches read as one
   undifferentiated cluster. Reorganise into: master toggle → (when on) event checklist + Email config
   in its own tab.
3. **"Add provider pool" dialog — clarity, not new fields.** Users don't know what SLUG / Auth header /
   Auth prefix / Model ID path / Extra headers mean. Add short inline hints on each (one line each,
   like the "url-safe id" hint already on SLUG). **Also make it discoverable that model *capabilities*
   (chat/embedding/image/…) are chosen on the *models inside a pool*, not on the pool** — e.g. a note in
   the dialog ("you'll pick each model's capabilities after creating the pool") and/or a prompt to add a
   model right after a pool is created. This is a known-correct design (pool = credentials; model =
   capabilities/tier/pricing) that simply isn't obvious in the UI.

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

- ~~**`Team.assignedTier` is stored and silently ignored by routing.**~~ ✅ Fixed in P7.8 — it now
  biases the model-first candidate ordering (preferred tier first, normal failover after).
- **No `Org` model.** The Enterprise section cannot be honest until one exists or the scope shrinks.

---

*Every phase ends with the standing green gate — lint / typecheck / test / build / audit all clean on
**both** the gateway and the dashboard — plus a `nexus-changes.md` entry, a commit, and a push.*
