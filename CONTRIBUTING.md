# Contributing to Alayra Nexus

Thanks for your interest in improving Alayra Nexus. Contributions are genuinely welcome — this
guide exists so that a good change has the shortest possible path to being merged, and so nobody
spends a weekend on something that was never going to land.

Read the two short sections below before you write code. Everything after them is reference.

## Production security commitment

Because Alayra Nexus is infrastructure software that manages AI provider credentials and production
traffic, every contribution is reviewed with a security-first mindset. Security, reliability, and
maintainability take precedence over feature velocity. **No code is merged without maintainer
approval, regardless of contributor status** — that includes the maintainers' own work, which goes
through the same pull requests, the same checks, and the same review as everyone else's.

## Opening a pull request does not mean it will be merged

This is the part most contribution guides leave implicit, and it is kinder to say it plainly. A
pull request is a proposal. Maintainers may request changes, rewrite parts of it, ask you to split
it, hold it until it fits the roadmap, or close it.

**Please open an issue before writing a large change.** A short discussion costs you ten minutes;
discovering after two weeks that the feature conflicts with work already in flight costs you the
two weeks. Small, obvious fixes — a typo, a broken link, a clear bug with a test — need no
preamble.

---

## Ways to contribute

| | |
|---|---|
| **Report a bug** | [Open a bug report](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/issues/new?template=bug_report.yml) |
| **Request a feature** | [Open a feature request](https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus/issues/new?template=feature_request.yml) |
| **Report a vulnerability** | **Privately** — see [SECURITY.md](./SECURITY.md). Never in a public issue, discussion, or PR |
| **Improve the docs** | Same process as code. See [Documentation](#documentation) |
| **Submit code** | Read on |

All participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

**Prerequisites:** Node.js **22+** (the package refuses to install on older runtimes), PostgreSQL
15+, Redis 7+ — or neither, if you use standalone mode.

```bash
git clone https://github.com/<your-username>/Alayra-Nexus.git
cd Alayra-Nexus
npm install

cp .env.example .env
# Generate a MASTER_ENCRYPTION_KEY and set your DB/Redis URLs:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npx prisma migrate deploy
npm run dev
```

**No Postgres or Redis handy?** Leave `DATABASE_URL` and `REDIS_URL` unset and the gateway runs on
a local SQLite file with in-process memory — one process, nothing to provision. The dashboard lives
in `web/` and has its own `npm install`.

## How a change gets merged

Every change — from every contributor, including maintainers — travels the same path:

**Fork → feature branch → pull request → automated CI → security scanning → review → maintainer
approval → merge by a maintainer.**

Nobody pushes to `main`. Nobody merges their own pull request. Nobody overrides a failing check.
These are enforced by repository rules, not by good intentions, so there is no case where being
trusted enough lets you skip them.

### Branch naming

Branch from `main` in your fork:

| Prefix | For |
|---|---|
| `fix/` | a bug fix — `fix/rpm-race` |
| `feat/` | a new capability — `feat/prometheus-metrics` |
| `docs/` | documentation only — `docs/standalone-quickstart` |
| `test/` | tests only — `test/cache-hit-path` |
| `chore/` | tooling, deps, CI — `chore/bump-vitest` |
| `refactor/` | no behaviour change — `refactor/extract-router` |

### Commit messages

Short, lower-case, conventional-style subjects. The body is where the value is: **explain why, not
what.** The diff already says what changed; it cannot say what you knew that made the change
correct.

```
fix: cool a key on upstream timeout, not just on 429

A provider that hangs is as unusable as one that rate-limits, but only the 429
path tripped the breaker — so a timing-out key stayed in rotation and every
request routed to it burned the full 30s timeout before failing over.
```

### Pull request checklist

The [template](./.github/PULL_REQUEST_TEMPLATE.md) has this as tick-boxes. Before you mark a PR
ready:

- [ ] `npm run lint` — 0 errors
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cd web && npm run lint && npm run typecheck && npm test` — if you touched the dashboard
- [ ] Tests added or updated for the behaviour you changed
- [ ] Docs updated if behaviour, configuration, or the API surface changed
- [ ] No secrets, real API keys, tokens, or `.env` values anywhere in the diff
- [ ] No generated or build output committed (`dist/`, `web/dist/`, coverage)
- [ ] One logical change — see below

## What we ask of a pull request

**One feature per pull request.** A PR that fixes a bug *and* renames three files *and* reformats a
module cannot be reviewed — only accepted wholesale or rejected wholesale. Split it.

**Small and focused beats large and complete.** Two reviewable PRs merge faster than one that
nobody has a spare hour for.

**Tests, for anything with logic.** Routing, rate-limit keys, encryption, cost calculation, cache
keys, SQL twins — these need unit tests. A test that passes whether or not your fix is present is
not a test; check it fails without your change before you push.

**Documentation, when behaviour changes.** If someone would configure or call it differently after
your change, the docs move with the code, in the same PR.

**Formatting-only PRs will be closed.** A diff that touches many files and changes no behaviour
costs real review time, conflicts with in-flight work, and destroys `git blame`. If you believe the
project's style is wrong, open an issue.

## Security rules for contributions

These are not stylistic. A PR that does any of the following will be rejected, and the maintainers
may not explain in public detail why:

- **Never include** API keys, tokens, credentials, or real `.env` values — even expired ones, even
  in tests or fixtures. Use obvious placeholders.
- **Never weaken authentication or authorization** on the proxy or the admin API, including
  "temporarily" or behind a flag.
- **Never disable, bypass, or reorder security middleware.** If a guard is in your way, that is a
  design discussion, not a diff.
- **Never remove or downgrade encryption** of secrets at rest, and never widen what a decrypted
  value is exposed to.
- **Never bypass audit logging.** An admin action that leaves no trace is worse than one that fails.
- **Never modify licensing headers** or the `LICENSE` file.
- **Never add a dependency casually.** Every one is permanent supply-chain surface. Say in the PR
  why it earns its place and why the standard library will not do.
- **Changes under `.github/` are credential changes.** This repository publishes to npm and two
  container registries from its workflows. A PR editing a workflow is asking for those permissions
  and is reviewed on that basis.

Found a vulnerability? **Do not open a PR that fixes it.** A public fix is a public disclosure, with
a window before anyone can upgrade. Follow [SECURITY.md](./SECURITY.md).

## Continuous integration

Every pull request runs, and all must be green before review concludes:

| Check | What it protects |
|---|---|
| **Lint** | ESLint, 0 errors |
| **Typecheck** | `tsc --noEmit`, strict |
| **Test** | the Vitest suite |
| **Build** | the compiled output actually compiles |
| **Security audit** | dependency advisories |
| **UI (web dashboard)** | the dashboard's own lint, types and tests |
| **Standalone (SQLite + in-memory)** | that the no-Postgres, no-Redis path still boots |
| **End-to-end (Postgres + Redis + browser)** | the real stack, driven for real |
| **CodeQL** | static security analysis |

CI is not a formality to be re-run until it passes. A flaky failure is a bug — say so in the PR
rather than pressing the button again.

**A first-time contributor's workflow runs require maintainer approval before they execute.** That
is deliberate and is not a comment on you.

## Documentation

Docs are contributions and follow the same process: fork, branch, PR, review.

- **README.md** is the shop window — the quick start and what Nexus is. Keep it short.
- **`docs/`** holds the long-form material.
- **CHANGELOG.md** follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add to
  `[Unreleased]`; maintainers cut versions.
- Write what is true today, not what is planned. A doc describing an unbuilt feature is a bug
  report from the future.

## Reporting issues

A good report is reproducible. Before opening one, please search existing issues — including closed
ones.

Include: what you expected, what happened, the **version** (`alayra-nexus --version` or the image
tag), your mode (standalone, or Postgres + Redis), and the smallest steps that reproduce it.
Redact keys. Logs and stack traces belong in the report, not a screenshot of them, so they can be
searched.

"It doesn't work" cannot be acted on and will be closed with a request for detail.

## Maintainer discretion

Maintainers reserve the right to reject or close any contribution that:

- does not fit the roadmap or conflicts with work already in flight,
- reduces security, or widens the surface without a proportionate gain,
- hurts maintainability, or introduces technical debt someone else inherits,
- does not meet the project's quality bar,
- or cannot be maintained by the people who will still be here in two years.

This is not personal, and a rejected PR is not a rejected contributor. Where we can explain, we
will. For security-sensitive rejections we may not be able to say much publicly, and we would
rather be terse than misleading.

## Releases

Releases are cut by maintainers only, from a signed tag, by an automated pipeline. Contributors
never publish.

Versioning is [semantic](https://semver.org/), and the public API covered by semver is the
`model: "alayra-nexus-1"` routing contract. The pipeline refuses to publish half a release: the
full suites run, the packed npm tarball is installed into an empty directory and driven over HTTP,
and one container image per architecture is started with no database — all before anything is
published.

## Licensing

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE) that covers this project. Do not paste code you did not write or
are not licensed to contribute — including output from tools you have not verified is
license-clean. If part of a change came from elsewhere, say so in the PR.

---

**Production quality and long-term maintainability always take priority over speed.** Anyone can
ship a feature this week; the work is keeping it correct, secure and understandable for years. If
that means your pull request takes longer to merge than you hoped, that is the standard doing its
job — and we are grateful you brought it here.
