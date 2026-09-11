# ai-email-support-agent
An AI agent that supports customers through email

Start with `CLAUDE.md` (how to work in this repo) and `docs/STATUS.md` (what is built and what comes next).

## Development

Requires Node >= 22, pnpm 10, Docker.

    corepack enable
    pnpm install
    pnpm db:up                                   # Postgres 17 + pgvector on :5434, minio on :9000/:9001
    pnpm s3:init                                 # creates the dev bucket + CORS policy in minio
    DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev pnpm --filter @aesa/db migrate
    cp apps/api/.env.example apps/api/.env      # set BETTER_AUTH_SECRET (openssl rand -base64 48)
    pnpm --filter @aesa/api dev                  # http://localhost:3001 — codes: /__dev/mail/latest?to=<email>
    cp apps/worker/.env.example apps/worker/.env # see "Worker environment" below
    pnpm --filter @aesa/worker dev               # binds no port; WORKER_ROLES picks which jobs it runs
    cp apps/app/.env.example apps/app/.env
    pnpm --filter @aesa/app dev                  # Expo: press w for web (http://localhost:8081), i / a for simulators
    pnpm e2e                                     # Playwright smoke (export the web app first: pnpm --filter @aesa/app export:web)
    pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
    pnpm brand:build                             # rebuild the brand assets after changing a brand/ source; see brand/README.md

Layout: `apps/api` (Fastify + Better Auth + tRPC), `apps/worker` (pg-boss), `apps/app` (Expo),
`packages/{contracts,db,crypto,core,queue,mail,platform-mail,llm,agent,test-kit}`, `brand`
(the `@aesa/brand` workspace package — see `brand/README.md`).
Ports: the api listens on 3001 (`PORT`; `HOST` defaults to `0.0.0.0`), the worker binds no port, Postgres
is on 5434. `APP_BASE_URL` is the api's public origin (Better Auth baseURL, OAuth redirect URIs);
`APP_WEB_ORIGIN` is the Expo web origin (CORS, trusted origin, invitation links).
Design spec: `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md`.

## Worker environment

`apps/worker/.env.example` is the full list; these are the ones that decide what a replica can do.
Each app reads only its OWN `apps/<app>/.env` — never the repo root — and never overrides a variable
already set in the process environment.

- `WORKER_ROLES` — comma-separated subset of `sync,agent,send,knowledge,cron`; it is what partitions
  the job registrations across replicas. `sync` runs the mailbox lifecycle, `agent` runs
  `ticket.triage`/`ticket.draft`/`agent.sandbox`, `send` runs `send.execute` (the only process that
  sends a customer reply), `cron` runs the sweeps and the digest.
- `AESA_KEK_V<n>` / `AESA_KEK_ACTIVE` — the KEK ring. Required in production when `WORKER_ROLES`
  includes `sync` or `send`: mailbox credentials are sealed under it and there is no other way to
  reach a provider.
- `ANTHROPIC_API_KEY` — required in production when `WORKER_ROLES` includes `agent`.
- `GMAIL_OAUTH_CLIENT_ID`/`_SECRET`, `MS_OAUTH_CLIENT_ID`/`_SECRET` — all-or-none pairs, one per
  provider. At least one is required in production for **`send`** — `maybeRegisterSendRole`
  (`apps/worker/src/send-role.ts`) refuses to boot without one. `sync` is not gated on a pair at
  boot, but needs one all the same: without it the mailbox jobs throw at the first token refresh.
- `GMAIL_PUBSUB_TOPIC`, `WEBHOOK_PUBLIC_URL` — optional push-subscription plumbing; without them the
  poll cadence still keeps mailboxes synced.
- `EMAIL_TRANSPORT` / `RESEND_API_KEY` / `MAIL_FROM` — platform mail. The worker sends the daily
  digest email through the same transport the api uses, so a production `cron` replica needs
  `resend` + a key; a replica without `cron` sends no platform mail and needs none of it.
- `APP_BASE_URL`, `APP_WEB_ORIGIN` — the digest email's two link bases. Both must be set or the
  digest email pass stays off (the 5-minute push digest still runs).

**`MAIL_FROM`, `APP_BASE_URL` and `APP_WEB_ORIGIN` must be the identical values in
`apps/api/.env` and `apps/worker/.env`.** Nothing checks it at boot and every mismatch fails
silently — see `CLAUDE.md` and `docs/runbooks/2026-09-phase-3-external-setup.md`.

## Database roles

- pg-boss owns the `pgboss` schema and creates it itself on first `boss.start()`; locally the connection user is a superuser so this just works, but in production the worker's connection user must be granted `CREATE` on the database (or have the `pgboss` schema pre-created and owned by it) so pg-boss can bootstrap its tables.
- Better Auth's seven tables are not tenant tables (no RLS; `aesa_app` has DML); the api reaches them only through Better Auth's adapter.

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
It runs only on pushes to `main` and on pull requests, so a phase branch is covered by the local gate alone
until a PR is opened.

## Dependency pins

- `libsodium-wrappers` is pinned to exactly `0.7.15` in `packages/crypto`: `0.7.16` ships a broken ESM build (its entry references a missing sibling file), which fails `import` resolution under Node ESM and vitest. Re-test the sealed-box suite (`pnpm --filter @aesa/crypto test -- sealed`) before lifting the pin.
