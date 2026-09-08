# Project status

Updated 2026-09-08. The spec (`docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md`)
defines seven build phases; this file records where the build stands against them.

## Done

### Phase 0 — rails and tenancy (complete; merged into `main` on 2026-09-08)

- Branch `phase-0` was fast-forwarded into `main` and deleted. Start Phase 1 from `main`; if
  `git log --oneline main | grep eebab14` finds nothing, the merge has not landed and you should
  stop and ask Robert.
- Plan: `docs/superpowers/plans/2026-09-07-phase-0-rails-and-tenancy.md` (16 TDD tasks, executed
  with subagent-driven development). Commits `73a0936..eebab14` (33, all reachable from `main`),
  followed by the documentation commit that added this file. Gate at merge: 125 tests, typecheck,
  lint, and migration drift check all clean.
- Review: `docs/superpowers/reviews/2026-09-08-phase-0-final-review.md` — the whole-branch review,
  what its fix wave changed, and what was deliberately deferred.
- What exists now: the pnpm monorepo and CI; `@aesa/db` with the tenant tables `workspaces`,
  `org_settings`, `audit_log`, `usage_counters`, `org_data_keys` plus `platform_state`, forced RLS with
  the `NULLIF` predicate, the runtime roles `aesa_app` / `aesa_platform` declared by the package (the
  `aesa_owner` migration owner comes from `scripts/db-init/001-roles.sql`), `withOrg` /
  `withPlatform`, and an isolation suite proven against real Postgres; `@aesa/crypto` (envelope
  encryption with KEK rotation, sealed-box enrollment, token hashing, SSRF guard with a pinned
  dispatcher); `@aesa/core` (tripwire, transitions, settings, plans, invariants); `@aesa/queue`
  (typed jobs with an injected `AbortSignal`, org-keyed singleton enqueue, crons, fair select, and a
  test pinning that pg-boss `stately` is not a mutex); api and worker skeletons.
- Deviations from the spec's Phase 0 list, all recorded in the plan: Better Auth tables move to
  Phase 1; the `SECURITY DEFINER` resolvers move to Phase 2; `agent.orphan-sweep` moves to Phase 3
  (a `platform.heartbeat` cron proves the rails instead); the session role is set through libpq
  startup options rather than `SET ROLE`; `minio` is left out of `compose.yaml` until Phase 4.

## Next: Phase 1 — accounts and the app shell

Start with `superpowers:writing-plans` against the spec's *Build phases → Phase 1* section; the
spec fixes the scope, so no brainstorm is needed unless Robert changes it. Scope from the spec: the
Expo universal app at `apps/app` (package `@aesa/app`; Expo Router, `ResponsiveShell`), Better Auth
with email one-time codes plus Google and Microsoft sign-in using minimal scopes, the `organization`
and `expo` plugins, workspace creation, the four-step onboarding scaffold (profile → mailbox →
knowledge → go live), team invites and roles, a Settings skeleton, push registration,
`web.output: 'server'` on EAS Hosting, EAS dev builds. Better Auth tables are generated with
`advanced.database.generateId: false` and `uuid` ids, and Phase 1 adds the foreign key from
`workspaces.org_id` to the organization table. External verifications start now: Google consent
screen and brand verification, Microsoft publisher verification, privacy and terms pages on the app
domain, the Resend sending domain with SPF, DKIM and DMARC.

Verify (from the spec): sign up on iOS, Android and web; the onboarding step resumes across
devices; audit rows carry `user:<id>`; a Playwright signup smoke; the Expo web export in CI.

Rulings the planner needs:

- Better Auth's tables (`user`, `session`, `account`, `verification`, `organization`, `member`,
  `invitation`) are not tenant tables. Add them to `RLS_EXEMPT` in `packages/db/test/rls.test.ts`
  in the same task that generates them, and keep the default `aesa_app` DML grants on them: the api
  reaches them only through Better Auth's adapter on the app-role handle, and the api never holds
  `aesa_platform`. Never weaken the invariant itself. If Robert prefers RLS-scoped auth tables,
  that ruling flips and the plan must say how Better Auth sets `app.org_id`.
- `apps/app` extends `expo/tsconfig.base`, not `tsconfig.base.json`, and the ESLint TypeScript
  block gains `**/*.tsx`. Expo packages are installed with `npx expo install`, everything else with
  pnpm.

### Phase 1 pre-flight carry-overs

Findings from the Phase 0 final review that were deferred by ruling. Fix each in the first Phase 1
task that touches the file.

- `apps/api/src/server.ts` error handler: copy `err.headers` onto the reply (Better Auth needs
  `WWW-Authenticate` on 401 and `Retry-After` on 429); honour `err.status` as well as
  `err.statusCode`, and let a deliberate 502 or 503 through instead of collapsing to 500; allow-list
  `err.code` (the Postgres SQLSTATE) in the log serializer so 500s stay triageable.
- `ServerDeps` still hands `Db` and `Pool` to the server. The tRPC context must receive a narrow
  facade (`withOrg`, `withPlatform`, a health probe), never the raw handle.
- `packages/crypto/src/ssrf/pinned-fetch.ts` rewrites `content-length` to the buffer size, which
  turns a `HEAD` response's length into 0.
- `packages/db/test/rls.test.ts` filters `relkind = 'r'`; include partitioned tables (`'p'`) once
  `llm_calls` gets monthly partitions.
- `withPlatform` now writes an audit row per call, so it cannot run against a read-only replica, and
  the minute-cadence heartbeat adds about 1,440 `audit_log` rows a day; give `platform.access` rows
  a retention rule when the retention sweep arrives.
- The worker has no structured logger (`LOG_LEVEL` is parsed and unused); `defineJob` retries a
  payload that fails zod validation instead of failing fast; `packages/db/test/keys.test.ts` cases
  are order-dependent; CI never runs the tenant suite through a non-superuser LOGIN role, so the
  production privilege boundary is documented but not exercised.
- The plan's Task 16 Step 3 README block (plan lines 2731–2741) still embeds the superseded roles
  paragraph that the final fix wave corrected in the README itself; the README is right.

## Later phases (see the spec for scope and verification)

- Phase 2 — mailboxes, agents, ingest, triage (Gmail and Microsoft 365 adapters, the OAuth claim
  step, `SECURITY DEFINER` resolvers, the CASA Tier 2 submission).
- Phase 3 — draft → review → send, the first shippable slice (`agent.orphan-sweep` lands here).
- Phase 4 — knowledge (parsers, crawler, Voyage embeddings, retrieval, `minio`/R2 uploads).
- Phase 5 — autonomy and learning (resolved-answer memory, evidence score, graduation).
- Phase 6 — provider choice (BYOK adapters, probes, per-agent model config).
- Phase 7 — billing, caps, launch hardening.

## Open items for Robert

Defaults are stated in the spec's *Open items for Robert* section and do not block implementation:
product name (codename `aesa` until then), pricing numbers, the assumed third-party services,
the managed drafting model per plan, and launch order (Microsoft 365 first, Gmail behind the
test-user gate until CASA clears).
