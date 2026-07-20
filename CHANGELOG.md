# Changelog

All notable changes to Alayra Nexus™ are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `model: "alayra-nexus-1"` routing contract is the public API surface covered by
semver. The legacy ids `kinetic-nexus-1` and `nexus` remain accepted as aliases.

## [Unreleased]

### Fixed
- **Deleting a pool now takes its models with it (Phase 7.17b).** The model registry is keyed by
  provider slug with no foreign key back to the pool, so deleting a pool left its models behind —
  they stayed in the Models list and came *back* the moment a pool of the same provider was created
  again. A pool delete now clears that provider's models, but only when it was the last pool for
  that provider (a sibling pool of the same type is still serving them).
- **Removing a model is recorded as a deletion, not an edit (Phase 7.17b).** Deletion went through
  the whole-registry `PUT`, so the audit trail logged `models.update` for what was plainly a delete.
  There is now a dedicated `DELETE /admin/models/:id` — it records `models.delete`, 404s honestly on
  an unknown id, and costs one round-trip instead of a read-modify-write of the entire registry.
- **A slow or misconfigured model fetch now explains itself (Phase 7.17b).** The fetch timeout rose
  from 8s to 15s (a full catalogue is large — OpenRouter alone answers with ~344 models), and every
  failure now names the URL that was actually called and the model-id path it looked under, so a
  pool pointed at the wrong endpoint is obvious instead of silently returning nothing.
- **The notifications panel no longer opens behind the page (Phase 7.17a).** The top bar's
  `backdrop-filter` already made it a stacking context, but without a `z-index` it sat at the same
  level as the page content painted after it — so the bell's panel, which overflows the bar, was
  covered by the first row of cards. The bar is now explicitly lifted above content (and still
  below dialogs).
- **A failed sign-in, claim, or password-recovery no longer locks the form (Phase 7.17a).** Each of
  those screens cleared its "busy" flag only on the success path, so a dropped connection left the
  button disabled until a reload. All three now clear it in a `finally`, and a thrown claim or
  recovery surfaces an error instead of failing silently.
- **The unread badge no longer animates when the count goes *down* (Phase 7.17a).** The previous
  count was only remembered when the count fell, so a rise-then-fall (0 → 3 → 2) still compared
  against 0 and popped on the decrease.

### Changed
- **The dashboard uses the whole screen now (Phase 7.16d).** Content was capped at 1180px and
  centered, so a wide monitor showed a narrow column framed by empty gutters. The cap is now a
  `--content-max` token at 1520px that content grows into fluidly — data-heavy pages (Analytics,
  Logs, Teams, Health) get the room, while reading-width panels (Settings) keep their own tighter
  cap. Below the cap nothing changes; tables still scroll and charts still measure their container,
  so no layout can break — the column just stops wasting the width it was given.
- **Notifications now have severity, and the panel is built around it (Phase 7.16c).** Every alert
  carries a severity — a dead key or a sign-in lockout is `critical`, a cooling breaker or a budget
  at 80% is `warning`, and a budget alert escalates from warning at 80% to critical at 100%. The
  bell panel is rebuilt around it: each event gets its own icon in a severity-tinted ring, the feed
  is grouped by day (Today / Yesterday / date), an **All / Unread** filter sits in the header, the
  badge turns red when any unread alert is critical and pops when the count climbs, and unread rows
  carry an accent bar. One additive `severity` column (defaulting to `info`, so every existing row
  stays valid); no alert is produced or delivered any differently.

### Added
- **A stepped, workspace-aware first-run wizard, and password reveal everywhere (Phase 7.16b).**
  Claiming a gateway is now a three-step wizard — prove you installed it, create your account, name
  your workspace — instead of one long form. Every password field across claim, invite-acceptance,
  password-recovery, and sign-in gained a **show/hide eye toggle** (one shared control), the new
  account screens show a live **password-strength meter** and a **confirm-password** field that
  blocks continuing on a mismatch, and the optional final step lets the owner set an **organization
  name** that white-labels the whole console from first paint (saved to branding after the claim; a
  failure there never blocks onboarding). No backend change — the claim API is untouched and the
  workspace name rides the existing branding endpoint.

### Changed
- **The model picker is opt-in, searchable, and harvests real pricing (Phase 7.16a).** Fetching a
  provider's models used to dump every one of them — 339, for OpenRouter — into the selection as
  removable chips, and threw away the pricing data in the very same response, so registry entries
  were born unpriced and every request costed "$0". Both halves are fixed. The fetch now keeps each
  model's **per-token pricing** (converted to USD per 1M tokens), context window, and display name;
  saving selected models writes those prices into the registry, and a re-fetch refreshes stored
  prices without ever letting an unpriced listing zero out values an operator set by hand. The
  dialog now shows a **searchable, opt-in picker**: nothing is selected until you say so, search
  narrows by id and name ("4o mini" finds `gpt-4o-mini`), each row shows its price and context
  window, "Select all shown" works on the filtered set, and the selection reads back as a compact
  strip — four chips, then "+N more" that expands on click.

### Fixed
- **The Overview's Recent Activity now names the person, not just their role (Phase 7.15c).** Accounts
  landed in 7.13a and the audit trail has recorded names ever since — the Logs page shows them — but
  the Overview's activity panel still displayed only "owner" / "viewer". The name now leads with the
  role beside it, the same shape the Logs page uses; a bare role (no name) still means a token-minted
  or pre-accounts action, as before.

### Added
- **A real QR code for two-factor setup, and downloads for the one-time secrets (Phase 7.15b).**
  Enrolling in two-factor now shows a **scannable QR code** — drawn as inline SVG from the secret
  in the browser, never sent to any image service — with the typed setup key and `otpauth` URI kept
  as a "can't scan?" fallback. The one-time credentials can now be **saved to a file**, not just
  copied: the recovery key (a headed `nexus-recovery-key.txt`) on the claim, invite-accept, and
  password-recovery screens, and the ten TOTP recovery codes (`nexus-recovery.txt`, headed
  "Alayra Nexus TOTP Recovery code"). The recovery key also renders on a single line instead of
  wrapping into a squeezed-looking block.

### Changed
- **Every copy button now confirms itself (Phase 7.15a).** One shared `CopyButton` replaces nine
  hand-rolled copy controls across the dashboard — recovery keys and codes, invite links, API
  tokens, quick-start snippets, and team access keys. Each now flips to an animated "Copied" tick
  and reverts, including the reveal-then-copy on a team key, which previously wrote the key to the
  clipboard with **no feedback at all** — a click that looked like nothing happened. The Teams
  access-keys table also gains breathing room so its column header no longer merges into the filter
  row above it.

### Added
- **Public URL truth (Phase 7.14).** The gateway can now be told its public address instead of
  having to guess it. A new `PUBLIC_URL` environment variable pins the origin every printed URL
  uses — the Connect page, quick-start snippets, and the SSO `redirect_uri` — and outranks both
  the proxy's `X-Forwarded-Proto`/`X-Forwarded-Host` headers and the Host-header fallback
  (forged forwarded headers cannot dislodge it; a malformed pin fails the boot with the reason
  rather than misprinting every URL). Without a pin, inference works as before but now carries
  its **provenance**, and the dashboard's Connect page cross-checks the server's claim against
  the browser's own address bar — the one witness that cannot be wrong about the scheme, since
  the dashboard is served same-origin. Agreement is confirmed and its authority named; a pinned
  address that differs from where you're browsing is explained; a *contradicted guess* (the
  classic case: a proxy that forwards `Host` but omits `X-Forwarded-Proto`, so a TLS deployment
  prints `http://`) is overruled — every copyable value follows the address bar, and a warning
  names the two permanent fixes.
- **Sessions, role-gated UI, and the factory reset (Phase 7.13b).** Every sign-in is now a
  session a person can see and end: **Admin → My account → "Where you're signed in"** lists each
  live session with the browser it claimed ("Chrome on Windows"), its IP, when it signed in and
  when it was last active — with per-row sign-out and a "Sign out everywhere else" button. Revocation
  takes effect on the session's very next request; suspending or removing a person now erases their
  sessions rather than merely refusing them. Sessions are indexed per-user in Redis — no schema
  migration. The dashboard's **Sign out** button now also revokes the session server-side instead of
  only forgetting the token. **Role gating everywhere:** viewers are shown no write controls at all,
  and admins are not shown owner-only ones (people management, admin API tokens, master-key rotation,
  network policy, compliance) — presentation only, the server guards were already there. Revealing a
  team access key's plaintext is now write-guarded on the server too: a copyable credential is not
  "read-only". **Factory reset (Admin → Danger zone,** owner-only): three proofs — an owner session,
  the `ADMIN_PASSWORD` from the server's environment, and the typed phrase `RESET THIS GATEWAY` —
  erase every table (discovered from the live schema, so a model added later cannot be silently
  spared) and every Redis key, returning the gateway to its unclaimed first-run state. The reset
  cannot appear in the audit trail — it empties that table — so it logs to the server console and
  the screen says so. **Topbar honesty:** the account chip names the signed-in person and their
  role, and the LIVE pill polls `GET /health` every 30 s — grey OFFLINE when a poll fails, instead
  of the hardcoded green word it had been since the shell was built. Fixed: saving the cache toggle
  now refreshes the Caching page's on/off badge without a reload. 16 new end-to-end specs cover
  sessions, gating, and the reset at the wire and in a real browser.
- **Audit trail & compliance logging for the admin panel (Phase 6.7).** Every state-changing
  admin action is now recorded to an append-only log — who (the Phase 6.5 role), what (a stable
  action slug), on what target, from which IP, at what time, with what result — captured by a
  single request hook so a route added later is covered automatically, plus explicit entries for
  every sign-in, sign-out, and SSO login (success and failure alike). Secrets are redacted before
  write and the log is read-only over the API (`GET /admin/audit`, filterable) — there is no edit
  or delete endpoint, so the trail cannot be tampered with; entries are removed only by the
  retention policy. Writes go through a buffered, off-the-request-path writer (the Phase 4 usage
  pipeline pattern), so auditing never slows a response. **Compliance controls (Settings → Compliance
  & audit):** independent retention windows for the audit log and the usage/analytics log (each
  selectable up to 90 days, or Off to keep forever; **both default to 90 days**, applied by a daily
  cleanup), and an anonymization option that replaces the usage session fingerprint with a one-way
  hash and masks audit IPs for GDPR-sensitive deployments. Additive migration; no new dependency.
- **Enterprise single sign-on for the admin panel (Phase 6.6).** The gateway can now delegate
  admin sign-in to a corporate identity provider over **OpenID Connect** (Okta, Microsoft
  Entra, Google Workspace, Auth0, Keycloak, and any OIDC-compliant IdP), using the
  Authorization-Code flow with PKCE, a `state` CSRF token, and a `nonce` replay guard. The
  IdP's endpoints are discovered from its published metadata, the returned identity token is
  verified against the provider's live signing keys, and its issuer, audience, and expiry are
  enforced. An SSO login is mapped onto the Phase 6.5 roles: a configured group/claim value
  grants **owner**, and every other authenticated user is a read-only **viewer** — least
  privilege by default, with the master password retained as the owner break-glass. The client
  secret is stored with the same AES-256-GCM envelope as every other credential, and every
  outbound URL passes the gateway's SSRF guard. A "Sign in with SSO" button appears on the
  login screen only when an identity provider is enabled. Additive migration; SSO is off until
  an operator configures it, so upgrading changes nothing. The configuration is protocol-aware
  so a SAML adapter can be added later without a restructuring migration.
- **Role-based access control for the admin panel (Phase 6.5).** Admin credentials now carry
  a role — **owner** (full control) or **viewer** (read-only: every page and figure is
  visible, but any action that changes state is refused). Enforced server-side in one shared
  place, so every mutating `/admin` route requires an owner and a route added later inherits
  the gate automatically; reads stay open to either role. A viewer API token can be minted
  (`POST /admin/tokens` with `role: "viewer"`) and used to sign in to the dashboard directly,
  giving a teammate or a monitoring tool read-only access without ever sharing the master
  password. The dashboard shows a read-only banner for viewers and surfaces a denied action
  as a clear message. Additive migration (a defaulted `role` column); the master password and
  every existing token remain owners, so upgrading changes nothing until you create a viewer.

### Security
- **Outbound requests no longer follow redirects.** The SSRF guard vets the URL a request
  starts at; `fetch`'s default policy then follows a 3xx anywhere — so a malicious or
  compromised "provider" answering `302 Location: http://169.254.169.254/` could walk a
  vetted request (credentials attached) straight into cloud metadata or the internal
  network. Every guarded outbound request — provider proxying across all modalities, key
  and credential tests, model discovery, notification email/webhook delivery, and SSO
  discovery/token exchange — now goes through one wrapper that refuses redirects with a
  clear message naming the target. No real provider API redirects an authenticated call;
  point the configuration at the final address.
- **Revealing a team key's plaintext now requires write access.** The reveal endpoint was
  readable by a viewer; a copyable live credential is not "read-only".

### Fixed
- **SSO sign-ins were rendered as read-only viewers.** The callback page stored the session
  token but not the identity the dashboard's role gating reads, so an SSO owner or admin saw
  a viewer's UI (every write control hidden) regardless of their actual role. The callback
  now stores the same identity a password sign-in stores.
- **Editing a team no longer silently re-enables shared-pool fallback.** The team list didn't
  round-trip `byokFallback` and the edit form defaulted it to on — so renaming a BYOK-isolated
  team quietly moved its traffic back onto shared keys. The field is returned, and the edit
  form seeds from what is actually stored.

### Changed
- **Notification delivery integrity.** A non-2xx reply from Resend (a rotated key, an
  unverified sender) or a webhook endpoint is now treated as a failure rather than silently
  discarded. Because the once-per-window coalescing claim is taken before the send, a failed
  delivery would otherwise have suppressed every retry for the whole window; the claim is now
  released when a configured channel was attempted and nothing got through, so the next
  occurrence can retry. A send that actually delivered still coalesces as before.
- **Analytics aggregation pushed down to the database.** The usage summary, per-team-key
  leaderboard, and the per-team / per-model time series no longer load every row for the
  window into memory and fold it in JavaScript — a 30- or 90-day window on a busy gateway
  could be millions of rows. Totals, per-model and per-provider breakdowns now use
  `aggregate`/`groupBy`, and the day-bucketed series use a `date_trunc` grouped query, so each
  returns a small, fixed result regardless of traffic. The usage summary also now reports the
  window's upper bound (`until`) alongside `since`, so a custom date range is unambiguous.

### Added
- **Budget & capacity alerts (Phase 6.4b).** Two more operator notifications, both detected
  on a live request and reusing the Phase 6.4 engine unchanged: a team crossing **80% / 100%
  of its budget** (caught the moment a request's cost lands — no extra read — and sent once
  per threshold per budget window), and a capability whose keys are **all exhausted (503)**,
  tapped uniformly at the routing boundary so it covers chat and every non-chat endpoint
  alike. Both are fire-and-forget, off the request path, and coalesced so a sustained outage
  or a busy over-budget team produces one message, not a flood. New per-event toggles in the
  Settings card.
- **Operator notifications — Resend email + webhooks (Phase 6.4).** Get alerted when the
  gateway degrades or is attacked instead of watching the dashboard: a provider key
  auto-banned, a circuit breaker opening, or an admin login locked out. Off by default;
  configured from a new Settings card. Email goes through Resend (free tier) with the API
  key stored AES-256-GCM encrypted (never plaintext, never logged, masked in the UI), and
  a generic webhook target covers Slack/Discord/PagerDuty. Delivery is fire-and-forget and
  **never on the request path** — a mail outage cannot slow or fail a proxied request — and
  is coalesced so a flapping key produces one message per window, not a flood.
- **Speech-to-text — `POST /v1/audio/transcriptions` (Phase 6.3d).** Audio transcription
  over the same routing, failover, breaker, budgets, and analytics as every other
  endpoint. The audio arrives as a multipart upload; Nexus rebuilds the form with the
  model it routed to (never the client's) and forwards it, so the model abstraction holds
  here as everywhere else. The reply — JSON, plain text, or a subtitle format, depending
  on the caller's `response_format` — is passed straight through. Billed once per
  transcription against a model's `transcriptionPrice`. Uploads are bounded
  (`MAX_UPLOAD_BYTES`, ~26 MB default).
- **Per-modality price fields in the Models tab.** The registry editor now has inputs for
  image (`$/image`), speech (`$/1M chars`), and transcription (`$/file`) pricing, so the
  non-token endpoints added in 6.3b–6.3d can be priced from the dashboard rather than the
  API.
- **Text-to-speech — `POST /v1/audio/speech` (Phase 6.3c).** Speech synthesis routes to a
  model that declares the `speech` capability, through the same routing, failover,
  circuit breaker, budgets, and analytics as every other endpoint. The upstream returns
  audio, so the response is streamed back as raw bytes with its `Content-Type` intact
  (no JSON re-encoding). Billed per input character against a model's
  `speechPricePer1MChars`, reusing the per-modality usage accounting added in 6.3b.
- **Image generation — `POST /v1/images/generations` (Phase 6.3b).** Text-to-image
  requests route to a model that declares the `image` capability, through the same
  routing, failover, circuit breaker, budgets, and analytics as every other endpoint.
  Introduces **per-modality billing**: images are metered per generated image against a
  model's `imagePrice`, not per token, so image cost is accounted honestly without
  polluting token totals. Token usage now carries a `unit` and `quantity` (additive,
  zero-downtime migration) — the foundation the audio endpoints build on next.
- **Embeddings and legacy completions — `POST /v1/embeddings`, `POST /v1/completions`
  (Phase 6.3).** `/v1/embeddings` unlocks RAG stacks (LangChain, LlamaIndex, vector
  search); `/v1/completions` is the fill-in-the-middle / autocomplete endpoint. Both run
  through the same model-first routing, circuit breaker, admission control, BYOK
  isolation, budgets, and analytics as chat — a thin non-chat transport over the shared
  core, not a second routing path. Each selects a model by capability (`embedding`,
  `completion`); if none is configured the endpoint returns `503` naming the missing
  capability. Usage and cost are recorded per request against the real model.
- **Anthropic Messages API — `POST /v1/messages` (Phase 6.2).** Alayra Nexus now speaks
  Anthropic's protocol as well as OpenAI's, so **Claude Code** and the Anthropic SDKs
  route through the same gateway. Point Claude Code at it with
  `ANTHROPIC_BASE_URL=<nexus>` and `ANTHROPIC_AUTH_TOKEN=<team key>`. Streaming, tool
  calls, images, and a `system` prompt are translated to and from the OpenAI shape at
  the edge — the request runs through the exact same routing, failover, budgets,
  guardrails, cache, and analytics as `/v1/chat/completions`, not a second path.
  `GET /v1/models` now returns a shape both OpenAI and Anthropic clients accept, and API
  keys may be sent as `Authorization: Bearer` **or** `x-api-key`.

### Changed
- **Routing is model-first (Phase 6.1).** The Models tab registry is now the source of
  truth for which model runs, its tier, and its priority — not each pool's single
  `preferredModel`. Selection walks models (tier → priority → cost) and finds a healthy
  key for the chosen model's provider, so one Anthropic key can now serve, say, Sonnet
  at the premium tier and Haiku at the fast tier. Models gain a **capabilities** set
  (`chat`, `completion`, `embedding`, `image`, `speech`, `transcription`) — the
  foundation the upcoming protocol endpoints filter on. A pool is now purely
  credentials; its model field is optional and labelled legacy. Existing deployments
  are seeded automatically on startup (each active pool's model becomes a registry
  entry with its tier and `chat`), so routing behaves exactly as before until you add
  more models. A legacy pool-tier fallback covers chat if the registry is somehow
  empty.

### Fixed
- **Per-request cost is no longer silently $0** when a pool's model was absent from the
  registry. Usage is now attributed to the real registry model id chosen by routing, so
  spend and budget accounting are correct.
- **`PUT /admin/models` now validates the registry.** It previously stored whatever it
  was sent; a malformed save could corrupt routing for every request. Entries are
  schema-checked and rejected for duplicate ids or duplicate provider+model pairs.

## [1.2.0] - 2026-07-10

### Added
- **Admin authentication hardening (Phase 6).** Signing in now exchanges the password
  for a short-lived **session token** at `POST /admin/login`; the dashboard no longer
  keeps `ADMIN_PASSWORD` in browser storage. Optional **TOTP two-factor
  authentication** (RFC 6238, implemented on node's crypto with no new dependency and
  verified against the RFC's published test vectors) with ten single-use **recovery
  codes**, both enrolled from Settings or `/admin/auth/totp/*`. Enrolment takes effect
  only once a code confirms it, so an abandoned enrolment cannot lock you out.
  **Per-source lockout** after `ADMIN_MAX_LOGIN_ATTEMPTS` failures (default 5) for
  `ADMIN_LOCKOUT_SECONDS` (default 900), returning `429` + `Retry-After`. A wrong
  password and a wrong code are indistinguishable in the response, so the login form
  cannot be used as a password oracle. **Admin API tokens** (`/admin/tokens`, hashed
  and revocable) let scripts and CI authenticate without a second factor.
  `nexus_admin_login_total{result}` tracks sign-in outcomes. Every unsuccessful
  outcome feeds the lockout counter, including a correct password submitted without
  a code — otherwise an attacker already holding the password would have an
  unthrottled oracle confirming it.
- **Custom-domain storage** — a `DomainAlias` model with per-domain verification state
  and a TXT challenge token. Schema only; the UI arrives in Phase 7.
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

- **Response caching (Phase 4.5):** optional exact-match response cache. When enabled,
  an identical request (same model + messages + generation params) is served from
  Redis, skipping the provider entirely — a real $0 call. The cache key excludes
  `stream`/`user`, so a hit is replayed in whichever mode the client asked for; every
  hit emits a $0 usage event attributed to the team (analytics stay honest, budget is
  not consumed). Tool-call and `n > 1` responses are not cached. Off by default;
  configurable via `CACHE_ENABLED` / `CACHE_TTL_SECONDS`, the dashboard Settings tab,
  or `GET/PUT /admin/settings/cache`. Responses carry `X-Nexus-Cache: hit|miss`, and a
  `nexus_response_cache_total{result}` metric tracks hit/miss/store.

### Security
- The admin password, the Nexus API key, and the metrics token are now compared with
  `crypto.timingSafeEqual` over fixed-width digests. `===` on strings short-circuits at
  the first differing byte, so rejection latency leaked how many leading bytes of a
  guess were correct. Team keys were already safe (hashed lookups).
- Provider names and ids no longer reach inline `onclick` handlers. HTML escaping does
  not protect a JavaScript string context — a browser decodes an attribute before
  parsing its contents as code — so a provider named `O'Reilly'); …` could break out.
  Values now travel in `data-` attributes read by a delegated listener. The edit-pool
  modal's `value=` attributes and several tabs' upstream error text are escaped too.

### Changed
- **`GET /admin/routing/status` reports per-provider key counts.** `totalKeys` and
  `activeKeys` were summed across a whole tier and then stamped onto every provider in
  it, so any tier with more than one provider showed each of them the tier's combined
  total — which the dashboard renders per provider.
- **README:** admin authentication was described as "bcrypt-hashed"; it never was.
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
- **A missing Postgres or Redis now fails with an instruction, not a retry storm.**
  Starting the gateway without its dependencies printed roughly twenty identical
  `ECONNREFUSED` stack traces followed by an opaque `MaxRetriesPerRequestError`.
  Startup now checks both dependencies first and prints which one is unreachable, at
  which host and port, and the command that starts it. Connection URLs are reduced to
  `host:port` in that message, so a password in `REDIS_URL` or `DATABASE_URL` is never
  written to stdout. Reconnection errors during normal operation are logged once and
  then collapsed into a periodic count.
- **README:** the dashboard is served at `/`, not `/dashboard`, and manual setup now
  says that Postgres and Redis must be running first.
- **Opening the dashboard from the filesystem now explains itself.** Its JavaScript is
  ES modules, which a browser refuses to load from a `file://` origin — so
  double-clicking `index.html` rendered the login screen with every button inert and
  no visible error. A small classic script now detects this and points at
  `npm run dev` (or `npx serve frontend` to preview without a database).
- **Demo mode** now shows the BYOK **Owner** column in its provider key tables, so the
  preview matches the real dashboard.
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

[Unreleased]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/releases/tag/v1.0.0
