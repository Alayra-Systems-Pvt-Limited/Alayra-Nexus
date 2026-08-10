<sub>Part of the [Alayra Nexus README](../README.md#standalone-mode--no-postgres-no-redis), moved into its own page so the README stays inside npm's 64 KB render limit. The content is unchanged.</sub>

## Standalone mode — no Postgres, no Redis

The easiest way in is [`npx @alayrasystems/nexus`](../README.md#option-a--one-command-nothing-to-provision), which does
all of the below for you. It also runs from the container, with no database alongside it:

```bash
docker run -d --name alayra-nexus -p 3000:3000 \
  -e MASTER_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -e ADMIN_PASSWORD="change-me" \
  -v nexus-data:/app/.nexus \
  alayrasystems/nexus:latest
```

> [!WARNING]
> **The `-v` is not optional.** Without it the database lives inside the container's writable layer
> and disappears the moment the container is removed — along with every provider key in it. The
> gateway cannot tell the difference, so nothing will warn you.

`nexus-data` there is a **named volume**: Docker creates it, seeds it from the image, and it inherits
the ownership the gateway needs. There is nothing to prepare.

To keep the database somewhere you can see it instead, own the directory and run as yourself:

```bash
mkdir -p ./nexus-data
docker run -d --name alayra-nexus -p 3000:3000 \
  -e MASTER_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -e ADMIN_PASSWORD="change-me" \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/nexus-data:/app/.nexus" \
  alayrasystems/nexus:latest
```

> [!NOTE]
> A bind mount **without** `--user` fails with `unable to open the database file`. Docker creates a
> missing host directory as root and mounts it exactly as it finds it, while the gateway runs
> unprivileged — so it cannot write there. Every image that drops privileges behaves this way, and no
> change to the image can alter it. `--user` is the fix; a named volume avoids the question entirely.

Set neither `DATABASE_URL` nor `REDIS_URL` and the gateway runs on a local **SQLite file** and
**in-process memory** instead. One process, one directory, nothing to provision — for trying Nexus
out, for local development against a real gateway, and for CI.

```bash
# In any empty directory.
MASTER_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
ADMIN_PASSWORD=change-me \
node /path/to/alayra-nexus/dist/server.js
```

```
  Database created → 16 tables at ./.nexus/nexus.db
  Storage → SQLite + in-process memory (data is not durable)
```

**No feature is disabled by engine.** There is no standalone-only build and no feature flag that
turns things off — the request path, the router, the breaker and both API surfaces are the same
code, reading and writing through the same interfaces. What differs is the two stores underneath,
and the consequences of that are below.

Every release proves it rather than asserting it: CI boots the compiled gateway in an empty
directory with no `DATABASE_URL` and no `REDIS_URL`, then drives it over HTTP — it builds its own
database, claims an owner, signs in, serves every dashboard read, writes, and signs out.

### It is not zero-configuration

Two secrets are still required, and they fail differently:

| | If missing |
|---|---|
| `MASTER_ENCRYPTION_KEY` | **The process will not start.** It exits with a Node stack trace rather than a guided message — the check runs at module load, before the startup checks that normally explain themselves |
| `ADMIN_PASSWORD` | Starts, but you cannot claim the owner account. The claim endpoint explains why |

Both are the same requirements server mode has. Keep the encryption key backed up somewhere other
than the machine — **without it the provider keys in your database can never be decrypted again**,
and standalone puts that database on one disk.

### What you give up

| | |
|---|---|
| **Sessions and rate-limit windows reset on restart** | Counters live in memory. Everyone is signed out, and every RPM window starts over |
| **One process only** | A second instance keeps its own counters, so an RPM limit would be enforced at roughly 2×. There is no horizontal scaling |
| **One writer at a time** | SQLite serialises writes. WAL keeps readers from blocking (see below), but concurrent *writers* still queue |
| **No replication, no managed backups, no failover** | The data is a file on one machine's disk |
| **Analytics slow down on large tables** | No parallel query and a weaker planner than Postgres |
| **Some Health readings are absent** | Connection-pool stats, cache hit ratio and deadlock counts are Postgres concepts. The panel shows them as unavailable rather than as zero |
| **Memory grows with use** | Active keys, tracked users and cached responses all live in the process. There is no eviction to a separate store to fall back on |

**Budgets are the exception** — spend is re-derived from usage history rather than held in a
counter, so it stays correct across a restart.

### Backups: use the export, not a file copy

Standalone runs SQLite in **WAL** mode, so the live database is **three files** — `nexus.db`, plus
a `-wal` sidecar holding commits not yet folded in, plus `-shm`.

> [!WARNING]
> Copying `nexus.db` on its own while the gateway is running produces a backup that restores to an
> **earlier state while looking complete**.

Use **[Backup & restore](../README.md#backup--restore)** instead: it reads a consistent snapshot from the
running gateway, encrypts it into one file, and restores onto any gateway — including a Postgres
one. If you would rather copy files, stop the gateway first and copy the whole `.nexus/` directory,
never the `.db` alone.

WAL is why background writes stay off the dashboard's back. Measured with six concurrent aggregates
over 120k rows while 60 writes landed underneath them:

| Journal mode | Total | Slowest background write |
|---|---|---|
| `delete` (SQLite's default) | ~2100 ms | ~2000 ms |
| `wal` (what Nexus sets) | ~600 ms | ~260 ms |

Re-run it yourself with `npm run bench:sqlite-journal`.

> [!IMPORTANT]
> **WAL cannot work on a network filesystem** — NFS, SMB, and some container volume drivers lack the
> shared memory it needs. SQLite refuses silently and stays in `delete` mode, where a write blocks
> every read. Nexus detects this, warns at startup, and the Health page shows the mode actually in
> force. Keep the data directory on local disk.

### Where the data goes

| | |
|---|---|
| Default | `./.nexus/` in the working directory the gateway was started from |
| Override | `NEXUS_DATA_DIR=/var/lib/nexus` |

A dot-directory rather than loose files, so it is one thing to back up and one thing to delete to
start over. In a container it **must** be a mounted volume, or removing the container destroys the
gateway.

### Checking what you are actually running

Never assume from the configuration — ask the gateway:

```bash
curl -s localhost:3000/ready | jq '.checks[].label'
# "In-process memory read"   ← standalone
# "SQLite SELECT 1"
```

**Health → Server** names the store in use, reports the SQLite version, file size, journal mode and
reclaimable space, and marks the Postgres-only readings as unavailable rather than showing zeros.

### When to move to server mode

Move when any of these becomes true: you need **more than one instance**, you need **rate limits
enforced accurately** across them, you need **backups and failover you did not build yourself**, or
your analytics tables have grown enough that the dashboard feels slow.

Point `DATABASE_URL` and `REDIS_URL` at real servers and restart — then carry your data across with
**[Backup & restore](../README.md#backup--restore)**: export from the standalone gateway, restore into the
Postgres one. Provider keys survive the move, because the restore re-encrypts every secret with the
target gateway's key rather than copying ciphertext it could not open. The direction works both
ways, which is also how you take a local copy of production to debug against.

---
