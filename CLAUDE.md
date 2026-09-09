# Working in this repo

A multi-tenant SaaS: an AI agent that answers a business's customer-support email. Working codename
`aesa` (package scope `@aesa/*`, database roles, header names) until Robert picks a product name.

## Read first

- `docs/STATUS.md` — what is built, what comes next, and the carry-overs for the next phase.
- `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md` — the normative design
  (product, architecture, data model, seven build phases). The spec wins over any plan.
- `docs/superpowers/plans/` — one implementation plan per phase, named
  `YYYY-MM-DD-phase-N-<slug>.md` and committed on the phase branch before the first implementation
  task; each plan lists its deviations from the spec. `docs/superpowers/reviews/` holds the
  whole-branch review of each finished phase.
- Reference implementation: `~/Desktop/code/ClosingBrackets/doge-buddy`, a live business. It is
  read-only: port code from it, never modify it, never share packages with it.

## How a phase is built

brainstorm → spec → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (fresh
implementer per task, task review, fix loop, whole-branch review) →
`superpowers:finishing-a-development-branch`. The spec already fixes the scope of Phases 1–7, so a
phase starts at `writing-plans`; brainstorm only when Robert changes the scope. Work on a branch
off `main`; never push, merge, or open a PR without Robert.

## Commands

    corepack enable && pnpm install
    pnpm db:up                                    # Postgres 17 + pgvector on :5434 (aesa/aesa/aesa_dev)
    DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev pnpm --filter @aesa/db migrate
    pnpm typecheck && pnpm lint && pnpm test && pnpm db:check    # the CI gate; run before every commit
    pnpm --filter @aesa/db test test/rls.test.ts  # one package, one file
    pnpm --filter @aesa/db generate               # after a schema change; commit the migration BEFORE running db:check
    pnpm --filter @aesa/api dev                   # copy apps/api/.env.example to apps/api/.env first
    pnpm --filter @aesa/worker dev                # copy apps/worker/.env.example to apps/worker/.env first
    pnpm --filter @aesa/app dev                   # copy apps/app/.env.example to .env first; EXPO_PUBLIC_API_URL must be the LAN address for a physical phone
    pnpm --filter @aesa/app export:web            # Expo web export (server output)
    pnpm --filter @aesa/app test                  # jest, no database
    pnpm e2e                                      # Playwright signup smoke against the api and the served web export

- The database must be running for every suite except `@aesa/core` and `@aesa/crypto`. Tests read
  `DATABASE_URL` from the real environment (default `postgres://aesa:aesa@localhost:5434/aesa_dev`)
  and never read a `.env` file. Most suites create a throwaway database per test file through
  `createTestDatabase()`; the `@aesa/queue` suites run against `DATABASE_URL` itself in the
  `pgboss_test` schema.
- `pnpm db:check` re-runs `generate` and, if anything under `packages/db/migrations` changes, fails
  and then restores that directory with `git checkout --` and `git clean -fd`. An uncommitted
  migration, generated or hand-written, is deleted by that step, so commit migrations first.
- `loadDotEnv` reads only the app's own `apps/<app>/.env` (never the repo root) and never
  overrides a variable already set in the environment. `migrate` loads no `.env` at all, hence the
  inline `DATABASE_URL` above.
- Local database roles come from `scripts/db-init/001-roles.sql`, run once by the compose
  container (CI runs the same file with `psql`). `pnpm db:down` drops the volume, so the roles are
  recreated on the next `pnpm db:up`.
- Ports: the api listens on 3001 (`PORT`, `HOST` defaults to `0.0.0.0`); the worker binds no port;
  Postgres is on 5434 because doge-buddy already uses 5433. `APP_BASE_URL` is the api's public
  origin (Better Auth's `baseURL`; OAuth redirect URIs are `<APP_BASE_URL>/api/auth/callback/<provider>`);
  `APP_WEB_ORIGIN` is the Expo web origin (CORS, trusted origin, invitation links).

## Layout

- `packages/contracts` — zod inputs and enums shared by api, db and app; zod only, no Node imports.
- `packages/db` — drizzle schema (`src/schema/`), SQL migrations, `createDb` (session role set through
  libpq startup options), `withOrg` / `withPlatform`, per-org data keys, `createTestDatabase`.
- `packages/crypto` — `Secret`, domain-separated token hashing, AES-256-GCM envelope with a KEK ring,
  libsodium sealed boxes, the SSRF guard (`validateOutboundUrl`, `resolvePublic`, `pinnedFetch`).
- `packages/core` — tripwire, state-transition matrices, settings catalog, plans, startup
  invariants, `loadDotEnv`.
- `packages/queue` — pg-boss wrappers (`startBoss`, `registerCron`), `defineJob` / `registerJob`,
  `enqueue`, `fairSelectSql`.
- `apps/api` — Fastify skeleton: `/healthz`, config, scrubbed error handler, log redaction. The api
  never holds the KEK, never calls a model, never touches customer mail (it sends platform email —
  sign-in codes, invitations — through the `MailTransport`; Resend in production, the devsink
  elsewhere).
- `apps/worker` — `WORKER_ROLES` partition, KEK ring, `jobs/` (a `platform.heartbeat` cron so far).
- `apps/app` — the Expo universal app (`@aesa/app`, SDK 57, Expo Router, `web.output` server):
  `src/app` routes only, `src/screens` bodies, `src/lib` clients and the session gate, `src/components`
  primitives; jest-expo + RNTL for units, Playwright for the signup smoke.

## Rules that hold here (most are test-enforced; do not work around them)

- **Tenancy.** Every tenant table carries `org_id uuid` (NOT NULL except `audit_log`, where NULL
  marks a platform event) and leads its tenant indexes with it; that ordering is a convention, not
  something a test checks. What `packages/db/test/rls.test.ts` enforces: row-level security ENABLED
  and FORCED on every ordinary table in `public`, with exactly two policies, `<table>_org_isolation`
  for `aesa_app` using the `NULLIF(current_setting('app.org_id', true), '')::uuid` predicate and
  `<table>_platform_all` for `aesa_platform`. Declare them with `tenantPolicies()` from
  `packages/db/src/schema/helpers.ts`. A table that is not tenant data (`platform_state` today;
  Better Auth's tables in Phase 1) goes in that test's `RLS_EXEMPT` list instead. drizzle never
  emits `FORCE`, so a custom migration adds it, and migration 0002's default privileges give
  `aesa_app` full DML on new tables, so a worker-only table needs an explicit `REVOKE`.
- **Data access.** Tenant reads and writes go through `withOrg(db, orgId, fn)` (branded `OrgTx`) or
  `withPlatform(db, reason, fn)`, which writes an `audit_log` row per call. Raw handles come only
  from `@aesa/db/raw`, and the ESLint gate also blocks value imports of `pg` and
  `drizzle-orm/node-postgres` outside `packages/db`, `apps/*/src/index.ts`, tests and scripts.
- **Transactions.** A `withOrg` transaction never spans network I/O. The app role gets a 5 s
  idle-in-transaction timeout and a 30 s statement timeout from `createDb` (configured there, not
  asserted by a test), so a violation fails loudly at runtime.
- **Jobs.** Payload schemas include `orgId`; `enqueue` sets `singletonKey` to `${orgId}:${entityId}`;
  `registerJob` hands the handler an `AbortSignal` that fires at `expireInSeconds` minus
  `JOB_SIGNAL_MARGIN_SECONDS` (owned by `@aesa/core`).
- **Secrets.** Never logged, never returned by an API. `Secret` serializes as `[redacted]`; the api
  error handler strips SQL parameters and redacts URLs before anything reaches a log or a client.
- **App bundle.** `apps/app` never imports `@aesa/db`, `@aesa/core`, `@aesa/crypto`, `@aesa/queue`,
  `drizzle-orm` or `node:*` as values, and `@aesa/api` only as `import type` (ESLint block for
  `apps/app/**`). Share types through `@aesa/contracts`.
- **Auth tables.** Better Auth's `user`/`session`/`account`/`verification`/`organization`/`member`/
  `invitation` are `RLS_EXEMPT` with uuid ids minted by Postgres (`generateId: false`); the api
  reaches them only through Better Auth; tRPC's `orgProcedure` derives `orgId` from the session's
  active organization plus `getActiveMember`, never from input.
- **Audit.** Tenant-side audit rows go through `audit(tx, entry)` with actor `user:<id>` |
  `agent:<run_id>` | `system:<job>`; every tRPC mutation writes one.
- **Toolchain.** TypeScript strict NodeNext ESM with explicit `.ts` imports, `tsx` at runtime (no
  build step), runtime dependencies in `dependencies`, vitest, zod 4. This covers the server
  packages and `apps/api` / `apps/worker`; `apps/app` extends `expo/tsconfig.base` instead
  (bundler resolution, JSX, extensionless imports) with `allowImportingTsExtensions`, `noEmit` and
  `types: ["node", "jest"]`, and is built by EAS; the root ESLint TypeScript block covers `**/*.tsx`.
- **Commits** end with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  (a convention, not a check).
