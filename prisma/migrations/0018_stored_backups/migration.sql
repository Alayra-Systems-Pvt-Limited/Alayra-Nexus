-- Stored backups — the gateway keeps its own (Phase B2).
--
-- Until now a scheduled backup could only be written to a folder path on the server. That is
-- durable on a VM and wiped on every redeploy inside a container, and nothing in the gateway can
-- tell those two situations apart — so on Railway, Render or Fly the feature produced files that
-- silently ceased to exist on the next push. The database is the only storage that exists and
-- survives in every deployment shape, so it becomes the default destination and needs no
-- configuration at all.
--
-- The payload is held in CHUNKS rather than one column so the export stays streamed in both
-- directions. B1 was built to stream precisely so a large gateway never has to hold its own
-- database in memory; a single BYTEA column would have discarded that at the final step.
--
-- Both tables are excluded from the backup export and from the schema fingerprint (see
-- src/lib/backup/modelOrder.ts). Without the first, backup #2 would contain backup #1 and compound
-- forever; without the second, every backup taken before this shipped would report schema drift on
-- restore. Tests enforce both, because omitting them silently is the mistake that looks correct.
--
-- Written by hand rather than generated. `prisma migrate dev` would have emitted these two tables
-- alongside roughly twenty unrelated corrections for the known schema/migration drift, burying a
-- reviewable change inside an unreviewable one. The drift is its own task.
--
-- Additive and safe to replay.
CREATE TABLE IF NOT EXISTS "Backup" (
    "id"        TEXT NOT NULL,
    "filename"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bytes"     INTEGER NOT NULL,
    "rows"      INTEGER NOT NULL,
    "origin"    TEXT NOT NULL DEFAULT 'scheduled',

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BackupChunk" (
    "id"       TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "seq"      INTEGER NOT NULL,
    "data"     BYTEA NOT NULL,

    CONSTRAINT "BackupChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Backup_filename_key" ON "Backup"("filename");

-- Retention and the dashboard both read newest-first; without this every prune is a sequential
-- scan over a table whose rows are megabytes each.
CREATE INDEX IF NOT EXISTS "Backup_createdAt_idx" ON "Backup"("createdAt");

-- Reassembly orders by (backupId, seq). The uniqueness is not decoration: a duplicated sequence
-- number would produce a file that reassembles differently depending on row order and fails
-- authentication with no indication of why.
CREATE UNIQUE INDEX IF NOT EXISTS "BackupChunk_backupId_seq_key" ON "BackupChunk"("backupId", "seq");

-- CASCADE, so deleting a backup takes its payload with it. Retention deletes the parent row and
-- must never be able to leave orphaned megabytes behind.
ALTER TABLE "BackupChunk"
    ADD CONSTRAINT "BackupChunk_backupId_fkey"
    FOREIGN KEY ("backupId") REFERENCES "Backup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
