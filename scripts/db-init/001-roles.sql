DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_owner') THEN CREATE ROLE aesa_owner NOLOGIN CREATEROLE CREATEDB; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_app') THEN CREATE ROLE aesa_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_platform') THEN CREATE ROLE aesa_platform NOLOGIN; END IF;
END $$;
-- WITH INHERIT FALSE: aesa_owner can SET ROLE into aesa_app/aesa_platform, but does not automatically
-- inherit their privileges — in particular aesa_platform's `USING true` RLS policy. Without this, a
-- FORCE ROW LEVEL SECURITY table owner would see every row through the inherited platform policy,
-- defeating the "table owner sees nothing" isolation guarantee tenant.test.ts (Task 4) depends on.
GRANT aesa_app, aesa_platform TO aesa_owner WITH INHERIT FALSE;
ALTER DATABASE aesa_dev OWNER TO aesa_owner;

-- pgvector ships with no `trusted` flag in its control file, so `CREATE EXTENSION vector` requires a
-- real superuser no matter who owns the database — `aesa_owner`, the role every migration (including
-- Task 3's 0012_pgvector.sql) and every throwaway test database run as, can never install it itself.
-- Install it here, once, as the superuser this script already runs as (compose's docker-entrypoint-initdb.d
-- and CI's own invocation of this file both connect as `aesa`): directly into `aesa_dev` (the database
-- `pnpm --filter @aesa/db migrate` and CI target) and into `template1`, so every database `CREATE DATABASE`
-- makes afterwards — including every `createTestDatabase()` throwaway — already carries the extension.
-- Migration 0012's `CREATE EXTENSION IF NOT EXISTS vector` then runs as `aesa_owner` against an
-- already-installed extension, which Postgres permits without a superuser check (verified empirically:
-- `CREATE EXTENSION IF NOT EXISTS` on an existing extension short-circuits before the privilege check).
CREATE EXTENSION IF NOT EXISTS vector;
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
\connect aesa_dev
