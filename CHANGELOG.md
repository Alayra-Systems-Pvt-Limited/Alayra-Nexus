# Changelog

All notable changes to Alayra Nexus™ are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `model: "alayra-nexus-1"` routing contract is the public API surface covered by
semver. The legacy ids `kinetic-nexus-1` and `nexus` remain accepted as aliases.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/compare/v1.5.2...HEAD
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
