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

## 2. Information architecture — 12 sections

**Models is gone** — folded into Nexus in P7.4b, where a pool now owns its own models, keys, limits
and pricing. **Health was added in P7.12** (Abbas's call — server/provider health and future
benchmarks needed a home of their own; route `/status` because `/health` is the liveness probe).

Overview · **Nexus** · Connect · Analytics · Teams · Enterprise · Security · Caching · **Health** ·
Logs · Settings · Admin

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

### ~~P7.10 — Budgeting cascade + Teams restructure~~ ✅ **DONE**
Teams became **three sub-tabs**: **Overview** (the team list + totals), **Access keys** (the global
key view, now filterable by team and free-text search), and **Team stats** — the new one. Team stats
is a team selector (dropdown + search) and a period filter (today/7d/30d/90d) over a new read,
`GET /admin/teams/:id/stats` (`services/teamStats.service.ts`): spend/requests/success-rate/tokens for
the viewing window, cost + request trends, busiest models (reusing Analytics' `ByModel`), and the
**per-member breakdown** — one row per access key, click to expand into spend, share of team,
requests, tokens, cost/request and last-active. A **"member" is honestly a team's access key**: the
gateway has no user identity, so a key *is* the seat, and an idle key is listed with zeros rather than
dropped. **Share is a proportion, never an allocation** — the cap lives on the team and no per-member
cap exists to report. Two windows coexist and are labelled: the period tabs pick the *viewing* window,
while the budget card reports the team's *own* daily/weekly/monthly cycle, read exactly the way
admission reads it — blurring them would show a 7-day spend against a monthly cap.

The cascade's enforceable half: **`Team.overBudgetAction`** (migration `0013`, additive, default
`'block'` = the historical behaviour, so no existing team changed). `block` = today's hard 429;
`notify` = a soft cap that alerts but never blocks; `downgrade` = keep serving but pin routing to the
fast/cheapest tier. Threaded through `checkTeamBudget` (which now returns `downgrade` alongside
`allowed`) into **both** admission paths, where an over-budget downgraded team routes to `fast`
regardless of its `assignedTier`. Unit-tested at the verdict layer and proven on the dispatch path
(over-budget → served, not blocked, with `discoverBestPool` called with `fast`).

*Deliberately not built, because the schema cannot back it honestly (see §5):* an **org-level or
pool-level budget parent** (no `Org` model exists, and pools are shared infrastructure, not spend
owners), a **true per-tier % split** of one budget (needs two caps per team), **per-team email
recipients** (notification config is global), and **quarterly/annual** windows. Listed in the backlog
rather than faked.

### ~~P7.11 — Notifications bell + Branding~~ ✅ **DONE**
**The finding that shaped the phase:** all five alert types were gated *at their call sites* by
`notificationsArmed(event)` = `config.enabled && config.events[event]` — and `enabled` is **false by
default**. So on a default install the alert message was never even built, and alerts were
fire-and-forget email/webhook with no persistence at all. A bell wired to the old `notify()` would
have been permanently empty: a placeholder pretending to be a feature.

**So recording was split from delivery.** Every raised alert is now recorded in the feed
*regardless* of the email config (migration `0014`, new `Notification` table); `enabled` and the
per-event flags now gate only whether an alert *also leaves the building*. `notify()` records first,
then decides on delivery; the four call sites no longer short-circuit. Delivery behaviour, coalescing
and the release-on-failed-send are untouched — their tests pass unchanged. The feed takes its **own**
Redis claim key (`nexus:notify:feed:`), separate from the send guard (`nexus:notify:sent:`), because
the send path *releases* its claim on a failed delivery to allow a retry — sharing one key would
re-insert an entry already sitting in the bell. This reframes Settings → Notifications as *email*
settings, which lines up with the deferred note #2 below (that UI reorg is still deferred).

**The bell** (`shell/NotificationsBell.tsx`) is a real dropdown: unread badge (counted over *all*
unread, never just the page shown), entries with relative time, mark-one / mark-all read, close on
outside-click or Escape, and a 60s poll (a socket would be overkill — alerts are coalesced to one per
window per source). Selecting an alert marks it read and **jumps to the section that raised it** via
a pure `sectionFor()` map in `lib/notify.ts` (keyBanned/breakerOpened/tierExhausted → Nexus,
adminLockout → Security, budgetThreshold → Teams) — an alert saying a key died is only useful if it
lands you where you can replace it.

**Branding** — company name + logo in the sidebar and on the sign-in screen. **No schema**: it is one
small singleton blob, which is what `AppSettings` is for. The logo is stored as a **data URI**, never
a URL: this gateway self-hosts its assets (the Chart.js CDN was removed for exactly this reason), and
a remote logo would break air-gapped/strict-CSP deployments *and* leak a request to a third party on
every load of a public sign-in page. Validation is pure and tested (`lib/branding.ts`): PNG/JPEG/WEBP/SVG
only, ≤64KB, and a stored value that no longer validates is dropped rather than served. SVG is safe
because the logo is only ever rendered through an `<img src=…>` (browsers treat that as secure static
mode) — it must never be inlined into the DOM. The read is a **public `GET /branding`** (the login
screen has no session yet; a branded login page is public by definition); the write is
`PUT /admin/branding`, owner-only and audited. A white-labelled sidebar keeps "Alayra Nexus" on the
line beneath, so the console still says what it is.

**Enhancements taken in this phase:** (1) **notification retention** — the feed is pruned by the
existing `runRetention()` job via a new `notificationRetentionDays` (default **30**, editable in
Settings → Compliance, `0` = forever). Alerts are operational noise, not a record — the audit trail
testifies to what happened — so they default shorter than the 90-day audit/usage windows, and this is
the one growing table that would otherwise have had no ceiling. (2) Mark-all-read + unread-only
filtering. **Caught in live verification:** saving branding left the sidebar showing the old name
until a page reload, because each reader holds its own fetch — fixed with a `nx:branding` event that
every `useBranding` listens for (the same idiom the session gate already uses for `nx:unauthorized`),
and pinned by a regression test. Dead code removed: `notificationsArmed` had no callers left.

### ~~P7.12 — Health section (Server health + the new Health IA home)~~ ✅ **DONE**
**Abbas's IA call, adopted:** health metrics had no home in the 11-section IA — the phase said *what*
but never *where*. There is now a **Health section** (12th section, after Caching) with three tabs:
**Server** (the real P7.12), **Providers** (read-only capacity summary reusing `getNexusOverview`,
linking to Nexus — one editor, no duplicate, same rule as Security→Network), and **Benchmarks**
(honestly empty until built; it says what it will do rather than showing invented numbers).
**Route is `/status`, NOT `/health`** — `GET /health` is the liveness probe, a JSON route the SPA
fallback deliberately excludes, so a deep link to /health would render `{ok:true}` instead of the page.

**The audit finding fixed:** `/health` was a hardcoded `{ok:true}` that never checked anything — a
load balancer would call the gateway healthy with its database down. Two probes now, each answering
the question it is actually for: `/health` stays a cheap liveness ping (restarting cannot fix a dead
database; a liveness probe that checks dependencies turns every DB blip into a restart loop), and the
new **`GET /ready`** really probes Redis + Postgres and answers **503** with per-check detail when a
dependency is down. Degraded-but-answering still says ready — pulling a slow gateway out of rotation
turns a slowdown into an outage. Both exempt from the abuse rate limit.

**What makes it real, not decoration:** a new in-memory **health sampler**
(`services/healthSampler.service.ts` over the pure `lib/health.ts`) probes Redis (PING) and Postgres
(SELECT 1) every 15s, reads the event-loop delay histogram (`monitorEventLoopDelay`, reset per tick)
and process CPU/RSS/heap, and keeps **one hour in a ring buffer** (240 samples, a few KB). That
buffer feeds the latency **sparklines**, the **p50/p95/p99 chips**, and the **per-minute status
strip** (worst sample per minute; empty minutes render as grey gaps, and a fresh process says
"collecting — N of 240 samples" instead of faking continuity). Redis detail parses `INFO`
(memory/maxmemory, clients, ops/sec, hit rate, evictions, fragmentation); Postgres detail reads
`pg_stat_activity`/`pg_stat_database`/`pg_database_size`/largest tables — every query independently
guarded so a managed instance that refuses one view nulls that fact instead of blanking the panel.

**Honesty rules baked in (keep them):** no Postgres "disk free" anywhere (unknowable from SQL); no
Redis memory % when `maxmemory` is unset (no ceiling exists — prose instead of a gauge); the
container memory gauge reads the **cgroup limit** (v2 then v1), NEVER `os.totalmem()` (inside Docker
that is the HOST's RAM); heap gauge is against the V8 heap limit; a failed probe is a **null** point
that breaks the sparkline rather than drawing a reassuring zero; hit rates with no traffic are "—",
not 100%. Every status carries its word (Healthy/Degraded/Down, Pass/Slow/Fail) — never colour alone.
The **readiness checks table is `/ready` rendered** — measured vs threshold vs verdict — so ops and
the dashboard share one truth. `GET /admin/health/overview` (admin-guarded) is the page's single read.

### ~~P7.13a — Accounts, roles, and first-run identity~~ ✅ **DONE**
*Split from P7.13 by agreement (Abbas, 2026-07-17): the auth rewrite lands and is verified on its
own, the way P7.9/P7.9b did, rather than in one blast radius with the UI gating.*

**The finding: there was no user.** One shared `ADMIN_PASSWORD` in an environment variable
authenticated everyone, and everything else followed from it — the audit trail could only ever say
"someone with the password", nobody could be added or removed without a redeploy, the second factor
belonged to the *gateway* rather than to a person, and "viewer" was unreachable for a human without
pasting a machine token into the password box. The dashboard also **threw away the role** the
gateway returned at sign-in, which is why P7.7's viewer-gating was blocked on two things, not one.

**The accounts primitive** (migration `0015`, additive): `AdminUser` (name/email/scrypt
hash/role/status/per-user TOTP/recovery key/source) and `AdminInvite`. Recovery codes gained an
owner; `AdminApiToken` gained `createdById`; `AuditLog` gained `actorId` + `actorName` —
**deliberately no foreign key, and the name copied not joined**, because an audit record has to
outlive the account it describes.

**`ADMIN_PASSWORD` changed job** (Abbas's call: *"close the door"*). It claims the first owner
account and authorises the reset-wipe; it is refused as a sign-in the moment an owner exists. It
lives in the deployer's `.env` and nowhere else, so it is proof you *installed* this gateway rather
than merely found the port — which is what defeats the first-run land-grab. **Nothing changes at
upgrade:** until the gateway is claimed, sign-in behaves exactly as Phase 6 left it, and every Phase
6 test still passes against that state on purpose. Claiming **carries an existing authenticator and
unused recovery codes across**, then NULLS the original — a live secret must exist in one place.

**Three roles** (owner / admin / viewer). Admin runs the gateway day to day; owner additionally
decides who it belongs to. All 55 owner-guarded routes re-gated: the default became owner-or-admin,
with an explicit owner-only list — people, invites, SSO, compliance, the master API key, **the SSRF
policy** (a control the party it constrains must not be able to edit) and **`POST /admin/settings`**
(an arbitrary key/value setter — every owner-only setting at once wearing a generic coat; an admin
holding it could set `NEXUS_API_KEY` to a value they already knew).

**Sessions name their subject, not their authority.** `{uid}` in Redis; role and status are read
from the account on every request. Baking the role in would leave a demoted admin with owner rights
for twelve hours and a suspended account signed in until its TTL ran out. Verified live: suspending
someone killed their open session on the very next request.

**The master API key is show-once** (Abbas's call). It was the only credential stored in plain text
while team keys were hashed and provider keys encrypted. Converted at boot, not in SQL (hashing in a
migration would demand the pgcrypto extension of everyone's database): the existing key **keeps
working** and is printed one last time in that boot's log. Connect shows a mask and a Rotate button.

**Also:** SSO now provisions a real account from the `email` claim (the claim's role applies only to
a *new* account — otherwise an IdP's groups could silently re-promote someone an owner had demoted);
invites are hand-over links, not emails (delivery is off by default — an email-only invite would be
the P7.11 trap again); passwords use **scrypt from Node's own crypto** (memory-hard, no new
dependency, no native build, async so it cannot spike the event-loop lag the Health tab measures).
The CodeQL justification was rewritten: it claimed in writing that no password is ever stored, which
this phase ended — the exclusion stays (it fires on our high-entropy token digests, where it is
wrong) but the guarantee is now held by our own test asserting the stored hash IS scrypt.

**Bug found by live testing, fixed in-phase:** Connect printed
`…/v1/v1/chat/completions` — the gateway sends an origin-plus-`/v1` base and the endpoint paths
carry their own `/v1`. Wrong since the P7.9 cutover, on the one page whose entire job is "copy this
and it works", and the unit test never caught it because its fixture used a base URL with no `/v1`,
which no real deployment sends. Fixed, with the fixture made realistic.

Green on both packages: backend **638 tests** (+81), web **122** (+11), lint/typecheck/build 0,
0 vulnerabilities. Verified end-to-end against a real Postgres + Redis: migration applied, the
plaintext key converted and the old key still authenticating (400 = past auth) while a wrong key is
401, claim refused without the env secret, password refused after claiming, invite ignoring an
injected email/role, an admin refused on all five owner-only routes, the last-owner invariant
holding on the one path that reaches it (an owner **API token**, which has no self to check), and
the audit trail naming Abbas and Liaqat — with `(nobody)` exactly where there is genuinely nobody.

### ~~P7.13a-fix — four defects found by clicking~~ ✅ **DONE** *(2026-07-17)*
Abbas found these in the running dashboard, not in the suite. Cause of the first, and of why it
survived: **`web/src/api.ts` had no test file at all** — the seam every page reaches the gateway
through, and every page test mocks it away.

- **Every bodyless request was rejected before its route ran.** The client sent
  `Content-Type: application/json` unconditionally; Fastify answers `FST_ERR_CTP_EMPTY_JSON_BODY`
  when that header arrives with no body. Broke **11 call sites**: setting up two-factor, enabling
  and disabling a provider key, marking notifications read (twice), and all 7 `DELETE`s — including
  **Remove person** and **Revoke invite**, i.e. the offboarding P7.13a had just shipped. The
  notification calls end in `.catch(() => {})`, so they had been failing silently. Fix: send the
  header only when a body accompanies it. Guarded by `web/src/api.test.ts` (new, 13 tests).
- **Framework errors printed raw JSON at the user.** `{"statusCode":400,"code":"FST_ERR_CTP…"}`
  rendered verbatim on the Security page. `errorText()` now extracts the sentence — reading
  `message` for Fastify's shape and `error` for ours, told apart by `statusCode`, which Fastify
  always sends and our routes never do. (The first cut of this read `error` first and would have
  shown "Bad Request" for every framework failure; the test caught it.)
- **Overview → "Active models" linked to `/models`**, removed when models were folded into Nexus in
  P7.4b. Right number, click landed on "Not found". Now `/nexus`. Asserting the href would not have
  caught it — the href was what someone typed. The new test checks **every** Overview link against
  `SECTIONS`, and was confirmed to fail on the real bug before being kept.
- **Enterprise's placeholder named a phase, and the name was wrong.** "Built in P7.8" — P7.8 shipped
  as Teams; Enterprise was never in it. Now reads "Coming soon". Our phase numbers are a promise in
  a private language, which is worse than no promise.

**Live-verified against a source build + real Postgres/Redis:** the old client behaviour reproduces
the exact error from Abbas's screenshot; the new one returns a secret; two-factor setup completes in
a real browser; Enterprise reads "Coming soon"; every Overview link resolves. Green both packages —
backend 638, web **137** (+14).

> **Trap that cost an hour, worth writing down:** `docker compose up -d --build` **does not build
> this repo.** `docker-compose.yml` pulls the *published* image (that is the README's promise to
> users); building from source needs `-f docker-compose.dev.yml`. The stack on `localhost:3000` was
> the last release — **five** migrations against our fifteen — so it authenticated `ADMIN_PASSWORD`
> against pre-accounts code and mislabelled the authenticator `admin`. Both "findings" evaporated on
> a real build. **Check what is actually running before believing what it tells you.**

### P7.13b — Sessions & devices, viewer gating, danger zone
Sessions & devices (browser, IP, last-seen; revoke one, sign out everywhere) — the honest version of
the plan's "device fingerprint", which cannot be an auth factor because any client can forge it.
Real role-gating across every section (**P7.7's deferral, now unblocked** — the dashboard stores the
role as of 7.13a). The double-confirmed reset-wipe (standing decision #2), which cannot leave an
audit record of itself: it destroys the table it would write to, so it logs to stdout and says so.

*In the gap, an admin who clicks an owner-only action gets a clear 403 naming what they have and
what is needed — which is exactly today's behaviour, so the split regresses nothing.*

### P7.14 — Public URL truth *(small; the `https` problem)*
**The question:** deployed on `xyz.com`, does Connect still say `localhost`? **No — that part
already works.** The base URL is built from how the client actually reached us
(`X-Forwarded-Proto`/`X-Forwarded-Host`, else `Host`). Verified live: with a proxy's headers it
returns `https://xyz.com/v1`.

**The real hole is the scheme.** A reverse proxy terminates TLS and speaks plain HTTP to the
gateway, so the gateway *cannot observe* that the visitor used HTTPS — it only knows if the proxy
says so. A proxy that forwards `Host` but forgets `X-Forwarded-Proto` makes Connect print
`http://xyz.com/v1`: verified live, and the worst kind of wrong, because the page looks fine and
the operator copies it. Then either their client is redirected (works, silently), or it is refused
on a strict deployment, or an HTTPS dashboard fetches an HTTP URL and the browser blocks it as mixed
content. We cannot fix someone's proxy — but we must not *print a confident lie* because of one.

Three layers, cheapest first:
- **`PUBLIC_URL` env var wins over everything.** The deployer states the address; no inference can
  contradict it. This is the only source that is true by construction, and it is what a locked-down
  deployment wants anyway.
- **The dashboard cross-checks.** It is served by the gateway from the same origin, so the browser's
  own address bar is ground truth — it cannot be lied to about the scheme it used. If
  `window.location` disagrees with what the gateway believes, say so on the page rather than hand
  over a URL we have reason to doubt.
- **Document the two proxy headers** in the README, next to the deployment section.

### P7.15 — End-to-end proof *(the testing phase Abbas asked for)*
**The state of it today: CI has no database and no Redis, and nothing in it drives a browser.** All
775 tests call our code directly with stand-ins. That is precisely why `/v1/v1` (P7.9→7.13a), the
bodyless-request bug (found today), and 11 broken buttons all shipped green. **Three bugs, one
pattern: found by a human clicking.** That is the argument for this phase.

- **Real Postgres + Redis behind the existing test job** (compose services in CI). Catches migration
  and data-shape bugs the mocks define away.
- **Browser-driven flows:** claim → sign in → invite → accept → role change → remove, and every
  bodyless button, against a real gateway. Every bug above dies here.
- **Rate limits (RPM/TPM), team limits, budget refusals** asserted at the real boundary.
- **Latency is deliberately NOT a gate.** A shared runner's timings are noisy; a latency check there
  fails at random, and a test everyone learns to ignore is worse than no test. Latency belongs in a
  measurement we run on purpose, not a merge gate.

### Backlog (unscheduled — pull in when they earn it)
- **Team stats: Comparison mode** *(Abbas, 2026-07-16)* — a "Compare" button in Team stats to select
  2 teams or 2 members and show them side-by-side / overlaid. Deferred by agreement as a future
  enhancement once the base Team stats tab is in use; the stats endpoint already returns everything a
  comparison needs, so this is a UI-only addition (two fetches, one layout).
- **Budget cascade — the levels the schema cannot back yet** *(from P7.10)*: an **Org/pool budget
  parent** (blocked on the missing `Org` model — pools are shared infrastructure, so a pool budget
  would need a new owner concept), a **per-tier % split** of a team's budget (needs two caps per team
  and a per-tier spend counter), **per-team email recipients** (notification config is global today),
  and **quarterly/annual** budget windows (the counter TTLs and `periodKey` assume ≤ monthly).
- **Benchmarks + branded PDF** — run tests on demand, clean report, downloadable. Its home now
  exists: the Health → Benchmarks tab (P7.12), which states this plan and stays honestly empty
  until the feature is real.
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
- ~~**There is no user.**~~ ✅ Fixed in P7.13a — one shared `ADMIN_PASSWORD` authenticated everyone,
  so the audit trail could only say "someone with the password" and nobody could be offboarded.
  Accounts, three roles, and per-person second factors now; the trail names people.
- ~~**The dashboard throws away the role it is given at sign-in.**~~ ✅ Fixed in P7.13a — `login()`
  kept the token and dropped the role, which is why viewer-gating was never possible client-side.
- **No `Org` model.** The Enterprise section cannot be honest until one exists or the scope shrinks.

---

*Every phase ends with the standing green gate — lint / typecheck / test / build / audit all clean on
**both** the gateway and the dashboard — plus a `nexus-changes.md` entry, a commit, and a push.*
