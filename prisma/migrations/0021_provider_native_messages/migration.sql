-- How a pool serves Anthropic Messages requests in Anthropic's own format (1.8.0).
--
-- One JSON object string per pool: whether the native path is on for it, and which request fields
-- Nexus cannot price the operator still lets through. NULL means the defaults, which is what every
-- existing pool gets.
--
-- Additive and safe. The column is nullable with no default, so adding it touches no row.
--
-- Fail fast rather than queue: ADD COLUMN takes a brief exclusive lock on NexusProvider, which the
-- routing read uses on every request that misses its cache. If the lock is not free within five
-- seconds the migration fails, and the next start simply runs it again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "NexusProvider" ADD COLUMN "nativeMessages" TEXT;
