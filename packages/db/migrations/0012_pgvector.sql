-- pgvector for knowledge_chunks.embedding (spec §Data model: vector(1024), exact cosine per org, no global HNSW).
--
-- Precondition: `vector` must already be installed in the database by a superuser before the first
-- `migrate` (pgvector's control file is not `trusted`; migrations run as `aesa_owner`). Locally and in
-- CI `scripts/db-init/001-roles.sql` installs it into `aesa_dev` and `template1`; a dev volume created
-- before Phase 4 needs `pnpm db:down && pnpm db:up`. In production, install it once (`CREATE EXTENSION
-- vector;` as the cluster superuser, or your provider's extension setting) before deploying this migration.
CREATE EXTENSION IF NOT EXISTS vector;
