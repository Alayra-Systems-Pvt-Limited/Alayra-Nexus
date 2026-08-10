# Changelog

All notable changes to Alayra Nexus™ are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `model: "alayra-nexus-1"` routing contract is the public API surface covered by
semver. The legacy ids `kinetic-nexus-1` and `nexus` remain accepted as aliases.

## [Unreleased]

### Added

- **`GET /v1/models` serves your models.** It returned one hardcoded entry, `alayra-nexus-1`, and
  read nothing. An operator could curate ten models in the Models tab and every client still saw
  exactly one — including Claude Code, which builds its model picker from this endpoint.

  The listing is now derived from the registry, and from the same filters routing applies: models
  you have paused are hidden, models whose provider pool no longer exists are hidden, and a team
  isolated from the shared pool sees only the providers it brought keys for. Both the listing and
  request-time resolution are built from one module, so the list can never advertise a model the
  gateway would then refuse. `alayra-nexus-1` is always listed first as the auto-route entry, and is
  still the only entry on a gateway with nothing configured yet.

- **A caller may pin a model.** Send an id or model string from `/v1/models` and the request is
  routed to that model only — still rotating and failing over across that provider's keys, but never
  answered by a different model. This works on every endpoint, including `/v1/messages` and the
  multipart transcription route. Omit the model, or send `alayra-nexus-1`, `auto`, `default`,
  `kinetic-nexus-1` or `nexus`, and Nexus routes as it always has.

  A pin never falls through to the legacy pool-tier path, because that path substitutes each pool's
  own preferred model — which is precisely what a pin exists to forbid.

- **A model now records where its price came from.** Every model carries `pricingSource`: `harvested`
  from the provider's own model list, `catalog` from the bundled reference, `manual` if you typed it,
  or `unset` when nobody knows. Until now a price of `0` meant both "free" and "unknown", and nothing
  downstream could tell the two apart. Existing models keep working — a stored price is read as
  `manual`, no migration required, since the registry is a JSON blob normalised on read.

- **Unpriced models are visible instead of silent.** A "No price" badge on the model row; a two-line
  confirmation before saving one, naming the provider and saying that its requests will report `$0`;
  a running count when adding models in bulk instead of one dialog per model; and a banner on
  Analytics when an active model has no price, so a total that is lower than the truth says so. All
  of it warns and allows — a gateway that refuses to save until you invent a number is worse than one
  that tells you what the number will cost you.

- **Any provider is a first-class provider.** The six-value enum on `POST /admin/providers` and
  `PUT /admin/models` is gone; a provider slug is validated for shape, not membership. It was never
  protecting an invariant — the column is free text, the transport is generic, and nothing downstream
  branches on the value — so all it did was refuse to create Mistral, HuggingFace, Cloudflare or
  Cerebras pools that the gateway routes perfectly well, with a `400` naming six providers and no way
  forward.

- **Presets for ten providers, in one table.** `src/data/providers.ts` holds the base URL, auth
  header and prefix, model-list endpoint, model-id path, extra headers, key prefixes and whether the
  provider publishes prices — read by the gateway and imported directly by the dashboard. This
  replaces four separate lists that each knew a different subset: the dashboard could seed a pool the
  router had no default URL for, and the key-format check knew a provider the dashboard could not
  offer. Presets are defaults, not a whitelist; a provider absent from the table is still first-class,
  it just does not pre-fill.

- **Cloudflare Workers AI works out of the box.** Its OpenAI-compatible base answers `/models` with a
  `405` and its catalogue lives at a different endpoint shaped `result[].name`, which is what the
  separate model-fetch URL and model-id path fields are for. Its URLs are account-scoped, so the
  add-provider dialog asks for the account ID and substitutes it into both URLs, and refuses to save
  a URL with the placeholder still in it — that pool would look configured and `404` on every request.

- **`npm run verify:providers`** re-measures every preset against the live provider APIs using the
  gateway's own header-building and response-parsing code, reports anything that contradicts the
  preset table, and exits non-zero. Opt-in — it needs real keys — and it never edits the table: a
  human decides whether the table or the world is wrong. Dated evidence is committed under
  `docs/provider-verification/`, with account-scoped URLs recorded as placeholders.

- **Provider pools and teams are tested at the HTTP layer.** Neither route file had a single test,
  which is exactly how a dependency bump got close to shipping a `PATCH` that reset a pool's
  `authHeader` and un-suspended a suspended team. 79 tests now drive both files through a real
  Fastify: who is refused, which fields reach the database, and what comes back.

  Six invariants that were carried only by a comment are now carried by a test — that
  `/admin/team-keys/:id/reveal` takes the *write* guard despite being a `GET`, because it hands
  back a live credential; that deleting a provider pool clears its models only when no sibling pool
  of the same provider is still serving; that the pool row is read before it is deleted, since
  afterwards its slug is unknowable; that an empty `extraHeaders` object means *clear them* rather
  than store `"{}"`; that the owned-key count is taken before the team is destroyed; and that the
  plaintext of a new access key is returned once and never stored.

- **`npm run gate:e2e`** walks the whole path a new operator walks — create a pool from a preset, add
  a real key, fetch models, save one with its provenance, send a request through
  `/v1/chat/completions`, and confirm the cost lands in analytics — against a running gateway. The
  cost step is the gate: a `200` proves routing, and a `$0` bill is indistinguishable from a cheap
  one. Measured six providers end to end, including two the old enum would have refused.

- **The README's provider table is generated from the measurements, not typed.** `npm run
  docs:providers` builds it by joining what Nexus ships with the dated evidence in
  `docs/provider-verification/`, and CI fails when the published table and the evidence disagree.
  Every row carries the date it was measured, so a claim that has quietly not been re-checked says so
  on the page. Evidence is chosen per provider rather than per file, because a run only probes the
  providers whose key is on that machine — reading the newest file alone would let a contributor
  holding two keys retract seven verifications they never tested.

- **Reference chapters moved to `docs/`.** Standalone mode, backup and restore, rate limits and
  routing, the API reference, and the accounts/SSRF/guardrails half of the security model are now
  their own pages, linked from short summaries that keep every existing anchor working. The README
  was 81,843 bytes and the npm registry renders only the first 65,536, so the package page had been
  silently cut off — a failure with no error anywhere. It is now 47 KB, with a test and a `prepack`
  check to keep it there.

### Fixed

- **`"model": "auto"` works.** The dashboard's Quick Start has always told operators to send it, and
  the gateway answered with a `400`. The first request most people ever made to this gateway failed,
  in all three copy-paste snippets. It is now an accepted auto-route alias.

- **A request that named a real model was refused.** `gpt-4o` or `claude-sonnet-4-5` returned
  `400 Invalid model … Alayra Nexus routes automatically`, while the README documented the opposite —
  that an exact model string could be used to target a provider. The documentation described the
  feature; the code refused it. The code now does what was written.

- **An Anthropic client's model choice was discarded.** `/v1/messages` overwrote `model` with the
  canonical id before the request was routed, so an Anthropic-SDK caller could never reach a specific
  model however it was configured — and had no way to discover one, since the listing showed a single
  virtual entry. Both halves are fixed together.

- **Routing failures said "rate-limited" when nothing was configured.** Every failure to find a route
  read `All API keys are currently rate-limited. Retry in Ns or add more provider keys.` — including
  on a gateway with no pools at all, and one whose pools hold no keys. Neither is rate limiting and
  neither is fixed by waiting, so the advice sent operators to watch a cooldown that was never going
  to arrive. A gateway with no pools, a gateway with no keys, and a pinned model whose provider is
  saturated now each say what is actually wrong.

- **A streamed Anthropic reply named the virtual model when the provider omitted one.** Providers
  that leave `model` out of their SSE chunks left the reply reporting `alayra-nexus-1`, telling a
  client that had pinned a real model nothing about what served it. The routed model is now supplied
  as the fallback; a provider that names its own model still wins, since it knows the dated variant
  it actually ran.

- **Cost-aware routing preferred the models whose price was unknown.** `effectivePrice` returned `0`
  for a model with no price rather than "unknown", so the cheapest-first ordering put unpriced models
  *first* — the exact opposite of what any operator would expect. Traffic was steered toward the
  models that then reported nothing, which compounds: the spend most likely to be misrouted was also
  the spend least likely to appear in the bill. Anyone running with `costWeight > 0` was affected.
  An unknown price now sorts last.

- **The bundled pricing catalog could never match a namespaced model.** Matching was anchored to the
  start of the model string, so `deepseek/deepseek-chat` and `@cf/meta/llama-3.1-8b` matched nothing —
  529 reachable models, every one of OpenRouter's and HuggingFace's, could not be auto-priced. The
  matcher now also tries the segment after the last slash, folds `.` to `-` so `gpt-4.1` matches
  `gpt-4-1`, and checks a token boundary so `gpt-4o` cannot claim `gpt-4o-mini`. A price borrowed from
  a different provider is offered but flagged, because a model resold by OpenRouter is not necessarily
  the upstream vendor's price. Server and dashboard run the same cases from one shared fixture.

- **A published price of zero was thrown away.** `0` was treated as a "no data" sentinel, so
  OpenRouter's `:free` models — the ones you can actually test with on no budget — were recorded as
  unpriced, sank to the bottom of cost routing and would have worn a permanent "No price" badge with
  no way to clear it. Zero is a price; `-1` (dynamic) is what is unknown.

- **A refetch could not clear a stale "No price".** The price-comparison required a value above zero,
  so a model whose provider publishes `0` never registered as a change, and the obvious remedy —
  fetch the models again — silently did nothing.

- **The registry cache returned unnormalised models.** `getModelRegistry` parsed its Redis entry and
  returned it directly, bypassing the normaliser. Bounded by a 60-second TTL, but it meant the
  invariant "a registry model has every field" was untrue on that path, and the next field added
  would have reopened it. It now normalises on both paths.

- **The dashboard and the gateway disagreed about the same model.** The gateway infers `manual` for a
  priced model written before `pricingSource` existed; the dashboard inferred `unset`. The published
  demo is served from a fixture that predates the field with no gateway in the path, so every priced
  model on it would have carried a "No price" badge while Analytics announced that ten unpriced models
  had no price — directly above their prices. One shared inference now, guarded by a test pinned to
  that fixture.

- **`npm test` overwrote a real gateway's API key file.** `convertLegacyApiKey()` writes the one
  retrievable copy of the master key to `<data dir>/api-key.txt`, and its unit test drives it with a
  mocked settings store — so running the suite on a machine that also runs a gateway replaced that
  machine's `.nexus/api-key.txt` with the test's fixture. The gateway keeps serving, because only a
  hash is stored, but the operator's single chance to read their own key was destroyed with nothing
  said. Every test now writes to a throwaway directory, and a guard fails if that protection is ever
  removed — which immediately caught a second case, where a test file's own cleanup deleted the
  protection instead of restoring it.

- **`npm run verify:providers` could destroy its own evidence.** The record's filename is its date,
  so re-verifying one provider (`verify:providers -- groq`) overwrote that day's full snapshot with a
  single result, and a run on a machine with no keys overwrote it with nothing but "skipped". Neither
  looked like a failure: the file still parsed and still read as authoritative. A record is a full
  snapshot or it is not written; a filtered or empty run now probes and prints without touching the
  committed evidence.

### Changed

- **Four dependency majors: zod 3 → 4, jose 5 → 6, @fastify/multipart 9 → 10, dotenv 16 → 17.** All
  four had been open and green for a week. Green was not the answer: two of them carried a real
  break that no existing test could see.

  **`PATCH` no longer overwrites fields the caller did not send.** Zod 4 changed `.partial()` to
  keep `.default()`, so a partial body came back carrying defaults for every omitted field — and
  both PATCH routes forward the parsed body straight to `prisma.update()`. Renaming a **suspended**
  team would have set `status` back to `active` and put it back to work; editing an Anthropic
  provider pool would have reset `authHeader` from `x-api-key` to `Authorization` and stopped it
  authenticating. The request still returns `200` in both cases, which is why nothing caught it.
  Patch bodies are now parsed through `patchSchema()`, which strips defaults first — a default
  answers "what should this be when created?", a question a PATCH is not asking.

  **Node 22.12 is now the floor** (`engines`), because jose 6 is ESM-only and the gateway compiles
  to CommonJS: it loads only through Node's `require(esm)`, default-on from 22.12.0. Measured
  against the older behaviour it is `ERR_REQUIRE_ESM` at boot, before a route is registered.

  Two libraries the suite was not really testing now are. The SSO test mocks `jose` wholesale, so
  every green tick on that bump was earned against a stub — there is now a test that generates a
  keypair, serves it as a JWKS over real HTTP, and verifies tokens through the same two calls SSO
  makes, including forged, expired, wrong-issuer, wrong-audience and `alg: none`. And
  `/v1/audio/transcriptions`, the gateway's only upload route, had no test at all — its multipart
  contract is now covered, including that `limits.fileSize` still refuses an oversized upload
  rather than buffering it into memory.

  dotenv needed no change: `import 'dotenv/config'` defaults `quiet` to true itself, so v17's new
  `◇ injected env (N) from .env` banner never reaches the gateway's output. Recorded because the
  programmatic `dotenv.config()` does print it, and because only `/config` reads
  `DOTENV_CONFIG_PATH` — which is how `--env-file` works.

- **An unknown model is a `400`, on every endpoint.** It names the models this gateway does serve, so
  the caller can correct it without reading the docs. The non-chat endpoints previously ignored
  `model` outright and routed by capability alone, which meant an operator with three embedding
  models had no way to choose between them — and a client asking for one it did not have was
  answered by another with no indication anything had been substituted.

  Upgrade note: a client sending a model id this gateway does not serve now receives a `400` where it
  previously received an answer from whichever model routing picked. Send `auto`, or register the
  model. This is the point of the change — a gateway that quietly answers with a model you did not
  ask for is wrong in a way that is invisible in the response, in the logs, and in the bill.

- **The response cache keys on the pinned model.** The model was a constant in the cache key, which
  was correct only while there was exactly one thing a caller could ask for. Once a request can pin
  `gpt-4o` or `claude-sonnet-4-5`, a constant would collapse both onto one entry and replay one
  model's answer as the other's. Auto-routed requests keep the canonical identity, so entries written
  before this release still hit.

### Internal

- **The release smoke test now checks the API key, not just the database.** It asserted `nexus.db`
  and nothing else, so it caught the data-directory bug in 1.6.0 only because that bug happened to
  crash the process. A key written somewhere unexpected *without* crashing would have shipped.

  Both halves of the contract are asserted now, because they fail in ways the other cannot catch: a
  key in the wrong **directory** is a container that will not start, and a key still on **stdout**
  is a security regression that starts perfectly. The second is the one 1.6.0 was released to fix,
  and nothing had ever verified it end to end — the check reads the generated key out of the file
  and proves that exact string is absent from the container's logs, then proves the logs still say
  where to find it. A key filed somewhere nobody was told about is the same outage as no key at all.

  The same assertions run in the PR-time container job, where they gate every change rather than
  only tag builds.

- **The SIGTERM guard has now been seen to fail.** The check added in 1.6.0 had only ever been seen
  to pass, which says nothing on its own — the unit test for the data directory *asserted the bug*
  and passed on every run for as long as it existed. Deliberately breaking signal handling produced
  `exited 137 after 20s`, so Docker had to SIGKILL it and both the exit-code and timing assertions
  fired. The guard is load-bearing.

### Security

- **The master API key no longer goes to stdout.** It was printed twice — once on first run, once
  when a pre-7.13a plaintext key was converted at boot. On a laptop that is fine, because a human is
  watching the terminal. In every deployment that matters it is not: stdout is collected by Docker,
  systemd, Kubernetes or a hosted log service, and a credential written there lands in a system with
  a different retention policy, a different access list and a longer memory than anyone intends.

  Deleting the message would have been worse than leaving it. The key is shown exactly once by
  design, so an operator who never sees it has to rotate and update every client — a self-inflicted
  outage during what was supposed to be an upgrade.

  So the key is written to a `0600` file in the data directory and the log gets the **path**. One
  `cat`, and the file survives a terminal that has already scrolled away or closed. `NEXUS_DATA_DIR`
  picks the location, and it falls back to exactly what the **database** falls back to — `.nexus`,
  relative to the working directory — so there is one directory to secure rather than a secret filed
  somewhere nobody was told about.

  That last sentence was not true when this change was first written, and it cost the release. The
  key had its own fallback, `~/.alayra-nexus`, while the database used `.nexus`: two defaults for
  one idea. In a container they resolve to different places, and running the image the way the
  README documents for a bind mount — `--user "$(id -u):$(id -g)"` — gives the process a uid with no
  passwd entry, so `homedir()` is `/`. First boot died with
  `EACCES: permission denied, mkdir '/.alayra-nexus'`, *after* building the database, so the failure
  arrived with a working database sitting next to it. The unit test that covered the fallback
  asserted the buggy path and so passed on every run; it now states the two functions must agree
  rather than restating a literal, and the container job runs the bind mount as an arbitrary uid.

  The mode is set on write and then applied again with `chmod`, because the mode argument only takes
  effect when a file is CREATED — a re-run over a world-readable leftover would otherwise keep it
  world-readable, which is exactly the case where the permissions matter.

  Closes CodeQL `js/clear-text-logging` (alert #40).

- **A guardrail rule can no longer hang the gateway.** Rules are regexes from operator
  configuration, and `compileRules` wrapped `new RegExp` in a `try/catch` — which covers a pattern
  that fails to COMPILE and does nothing about one that compiles perfectly and then backtracks
  exponentially.

  Measured, because the size of this is easy to understand and hard to believe: `(a+)+$` against
  **41 characters** of non-matching input ran for over 90 seconds without finishing. Node is
  single-threaded, so that is not a slow request — it is a stalled event loop, and every other
  request in flight stops with it. One admin-configured rule and a short prompt.

  `isSafePattern` now refuses the shapes that cause this — a quantifier applied to a group that
  itself contains one, and identical alternation branches under a quantifier — plus a 1,000-character
  cap on pattern length. All six shipped presets pass unchanged, and ordinary operator patterns
  (`\bsecret\b`, `(cat|dog)s?`, `\d{3}-\d{4}`) are unaffected; a guard that quietly disabled real
  rules would be worse than none.

  This is a heuristic and is documented as one. JavaScript cannot bound a regex's running time, and
  the only complete fix is a linear-time engine like RE2 — a native dependency this package cannot
  take on and still install cleanly from `npx`. What is true is that the shapes seen in practice are
  refused, guardrail rules remain admin-only, and `MAX_SCAN_CHARS` bounds how much text any rule sees.

  Closes CodeQL `js/regex-injection` (alert #41).

- **The in-memory KV checks that a script twin is callable before calling it.** `MemoryKv.eval`
  looks a registered implementation up by its Lua source and invokes it. The registry is
  module-private and only `defineScript` ever writes to it, so the value is always one of our own
  function literals — but this is the single place in the codebase where something fetched by a
  lookup is CALLED, and it now verifies `typeof impl === 'function'` rather than mere truthiness.
  Addresses CodeQL `js/unvalidated-dynamic-method-call` (alert #46).

### Fixed

- **An unreachable Redis is now a `503` with a `Retry-After`, not a 500, a hang, or a dead
  process.** This is the other half of the change below, and the more important one: the crash
  handler makes the gateway *die* well, and this stops it dying at all for something that was never
  its own fault.

  Three states needed three different answers, which is why one option could not cover it. Each was
  measured against a stopped Redis rather than read from the documentation:

  | state | before | fix |
  |---|---|---|
  | retries exhausted | `MaxRetriesPerRequestError` after ~10s, as a rejected promise that ended the process | `maxRetriesPerRequest: null` |
  | disconnected | queued indefinitely | `commandTimeout` — measured: a queued command rejected at 2002ms under a 2000ms budget, so the timer does cover the queue |
  | connected but wedged | waited forever | same timeout |

  `maxRetriesPerRequest: null` on its own is **worse than the bug**: measured, a command issued
  during an outage never settled at all, which fills a caller's connection pool instead of
  answering it. `enableOfflineQueue: false` looked tidier still and is a trap — the socket is also
  not open for the first milliseconds of the process's life, and with the queue off 0 of 50 commands
  issued at boot succeeded, including the dependency ping the gateway starts with. It stays on.

  Timeout is `NEXUS_KV_COMMAND_TIMEOUT_MS`, default 2000ms. A healthy command measured p50 0.9ms,
  p99 1.7ms, worst 2.45ms — so the budget is not about Redis. It is about this process: the timer
  fires on the gateway's own event loop, which is CPU-bound at saturation, and too tight a budget
  starts rejecting commands Redis answered perfectly well while the loop was busy.

  Fails **closed**, deliberately. A gateway that cannot reach its key-value store cannot enforce a
  rate limit or a budget, and serving anyway would spend an operator's provider credit with the
  controls switched off. Measured end to end on a live gateway: 5 of 5 requests refused with 503,
  0 reached a provider, `/health` still answering, `/ready` correctly 503, and full recovery **0.2s**
  after Redis returned with no restart and no operator action — against 3 hangs plus 2 × 500 and a
  1.6s recovery before.

  Known and bounded: entries stay in the offline queue after their own timeout has rejected them, so
  a long outage grows it and reconnection replays it. Those commands have already been answered, so
  their results are discarded and a replayed reservation expires with the RPM/TPM window it belongs
  to. Putting a breaker in front of the KV would remove it properly and is deliberately left to its
  own review.

- **A key-value failure is no longer reported as a gateway bug.** Without an error handler, an
  unreachable store reached Fastify's default and became a 500 — "the gateway is broken", with no
  `Retry-After` and no reason for a client to retry. Wrong twice: the gateway is fine, and the
  condition is temporary. The predicate is narrow on purpose and matches only failures observed from
  a real ioredis rejection; a `TypeError` or a `WRONGTYPE` keeps its 500, because dressing a defect
  up as a dependency outage tells a caller to come back later for something that will still be
  broken when they do.

- **The gateway now ends deliberately, with the exit code a supervisor needs.** An error reaching
  the top of the process — a background promise nobody caught — got Node's default: terminate,
  print a stack, lose whatever was buffered. That default is right about the terminating part. A
  process whose state nobody has checked must not keep serving traffic, still holding the port and
  still passing its liveness probe. What it cannot do is leave well.

  So the crash is kept and made to land properly. `unhandledRejection` and `uncaughtException` now
  log one line carrying a stable `FATAL` token — the string an operator's log alert matches on —
  followed by the stack, which for a programmer error is the report rather than the noise. Then the
  listener closes, in-flight requests finish, the buffered usage and audit entries are flushed, and
  the database disconnects. Every step is contained, so a failed flush still leaves the disconnect
  behind it to run.

  Deliberately NOT a rescue. Logging the error and carrying on is the tempting version and it is
  worse than the bug: it converts a crash into a process that is broken, quiet, and still in the
  load balancer.

  The whole wind-down is bounded by `NEXUS_SHUTDOWN_DEADLINE_MS` (10s). Every step talks to
  something that can itself be down, and a drain with no deadline against a dead dependency does
  not fail — it waits, until the orchestrator's grace period ends in SIGKILL and nothing is
  flushed at all. Ten seconds sits comfortably inside Kubernetes' default 30s
  `terminationGracePeriodSeconds`, so the deliberate exit always wins that race.

- **A crash exits 1; only a signal exits 0.** The shutdown path always exited 0, whatever brought
  it about. `systemd Restart=on-failure` and `docker --restart=on-failure` both read that code and
  both treat 0 as "it meant to stop" — so a gateway that had just crashed was left down, by a
  supervisor that was configured correctly and told the process had finished its work.

- **A worker that dies at boot no longer spins the machine.** The cluster primary replaced a dead
  worker immediately, which is right for the failure it was written for: one worker hitting a bug
  on one request. It is wrong for the failure that actually happens, which is every worker dying
  for the same reason at once — each replacement checks its dependencies at boot, so while Redis
  is unreachable the primary forked, failed and forked again as fast as the machine allowed. That
  burns a core per worker and floods the log at precisely the moment an operator is trying to read
  it: damage added on top of an outage that was going to last as long as it lasted.

  The first replacement in any minute is still immediate, so single-casualty recovery is unchanged.
  Beyond that the delay doubles from 200ms to a 30s ceiling, and crashes older than a minute stop
  counting — a gateway losing one worker an hour is never penalised. It never stops trying: a cap
  that gave up would turn a recoverable dependency outage into one that needs a human.

- **Signal handling no longer cuts its own flush short.** The cluster primary registered both its
  own handler and the shared one. The shared handler began an async drain; the primary's ran next,
  synchronously called `process.exit(0)`, and ended the process mid-flush. The primary now uses
  only its own handler — it has no buffers of its own to drain — and gives its workers, which do,
  a moment to finish before it leaves.

- **A retention pass can no longer take the gateway down.** `runRetention` guards each of its three
  deletes and not the settings read in front of them, and that read goes to the key-value store. On
  a gateway whose Redis was unreachable it produced a rejected promise with nobody holding it, one
  minute after boot — which, before the change above, ended the process. A housekeeping job is
  best-effort by nature: the rows it did not delete today are still there tomorrow.

### Internal

- **`npm run bench:resources` — where the gateway stops, rather than what it costs.** Every other
  benchmark here measures price per request. This one measures ceilings, which is the question
  behind "it worked in testing and fell over in production": a gateway rarely fails by getting
  slower, it fails by running out of something, and the symptom is timeouts that look exactly like
  a slow provider.

  | | measured |
  |---|---|
  | memory | RSS plateaus at **~505 MB** and stays there — `+0.04 MB` per 1000 requests once the ramp is over |
  | database pool | never the constraint. Peak **5** connections at 64 concurrent callers, no `P2024`, no latency cliff — the routing path commits 0.13 transactions per request, so the pool is barely asked for anything |
  | the ceiling | 128 concurrent callers → **100% 200s, zero dropped connections**. The failure shape matters more than the number: a refusal a client can act on, never a dropped socket that fills its pool |

  The memory figure carries a sizing warning worth having: **size a container from the ~505 MB of
  RSS, not from the ~230 MB of live heap.** V8 sizes its reservation from the memory it can see
  rather than from what the process needs, so RSS follows the reservation. A container sized from
  the live-heap number gets killed by the allocator rather than by a bug. `--max-old-space-size`
  pins it lower.

  Two things this benchmark got wrong about itself before it was right, both left in the file
  because they are the obvious way to build it:

  - **It reported a leak on healthy code — twice.** The first version drove three waves of load and
    watched RSS rise; three waves is entirely inside the ramp, so it could only ever see a rise and
    reported one whatever the truth was. The second version compared per-wave deltas and asked
    whether they were shrinking, which flipped to "leak" on a single busy wave. What works is
    throwing the ramp away and measuring a rate — bytes per thousand requests — across the second
    half of the run only.
  - **The pool check could pass without touching the database.** "The pool was never the limit" is
    only a finding if the pool was asked for something, and this request path resolves most requests
    without a query. It now counts committed transactions from `pg_stat_database` and reports SKIP
    below a floor, rather than a clean result about a component it never used.

  The leak threshold was set from both sides, which is why it is trustworthy: four healthy runs
  measured 0.061–0.442 MB/1k, and a deliberate 10 KB-per-request leak measured 2.82. The limit of
  1.2 sits 2.7x above the worst healthy reading and 2.4x below the leaking one. The detector was
  verified by injecting that leak and watching it fire — including the `external` column, which
  pinpointed off-heap buffers while the JavaScript heap stayed flat.

  Not a CI gate: it needs a real PostgreSQL and runs for about four minutes, which is the wrong
  shape for a merge check. It resets both stores at the start so a second run measures the same
  thing as the first.

- **`bench:guard` gained a fourth check: a KV outage must still answer 503, from a process that is
  still alive.** It guards a production bug rather than a benchmark number, and distinguishes the
  three regressions that are possible — the process dying, a 500 instead of a 503, and a request
  that never returns — because they have different fixes. Both directions were verified by breaking
  the code: removing the command timeout produces "saw hung (5 never returned at all)", removing the
  error handler produces "saw 500 instead of 503".

  The outage is simulated with a TCP forwarder rather than by stopping a container: no privileges,
  no container names, identical on a laptop and in CI, and it severs the connection at a moment the
  test chooses rather than whenever the daemon gets round to it.

- **The benchmarks now refuse to run against a stale build.** They execute the compiled `dist/`, and
  a run against a build older than its source reported the exact behaviour a change had just
  removed — real numbers belonging to the previous version of the code, with nothing in the output
  saying so. That measurement was very nearly published. Fatal rather than a warning: a warning in a
  scrollback is no defence against a number that is confidently wrong.

### Changed

- **Picking a key is now one call to the KV instead of three per candidate, so an exhausted pool
  costs a fifth of what it did.** Routing asked three separate questions about every candidate, one
  at a time — a breaker gate, a Max Users admission, an atomic RPM/TPM reservation. A key that
  failed the last of them had already cost two round trips, and the router paid that again for every
  key it rejected before finding one that worked.

  The whole candidate list now goes in one script and the loop runs inside the KV. Depth costs Redis
  CPU — a few reads per rejected key — but no additional network hops.

  Measured with `ROUTING_POOLS=1 ROUTING_KEYS_PER_POOL=10`, which is the shape a real deployment has
  when one provider account holds many keys:

  | | before | after |
  |---|---|---|
  | first key has headroom | 7.1 | **6.1** |
  | pool partly exhausted, walking past most keys | 12.1 | **5.8** |
  | pool fully exhausted, every request walks all ten | 23.7 | **4.5** |

  Round trips per request. The gap widens exactly as pressure rises, which is the point — the old
  shape was slowest at its busiest. On the sticky path, which is the common one once a conversation
  is going, a pinned request paid three round trips to be told yes and now pays one.

  Two things worth being precise about. Within a pool the walk does not deepen as smoothly as
  expected, because LRU ordering sorts freshly-unused keys to the front — the cost only materialises
  once many keys are unusable at the same time, which is when the last two rows above apply. And the
  sweep across POOLS is still one call each; a deployment with many pools rather than many keys sees
  a smaller share of this.

  **Two bugs fell out of writing the sequence down in one place.** The old order performed its side
  effects as it went, so a key rejected late had already been written to.

  A half-open key's probe slot is claimed with `SET NX`, and exactly one caller may hold it.
  `breaker.acquire` claimed it *before* the RPM/TPM check, so a half-open key then skipped for lack
  of headroom left the slot claimed for its full thirty-second TTL — thirty seconds in which the
  breaker could not send the trial request it was waiting to send. A key recovering from an outage
  stayed dark longer precisely when its pool was busy.

  And `admitUser` recorded a new end-user with `SADD` before RPM/TPM was checked, so a key that was
  then skipped still counted that user against its Max Users cap from then on.

  The script reads every test before it writes anything, and the probe claim goes first among the
  writes because it is the only one that can fail — losing that race skips the key with nothing yet
  written. Both fixes are covered in the parity suite.

  Like every other script here it ships with a synchronous JS twin so standalone mode keeps working,
  and `lib/kv/parity.test.ts` runs fourteen scenarios through both. That gate was verified by
  deliberately diverging the twin from the Lua: the memory-only run still passed and the real-Redis
  run caught it, which is exactly why `PARITY_REDIS_URL` matters.

- **The routing sweep no longer queries the database once per pool it tries, so a deep walk costs
  what a shallow one does.** `bench:routing` measured the defect: exactly one extra `SELECT NexusKey`
  per exhausted pool walked, arriving when every pool is tight and the walk is deepest — the moment
  a gateway can least afford to get slower.

  The cause was that `tryPickKey` issued its candidate query per pool, and issued it unprojected —
  every column, including the label, the masked key and both timestamps, where routing reads eight
  fields. The candidate list is now read through the same one-second cache that already held the
  pinned key's row, and the projection is narrowed to match.

  | | before | after |
  |---|---|---|
  | `SELECT NexusKey` per request, sweep path | 1.0 | **0.1** |
  | database queries per extra pool walked | +1.0 | **+0.1** |
  | queries per request, sweep path | 1.2–1.3 | **0.3** |

  The sweep now costs on the database exactly what the pinned fast path costs. What remains is the
  TTL expiring mid-run, not a per-request query. Failover is unchanged and still correct: 47 of 50
  available slots served, clean refusal once every key is out.

  Two things had to be true for this to be safe, and both are tested.

  The cache is keyed by pool **and owner**, because `ownerTeamId` is what enforces BYOK isolation in
  the query — a shared-pool caller served a list built for a team would be a private credential
  leaving its team through a cache. And the lists are cleared wholesale on every NexusKey write,
  including **create**, which previously invalidated nothing because a brand-new key cannot be in a
  cache keyed by id. Without that, a key added to relieve an exhausted pool would sit idle while the
  pool went on reporting the headroom it had before.

  Caching the list also freezes its `lastUsedAt: 'asc'` order for a second, which is a real trade and
  a smaller one than it looks: `lastUsedAt` is already written at most once per five seconds per key,
  so the stored ordering lags reality by up to five seconds by design. This adds at most a fifth of
  an error the write window already accepts, and ordering only breaks ties between keys that both
  have headroom — RPM/TPM admission is what actually stops a key being overused, and it is atomic in
  the KV where no cache can reach it.

  The Redis half of the walk is untouched and still grows: about two more round trips per pool
  walked, for a breaker gate and an RPM/TPM reservation paid per key rejected. Flattening that needs
  select-and-reserve in a single server-side script, which is separate work.

### Added

- **`npm run bench:failures` — what the gateway does when things break, and a crash it found.**
  Every other benchmark here measures a gateway that is working. The resilience machinery — strikes,
  cooldowns, half-open probes, credential bans — only runs when something is broken, which makes it
  the least exercised code in the product and the code whose failure costs most. It had unit tests.
  Nothing had ever watched it work end to end against a provider that was actually misbehaving.

  Four scenarios, all counted at the provider's own request counter rather than in our logs:

  | scenario | result |
  |---|---|
  | provider returns 500 | blast radius **3 requests** — once the breaker trips the provider is not contacted again, so an outage costs the strike threshold and not one call per request for its duration |
  | credential rejected (401) | **4 wasted calls** for 2 keys — 2 per key, as designed — then the key is banned rather than cooled, because a bad credential does not recover on its own |
  | cooldown expires under load | **2 probes for 2 keys from 20 simultaneous callers.** The half-open slot is claimed atomically per key, so a recovering provider sees one trial request per credential however many callers are queued. A successful probe closes the breaker and the next 10 requests all succeed — recovery needs no operator action |
  | Redis disappears | **the process exits.** See below |

  **The Redis finding is a crash, not a degradation.** When Redis is unavailable long enough for
  ioredis to exhaust its default 20 retries per request, the resulting `MaxRetriesPerRequestError`
  arrives as an unhandled promise rejection and terminates the process. The gateway does not fail
  closed — failing closed is a decision, and this stops answering `/health` altogether. It does not
  return when Redis does; it needs a restart. Under a container runtime with a restart policy that
  is a crash loop for as long as the outage lasts, and for anyone running it directly from `npx`
  it is simply gone.

  The script distinguishes the two deliberately, because "refused every request" and "stopped
  existing" look identical from the client side, and reporting the second as the first would credit
  the gateway with a safety behaviour it did not perform.

  Two smaller observations from the same window, recorded rather than fixed: 3 of 5 requests during
  the outage returned nothing at all — hanging until the client timed them out rather than being
  refused promptly, which saturates a caller's connection pool long before anyone has identified the
  cause — and the prompt refusals were `500` rather than `503`, which is the code that actually
  means a dependency is unavailable and the only one that carries `Retry-After`.

  Fixing this needs a decision rather than a patch, which is why it is reported here rather than
  changed: `maxRetriesPerRequest: null` stops the crash but converts it into an unbounded hang,
  which is the failure mode the paragraph above argues against.

  Three fixture bugs were found and fixed while writing this, each of which had produced a confident
  false claim about the product:

  - Bodyless `POST`s were sent with `content-type: application/json`, which Fastify correctly
    refuses with a 400. Every `unban` in the setup failed silently, keys stayed cooling, and two
    later scenarios measured a gateway with no usable keys — blaming the result on what they were
    testing. The heal step now checks every response and asserts the keys came back.
  - The half-open scenario sent exactly `STRIKE_THRESHOLD` failures, which is right for one key and
    wrong for any other number. With two keys the failures split, neither tripped, and the burst
    flooded a provider whose breaker had never opened — reported as a **stampede that had not
    happened**. It now drives failures until the provider stops receiving them, which is what "the
    breaker is open" means from outside.
  - Recovery was polled with a 15-second timeout inside a 60-second budget, so "still failing after
    60s" really meant "tried four times". It now probes with a short timeout and reports how long
    recovery actually took.

- **`npm run bench:guard` — a CI gate on the findings that were measured and fixed.** Three real
  defects were found by running the gateway and counting, and until now nothing would have noticed
  any of them coming back. All three pass typecheck, lint and the entire unit suite in their broken
  form, which is the whole problem: they are invisible to every check this project already had.

  A new required job asserts **counts and correctness, never latency.** That is this repository's
  own rule, already written into the e2e job — a shared runner's timings are noise, a flaky gate
  gets ignored, and an ignored gate is worse than none. A count reads the same on a laptop and on a
  loaded runner.

  | check | healthy | limit | the bug produced |
  |---|---|---|---|
  | the response cache serves | 1 provider call per 5 identical requests | 1 | 5 — the feature silently inert |
  | database queries per request | 0.15 | 0.80 | 1.10 |
  | routing walk stays flat | 0.55–0.58 | 1.20 | 1.67 (weakest form), 3.34 (full) |

  **Both limits were verified by breaking the fix and watching the guard fail** — making `getCached`
  always return null took the cache check to 5 provider calls, and disabling the key-row list cache
  took queries to 1.10. A guard nobody has seen fail is a guard nobody knows works. The limits sit
  above the healthy value with room for variation and below what the defect produces; both numbers
  are printed next to every limit so the next person can see the gap rather than guess at it.

  The cache check has two independent witnesses — the provider's own counter, which cannot be wrong
  in our favour, and the `X-Nexus-Cache` header a caller sees. They are reported separately, because
  a response stamped `hit` that the provider actually served is a different and worse bug than no
  caching at all.

  **PR #78's round-trip reduction took three attempts to guard**, and it is worth recording the two
  that were thrown away, because both look correct:

  - `INFO commandstats` counts the calls a Lua script makes internally — the exact distinction this
    project already got wrong once and corrected publicly. After the fix a single `EVAL` performs
    about eight internal operations, so executed commands stay level or *rise* while round trips
    fall fivefold. Reverting the fix would barely move the number.
  - An **absolute** round-trip limit measures the right thing but needs a number that travels. Round
    trips per request depend on how many pools and keys exist, so any constant is a fact about the
    fixture rather than about the gateway.

  What is asserted is a **ratio**: the cost of a request that walks past every exhausted key over
  one served immediately. That is the *shape* of the defect rather than its size — the old code paid
  round trips per candidate, so walking ten keys cost ten times walking one; the new code pays them
  inside a single script, so depth costs Redis CPU and no further hops. A ratio also cancels the
  machine, the fixture size and the Redis version.

  The healthy ratio is below 1.0 for a structural reason: a request that walks a fully exhausted
  pool is *refused*, so it never makes the upstream call or the bookkeeping that follows one. Deep
  is cheaper than shallow while the walk costs a single call, and stops being so the moment it does
  not.

  **The first limit for this check was useless and the mutation test is the only reason anyone
  knows.** Set to 2.0 from the numbers in PR #78's own changelog entry, it then *passed* while the
  fix was reverted — one call per candidate produces a ratio of 1.67, comfortably underneath it. The
  limit is now 1.2, taken from measurement rather than reasoning: healthy runs at 0.55–0.58 with a
  spread of 0.03, so 1.2 is roughly double the healthy value and still fails the weakest available
  regression with margin. The real pre-#78 code made *three* calls per candidate, so anything closer
  to the original fails harder.

  A skipped check prints as loudly as a failing one. `npm test` silently skipping the parity suites
  without Docker has already produced one wrong "all green" in this project, and a gate that reports
  success while asserting nothing is the same mistake with higher stakes.

- **`npm run bench:cache` — the response cache measured, and the doubt about it settled.** The cache
  is the gateway's headline cost-saving feature and had never been measured once. Worse, it had been
  DOUBTED: reported from real use as writing and reading but never actually serving. A code audit
  disagreed, which settles nothing — a cache that works in the source and not in production is
  exactly the failure that can only be seen from outside.

  So the first thing this benchmark reports is not a latency figure. It is a proof taken from the
  upstream's own counter: five identical requests, cache off, reached the provider five times; cache
  on, once. The repeat comes back stamped `X-Nexus-Cache: hit`. **The cache serves.**

  What a hit is worth, at a 200 ms provider and 400 requests per cell:

  | repeat rate | p50 ms | p95 ms | RPS | provider calls | avoided |
  |---|---|---|---|---|---|
  | 0% | 261.6 | 280.3 | 31 | 400 | 0 |
  | 25% | 239.1 | 266.5 | 42 | 300 | 100 |
  | 50% | 31.1 | 266.0 | 63 | 200 | 200 |
  | 75% | 6.92 | 254.3 | 112 | 100 | 300 |
  | 100% | 5.92 | 40.7 | **898** | 0 | 400 |

  **Read the RPS column, not the p50 one.** p50 moves in a step rather than a curve, because below a
  50% hit rate the median request is a miss and above it the median is a hit — the median is just
  picking a side of a two-humped distribution, and it reads as "the cache does nothing" at 25% and
  "the cache does everything" at 75%. Neither is true. p95 barely moves at all until the very top,
  for a reason worth stating plainly: **the tail is made of misses, and a cache cannot make a miss
  faster.** What improves smoothly and honestly with the hit rate is throughput and money.

  `avoided` is counted at the provider — requests sent minus requests received — so it is the one
  figure here that cannot be wrong in our favour unless the mock is wrong too.

  **The money reconciles exactly.** 1,590 hits counted at the provider, 1,590 recorded by the
  gateway, `savedUsd` agreeing to four decimal places. That is the dashboard's cost-saving figure
  verified against an independent counter rather than against itself.

  **Three methodology problems had to be fixed before any of the above could be trusted**, and each
  would have produced a plausible wrong answer:

  - The first version read the cache's cost-on-a-miss off the 200 ms cells and got **−6.0 ms on one
    run and +5.7 ms on the next** — the two runs disagreeing about whether the cache makes misses
    slower or faster. A single-digit effect cannot be resolved against a 200 ms constant. It now has
    its own experiment at 0 ms upstream with interleaved repeats, and prints the spread between
    repeats of the *same* configuration beside the answer. At 1.53 ms against a 4.48 ms spread it
    reports "smaller than we can measure here" rather than inventing a number.
  - Warmup requests reached the provider and were counted there, then subtracted from a measured
    total that never included them — which at a 0% repeat rate yields a *negative* "calls avoided"
    and at every other rate a quietly overstated one. Warm and measured phases are now counted
    separately.
  - Both phases share ONE workload generator. A fresh generator per phase restarts its unique
    counter, so the measured run re-sends the warm run's "unique" prompts — every one a cache hit
    recorded as a miss. That is the single most dangerous mistake available here: it inflates the
    headline number in our own favour and looks entirely plausible. `scripts/bench/cacheWorkload.ts`
    is extracted and tested for exactly this, including a test that documents what the mistake costs;
    the suite was confirmed to fail by making unique prompts collide with the hot set.

  The load driver gained per-request bodies to make this possible — a fixed body cannot express a
  workload *shape*, and a cache's entire behaviour is a function of how often traffic repeats.

  Not published as a benchmark: these numbers carry the Docker Desktop VM tax like every other
  figure in this repository so far, and every saving scales with the assumed provider latency
  (`CACHE_UPSTREAM_MS`, 200 ms by default and printed with every result). The mock's fixed 12-token
  response also makes the dollar column a floor rather than an estimate.

  One thing recorded now because it stops being true later: this is **exact-match** caching, so a hit
  is the same answer the model already gave and the saving carries no correctness risk. A semantic
  cache changes both halves of that — the answer is no longer identical, and the hit costs an
  embedding call, so the honest figure becomes saved *minus* that.

- **A key from the wrong provider is now refused when you paste it, instead of quietly banning
  itself an hour later.** A pool is bound to one provider: its slug picks the base URL, the auth
  header and the models, and every key inside it inherits that. So an OpenRouter key pasted into an
  Anthropic pool is not a configuration choice, it is a typo — and the way it used to fail was the
  worst available. The key saved without complaint. Then every request routed to it came back 401,
  the breaker counted the auth failures, and after two of them the key was banned. What the operator
  saw was a pool that silently stopped working several minutes after the action that broke it, with
  nothing on screen connecting the two.

  Adding or rotating a key now runs two checks before anything is written:

  - **The prefix**, instantly and offline. Most issuers stamp their keys — `sk-ant-` is Anthropic,
    `sk-or-v1-` is OpenRouter, `hf_` is HuggingFace, `gsk_` is Groq, `AIza` is Google — which is
    enough to catch the common paste error with no network at all.
  - **The provider itself**, which is authoritative and the only thing that can catch a revoked key,
    a mistyped character, or a key whose prefix says nothing.

  The prefix rule only ever rejects a POSITIVE mismatch, and that restraint is the design rather
  than a shortcut. A bare `sk-` is claimed by OpenAI and copied deliberately by every
  OpenAI-compatible provider, so it is evidence of nothing. Mistral and self-hosted providers stamp
  nothing at all. And formats change — OpenAI added `sk-proj-` years after `sk-`. A rule that
  hard-failed on anything it did not recognise would start refusing valid keys the week a provider
  rotated its format, with no way for the operator to know why. So unrecognised passes, and the live
  check is what catches those.

  The live half is equally narrow about what counts as evidence: **only a 401 or a 403 refuses the
  save.** A 404 usually means the provider does not serve `/models`; a timeout means the network is
  unhappy. Neither says anything about the credential, and refusing on either would make a working
  key unsavable because something else was down — locking the operator out of the fix at the moment
  they need it. `verify: false` on the request drops the network call for an air-gapped pool, but
  never the offline check, which needed nothing and is certain.

  Rotation is checked the same way a create is. Rotating a live key to a wrong one is the worse of
  the two cases: the pool was serving traffic a minute ago, which makes the eventual failure even
  harder to connect back to the action that caused it.

  One consequence worth knowing about: adding or rotating a key now makes a real request to the
  provider, so it appears in their request log against that credential. It is a `GET` of the models
  listing, it happens once per admin action, and it does not touch the key's rate counters — but it
  is a request, and an operator reading their provider dashboard should not have to wonder where it
  came from. The e2e suite had quietly assumed the opposite, counting every request its mock
  received as routed traffic; that oracle now counts completions, which is what it always meant.

  Verified end to end in the dashboard rather than only in tests, which is how the grammar bug
  ("This looks like OpenRouter key", "add a OpenRouter pool") was found — an error an operator reads
  while something is already going wrong is not the place to be sloppy. The route test drives each
  provider response through real Fastify and asserts which side of the line it lands on; it was
  confirmed to fail by replacing the status rule with `if (!result.ok)`, which is the exact
  "simplification" a later change is most likely to make.

- **A benchmark for the routing path, and the discovery that no benchmark had ever taken it.** The
  gateway pins a conversation to the key that last served it, and the pin is keyed by a hash of the
  MESSAGE CONTENT (`src/lib/sticky.ts`). Every benchmark in this repository sent a byte-identical
  body on every request. So every request hashed to the same session, hit the same pin, and took
  `tryStickyKey` — one indexed lookup. The routing sweep that real traffic runs on almost every
  request was never executed once, in any measurement, on any rig.

  `SESSIONS=unique` (k6) and `BENCH_SESSIONS=unique` (the Node harnesses) give every request its own
  conversation and force the miss. The gap between the two settings is what routing costs:

  | | queries per request |
  |---|---|
  | identical bodies — the pinned fast path | 0.3 |
  | unique bodies — the real sweep | 1.2–1.3 |

  The variable part is batched usage writes landing inside or outside the window; the deterministic
  part is exactly one extra `SELECT NexusKey` per request. Both defaults are unchanged, so every
  earlier figure still means what it said — it just described a narrower path than we thought.

- **`npm run bench:routing`, which measures what a key running out actually costs.** Several pools,
  each with one key clamped to 10 rpm, driven past exhaustion in order so the router has to walk
  deeper on each band. Two questions, and they have different answers.

  *Does failover work?* Yes. 47 of 50 available slots were served, the walk rolled to the next pool
  each time a key was exhausted, and once every key was out the gateway refused cleanly rather than
  failing open.

  *What does it cost?* This is the defect:

  | band | pool reached | served | refused | Redis round trips / req | DB queries / req |
  |---|---|---|---|---|---|
  | 0 | pool 0 | 10 | 0 | 7.7 | 1.5 |
  | 1 | pool 1 | 10 | 0 | 9.7 | 2.5 |
  | 2 | pool 2 | 10 | 0 | 12.8 | 3.5 |
  | 3 | pool 3 | 10 | 0 | 13.7 | 4.5 |
  | 4 | pool 4 | 7 | 3 | 14.7 | 5.5 |

  **About two extra Redis round trips and exactly one extra database query per exhausted pool
  walked**, linear in both. The Redis pair is the breaker gate and the RPM/TPM reservation, paid per
  key the router rejects; the query is the `findMany` that `tryPickKey` issues for every pool it
  tries. Extrapolated to a deployment with 20 pools of which 19 are busy, one request pays roughly
  38 extra Redis round trips and 19 extra database queries — precisely when capacity is tight, which
  is the worst moment to get slower. The database half is the more expensive of the two.

  This is a real defect in our own code, not a rig artifact. The fix it justifies is select-and-
  reserve in a single server-side Lua script, with pool metadata already cached in process, so the
  cost is flat regardless of how deep the walk goes; that work is not in this change.

  Two ways this measurement lied before it was believed, both now fixed in the script.

  `INFO commandstats` counts the calls a Lua script makes INTERNALLY, not just the ones that crossed
  the network — one `EVALSHA` doing two `GET`s registers as three commands. Reported as-is, the
  growth above reads as 19.7 → 35.4 "Redis ops", which was quoted as round trips and overstated the
  problem by about two and a half times. The script now counts round trips from a `MONITOR` capture,
  where a call made inside a script is logged against `lua` instead of a client address, and prints
  the raw command count beside it as a separate column so the two can never be confused again.

  And the first version clamped keys via `/admin/keys`, which does not exist — keys live under their
  provider. The 404 produced `undefined`, the clamp silently did nothing, the harness's own key kept
  its 100,000,000 rpm and absorbed the entire run, and the script printed a beautifully flat cost
  curve for a walk that never happened. It now asserts that every key was clamped and fails loudly
  if not. A setup step that quietly does nothing is worse than one that crashes.

- **A two-machine benchmark rig, and four measurements of the same build that disagree by twelve
  times.** `docker-compose.bench.yml` brings up everything that gets MEASURED — gateway, mock
  upstream, Postgres, Redis — on one host. `npm run bench:provision` claims it and prints the exact
  commands for the load generator, which runs on a SECOND MACHINE and is deliberately not in the
  compose file: it must not share a CPU with the thing it is measuring.

  Measured across four configurations, same code each time:

  | configuration | throughput | what actually limited it |
  |---|---|---|
  | host process, load driver on the same box | 1,094 rps | **Nexus** |
  | Docker Desktop VM, k6 in the same VM | 476 rps | the VM |
  | Docker Desktop VM, k6 on a second machine | ~320 rps | the VM |
  | closed loop, 64 VUs | 90 rps | its own tail |

  Only the first is a measurement of the gateway. The others are the rig, and each looked like a
  result until it was checked. That table is the finding.

  With a load generator that is no longer stealing CPU, overhead is finally a subtraction at matched
  load rather than an estimate — the same rate driven at the mock directly and then through the
  gateway:

  | arrival rate | network alone | through the gateway | overhead |
  |---|---|---|---|
  | 200 rps | 3.8 ms p50 | 10.9 ms p50 | **7.1 ms** |
  | 400 rps | 3.7 ms p50 | 152.1 ms p50 | 148.4 ms — past the knee |

  The network was suspected and is innocent: it carries 600 rps at a 16 ms p99 with nothing dropped,
  while the gateway at that rate collapses to 320 rps and a 20-second tail. Congestion collapse
  under a virtualisation tax, not a slow link.

  No absolute figure is published from any of this. What the rig establishes is that the number has
  to be taken on Linux, where Docker is native and the VM tax does not exist.

- **An open-loop load benchmark on k6, and the discovery that our own tail figures were about five
  times too kind.** Every latency this project had published internally came from a closed-loop
  driver: send a request, wait for the reply, send the next. That measurement has a known defect —
  when the server stalls, the generator stops sending, so the requests that would have arrived
  during the stall are never made and the stall never reaches the percentiles. The worse the server
  behaves, the fewer slow samples are taken.

  `npm run bench:k6` replaces it for anything published. It drives a fixed ARRIVAL RATE with k6
  (pinned to v0.49.0) regardless of whether the gateway is keeping up, reports p50 through p99.9,
  and counts the iterations it could not start on time. Both executors are in the one script, so
  the comparison can be run with a single variable changed:

  | same gateway, same network, ~equivalent throughput | p50 | p99 | p99.9 |
  |---|---|---|---|
  | closed loop, 64 VUs → 476 rps | 127.6 ms | **281.6 ms** | 965 ms |
  | open loop, 400 rps requested | 45.7 ms | **1,404 ms** | 3,566 ms |

  Nothing about the gateway changed between those two rows. Only the honesty of the measurement.

- **The whole rig in containers, on one network.** The gateway, the mock upstream, Postgres, Redis
  and the load generator now run as containers on a single Docker network, which is both what a
  reader should be able to reproduce and the only way to get a trustworthy number: the first attempt
  ran k6 against a gateway on the host and measured Docker Desktop's NAT — 88 ms p95 at 200 rps
  where a host-side driver saw 17 ms, then connection refused. `--network host` is not an escape
  either; on Docker Desktop it joins the VM's namespace rather than the host's.

  The runner also measures its OWN ceiling every run, by pointing k6 straight at the mock with the
  gateway out of the path, and says so when a result approaches it. That check exists because this
  project has twice mistaken the harness's limit for the gateway's.

- **Settings, the model registry and the provider pools are held in this process for a few
  seconds, and the gateway got roughly four times faster where it counts.** Each of these already
  sat in Redis, which is the right place for them — shared, and a write on one instance is visible
  to the others at once. It is also a network round trip, and a request made a great many of them:
  **31 commands per request**, eighteen of them individual `nexus:setting:*` reads, plus the model
  registry and the active pools fetched twice each.

  None of it could be seen in a CPU profile, because none of it uses CPU. The process was waiting.
  That is the whole reason the same gateway measured 671 requests a second on the standalone file
  and 281 against Postgres and Redis — and why the previous release's figures, measured standalone,
  did not describe a real deployment.

  A small in-process memo now sits in front of each, holding a value for a few seconds. The windows
  are seconds rather than minutes on purpose: the saving comes from holding a value across the
  requests arriving while it is hot, not from holding it long — five seconds already removes better
  than 99.9% of these reads — while the cost is the window in which two instances can disagree.
  The instance making a change is never stale about it, since every write path updates its own memo.
  `SETTING_MEMO_TTL_MS`, `REGISTRY_MEMO_TTL_MS` and `PROVIDER_MEMO_TTL_MS` tune them; `0` disables.

  Measured against Postgres and Redis, one worker at 64 concurrent callers:

  | | before | after |
  |---|---|---|
  | Redis commands executed per request | 31 | **18** |
  | Redis network round trips per request | — | **7** |
  | throughput | 281 RPS | **1,094 RPS** |
  | median latency | 222 ms | **34.7 ms** |

  The first row is what `INFO commandstats` reports, and it counts the calls a Lua script makes
  internally as well as the ones that crossed the network — our breaker and admission scripts each
  turn one `EVAL` into two or more counted commands. An earlier draft of this entry called that row
  round trips, which it is not. The 18 that remain are **7 network hops**; the rest is Redis CPU.
  The throughput and latency rows are direct measurements and are unaffected either way.

  What remains is live shared state that must be remote for a scaled deployment to be correct —
  rate-limit and token-budget counters, breaker state, session pins.

  Scaling works now that requests are not spent waiting: **two workers serve 2,244 RPS, 2.05× one
  worker**. Three and four could not be measured on the development machine, which has four physical
  cores and was also running the load driver and both containers.

- **The gateway can run as several processes, and refuses to when that would be wrong.**
  `NEXUS_CLUSTER_WORKERS=4` (or `auto`) forks that many workers over one listening socket. One
  process costs about 1.5 ms of CPU per request and tops out near 670 a second, and no amount of
  concurrency adds a second core; more processes is Node's answer.

  It refuses to fork without a shared `REDIS_URL`, and that refusal is the point. In standalone
  mode the KV is an in-process map, so four workers would keep four independent sets of RPM/TPM
  counters and enforce each key's limit once *per worker* — a key capped at 60 requests a minute
  would serve up to 240. That is the kind of mistake a provider answers with a suspension, so it is
  fatal at boot rather than a warning nobody reads twice.

  One-time work — building the SQLite schema, seeding the registry, generating the API key — now
  happens in the primary before any worker exists, instead of racing four ways. Retention, the
  health sampler and the backup scheduler run on the first worker only.

- **`npm run bench:scaling` and `npm run bench:store-ops`.** The first walks worker counts one at a
  time so a scaling curve can be seen bending, against Postgres and Redis in Docker because that is
  the only topology where forking is allowed. It measures the load driver's own ceiling in every
  run, so "the gateway stopped scaling" can be told apart from "the machine ran out of cores".

  The second counts Redis work per request, and exists because the first produced a number less than
  half the standalone one and the reason had to be found rather than guessed at. It found **31 Redis
  commands per request**, eighteen of them individual `nexus:setting:*` reads for values that change
  when an operator edits them and never between two requests. Against an in-process map those are
  free, which is why nothing had noticed. Against a real Redis they are the dominant cost of a
  request, and they are why the production topology measures 281 RPS where standalone measures 671.

  It now reports round trips and executed commands as two separate figures, tagging the `(lua)`
  lines that happened inside a script that had already crossed the network. Conflating the two is a
  mistake this repository made and had to correct.

- **The pinned key's row is cached for one second, taking the last query off the request path.**
  This one was held back from the previous change on purpose, because it is not the same kind of
  cache: key rows change underneath us at runtime. The breaker cools a key on a 429, bans it after
  repeated auth failure, and an admin can rotate its credential or hand it to a team. Three fields
  are ones we would rather not be wrong about even briefly — `status`, `ownerTeamId` (BYOK
  isolation) and `encryptedKey`.

  What makes it safe is that the benefit does not need a long TTL. A key serving 400 requests a
  second is read once instead of four hundred times at a one-second TTL — about 99.75% of the
  queries gone — and a longer window buys almost nothing while costing exactly how wrong we can be.
  One second is also the *worst* case: every write path invalidates explicitly, so within a process
  a ban or a rotation takes effect immediately. The TTL covers only what invalidation cannot reach —
  another instance's write, a change made directly in the database, a restore.

  Two live checks are untouched and bound the risk further: the breaker gate is read from the KV,
  not from this row, and RPM/TPM admission is atomic in the KV. A stale row cannot pass either.
  `KEY_ROW_CACHE_TTL_MS=0` disables the cache entirely.

  The row is also read with a projection now instead of every column.

  **Across the three changes: 4.2 queries per chat completion down to 0.3, median overhead from
  3.02 ms to 1.60 ms, and throughput from 237/329/336 to 390/599/671 RPS at 1/8/32 workers** — a
  doubling under concurrency.

- **Sticky routing stopped joining to the provider table, and `lastUsedAt` stopped being written on
  every request.** Two more per-request queries gone. Sticky session routing — the common path once
  a conversation is under way — reached its pool through an `include`, which Prisma issues as a
  second query reading every column where routing needs eight. It now resolves the pool from the
  cache above. A pool missing from that cache is inactive or deleted, which is exactly what the old
  `isActive` check on the joined row meant.

  `lastUsedAt` is written at most once per key per five seconds instead of once per request, with
  `updateMany` rather than `update` so Prisma stops compiling it to a `RETURNING` of every column
  that nothing reads. This is a real trade and worth stating: the column orders candidate keys so
  load spreads across a pool, so suppressing writes lets a busy key sort earlier than it deserves.
  The error is bounded by the window, and RPM/TPM admission — not this ordering — is what actually
  stops a key being overused. `LAST_USED_WRITE_WINDOW_MS=0` restores a write per request.

  Together with the provider cache: **4.2 queries per chat completion down to 1.2**, median overhead
  from 3.02 ms to 1.83 ms, and throughput from 237/329/336 to 374/491/490 RPS at 1/8/32 workers.

- **The active provider pools are cached, removing a query from every routed request.** Routing
  asked the database which pools exist on every single request, and the answer changes only when an
  operator adds, edits or removes one. It is now read once and served from the shared KV, with every
  mutation path invalidating explicitly — and because invalidation is a `del` against that shared
  KV, a scaled deployment invalidates every instance rather than only the one that took the write.

  Only the scalar columns routing reads are cached. That keeps the payload small, but the reason is
  correctness: the value round-trips through JSON, and `JSON.parse` turns a `DateTime` into a string
  while TypeScript goes on calling it a `Date` — code that then called `.getTime()` would compile
  and throw. Not selecting `createdAt` makes that impossible rather than merely unlikely.

  Queries per chat completion fall from 4.2 to 3.2. The remaining provider read turned out to belong
  to a different caller than expected — sticky session routing, which reaches its pool through an
  `include` and short-circuits before the cached path is used.

- **A CPU profiler and a query counter for the gateway, and the answer they gave.** The first
  benchmark established that a request costs about 3 ms of CPU and that throughput barely moves
  between 1 and 32 concurrent workers — one saturated thread. It could not say which code was
  spending the time, and every optimisation proposed from reading the source was a guess.

  `npm run bench:profile` runs the compiled gateway under a V8 sampling profiler that can be started
  and stopped mid-run, so the profile covers the measurement window rather than boot and warmup.
  `npm run bench:queries` counts the database queries one request issues. Neither needs Chrome
  DevTools: `scripts/bench/analyzeProfile.ts` prints the rankings a flame graph is normally read
  for, which also means a profile can be evidence in a pull request.

  What they found contradicted the plan they were built to test. Application code — routing,
  guardrails, cache lookups, our own JavaScript — is about 4% of the CPU a request costs. The
  database layer is the majority of it, and the reason is that a single chat completion issues
  **4.2 queries**: the provider list twice, the key sweep once, and one `UPDATE` whose only purpose
  is to stamp `lastUsedAt` on the key that was used. Three of those four ask for something that did
  not change since the previous request.

  The tokenizer, which had been the leading suspect, measured 1.0–1.2%. Replacing it with a
  Rust-backed one would have bought about a percent.

- **Move to PostgreSQL, from the dashboard.** A gateway started with `npx` runs on a single file,
  which is why it starts in seconds and needs nothing set up. Growing out of that — a team, real
  traffic, a server — meant knowing to point `DATABASE_URL` at Postgres, restart, and restore a
  backup. Every piece worked; the screen that walks somebody through it did not exist, and that step
  is where people either commit to the product or give up.

  Admin → Database now checks the destination before touching it (can it be reached, what is it, is
  something already in it), builds the schema with `prisma migrate deploy` so the new database keeps
  a migration history and stays upgradeable, copies every table parents-first, and counts both sides
  afterwards. "Moved" is claimed only once every count matches.

  The gateway refuses requests while it runs, for the same reason a `replace` restore does: a copy
  taken over time would silently miss anything written after its table was read. Nothing is deleted
  and nothing switches over — the old gateway keeps running until the operator changes
  `DATABASE_URL` themselves, which is what makes it safe to attempt.

- **`alayra-nexus --migrate`**, the same move for headless and CI use. The destination is read from
  `NEXUS_MIGRATE_TO` rather than an option, because a command-line argument is readable by every
  other process on the machine and that string holds a database password.

- **The gateway keeps its own backups, and you can download them.** A scheduled backup used to be
  written only to a folder path on the server. That is durable on a VM and wiped on every redeploy
  inside a container — and nothing in the gateway can tell those two situations apart, so on a
  hosted platform the feature produced files that ceased to exist on the next push, and that nobody
  without shell access could have retrieved anyway.

  Every backup is now stored in the gateway's own database, which is the only storage that exists
  and survives in every deployment shape. There is nothing to configure: switch the schedule on, or
  press **Back up now**, and the file appears in a list with a download button. Held in chunked rows
  rather than one column so the export stays streamed in both directions, and the backup tables are
  excluded from both the export and the schema fingerprint — otherwise each backup would contain the
  one before it, and every backup taken before this shipped would report drift on restore.

- **An optional second copy, kept off the machine.** A folder on the server is now an *extra* copy
  rather than the destination, written by streaming the stored backup out byte-for-byte, so the copy
  on your disk and the copy you download are the same artifact. A copy that fails is reported as a
  copy that failed — the backup itself still succeeded and is still downloadable.

- **A plain statement of the one thing these backups cannot survive.** Losing the database takes the
  backups with it. The panel says so, at a strength that tracks the actual risk: prominent when the
  backups exist in one place only, softened once a second copy is genuinely being written, and gone
  when that copy is off the machine entirely.

### Changed

- **Prisma 6 → 7.** The gateway now runs on the current major. Nothing about how it behaves changes,
  and no configuration a user or a deployment holds needs editing — `DATABASE_URL` is still the only
  thing that decides which database is used, and it is still read from the environment.

  What moved is internal. Prisma 7 takes its connection through a **driver adapter** rather than a
  `datasources` option, so the Postgres client is opened with `@prisma/adapter-pg` and the SQLite one
  with `@prisma/adapter-better-sqlite3`. The SQLite adapter is a native addon and is loaded lazily,
  for the same reason its client always was: a Postgres deployment must not fail to start because a
  binary it will never call was built for another platform. `url` also left the datasource block, so
  the CLI reads it from a new `prisma.config.ts` — which reads the environment, because this
  repository has two schemas and a URL written into a file would be right for one and wrong for the
  other.

  Three things Prisma 7 removed had load-bearing uses here, and each is worth naming because two of
  them fail QUIETLY:

  - **The DMMF no longer reports `isRequired`, `hasDefaultValue`, `isId`, `isUnique` or
    `relationOnDelete`.** The backup fingerprint that depended on the first two is dealt with above.
    The engine-parity suite depended on the rest, and did not fail — both clients lost the same
    properties, so five assertions kept comparing and matching while checking nothing at all. They
    now read the schemas directly, and a new test asserts that every DMMF property the file still
    reads is actually present, so the next removal fails one obvious test instead of hollowing the
    suite out again.

  - **The generated client has no default location.** Adding an explicit one is the obvious fix and
    is wrong: an explicit path is resolved against the schema file, which inside an installed package
    means the client lands in that package's own `node_modules` while `@prisma/client` — hoisted to
    the top level by npm — looks somewhere else entirely. That shipped as
    `Cannot find module '.prisma/client/default'` on `npx @alayrasystems/nexus`, and was caught by
    the packaging smoke test rather than by a user. Leaving the output unset is what is correct:
    Prisma then writes into whichever `@prisma/client` node resolution finds, which is the only rule
    that survives hoisting.

  - **`prisma migrate diff --to-schema-datamodel` is now `--to-schema`.** This one fails loudly, as
    do `db push --skip-generate` and `migrate reset --skip-generate --skip-seed`, whose behaviours
    were removed along with the flags.

  Two more differences were found by running the engine-parity suites against a real PostgreSQL and
  a real SQLite, and neither would have been visible any other way:

  - **SQLite timestamps keep their existing storage format.** Prisma 7's SQLite adapter writes a
    `DateTime` as ISO text by default; every gateway that has ever run standalone holds integer epoch
    milliseconds. Nothing converts on upgrade, so the default would have started appending rows in
    the second format to columns full of the first — and SQLite permits that. The damage is silent:
    the dashboard's day buckets divide the stored value by 1000, so every row written after the
    upgrade would have landed in **1970**, and "last 7 days" filters would have been wrong in a
    different way again, because SQLite orders by storage class before value. The old format is
    pinned, so existing files stay correct and an upgrade stays a binary swap.

  - **The restore timeout is now enforced by this gateway rather than by Prisma.** A restore runs in
    one transaction with a time budget, and exceeding it is reported as "this needs longer" rather
    than as a damaged file. Prisma 7's PostgreSQL adapter still honours that budget; its SQLite
    adapter does not — measured, a transaction running 411 ms completed under a 1 ms budget, with no
    warning. That is the whole guarantee gone on standalone, which is the mode with no operator
    watching. The deadline is now checked on the wall clock inside the restore loop, so it holds the
    same way on both engines. Rollback is unchanged.

- **Prisma 5 → 6.** The ORM this gateway runs on had been on 5.x, which is no longer the supported
  line. Nothing about the gateway behaves differently — the upgrade needed no code change at all, and
  the full suite, the browser end-to-end run and the standalone smoke test all pass unmodified. Every
  documented breaking change in that release was checked against this codebase and none applied: no
  preview features were in use, every relation is explicit, and the one type change (`Bytes` becoming
  `Uint8Array`) was already handled where backups are read back.

  Worth knowing if you develop with an AI coding agent: from Prisma 6 onward, commands that would
  destroy a database refuse to run when they detect one, until a human explicitly approves. Nothing a
  user or a deployment runs is affected — `prisma migrate deploy`, which is what the move to
  PostgreSQL uses, is not gated — but running this repository's engine-parity suites through an agent
  now asks first.

- **The backup drift check stopped depending on a Prisma detail that Prisma is removing.** Every
  backup carries a fingerprint of the schema that wrote it, describing each column four ways: name,
  type, whether it is required, and whether the database can produce a value for it. The last two
  are what let a restore tell "this file predates a nullable column" — fine, restore it — from "this
  file predates a REQUIRED column with no default", which cannot be honoured and is refused before
  anything is emptied.

  All four came from Prisma's DMMF. Prisma 7 reduces a field there to `{name, kind, type}`, and the
  consequence is not that a check goes quiet. Measured on a real column, `NexusProvider.slug`:

  | | fingerprint | verdict | what the operator is told |
  |---|---|---|---|
  | before | `slug:String:req:nodef` | blocking | "required here with no default" — refused |
  | on Prisma 7 | `slug:String:opt:nodef` | not blocking | "it will take its default" — **allowed** |

  A restore that cannot succeed would have been described as safe, then failed partway through with
  the tables already emptied. False reassurance in the one place an operator has no choice but to
  trust what they are read.

  Prisma was never the source of those two facts, only a relay. `prisma/schema.prisma` states them
  outright, so they are now read from there at build time into a generated module. The change is a
  pure refactor on the current version: the fingerprint is **byte-identical** to the one this gateway
  produced before, across all 161 scalar columns and on both generated clients, so every backup ever
  taken still compares exactly as it did.

  A column the generated file does not describe is now a hard error rather than a guess. Falling back
  to a default would reproduce precisely the bug above, and a fingerprint that is quietly wrong is
  worse than one that is missing, because it is believed.

### Fixed

- **The migrations and `schema.prisma` had drifted apart, and now cannot again.** Nineteen
  differences had accumulated over eighteen hand-written migrations: database-level defaults on
  `id` and `updatedAt` that the schema does not declare, and five foreign keys missing
  `ON UPDATE CASCADE`.

  None of it changed behaviour — every `ON DELETE` action already matched, and `ON UPDATE` fires
  only when a primary key value changes, which never happens to a uuid written once. That is
  precisely why it survived. The cost lands later: the next person to run `prisma migrate dev` for a
  one-line change receives all nineteen statements folded into their migration, and either ships
  them unread or unpicks them under pressure.

  Migration `0019` applies them deliberately, and a new check replays every migration into a real
  PostgreSQL and fails if anything is left over — so this is now caught by CI rather than by
  whoever happens to touch the schema next. `npm run db:drift` runs the same check by hand.

- **The demo answered nothing for the database section**, so a visitor could not tell that moving
  between engines is a supported step.

- **"Back up now" can no longer be offered and then refuse.** It was withdrawn until a folder had
  been configured, which on a host with no persistent disk meant it could never be pressed at all.

- **Deleting a team key no longer depends on Redis being up.** The delete cleared a cache entry that
  nothing has ever written, and it did so *after* the row was already gone and without guarding the
  call — so with Redis unavailable the request answered with an error about a key that had in fact
  been revoked, sending the operator to look for something that no longer existed. A team key is
  verified by an indexed lookup straight against the database, so deleting the row is the
  revocation, and it takes effect on the very next request.

- **Taking two backups in the same second no longer wastes one and hides the wreckage.** A backup's
  name is its timestamp to the second, and it is unique — so pressing **Back up now** twice quickly,
  or pressing it in the second a scheduled run lands, asked for a name that was already taken. The
  collision surfaced at the very last step, *after* the entire database had been exported,
  compressed and written: all of that work discarded, reported as a raw database constraint error,
  and the half-written record left behind holding every one of those chunks — invisible in the list
  and counting against the gateway's storage permanently. It now refuses immediately, and says so in
  a sentence that names the fix.

### Internal

- **The paths that move your data are now covered end to end.** Moving to PostgreSQL, the stored
  backups, the off-machine copy and the unattended schedule each shipped without a test that ran
  them for real. They now have one, and the checks run on every change: a populated gateway is
  genuinely migrated into a real PostgreSQL and counted on both sides; a real timer is waited on
  until it produces a backup nobody asked for; that unattended file is handed back and opened with
  no passphrase, which is the operation it exists to make possible. Writing them turned up the
  same-second backup collision fixed above, and each check was then verified by deliberately
  breaking the code it guards — a test that has never been seen to fail is not evidence of anything.

- **The Move to PostgreSQL screen is covered, including the two things about it that would be worst
  to get wrong.** A verdict on a destination cannot outlive the connection string it was about — edit
  the box after a check and the green "ready" and the button both withdraw, because a reassurance
  about a different database is worse than no reassurance. And a connection that drops mid-move is
  never reported as "it did not happen": that outcome is genuinely unknown, and saying otherwise
  invites somebody to run it a second time into a database that is now full. The move itself was
  already proven against two live engines; this is the part a person actually touches.

- **A third intermittent failure, this one self-inflicted, is gone.** Refusing two backups taken in
  the same second — the fix above — made the end-to-end suite's own timing an issue: it presses
  "Back up now" moments after detecting the scheduled run, and the poll that detects it can return
  inside the very second the timer wrote its file. The spec now crosses a second boundary before
  asking for a backup, which is what the gateway's own refusal message tells an operator to do.

- **Two long-standing intermittent test failures were diagnosed and removed.** The older one had
  been recorded for months as a slow-machine problem. It was the reverse: a restore carrying six
  rows finished inside the one-millisecond budget its test imposed, so the expiry it was checking
  for never happened, and it failed when the machine was *fast*. A green suite that is occasionally
  red for reasons nobody trusts is worse than a slow one.

## [1.5.3] - 2026-08-01

**Upgrade if you are on any earlier version.** This closes a rate-limit bypass that made the
protection on unauthenticated endpoints — sign-in among them — ineffective against an IPv6 client.

### Security

- **An IPv6 client could not be rate-limited at all.** The abuse guard keyed its buckets on the
  verbatim client address, which does not work for IPv6 in two independent ways. A single customer
  `/64` holds 2^64 addresses, so a new source address per request means a new bucket per request
  without ever leaving the allocation you were given. And one address has several spellings —
  `2001:db8::1`, `2001:0db8:0000:…:0001`, `2001:DB8::1` — so even a client that cannot rotate can
  simply rewrite the text.

  The endpoint that matters is **sign-in**: unauthenticated, so it takes the IP path, and
  brute-force protection is the entire reason a limit is on it. Password reset and invite
  redemption are the same shape.

  Addresses are now canonicalised and masked to their `/64` before becoming a key, so every address
  one attacker plausibly controls shares a bucket and the textual variants collapse onto each other.
  IPv4 is unchanged; an IPv4-mapped address buckets as the IPv4 address it actually is.

  `@fastify/rate-limit` also goes to **11.2.0**, which fixes the same class of problem
  ([GHSA-grpc-p53c-r64v](https://github.com/fastify/fastify-rate-limit/security/advisories/GHSA-grpc-p53c-r64v),
  CVSS 7.3). **That upgrade alone would not have fixed this gateway**, and this is the part worth
  reading twice: the plugin's fix lives in its own key generator, and Nexus supplies a custom one.
  Anyone who upgraded the dependency themselves — or whose scanner told them to — would have seen a
  patched version number and remained exactly as exposed.

- **Two high-severity advisories cleared, and one stale pin that caused the second one.**
  `fast-uri` goes to 3.1.5 / 4.1.2
  ([GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7)) and `brace-expansion`
  to 5.0.9 ([GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895)). Both arrive
  through dependencies rather than this codebase, and both resolve at the patch level, so no
  package here changed its declared range.

  The `fast-uri` advisory is worth being precise about, because the honest answer is not the
  alarming one. It describes a parser desync: `fast-uri` reads `\\evil.com` as a path, Node's own
  `URL` reads it as a host, so a check written with one and enforced with the other can be walked
  past. That only bites an application that uses `fast-uri` to decide *where a request is allowed to
  go*. **Nexus does not.** The SSRF guard parses with `new URL()` — the same parser `fetch` and
  undici use — so the two halves cannot disagree, and `fast-uri` is reached only through ajv's
  schema validation of request bodies. Patched because it should be, not because this gateway was
  reachable through it.

  `brace-expansion` is the more instructive one. It was already pinned — to `>=5.0.8`, past its
  previous advisory — and the new advisory covers 5.0.8 itself, so the pin that had fixed the last
  problem was, verbatim, the thing carrying the next one. A floor written to clear one CVE keeps
  looking deliberate long after it has stopped protecting anything, which is the failure mode worth
  naming: it does not break, it just quietly stops being true.

### Fixed

- **"A gateway is already running" when nothing was.** A pid is not an identity. When a gateway
  exits without cleaning up its lock — closing the terminal window, a reboot, anything short of a
  clean Ctrl-C — the operating system is free to reissue that number, and Windows does so quickly.
  On the machine this was found on, the lock pointed at **Phone Link**, and the data directory was
  unusable until somebody knew to delete a file nobody had told them about.

  A lock is now held only when the pid is alive **and** something is serving on the port the lock
  itself recorded, which is the part no unrelated process can imitate by accident. A 15-second
  grace period covers the one moment a live gateway is legitimately silent: it has not finished
  starting. Taking a stale lock over says so on the way past.

- **Every dialog in the dashboard lost focus after one keystroke.** The modal's focus effect
  listed `onClose` as a dependency, and every caller passes an inline arrow — a new function on
  every render. Typing one character re-ran the effect, which handed focus back to whatever opened
  the dialog. It looked like a separate small bug on each screen it happened on; it was one bug,
  in every form in the product.

- **A pool's models could not be changed after it was created.** Models could only be chosen while
  a key was being added, so the list froze the moment the pool existed and growing it meant
  deleting the pool and rebuilding it — discarding a working encrypted credential to edit a list
  that has nothing to do with it. "Add models" now sits beside the model list, fetches using the
  key the pool already holds, and hides what is already there.

### Changed

- **ESLint 10**, whose two new rules found eight real things: three rethrows that flattened the
  original error into a sentence and lost its stack, now carrying `{ cause }`; and five dead
  assignments, two of which were `timer = null` writes nothing ever read.
- **TypeScript is held at 5.9.3 and `@types/node` at 22.** Not oversights. No stable
  `typescript-eslint` accepts TypeScript 7 — with 7 installed, linting does not report errors, it
  crashes. And `@types/node` must describe the runtime rather than lead it: this runs on Node 22,
  and typing against 26 would let code compile against APIs the process does not have.
- **The release pipeline waits for the registry** before calling a release broken. 1.5.2 published
  correctly to npm and both container registries and the run still went red, because the final
  visibility check asked a CDN seconds after writing to it.

### Documentation

- **CONTRIBUTING.md now describes how this repository is actually defended** — the path every
  change takes, and the security rules that are not stylistic. `CODEOWNERS` is new and is the half
  that enforces it.
- **Issue templates that know what Nexus is.** The old ones could have belonged to any Node
  project; they did not ask which storage engine you were on, which is the fact that most often
  decides whether two identical symptoms are the same bug.
- **SECURITY.md** drops the "pre-1.0" line it had carried since 1.0.0 shipped, and says the thing
  a well-meaning finder most often gets wrong: do not fix a vulnerability in a public pull request.

## [1.5.2] - 2026-07-30

Everything here came from watching one person install the published package and use it, which is
the one test that had never been run. Nothing was found by reading the code.

### Fixed
- **A generated admin password no longer ends up in log files.** The launcher printed it
  unconditionally — right for a person, who cannot claim the gateway without it, and wrong for
  `> deploy.log`, a piped invocation, or CI, where a live credential lands in a file that outlives
  its usefulness. It now prints only when stdout is a **terminal**, and otherwise names the `0600`
  file it is already kept in. Showing it at all is deliberate: refusing would begin every first run
  by sending someone to open a file, for no gain, since anyone who can read that terminal can read
  that file.
- **The backup passphrase screen had no Copy button.** Every other screen showing a secret had one.
  So the only way past that step was to read a *generated* secret off the screen and retype it —
  precisely what generating it was meant to prevent.
- **Secrets are now legible.** They were set at 12px on a single line that scrolled sideways, a
  deliberate choice to avoid folding a hyphenated key mid-group. It solved the wrong problem: a
  value you can see a third of at a time is worse than one that wraps. They now wrap **only after a
  hyphen**, so a group is never split down the middle, at a size you can read without leaning in.
- **The last step of first-run setup no longer strands you.** It read as three things to consider
  rather than two things to do in order, and the button stayed disabled until the passphrase was
  pasted back with nothing explaining that downloading the kit is what makes pasting possible. The
  steps are numbered now, the download is the primary action, and once it has been taken, step two
  says where to find what it is asking for.
- **A regular expression stopped pretending to parse HTML** in the package end-to-end test. It
  missed `<SCRIPT`, and asserted so little that any page satisfied it — including an error page. It
  now checks for the content-hashed bundle name, which appears only when the dashboard that was
  compiled is the one being served.
- **The new container check mounted the one way that cannot work.** It failed on both architectures
  the first time it ran — before anything was published, which is what it is for. It bind-mounted a
  host path, which Docker creates as **root** and overlays exactly as it finds it, while the gateway
  runs unprivileged: SQLite could not open its own database. A named volume, which Docker seeds from
  the image with the image's ownership, was always the documented form and the one the image was
  fixed for. The step now tests that, proves the volume actually **persists** across a second
  container — the whole reason the `-v` exists, and never once checked — and tests a bind mount
  prepared the way the README says to prepare one, so the recipe cannot rot.

### Changed
- **Releases run from a tag, and refuse to publish half of one.** Four gates, in order: the full
  suites; the **packed tarball installed into an empty directory and driven over HTTP**; one image
  per architecture on native hardware, each **started with no `DATABASE_URL`** and checked; then
  publication. npm waits for the container deliberately — a release where the package works and the
  image does not is worse than one that fails outright, since neither half can be withdrawn and the
  version then means two different things. Authentication is OIDC, so **no npm token exists in this
  repository**: npm trusts one repository and one workflow filename, GitHub signs a short-lived
  assertion of both, and provenance tying each tarball to its commit comes free. The final step asks
  the registry **anonymously** whether the version is visible, because a scoped package published
  privately looks identical from the inside and the publisher is the last person positioned to
  notice.
- **CI now runs on Node 22.** It had been running on 20 while `engines` required 22, so every green
  run was validating a runtime the package refuses to install on. Node 20 has been end-of-life since
  April 2026.

### Documentation
- **The quick start says the single command does both things.** `npx @alayrasystems/nexus`
  downloads *and* starts — there is no install step before it. It also warns that the first run
  takes about a minute behind an npm spinner: that output belongs to npm and cannot be replaced with
  a progress bar, so the honest fix is to say so rather than let a normal wait read as a hang.
- **Both working ways to mount the data directory are written down**, with the reason a bind mount
  needs `--user` and a named volume does not. The startup error now names bind mounts and shows the
  two recipes, instead of explaining a cause the image no longer has — it said the mount point was
  root-owned because the image did not create it, which stopped being true in 1.5.0.

## [1.5.1] - 2026-07-30

### Changed
- **The npm package is now `@alayrasystems/nexus`.** 1.5.0 was published unscoped as `alayra-nexus`,
  which npm allows only under a personal account: *"Only user accounts can create and manage
  unscoped packages. Organizations can only manage scoped packages."* There is no transfer, no
  button, and no workaround — a package meant to outlive any one person's npm account has to be
  scoped. That is worth more than four characters of typing.
  **The command is unchanged.** `bin` still installs `alayra-nexus`, so the scope is paid exactly
  once, by whoever runs the one-off `npx @alayrasystems/nexus`; everyone who installs it types
  `alayra-nexus` forever after. `publishConfig.access` becomes load-bearing here rather than
  decorative: a scoped package defaults to restricted, and without it the publish would either fail
  or quietly ship something nobody can install.
  `alayra-nexus@1.5.0` stays published and working, and is deprecated with a pointer to the new
  name rather than removed — unpublishing would break anyone who already installed it.

## [1.5.0] - 2026-07-30

### Added
- **`npx alayra-nexus` — one command, nothing to provision.** No clone, no build, no Postgres, no
  Redis, no Docker. It creates `~/.alayra-nexus`, generates and persists its own encryption key and
  admin password, builds a SQLite database from the schema shipped in the package, and serves the
  **full dashboard** — provider pools, team keys, budgets, analytics, backup. Nothing is disabled
  because there is no database server. `npm install -g alayra-nexus` for the same thing kept around.
  **It is a launcher, not a CLI.** There are no subcommands for pools, keys or analytics, because
  those already exist in the dashboard it serves. A command-line interface remains a separate,
  later thing, and a thin one — every operation is already an HTTP endpoint.
  **A `.env` in the launch directory is not read.** It belongs to the project in that directory, and
  Nexus is not that project — the tools that legitimately read `./.env` are all operating *on* your
  project. This is not a rule about `DATABASE_URL`: ten of the variables the gateway reads have
  names ordinary enough to appear in someone else's file, and `ADMIN_PASSWORD` is the alarming one,
  since it would silently become the owner credential *and* the second proof required to authorise
  a destructive restore. When such a file is found, the launcher names what it ignored and how to
  use it deliberately (`--env-file ./.env`). Nothing is inherited from where you happened to stand.
  Three defaults chosen rather than accepted: it binds **loopback only** unless `--host` says
  otherwise; the admin password is **generated, never defaulted**; and the encryption key is written
  once at `0600` and never regenerated, because a fresh key each run would be silent, unrecoverable
  data loss. It also refuses to start a **second gateway over the same data directory** — SQLite
  takes one writer and counters live per process, so two instances do not share a gateway, they
  disagree about one.
  **Measured, not estimated:** 0.7 MB compressed, **48.4 s** from tarball to a gateway answering
  HTTP, 279.7 MB installed. Almost all of that weight is Prisma's query engine and its two generated
  clients; the package's own payload is about 2 MB.

### Changed
- **A container can now run without a database.** The image started with
  `prisma migrate deploy && node dist/server.js`, and that migration needs a `DATABASE_URL` — so a
  container launched without one died before the gateway existed. That is why standalone mode
  shipped in 1.4.0 and could not be reached from the published image. The migration now runs only
  when there is a database to migrate; SQLite needs no migration step, since the gateway creates its
  schema on first connection. A failed migration still stops everything. The server is also now
  `exec`'d rather than left a child of the shell, so `docker stop` reaches its SIGTERM handler — the
  one that drains buffered usage and audit rows before exit.
  Two further defects surfaced only once a container was actually started without a `DATABASE_URL`,
  neither of them the migration step. **The image had never contained the SQLite client at all** —
  the build ran `npx prisma generate`, which builds only the default schema, so standalone shipped
  in 1.4.0 with no engine in the image to run it on. A Postgres deployment never touches that
  client, which is why every existing install and every test against one was blind to it; the build
  now generates both and **fails if either is missing**, so it cannot happen quietly again. And the
  data directory did not exist in the image, so Docker created that mount point as root while the
  gateway runs as an unprivileged user, and SQLite could not open its own database.
  Verified end to end: a container with no `DATABASE_URL` serves `/health`, `/ready` and the
  dashboard, builds its own 16-table database, and reuses it across a restart.

### Fixed
- **A failed startup no longer confidently names the wrong database.** On SQLite the message read
  `Cannot reach PostgreSQL at` — with an empty address, because the formatter reduced every URL to
  `host:port` and a `file:` URL has no host — and then advised `docker compose up -d postgres` and
  `npm run migrate`. Every line of that is wrong for an engine with no server to start and a schema
  the gateway creates itself, and it would send an operator to fix a database they are not running.
  It now names SQLite, prints the file it could not open, and points at the actual cause. The
  PostgreSQL wording is untouched, and still redacts credentials.
- **The first-run output is no longer interrupted by its own logging.** `Ctrl-C to stop` printed in
  the middle, four paragraphs before the end; the launcher now prints it once the gateway genuinely
  answers, so "Ready" is a fact rather than a hope. `npx` also defaults to a quiet log level — a
  gateway running in front of you in a terminal should not bury its one useful screen in
  per-request JSON — and an explicit `LOG_LEVEL` still wins. The generated API key notice no longer
  names one specific editor.
- **A gateway told to run standalone can no longer be talked out of it by a file nobody named.**
  Importing `@prisma/client` loads the `.env` beside its schema — the checkout's — and sets whatever
  it finds there. So an operator who pointed the gateway at a different config file
  (`DOTENV_CONFIG_PATH`) with no `DATABASE_URL` and no `REDIS_URL` got the right decision at boot,
  printed honestly, and then a `REDIS_URL` set behind its back three levels down an import chain.
  The gateway ended up **reporting one configuration and running another** — the exact contradiction
  the boot check exists to refuse, arriving after the check had already passed. Changing directory
  was no escape: the file is found from the schema, not from the working directory.
  The two variables are now pinned to an empty string at boot when they are absent, before anything
  can reach Prisma. Every env-file loader leaves an already-present key alone, so declaring the
  absence explicitly is what makes it survive; the codebase already reads empty as unconfigured, and
  a configured value is never touched, so nothing about a server-mode gateway changes.
  The standalone smoke had this worked around by hand since S2.0 — it passed both URLs as empty
  strings, which immunised the one caller that could have caught it and left every other exposed.
  It now deletes them instead, so the gateway has to do the pinning itself, and disabling the pin
  makes that suite fail with `Cannot reach Redis at localhost:6379` on a variable it never set.

## [1.4.0] - 2026-07-29

### Added
- **Standalone mode — the gateway runs with no Postgres and no Redis.** Set neither `DATABASE_URL`
  nor `REDIS_URL` and Nexus starts on a local SQLite file and in-process memory: one process, one
  directory, nothing to provision. Intended for evaluation, local development against a real
  gateway, and CI — not for production. It is **not** zero-configuration: `MASTER_ENCRYPTION_KEY` is
  still required, because a gateway that invented its own would be a gateway whose provider keys
  nobody else can ever decrypt.
  The Postgres schema stays the single source of truth — the SQLite client and its schema are
  *generated* from it, so the two cannot drift. All 14 raw aggregate queries gained a SQLite twin
  declared beside the Postgres text it stands in for, and a parity suite stands up a real PostgreSQL
  and a real SQLite, seeds them identically, and fails if any twin disagrees.
  **What differs, stated rather than papered over:** one writer at a time; no replication or failover;
  analytics slow down on large tables; `p95` is a nearest-rank pick rather than Postgres' interpolated
  `percentile_cont`, so the two engines can report neighbouring values; and the Postgres-only Health
  readings (pool stats, cache hit ratio, deadlocks) report as *unavailable* rather than as `0`, which
  would read as a measurement instead of an absence.

- **Encrypted backup and restore, portable across engines.** Owner-only, under Admin → **Backup**.
  Export writes a single encrypted `.nxb` file streamed straight to the browser; restore takes it
  back, on this gateway or a different one entirely. Every encrypted secret is **re-keyed** in
  transit — decrypted with the source gateway's master key and re-sealed with the target's — which is
  what makes a backup portable rather than merely restorable, and what a file copy can never be.
  A backup carries a manifest of what it came from: format version, source engine, row counts, a
  schema fingerprint, and the *names* (never the values) of the environment variables the source had
  set. The restore refuses a backup this gateway cannot honestly restore and lists the specific
  schema differences instead of failing partway through.
  **Every restore is dry-run first** — there is no route to a destructive one that skips the report.
  The report names what would collide, what would be dropped, and what the chosen mode would do,
  under either **merge** (add and update, keep everything else) or **replace everything** (empty each
  table first). A replace puts the gateway into maintenance with a live progress figure and a shared
  countdown, rather than hanging silently, and invalidates the KV afterwards so no stale counter
  survives its own data. Audited as `backup.export`, `backup.restore.dryrun` and `backup.restore`.
  **Proven end to end, cross-engine and cross-key:** a 22.6 MB backup from a PostgreSQL gateway
  restored into a standalone SQLite gateway holding a *different* master key — 51,033 rows across 16
  tables, 18 secrets re-keyed. The same provider key decrypts to identical plaintext on both sides,
  the two ciphertexts differ, and the SQLite row cannot be opened with the PostgreSQL key.

- **A Recovery Kit at install, so a backup can outlive either loss.** One file key is wrapped for
  several recipients rather than encrypting the archive twice. A passphrase recipient (minimum 12
  characters) is what a person types; a **gateway** recipient lets unattended work proceed without a
  human awake; and a **recovery** recipient wraps to an X25519 key generated at install and shown
  once, whose private half the server never holds — so a stolen gateway yields no way in. A
  gateway-only file is refused at write time, since it would be unopenable the moment the machine it
  came from is gone, which is precisely the disaster the feature exists to prevent.

- **A static, read-only demo of the console.** The product can now be seen without installing it.
  The whole demo backend is one function mapping the dashboard's existing single API entry point
  onto a frozen dataset, so it cannot drift into a second client. Writes are refused rather than
  faked — a demo that appears to save and silently forgets is worse than one that admits what it is —
  and the visitor is signed in as a viewer, so the role gating the dashboard already enforces hides
  every write control. None of it reaches a production build. The dashboard also became mountable
  under a sub-path, with a root deployment reducing to byte-for-byte what it was.

- **A deterministic synthetic data generator and seed script.** A gateway that has served three
  requests photographs badly — every chart one spike on a flat line. The generator touches no clock
  and no global random state, so a seed and an anchor time produce byte-identical output and a
  fixture changes only when someone means it to. Prices come from the real model catalogue.

- **The Health page now says which stores the gateway is running on.** A Storage card names the
  database and the counter/session engine, whether a restart loses anything, and the caution that
  goes with an ephemeral pairing. Admin-only: the public `/health` and `/ready` are unchanged, since
  "this gateway keeps its rate-limit windows in memory and runs one process" is a useful thing to
  know before attacking it.
- **A storage configuration check at boot.** `NEXUS_MODE` (`server` / `standalone`) is read alongside
  `DATABASE_URL` and `REDIS_URL`. A configured URL is always honoured, and an unreachable one still
  fails loudly exactly as before — a database outage must never demote a gateway into an ephemeral
  store that accepts traffic it will lose. A contradiction (`NEXUS_MODE=standalone` next to a
  `DATABASE_URL`) is refused rather than guessed: both readings destroy something, so the message
  names the two settings that disagree.

- **Redis is now optional.** Without `REDIS_URL` the gateway keeps counters, sessions, breaker state
  and the response cache in process, and starts with no Redis at all. Everything a Redis deployment
  does still works: rate-limit admission, the per-key Max Users cap, circuit-breaker escalation,
  budget accumulation, the session index and sign-out. The six Lua scripts each gained a JavaScript
  twin declared beside the Lua it stands in for, and a parity suite runs every scenario through both
  a real Redis and the in-process store and fails if they disagree.
  **The costs, unchanged from the plan:** a restart signs everyone out and resets rate-limit windows
  and breaker state; one process only, since a second instance would keep its own separate counters.
  Budgets are the exception — they re-derive from usage history, so spend stays correct. The Health
  page and `/ready` name the store in use rather than reporting on a Redis that is not there.

### Changed
- **A standalone gateway opens SQLite in WAL journal mode.** SQLite's default `delete` mode locks the
  whole file for a write while readers wait, which is the wrong trade for this process: the usage
  pipeline, audit buffer and health sampler all write continuously underneath a dashboard that reads.
  Measured over six concurrent aggregates across 120k rows with 60 background writes — **~2100 ms
  total and a ~2000 ms slowest write under `delete`, against ~600 ms and ~260 ms under WAL.** Note
  that the live database is then *three* files (`nexus.db`, plus `-wal` and `-shm` sidecars): copy
  the directory, or stop the gateway first — or use the backup export above, which is the supported
  answer.

### Fixed
- **A fresh PostgreSQL install was missing a table the schema declared.** `AiModelRegistry` existed in
  `schema.prisma` and in no migration. Every developer machine had it, because `prisma db push`
  writes the schema directly; every fresh install did not, because the container runs
  `prisma migrate deploy` and migrations are all it applies. It stayed invisible until the backup
  export — the first feature that walks *every* model in the schema — aborted on it. Standalone was
  never affected, since the SQLite schema is generated from `schema.prisma` rather than replayed from
  migrations; the engine missing the table was the production one. A fresh `migrate deploy` now
  builds all 16 tables.
- **The seed script wrote random bytes into an encrypted column.** `encryptedKey` has a format, and a
  placeholder that could not be decrypted broke every feature that walks secrets. The seeded value is
  now sealed with the real encryption path, so the row is structurally valid while what comes out of
  it is a string no provider will ever accept.
- **A re-key failure now names the row it failed on.** "Invalid ciphertext format" was true and
  useless against a database with fifty thousand rows; it now names the model, field and row id. The
  failure itself remains hard by design — a value that cannot be decrypted must never be written into
  a backup as whatever bytes happened to be there, because that produces a file that restores
  cleanly and hands back a credential nothing can open.
- **The top-eight model and provider breakdowns were never deterministically ordered.** `ORDER BY
  requests DESC` alone left tied rows to the engine, so which entries appeared in a `LIMIT 8` could
  change between identical queries. Four queries gained a tiebreaker on the group key. Found by the
  cross-engine parity suite, and a latent PostgreSQL defect rather than an accommodation for SQLite.
- **A malformed `SELECT version()` row no longer takes the whole Health response down.** The Postgres
  introspection read guarded a missing row but not a null column, so an unexpected shape raised a
  TypeError instead of degrading to the "version —" the UI already renders. Found while writing the
  tests above.

### Security
- **Three high-severity advisories cleared** across the gateway, the dashboard and the e2e tooling,
  including pinning `brace-expansion` past its OOM advisory in dev tooling.

## [1.3.2] - 2026-07-20

### Fixed
- **`prisma` works inside the container again.** Removing npm in 1.3.1 took `npx prisma …` with it,
  which is the command an operator reaches for when inspecting a live container (`prisma studio`,
  `migrate status`, `db execute`). The CLI was never removed — only its launcher — so a `prisma`
  command is back on `PATH` and `docker exec <container> prisma studio` behaves exactly as it did
  before 1.3.1. The container's own startup goes through the same shim, so the operator path and the
  boot path cannot drift apart.

### Changed
- **A future Prisma reshuffle now fails the build instead of the boot.** The start command reaches
  Prisma through `build/index.js`, which is Prisma's internal layout rather than a published
  contract. Since the first thing the container does is run a migration, a moved file would have
  surfaced at runtime as what looked like a database failure. The image now proves the CLI answers
  at **build** time, turning that into an immediate, obvious build error. Verified by deliberately
  breaking the path and confirming the build fails at that step.

## [1.3.1] - 2026-07-20

### Security
- **The container no longer ships a package manager (and no longer ships its CVEs).** Docker Scout
  reported two HIGH vulnerabilities against the 1.3.0 image — `sigstore` (CVE-2026-48815, signature
  verification) and `picomatch` (CVE-2026-33671, ReDoS). Neither is a dependency of this project:
  both are vendored inside the copy of **npm bundled with Node**, so they were inherited from the
  base image and unpatchable from `package.json`. npm is not needed at runtime — the start command
  now invokes Prisma's own entrypoint directly instead of going through `npx` — so it is deleted
  once it has installed the production dependencies. The image reports **0 vulnerabilities**,
  carries 135 packages instead of 317, and drops from 214 MB to 183 MB. A production container has
  no business shipping a package manager in any case.

## [1.3.0] - 2026-07-20

### Added
- **The dashboard works on a phone (Phase 7.17d).** There was no responsive handling at all: a fixed
  232px sidebar ate most of a small screen and three-across field rows were unusable. Below 820px the
  sidebar is now a slide-in drawer opened from a hamburger in the top bar — dismissed by the scrim,
  Escape, or simply following a link — and below 640px field rows stack one per line, dialogs take
  the full width, and the page padding tightens. Nothing changes above the breakpoints.

### Fixed
- **The mobile navigation drawer was see-through (Phase 7.17d).** Docked, the sidebar is a grid track
  and its 3.5%-white glass fill reads against the page background. Floating over the content as a
  drawer, that same fill let the page show straight through the nav labels. Under the breakpoint it
  is now opaque.
- **Dialogs were being sized by whatever card opened them (Phase 7.17d).** `backdrop-filter` makes an
  element a containing block for `position: fixed` descendants, and cards carried it — so a dialog's
  "full-screen" overlay was really only as big as the card behind it. On a desktop that quietly
  mis-centred every dialog; on a phone it pushed them wider than the screen. Cards no longer carry
  the filter (it was imperceptible on them anyway), so overlays cover the viewport as intended.

### Changed
- **Editing a key no longer makes you scroll sideways to read it (Phase 7.17c).** The masked
  credential was the dialog's *title*, where a full-length mask ran off the edge. It now sits in the
  body as a boxed row that truncates — the mask is unreadable by design, so there was never anything
  to gain from scrolling it — with a **Replace** button beside it. Replacing is progressive: the
  input only appears when you ask for it, and because a new credential often means a different
  catalogue, you can **re-fetch this provider's models** right there and merge the ones you pick
  (with their pricing) when you save.

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

[Unreleased]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.5.3...v1.6.0
[1.5.3]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/releases/tag/v1.0.0
