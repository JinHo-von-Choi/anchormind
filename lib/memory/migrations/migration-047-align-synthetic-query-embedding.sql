-- migration-047-align-synthetic-query-embedding.sql
--
-- The target dimension is derived from the existing fragments.embedding column,
-- so the DDL is applied by scripts/migrate.js after the numbered migrations.
-- This marker makes the repair part of the versioned migration history.

SELECT 1;
