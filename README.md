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

One `DATABASE_URL` (the cluster admin locally; the migration owner in production). Every pool
connection *starts* in a role, set by the server from the libpq startup options: `aesa_owner` for
migrations, `aesa_app` for api/worker traffic (forced row-level security — a handle without
`withOrg()` sees no tenant rows); `aesa_platform` is entered only inside `withPlatform()`. Local
roles come from `scripts/db-init/001-roles.sql` (run once by the compose container); CI runs the
same file with `psql`.

Production layout (not code — three LOGIN roles, none of them `aesa_app`/`aesa_platform` themselves):

- **migrations** connect as `aesa_owner`, the table owner. Nothing else uses that URL.
- **api** connects as its own LOGIN role, a member of `aesa_app` **only**. The api never calls
  `withPlatform()`, and must not be able to: `GRANT aesa_app TO api_login WITH INHERIT FALSE`.
- **worker** connects as its own LOGIN role, a member of `aesa_app` **and** `aesa_platform`, both
  `WITH INHERIT FALSE`, because `withPlatform()` runs `SET LOCAL ROLE aesa_platform` and that needs
  membership with the SET privilege. `INHERIT FALSE` keeps the privileges out of the login role
  itself, so a connection only ever holds what `-c role=…` or `SET LOCAL ROLE` gave it.

`createDb()` puts `-c role=aesa_app` (or `aesa_owner`) in the libpq startup options, so every
connection starts in the right role before its first query. One exception: pg-boss opens its own pool
in `startBoss()` with no startup options, so it runs as the LOGIN role and `boss.getDb()` is a raw-SQL
channel at that role's privilege — that role must not be a superuser in production, and needs `CREATE`
on the database (see above) rather than blanket rights.

`packages/db/migrations/0001_*.sql` was hand-edited after generation: its `CREATE ROLE` statements are
wrapped in idempotent `DO` blocks so a second database in the same cluster migrates cleanly. The drift
check compares drizzle's snapshots, not the SQL, so this stays valid — do not regenerate that file.

## CI

`.github/workflows/ci.yml`: typecheck → lint → migrate → tests (fresh database per test file) →
migration drift check. Run the same locally with `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check`.

## Dependency pins

- `libsodium-wrappers` is pinned to exactly `0.7.15` in `packages/crypto`: `0.7.16` ships a broken ESM build (its entry references a missing sibling file), which fails `import` resolution under Node ESM and vitest. Re-test the sealed-box suite (`pnpm --filter @aesa/crypto test -- sealed`) before lifting the pin.
