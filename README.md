# ai-email-support-agent
An AI agent that supports customers through email

## Development

Requires Node >= 22, pnpm 10, Docker.

    corepack enable
    pnpm install
    pnpm db:up                                   # Postgres 17 + pgvector on :5434
    DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev pnpm --filter @aesa/db migrate
    pnpm typecheck && pnpm test && pnpm lint

Layout: `apps/api` (Fastify), `apps/worker` (pg-boss), `packages/{db,crypto,core,queue}`.
Design spec: `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md`.

## Database roles

- pg-boss owns the `pgboss` schema and creates it itself on first `boss.start()`; locally the connection user is a superuser so this just works, but in production the worker's connection user must be granted `CREATE` on the database (or have the `pgboss` schema pre-created and owned by it) so pg-boss can bootstrap its tables.

## Dependency pins

- `libsodium-wrappers` is pinned to exactly `0.7.15` in `packages/crypto`: `0.7.16` ships a broken ESM build (its entry references a missing sibling file), which fails `import` resolution under Node ESM and vitest. Re-test the sealed-box suite (`pnpm --filter @aesa/crypto test -- sealed`) before lifting the pin.
