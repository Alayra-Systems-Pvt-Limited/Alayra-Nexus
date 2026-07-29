-- AiModelRegistry — the table the migrations forgot.
--
-- `model AiModelRegistry` has been in schema.prisma for a long time, but no migration ever created
-- it. Every developer machine has the table because `prisma db push` writes the schema directly;
-- every FRESH install does not, because the container runs `prisma migrate deploy`, and the
-- migrations are the only thing it applies. So the schema said sixteen models and a new Postgres
-- deployment got fifteen.
--
-- It stayed invisible because nothing read the table on a path anyone exercised: the registry cache
-- tolerates a miss, and no test touched it against a migrated-from-scratch database. The backup
-- export is what finally surfaced it — it is the first feature that walks EVERY model in the schema,
-- so a table that does not exist stops it dead, on a fresh install, with the whole export lost.
--
-- Standalone was never affected: prisma/sqlite-schema.sql is generated from the schema itself rather
-- than replayed from migrations, so SQLite has always had the table. The engine that was missing it
-- was the production one.
--
-- Additive and safe to replay: a database that already has the table (any machine built with
-- `db push`) is left exactly as it is.
CREATE TABLE IF NOT EXISTS "AiModelRegistry" (
    "id"         TEXT NOT NULL,
    "modelsJson" TEXT NOT NULL,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModelRegistry_pkey" PRIMARY KEY ("id")
);
