# Phase 1 — final whole-branch review (2026-09-08)

Review of branch `phase-1` at `ce31a4c` (merge base with `main`: `ab07316`), performed after all 14
tasks of `docs/superpowers/plans/2026-09-08-phase-1-accounts-and-app-shell.md` had passed their
task-scoped reviews. Verdict: **with fixes**. One fix wave (the 7 commits `b0ff5d2..aac485c`)
addressed Critical 1, Important 2–6 and the folded minors 9–12; a scoped re-review of that wave
confirmed every finding addressed with no new Critical or Important breakage and left four residual
minors, parked with rulings and carried into `docs/STATUS.md`'s Phase 2 pre-flight list:

- `pnpm-lock.yaml` grew by roughly 300 lines during the wave with a second Expo toolchain variant
  resolved against `typescript@5.9.3` next to the `6.0.3` one (`pnpm dedupe`, re-export and re-run
  the smoke in Phase 2's first task).
- `organizationLimit: 5` counts memberships, not creations, and hitting it surfaces as the masked
  generic 500 (Phase 2 maps Better Auth `APIError`s to tRPC client codes and revisits the cap).
- The per-org invite throttle records a slot before `createInvitation` succeeds and never evicts
  idle organizations from its map (per-replica, in-memory, already documented as temporary).
- With `AUTH_RATE_LIMIT=off` and `TRUST_PROXY=false` in production the global limiter keys on the
  proxy's address (one bucket); the runbook recommends the CIDR list for every deployment.

Gate after the wave: typecheck and lint clean across 8 packages/apps; `pnpm test` green with 234
tests (`@aesa/contracts` 8, `@aesa/core` 30, `@aesa/crypto` 40, `@aesa/db` 33, `@aesa/queue` 14,
`apps/worker` 6, `apps/api` 60, `apps/app` 43); migration drift check clean; the Expo web export
produces 17 static routes; the Playwright signup smoke passes.

Ledger references in the reports below (`progress.md`, task numbers, agent ids) point at the
subagent-driven-development workspace under `.superpowers/`, which is git-ignored and deleted once
the branch is finished. Every ruling that still matters is restated in `docs/STATUS.md`.

---

# Whole-branch review (`phase-1`, ab07316..ce31a4c)

Reviewer: final whole-branch pass (read-only). Read in passes, path-ordered: plan header + ledger +
the five spec sections → `packages/contracts` → `packages/db` (schema, both migrations, tests) →
`apps/api` (config, logging, deps, auth, server, trpc, mail, all 10 test files) → `apps/app` (lib →
components → screens → routes → tests) → CI/eslint/Playwright → docs/runbook/STATUS.

### Strengths

- **Tenancy net 3 is genuinely enforced, not asserted.** `orgProcedure` (`apps/api/src/trpc/init.ts:23-36`) takes `orgId` only from `session.session.activeOrganizationId`, then independently confirms it with `getActiveMember` *and* compares `member.organizationId !== orgId`. No procedure accepts an org id. `managerProcedure` layers role on top. `workspace.test.ts:64-80` proves a hijack `set-active` on another owner's org is rejected and that the fresh session still resolves to its own org.
- **The `cancelInvitation` scoping fix is the best catch of the branch.** Better Auth's cancel endpoint authorizes against the *invitation's* org, not the caller's; without the pre-check a manager of two workspaces could cancel B's invitation from A and the audit row would land in A. The test (`team.test.ts:74-86`) asserts both the NOT_FOUND and the empty audit trail in the wrong org.
- **Audit coverage is complete and correctly attributed.** Every mutation writes `user:<id>`; the `afterAcceptInvitation` hook is deliberately split out because its `user` is the joiner, not the actor. `audit()` validates the actor prefix at the only write site.
- **The logging work is unusually careful.** `serializeError` collapses `DrizzleQueryError` to `Failed query: [redacted]`, keeps only a `^[A-Z0-9_]{1,40}$` code, rebuilds the stack from `at ` frames so the message can't ride along, and `betterAuthLogger` survives better-auth 1.7.3's `logger.error(e)` call with a bare Error as the *message*. `logging.test.ts` pins all of it, including "never throws".
- **`resolveGate` pure / `useGate` effectful is the right seam,** and the activation guard held through the session-refetch race is a subtle bug caught with a test proven load-bearing by revert.
- **The Playwright smoke earned its place** — it found two defects no unit test could (the `Link asChild` CSS crash on first real-browser mount, and the post-sign-out gate stranding). Unique email per run, `expect.poll` instead of sleeps, both webServers declared.
- **Docs are accurate.** CLAUDE.md's two stale lines were corrected, STATUS.md carries every ruling and all 24 open minors, and the runbook is specific enough to execute (exact redirect URIs, exact scopes, exact DMARC record).

### Issues

#### Critical (Must Fix)

**1. `/trpc` returns raw internal error messages — and, outside `NODE_ENV=production`, full stack traces — to the client, bypassing the scrubbed error handler**
`apps/api/src/trpc/init.ts:8` — `initTRPC.context<TrpcContext>().create({ transformer: superjson })` sets no `errorFormatter` and no `isDev`. tRPC's default `getErrorShape` always emits `message: error.message`, and emits `data.stack` whenever `config.isDev` — which defaults to `process.env.NODE_ENV !== 'production'`. The `onError` hook in `server.ts:83-87` only *logs*; the response body is built entirely by tRPC, so the Fastify error handler — the one that strips SQL parameters, collapses 5xx to a bare body and redacts URLs — never runs for `/trpc`. Reproduced against the real `buildServer` + real `appRouter` with `api.withOrg` throwing: the 500 body contained the full SQL, the bound `ExponentPushToken[SECRET-DEVICE]` and a complete stack trace with absolute file paths. Also reachable **pre-auth**: `createContextFactory` calls `deps.auth.api.getSession` before any procedure runs. This is the precise string `logging.ts:22-25` documents as carrying "session tokens, verification codes", and CLAUDE.md's Secrets rule says secrets are "never logged, **never returned by an API**". Fix: `isDev: false` plus an `errorFormatter` that masks `INTERNAL_SERVER_ERROR` messages and strips `data.stack`, with a test that a `DrizzleQueryError` thrown inside a procedure returns no SQL, no params, no stack — and the log line still carries the redacted `err`.

#### Important (Should Fix)

**2. No rate limit on `/trpc` at all — `team.invite` is an authenticated mail relay, `workspace.create` is unbounded.** Better Auth's limiter covers only `/api/auth/*`. `team.invite` sends one Resend email per call to an arbitrary address with a subject built from user-controlled text (`${inviter.user.name} invited you to ${organization.name}`); `user.name` has no length cap. `workspace.create` is unbounded: `organizationLimit` is not set and its default is no limit. Fix: set `organizationLimit`, register `@fastify/rate-limit` on `/trpc` (or a per-user bucket on the mail-sending paths), cap `user.name`.

**3. `ApiFacade` hands every request handler a one-line escalation to `aesa_platform`.** `apps/api/src/deps.ts:16,24` expose `withPlatform(reason, fn)`, which issues `SET LOCAL ROLE aesa_platform` — contradicting the spec's net 1 ("the api never holds `aesa_platform`") and CLAUDE.md. Nothing in `apps/api` calls it. Remove it from the facade and soften the comment: `auth.$context` / `auth.options.database` still close over the raw `Db`, so the facade is a convention, not an enforcement.

**4. The `/trpc` CSRF origin guard has zero test coverage.** Every tRPC test sends `origin: WEB`; deleting the hook would leave the suite green. Under `AUTH_CROSS_SITE_COOKIES=true` this hook is the only CSRF defence on the mutation surface. Add foreign/absent/web Origin cases; pull the deferred self-removal and role-restriction tests into the same wave.

**5. The runbook's production env list omits `TRUST_PROXY`, so the first production boot will crash** (`AUTH_RATE_LIMIT` defaults to on and `config.ts` refuses to start without a trusted proxy in production). Add it, and say which form to use: `true` is only safe behind a proxy that *replaces* `x-forwarded-for`; the CIDR-list form is the correct default.

**6. `AUTH_TRUSTED_ORIGINS` cannot actually serve a second web origin, but the config comment and the runbook say it can.** The extras reach Better Auth's `trustedOrigins` only; CORS is pinned to a single origin and the `/trpc` guard compares against `appWebOrigin` exactly. Either feed the extras into CORS and the guard, or restrict the documented purpose.

#### Minor (Nice to Have)

7. `packages/db/src/schema/auth.ts:63,67` — `slug` carries both `.unique()` and `uniqueIndex('organization_slug_uidx')`: two unique btrees on one column (confirmed live). Needs a migration; bundle with Phase 2's first schema change.
8. `apps/app/src/screens/create-workspace.tsx:23-30` — a network-level failure on a `workspace.create` that succeeded server-side shows "Try again"; pressing again creates a second organization. An idempotency key or a pre-check would close it.
9. `apps/app/src/screens/settings/workspace.tsx:23` — the "Saved." banner is on the screen being popped, so it is never seen.
10. `apps/app/src/screens/sign-in.tsx:35-40` — `social()` is the only submit path without the `busy` guard.
11. `apps/api/src/trpc/routers/workspace.ts:45` — the `throw` after the retry loop is unreachable.
12. `apps/api/src/server.ts:99-105` — the devsink gate hangs off `NODE_ENV`; a boot log line stating the resolved `env` + `mail.transport` would make a missing `NODE_ENV` visible.
13. `apps/app/src/components/responsive-shell.tsx:57` — the `router.push` fix costs the web sidebar its `<a href>` (no middle-click, no open-in-new-tab); `<Link href><View/></Link>` without `asChild` may keep the anchor.
14. `apps/app/src/lib/api-url.ts:2` — a production build with `EXPO_PUBLIC_API_URL` unset silently ships `http://localhost:3001`; a build-time assert would fail the build instead.

### Rulings challenged

None reversed. Verified against the installed sources: Better Auth tables `RLS_EXEMPT` (the adapter queries `user`/`session` by id across orgs) — record that `member`/`invitation` are org-scoped data with no RLS net and that appending to `AUTH_TABLES` silently exempts a table; `advanced.disableOriginCheck: false` (Better Auth skips the check under its own `isTest()`); the `TRUST_PROXY` refusal at boot; `isNotRecipient` narrowed to the recipient signal (a bare 403 would have swept in `ORGANIZATION_MEMBERSHIP_LIMIT_REACHED`); owner protection left to Better Auth (`crud-members.mjs` refuses demoting/removing the creator or the last owner). The "tenancy enforced by construction" framing of the facade should be softened (Important 3).

### Deferred minors to promote

Must be fixed before merge: the `/trpc` origin-guard test (Important 4) plus the deferred team self-removal and role-restriction tests. Everything else in the ledger may wait for Phase 2 as scheduled: the duplicate slug unique index (migration), the drizzle-orm peer bump (dedicated task), `err.headers` normalisation (latent), the malformed-JSON parser code, the unused `ServerDeps` re-export, `keys.test.ts` order, `platform.access` retention, `pinned-fetch` HEAD length, the worker logger and `defineJob` fail-fast, the non-superuser CI login role (tied to Phase 2's `mailbox_credentials` grants), every `apps/app` accessibility/UX item and the placeholder art (gate them on store submission), the once-in-six `use-gate` act() flake (promote if it recurs in CI).

### Recommendations

1. Do the Critical fix and Important 2–6 as one short fix wave, re-run the gate and the smoke, then merge.
2. Give the next phase an "api error surface" invariant test, the way `rls.test.ts` is an invariant test: neither the Fastify path nor the tRPC path ever emits a `Failed query:` tail, a `stack`, or a bound parameter.
3. Write this review record before finishing the branch.
4. Before the first real deploy, decide the cookie topology explicitly: `app.<domain>` + `api.<domain>` keeps `SameSite=Lax` working; only a genuinely cross-domain split needs `AUTH_CROSS_SITE_COOKIES=true`, and that path will want CHIPS/`Partitioned`.
5. `orgProcedure` calls `getSession` + `getActiveMember` on every request; enable Better Auth's `session.cookieCache` when the inbox screens start polling.

### Verification performed

| What | Result |
|---|---|
| `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check` (full gate, once) | exit 0. 221 tests: contracts 8, core 30, crypto 40, db 33, queue 14, worker 6, api 47, app 43. `db:check` → `migrations in sync with schema`, 14 tables. |
| Postgres probe: RLS/force state on all 14 `public` tables | `workspaces`, `org_settings`, `usage_counters`, `audit_log`, `org_data_keys`, `notification_devices` all `t/t`; the seven auth tables + `platform_state` all `f/f`. |
| Postgres probe: `pg_indexes` on `organization` | `organization_slug_unique` **and** `organization_slug_uidx`, both unique btrees on `slug`. |
| Postgres probe: `role_table_grants` for the auth tables | `aesa_app` and `aesa_platform` each hold SELECT/INSERT/UPDATE/DELETE — migration 0002's default privileges reached the 0003 tables. |
| Runtime probe: real `buildServer` + real `appRouter` — `/trpc` origin guard | foreign Origin → 403; no Origin → passes; web Origin → passes. Control works; untested (Important 4). |
| Runtime probe: `api.withOrg` throwing a `Failed query: … params: …` error, valid session | Critical 1 reproduced — 500 body with the full SQL, the bound token and a stack; `appRouter._def._config.isDev = true`. |
| Source read: `@trpc/server@11.18.0` `getErrorShape` / `initTRPC`; `better-auth@1.7.3` `crud-members.mjs`, `crud-invites.mjs`, `crud-org.mjs`, `core/utils/ip.mjs` | Behaviour as described above. |

### Assessment

**Ready to merge?** With fixes.

**Reasoning:** The tenancy, audit and authorization design is correct and genuinely tested against real Postgres and real Better Auth, and the branch meets its Phase 1 scope with every deviation justified — but the new `/trpc` surface returns raw internal error messages and (outside `NODE_ENV=production`) full stack traces straight to the client, reachable pre-auth, which bypasses the scrubbed error handler this project deliberately built. That plus five small Important items is a half-day fix wave, after which I would merge without reservation.

---

# Scoped re-review of the fix wave (ce31a4c..aac485c)

### Finding Verdicts

- **Critical 1** — ADDRESSED. `apps/api/src/trpc/init.ts:14-27`: `isDev: false` and an `errorFormatter` that returns `shape` untouched for every non-`INTERNAL_SERVER_ERROR` code and otherwise replaces `message` over a shallow copy of `shape.data` with `delete data.stack` (correct: superjson would otherwise emit a literal `"stack":null`). Covered by `apps/api/test/error-surface.test.ts` — procedure path, the pre-auth `getSession` path, the Fastify control, and a `FORBIDDEN` that keeps its message.
- **Important 2a (rate limit)** — ADDRESSED. `API_RATE_LIMIT_PER_MINUTE` → `config.rateLimit`; `@fastify/rate-limit` registered `global: true` keyed by `req.ip`, skipped at `0`; the `global: true`/`onRoute` ordering claim is real Fastify behaviour and the nested-`register()` remedy is right; `rate-limit.test.ts` trips it on `/healthz` (a moved route) and asserts 429 + `retry-after`.
- **Important 2b (`organizationLimit: 5`)** — ADDRESSED (`apps/api/src/auth.ts:94`).
- **Important 2c (invite throttle)** — ADDRESSED. `team.ts:16-28`, 20 per rolling hour per org, `TOO_MANY_REQUESTS`, commented as per-replica; test: 20 succeed, the 21st is refused.
- **Important 2d (`user.name` cap)** — ADDRESSED. `auth.ts:24-30,56-61` via `databaseHooks.user.create/update.before` throwing `APIError('BAD_REQUEST')`; verified against `better-auth/dist/db/with-hooks.mjs` that a `void` return leaves the data untouched; tested through `/api/auth/update-user`.
- **Important 3** — ADDRESSED. `withPlatform` gone from `ApiFacade`, `createApiFacade` and `stubDeps`; the comment states "a convention, not an enforcement boundary" and why; the sole remaining caller is the worker's heartbeat.
- **Important 4** — ADDRESSED. `trpc-origin.test.ts` (foreign → 403 exact body; absent and web pass); `team.test.ts` self-removal → BAD_REQUEST, `'owner'` role → BAD_REQUEST.
- **Important 5** — ADDRESSED (runbook §1: CIDR list preferred, why an appending proxy collapses the bucket, `true` only behind a replacing proxy).
- **Important 6** — ADDRESSED. `config.webOrigins` (app origin first, http(s) extras only, deduplicated; native schemes excluded) consumed by CORS and the `/trpc` guard; config and runbook updated; tests for a second origin passing and a third failing.
- **Minors 9–12** — ADDRESSED (banner shown in place; `social()` busy guard; the 5th collision throws its own error, the remaining `throw new Error('unreachable: …')` is required by TS2366 and labelled; the `AUTH_TABLES` comment).

### New Breakage in the Fix Diff

None Critical or Important. Named risks checked: the parser, error handler, CORS and the `/trpc` hook live on the parent instance and children inherit them (proven by the moved routes' suites); the limiter is a route-level `onRequest` hook and does not double-limit Better Auth; client errors bypass the formatter and `data` is a shallow copy; nothing called `withPlatform`; the OTP path creates users with `name: ""`, which passes the cap; `webOrigins` puts the app origin first and excludes `aesa://`/`exp://`. Four Minors introduced or unreported by the wave (listed at the top of this record as parked residuals): the lockfile's duplicate Expo toolchain variant; `organizationLimit` counting memberships with a masked 500 at the limit; the invite throttle consuming a slot on failure and never evicting idle orgs; the global limiter's single bucket when `TRUST_PROXY` is unset with `AUTH_RATE_LIMIT=off`.

### Out-of-Scope Observations

No test throws inside the new nested `register()` block (error-handler inheritance there is correct by Fastify semantics rather than covered); genuine 500s now read "Internal Server Error" in the app's banners; the friendly slug-allocation message is client-invisible (its value is in the logged `onError` line).

### Checks run

`pnpm --filter @aesa/api test` → 13 files, 60 tests passed; `pnpm typecheck` → 8 projects clean; `pnpm lint` → clean; checkout unmutated; all 7 commits carry the trailer; `better-auth@1.7.3` dist read for the three behavioural claims.

### Verdict

**Fix wave:** all findings addressed, no new Critical/Important breakage; four Minors for the human as residuals.
