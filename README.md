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
