# Contributing to Alayra Nexus

Thanks for your interest in improving Alayra Nexus. This guide covers how to get
set up, the quality bar we hold, and how to get a change merged.

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/Kinetic-Ide/alayra-nexus/issues/new?template=bug_report.yml).
- **Request a feature** — open a [feature request](https://github.com/Kinetic-Ide/alayra-nexus/issues/new?template=feature_request.yml).
- **Report a vulnerability** — see [SECURITY.md](./SECURITY.md). Please do **not** open a public issue for security problems.
- **Submit a pull request** — see below.

## Development setup

**Prerequisites:** Node.js 20+, PostgreSQL 15+, Redis 7+ (or just Docker).

```bash
git clone https://github.com/Kinetic-Ide/alayra-nexus.git
cd alayra-nexus
npm install

cp .env.example .env
# Generate a MASTER_ENCRYPTION_KEY and set your DB/Redis URLs:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npx prisma migrate deploy
npm run dev
```

## Before you open a pull request

Run the same checks CI runs — all must pass:

```bash
npm run lint        # ESLint — 0 errors required
npm run typecheck   # tsc --noEmit
npm test            # Vitest
npm run build       # tsc build
```

Please also:

- **Add or update tests** for any behavior you change. Pure logic (routing,
  rate-limit keys, encryption, cost calculation) should have unit tests.
- **Update the README/docs** if you change behavior, config, or the API surface.
- **Never commit secrets** — no real API keys, tokens, or `.env` values. `.env`
  is gitignored; keep it that way.

## Pull request process

1. Fork the repo and create a branch from `main` (e.g. `fix/rpm-race`, `feat/prometheus`).
2. Make your change, with tests and docs.
3. Ensure all checks above pass locally.
4. Open a PR against `main` and fill out the template. Link any related issue.
5. A maintainer will review. CI (lint, typecheck, test, build, audit) must be
   green before merge.

## Commit style

We use short, lower-case, conventional-style commit subjects, e.g.:

- `fix: cool key on upstream timeout, not just 429`
- `feat: add prometheus /metrics endpoint`
- `docs: correct admin endpoint table`

## Code style

Style is enforced by ESLint (`npm run lint`) and TypeScript in strict mode.
Match the conventions of the surrounding code. Keep the request hot path free of
blocking database calls.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE) that covers this project.
