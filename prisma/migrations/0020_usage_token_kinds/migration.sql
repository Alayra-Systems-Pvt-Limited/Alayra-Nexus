-- The token kinds a provider reports beyond input and output (1.8.0).
--
-- A usage block says how much of the prompt was read from the provider's cache, how much was
-- written to it (Anthropic splits the writes into 5-minute and 1-hour lifetimes), how much missed
-- it (DeepSeek), and how much of the output was reasoning. Until now only input and output were
-- kept. These six columns keep the rest, as the provider reported them.
--
-- Additive and safe. Every column is nullable with no default, so adding it touches no row: every
-- existing row reads as NULL, meaning "not reported", which is exactly what it was. Nothing prices
-- these columns, so no cost or token total changes for old rows or new ones.
--
-- Fail fast rather than queue: ADD COLUMN takes a brief exclusive lock on TokenUsage, and a long
-- dashboard query holding the table would otherwise make it wait while every usage write and read
-- waits behind it. If the lock is not free within five seconds the migration fails, and the next
-- start simply runs it again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "TokenUsage"
  ADD COLUMN "cachedInputTokens"  INTEGER,
  ADD COLUMN "cacheWriteTokens"   INTEGER,
  ADD COLUMN "cacheWrite5mTokens" INTEGER,
  ADD COLUMN "cacheWrite1hTokens" INTEGER,
  ADD COLUMN "cacheMissTokens"    INTEGER,
  ADD COLUMN "reasoningTokens"    INTEGER;
