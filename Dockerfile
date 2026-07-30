# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
# OpenSSL so Prisma detects the correct engine at generate time (Alpine ships
# OpenSSL 3.x; without libssl present Prisma mis-guesses openssl-1.1.x).
RUN apk add --no-cache openssl
# The lifecycle script comes with the manifest that names it. `postinstall` generates the Prisma
# clients for whatever schemas sit beside it, and here there are none yet — prisma/ arrives with
# `COPY . .` below, and the explicit generate after it is what builds them. So this script has
# nothing to do at this point and says so by exiting 0. It still has to EXIST: npm runs the command
# in package.json whether or not the file is there, and a missing file is a MODULE_NOT_FOUND that
# fails the image build.
COPY package*.json ./
COPY scripts/npm ./scripts/npm
RUN npm ci
COPY . .
# BOTH clients, via the same script CI and local development use — `npx prisma generate` alone
# builds only the Postgres one, from the default schema. That is how the image came to contain no
# SQLite client at all: standalone mode shipped in 1.4.0, and a container had no engine to run it
# on even before the migration step killed it. Two independent blockers, one of them invisible
# until a container was actually started without a DATABASE_URL.
RUN npm run db:generate && npm run build
# Build the redesigned dashboard (Phase 7.9 cutover). It is a separate npm package under web/; its
# static output (web/dist) is what the runtime image serves. Built here so the runtime stage carries
# only the compiled assets, never the dashboard's dev toolchain.
RUN cd web && npm ci && npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# libssl must also be present in the runtime image so the Prisma query engine
# loads when the container starts.
RUN apk add --no-cache openssl

LABEL org.opencontainers.image.title="Alayra Nexus" \
      org.opencontainers.image.description="Open-source AI gateway — one OpenAI-compatible endpoint for every provider, with load balancing, failover, rate limits, and cost analytics." \
      org.opencontainers.image.source="https://github.com/Alayra-Systems-Pvt-Limited/Alayra-Nexus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Alayra Systems"

# Production dependencies only. `prisma` is a runtime dependency (migrate deploy
# runs at startup), so the CLI is present without pulling in dev tooling.
# Same pairing as the builder stage: the postinstall script must be present for npm to run it, and
# it exits 0 here because no schema sits beside it. The generated clients arrive from the builder a
# few lines down, already built for this platform, so there is nothing to generate in this stage.
COPY package*.json ./
COPY scripts/npm ./scripts/npm
# npm is deleted immediately after it has done its job. It is not needed at runtime — the start
# command invokes Prisma's own entrypoint directly rather than going through npx — and the copy
# bundled with Node vendors its own dependency tree, which is where every CVE reported against this
# image has come from (sigstore, picomatch: ours by inheritance, not by choice, and unpatchable from
# our package.json). A production container has no business shipping a package manager anyway.
RUN npm ci --omit=dev \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /root/.npm /usr/local/share/.cache

# Removing npm took `npx prisma …` with it, which is the command an operator reaches for when they
# need to inspect a live container (`prisma studio`, `migrate status`, `db execute`). The CLI itself
# is still installed and fully functional — only the launcher went away — so put a `prisma` command
# back on PATH. `exec` so signals and the exit code pass straight through:
#   docker exec <container> prisma studio
RUN printf '#!/bin/sh\nexec node /app/node_modules/prisma/build/index.js "$@"\n' > /usr/local/bin/prisma \
 && chmod +x /usr/local/bin/prisma

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
# The dashboard's static build. The gateway serves it from web/dist (see the static root in
# src/server.ts); only the built assets ship, not web/'s source or toolchain. @fastify/static only
# logs a warning for a missing root, so keep this COPY in step with that static root — if they drift,
# the container starts clean but returns 404 for the dashboard.
COPY --from=builder /app/web/dist ./web/dist

# Fail the BUILD if either database client is missing.
#
# The image shipped without the SQLite client from S2 until S4 — `npx prisma generate` builds only
# the default schema, and nothing checked. A gateway configured for Postgres never touches the
# SQLite client, so the gap was invisible to every existing deployment and to every test that ran
# against one. It surfaced only when a container was started with no DATABASE_URL, at which point
# the failure was a MODULE_NOT_FOUND several frames deep in a require chain.
#
# `require.resolve` rather than a path test: it asks the same question the gateway asks at runtime,
# through the same resolution rules, so this cannot pass while the real load fails.
RUN node -e "for (const s of ['.prisma/client', '.prisma/client-sqlite']) { require.resolve(s); console.log('ok', s); }"

# Fail the BUILD if the Prisma CLI cannot be launched. `build/index.js` is Prisma's internal layout,
# not a published contract, so a future version could move it — and the first thing the container
# does at runtime is a migration, meaning a broken launcher would surface as what looks like a
# database failure rather than a missing file. Proving the CLI answers here turns that into an
# obvious, immediate build error instead. The dependency range is pinned to ^5 so a major
# reorganisation cannot arrive unreviewed in the first place.
RUN prisma --version

# The standalone data directory, created in the IMAGE and owned by the user that will write to it.
#
# Docker creates a bind or named-volume mount point that does not exist in the image as root, and
# this container drops to uid 1000 — so a `-v nexus-data:/app/.nexus` produced a directory the
# gateway could not write, and SQLite failed with "unable to open the database file". Creating it
# here means a fresh named volume inherits this ownership when Docker seeds it from the image.
# Harmless in server mode, where nothing ever writes to it.
RUN mkdir -p /app/.nexus

# Drop root: run as the image's built-in unprivileged `node` user.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Container healthcheck against the app's own /health endpoint (Node 22 has fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# npm's update notice is noise in a container log and cannot be acted on from inside
# an immutable image.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Apply pending migrations, then start the server, through the same `prisma` shim an operator gets —
# one definition of where the CLI lives, so the start path and the interactive path cannot drift.
#
# The migration runs ONLY when there is a database to migrate. `prisma migrate deploy` needs a
# DATABASE_URL, so running it unconditionally meant a container started without one died before the
# gateway existed — which is why standalone mode shipped in 1.4.0 and could not be reached from the
# image. SQLite needs no migration step at all: the schema is created from prisma/sqlite-schema.sql
# on first connection, by the gateway itself.
#
# A failed migration still stops everything. `|| exit 1` rather than `;` because a gateway that
# starts against a half-migrated database is worse than one that refuses to start.
#
# `exec` so the server becomes PID 1 instead of a child of this shell. Without it, `docker stop`
# signals the shell and the gateway never runs its SIGTERM handler — the one that drains buffered
# usage and audit rows before exit.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then prisma migrate deploy || exit 1; fi; exec node dist/server.js"]
