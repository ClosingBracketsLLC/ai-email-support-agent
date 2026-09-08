# Phase 0 — final whole-branch review (2026-09-08)

Review of branch `phase-0` at `763eff4` (base: plan commit `73a0936`), performed after all 16 tasks
had passed their task-scoped reviews. Verdict: **with fixes**. One fix wave (the 8 commits
`763eff4..eebab14`) addressed C1, I1–I9 and minors M1–M6, M8, M9, M10 and M13, and a scoped
re-review confirmed each one. Deferred by ruling to the Phase 1 pre-flight (listed in
`docs/STATUS.md`): M7, M11, M12, the non-superuser CI variant from I5, the `ServerDeps` facade from
I9, the six re-review residuals below, and the stale roles paragraph left in the plan's Task 16
Step 3 block.

Ledger references in the report (`ledger 34`, `ledger 53`, and so on) point at the
subagent-driven-development ledger under `.superpowers/`, which is git-ignored and not available
to later sessions. The rulings that still matter are restated in the report body, in `README.md`
(database roles) and in `docs/STATUS.md`.

## Re-review residuals (found in the fix wave, deferred)

- `apps/api/src/server.ts:52-67` — the custom error handler does not copy `err.headers` onto the
  reply, consults only `err.statusCode` (not `err.status`), and turns a deliberate 502 or 503 into
  a 500.
- `apps/api/src/server.ts:26-33` — the log serializer keeps only `type`, `message` and `stack`, so
  `err.code` (the Postgres SQLSTATE) and constraint names are dropped from 500 logs.
- `packages/crypto/src/ssrf/pinned-fetch.ts:91` — `content-length` is rewritten to the buffer size,
  which reports 0 for a `HEAD` response.
- `packages/db/test/rls.test.ts:33` — the catalog invariant filters `relkind = 'r'`, so a partitioned
  table would be skipped.
- `packages/db/src/tenant.ts:41-47` — `withPlatform` now inserts an `audit_log` row per call, so it
  is no longer usable on a read-only replica and the heartbeat adds about 1,440 rows a day.
- `packages/db/test/tenant.test.ts:79-85` — the audit-row test reads inside the same transaction,
  so it pins the insert and the grant path but not post-commit visibility.

The report below is preserved verbatim as the record of what was found and why.

---

# Phase 0 — whole-branch review (`phase-0`, 73a0936..763eff4)

Reviewer: final whole-branch pass (read-only). Scope: cross-task integration, spec/plan alignment, tenancy and security, code quality, tests, production readiness. All 25 commits, every source/test/config file on disk, the ledger rulings, the plan header/deviations, and the spec sections named in the brief were read. Verification suite run locally; five empirical probes run against the local cluster / Node 22 where reasoning from memory would have been guesswork (details under *Verification performed*).

---

## Strengths

- **The tenancy rails are right, and proven against real Postgres.** `NULLIF(current_setting('app.org_id', true), '')::uuid` on every tenant table, RLS `ENABLE` + `FORCE`, per-table `org_isolation` (USING + WITH CHECK) for `aesa_app` and `platform_all` for `aesa_platform` (`packages/db/src/schema/helpers.ts:24-29`, migrations 0001/0002). `withOrg` runs `set_config(..., true)` inside the same drizzle transaction the callback uses (`packages/db/src/tenant.ts:23-29`), so `OrgTx.orgId` cannot disagree with the GUC. The isolation suite (`packages/db/test/tenant.test.ts`) uses a `max: 1` pool so the GUC-leak test genuinely reuses the physical connection; WITH CHECK is asserted on the driver error (`cause.code === '42501'`); the branded-type check is compile-time (`@ts-expect-error`).
- **The role-switch ruling (ledger 34) is better than the plan text it replaced.** Verified: with `-c role=aesa_app` in libpq startup options, `RESET ROLE` returns to `aesa_app` (not the session user) and the 5 s / 30 s timeouts are present on the connection. An on-connect `SET ROLE` query would have been resettable.
- **The owner-inheritance catch (ledger 53) was a real security find** by Task 4's implementer: without `WITH INHERIT FALSE`, the table owner inherited `aesa_platform`'s `USING (true)` and FORCE RLS was moot. Pinned by a `pg_auth_members.inherit_option` test.
- **Crypto is sound in the parts that matter:** AES-256-GCM with a version byte and a 12-byte nonce, AAD binding tested for both transplant and tamper (`packages/crypto/test/envelope.test.ts:21-30`), KEK-ring rotation tested end to end; the sealed-box direction is correct (the api only ever reads `workspaces.box_public_key`; `openSealedForOrg` needs the KEK, so only the worker can open); `apps/api/src/config.ts:16-17` refuses any `AESA_KEK_*` at boot; `Secret` is tested through `String`, template literal, `JSON.stringify`, `util.inspect` and `Object.keys`.
- **Queue behaviour is pinned rather than assumed:** the stately-is-not-a-mutex test, the `singletonSeconds` debounce test, and the AbortSignal deadline test all run against a real pg-boss 10.4.2 with exception-safe cleanup. `registerCron`'s policy-preservation logic (`updateQueue` silently downgrading to `standard`) is documented precisely.
- **Core is tidy:** NFKC + word-boundary tripwire with the "does not trip" table; `NoInfer` transitions that reject unknown keys at compile time; three-level settings resolution with type checks; invariants asserted at both app boots.
- **Process discipline shows:** all 25 commits carry the trailer; `loadDotEnv` was consolidated once instead of duplicated; every ruling in the ledger records a cost-if-wrong; the drift check demonstrably works; CI mirrors the README sequence exactly.

---

## Issues

### Critical (Must Fix)

**C1. The api skeleton returns SQL query parameters to HTTP clients and writes them to the log by default.**
`apps/api/src/server.ts:9-15` (no `setErrorHandler`, default pino `err` serializer).
drizzle-orm 0.44's `DrizzleQueryError` message is literally `Failed query: <sql>\nparams: <params>` (`node_modules/.pnpm/drizzle-orm@0.44.7*/node_modules/drizzle-orm/errors.js:11-14`). Fastify 5's default error handler puts `err.message` in the 500 body and logs `{ err }`. Reproduced through the real `buildServer` with a throwing route:

```
res body: {"statusCode":500,"error":"Internal Server Error","message":"Failed query: insert into \"session\" (\"token\") values ($1)\nparams: tok_SUPER_SECRET_SESSION_TOKEN"}
log:      "err":{"type":"DrizzleQueryError","message":"Failed query: insert into \"session\" (\"token\") values ($1)\nparams: tok_SUPER_SECRET_SESSION_TOKEN: duplicate key", ...}
```

Why Critical: the Global Constraint says secrets are "never logged, never returned by an API", and this skeleton is the one place the api's error semantics are defined. Nothing exposes it today (`/healthz` catches its own errors), but Phase 1 is Better Auth — session tokens, verification codes and account tokens all go through drizzle — and every route inherits this default. Cheap now; embarrassing later.
Fix: (1) `app.setErrorHandler` that logs a scrubbed error and returns a generic body for 5xx (`{ statusCode: 500, error: 'Internal Server Error' }`); (2) a pino `serializers.err` that, for `DrizzleQueryError`, drops `params` and replaces the message with the query only (or `[redacted]`), and runs `redactUrl` over any URL found in `err.message`; (3) a test that injects a throwing route and asserts neither body nor log line contains the parameter. The existing `redact.paths` for headers stay.

### Important (Should Fix)

**I1. `buildPinnedDispatcher` cannot open a connection on Node ≥ 20 — every `pinnedFetch` fails.**
`packages/crypto/src/ssrf/pinned-fetch.ts:16-18`. Node's `net.connect` has `autoSelectFamily` on by default since v20, so it calls the custom `lookup(host, { all: true }, cb)` and expects an *array*. The pinned lookup ignores `opts` and answers `cb(null, address, family)`. Reproduced with the shipped function: `fetch failed <- TypeError: Invalid IP address: undefined`. Works with either an `all`-aware lookup or `autoSelectFamily: false` in the connect options. Fails closed, so no SSRF exposure — but the primitive the spec injects into both LLM SDKs and every customer-URL fetch is non-functional.
Fix: `const pinnedLookup = (_h, opts, cb) => opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)`, *and* set `autoSelectFamily: false` (happy-eyeballs has no business in a pinned connection). Verbatim from the plan → plan defect, not the implementer's.

**I2. `pinnedFetch` deadlocks on any response body larger than the socket buffer.**
`packages/crypto/src/ssrf/pinned-fetch.ts:36-49`. `finally { await dispatcher.close() }` runs before the caller can read the body; `Agent.close()` waits for the in-flight request, which cannot complete until the body is consumed. Measured with a working lookup: 5 B and 16 KB bodies fine; 64 KB and 1 MB hang until `AbortSignal.timeout` fires, then the body read throws. Default `timeoutMs` is 30 s, so a real call burns 30 s and then fails. LLM responses and knowledge crawls routinely exceed 64 KB.
Fix: read the body inside `pinnedFetch` (cap it, e.g. 10 MB) and return `{ status, headers, body: Buffer }`; close the dispatcher after the read; use `dispatcher.destroy()` (not `close()`) on the redirect/error path so an unread 3xx body cannot hang either. Verbatim from the plan → plan defect.

**I3. The SSRF test that "pins the vetted IP" is tautological.**
`packages/crypto/test/ssrf.test.ts:30-34` calls `pinnedLookup` directly and asserts what it was constructed with; no socket is ever opened, which is why I1 and I2 ship green. Replace with a socket-level test: local `http.createServer` on 127.0.0.1, `undici.fetch` through `buildPinnedDispatcher('127.0.0.1', 4)` with a hostname that would not otherwise resolve (the dispatcher is scheme-agnostic, so plain http is fine for the pinning property), assert status + full body for a >64 KB response, and assert a 302 rejects promptly. Also verbatim from the plan.

**I4. `JOB_SIGNAL_MARGIN_SECONDS` exists twice in packages that do not depend on each other.**
`packages/core/src/invariants.ts:10` (`30`, used by the boot invariant `DRAFT_WATCHDOG + MARGIN < DRAFT_JOB_EXPIRE`) and `packages/queue/src/define-job.ts:5` (`30`, the value the AbortSignal deadline actually uses). Change one and the invariant keeps passing while the real deadline drifts. This is exactly the "coupled constants enforced only by comment" the spec's cross-cutting rule forbids. Fix: single source — `@aesa/queue` imports it from `@aesa/core` (add the workspace dep), or `checkInvariants` takes the margin from `@aesa/queue`; at minimum a test asserting equality.

**I5. README's production-hardening paragraph is wrong about `withPlatform`, and silent about pg-boss's pool.**
`README.md:27-29` says "point the api/worker `DATABASE_URL` at `aesa_app` … `SET ROLE` to the same role is a no-op, so no code changes". But `withPlatform` runs `SET LOCAL ROLE aesa_platform` (`packages/db/src/tenant.ts:39`), which requires the *worker's* LOGIN role to hold `aesa_platform` membership with the SET privilege (`GRANT aesa_platform TO <worker_login> WITH INHERIT FALSE`), and the spec requires the *api's* LOGIN role to hold none ("the api never holds `aesa_platform`"). Also `startBoss` (`packages/queue/src/pg-boss.ts:101-106`) opens a second pool with no `-c role`, so pg-boss runs as the LOGIN user and `boss.getDb()` is a raw-SQL channel at that privilege — locally a superuser. Verified locally that a raw app handle can `SET ROLE aesa_platform` and `SET ROLE aesa` (superuser) because the session user is a superuser; the local suite therefore never exercises the production privilege boundary. Fix: document the three-role production layout (migrations → `aesa_owner`; api → LOGIN member of `aesa_app` only; worker → LOGIN member of `aesa_app` + `aesa_platform`, both `INHERIT FALSE`), and consider a CI variant that runs `tenant.test.ts` through a non-superuser LOGIN role (a one-line addition to `scripts/db-init/001-roles.sql`) so `SET ROLE` escapes fail loudly.

**I6. No generic "every table has RLS" invariant — Phase 1–7 tables can ship unprotected without a test noticing.**
`packages/db/test/rls.test.ts:5` checks a hard-coded `TENANT_TABLES` list. drizzle-kit emits `ENABLE ROW LEVEL SECURITY` only for tables that declare policies and never emits `FORCE`; both `tenantPolicies(...)` and the hand-written `FORCE` line in a custom migration are per-table manual steps with nothing enforcing them. A tenant table that forgets `...tenantPolicies(t.orgId, name)` has no RLS at all and `aesa_app` sees every row. Add one test: every `pg_class` relation in `public` outside an explicit allowlist (`platform_state`, later `webhook_events`, Better Auth tables) must have `relrowsecurity AND relforcerowsecurity` and exactly the `_org_isolation` / `_platform_all` policies with the NULLIF predicate. Related footgun to document in `helpers.ts`: migration 0002's `ALTER DEFAULT PRIVILEGES` grants `aesa_app` full DML on every future table by default, so Phase 2's `mailbox_credentials` (spec: worker-role column grants only) needs explicit `REVOKE`s.

**I7. Spec requires "an audit line per `withPlatform()` call"; not implemented and not a flagged deviation.**
Spec *Where tenancy is enforced*, net 1: "platform sweeps as `aesa_platform` with an explicit `USING (true)` policy scoped to that role **and an audit line per `withPlatform()` call**". `packages/db/src/tenant.ts:31-43` only takes a `reason` string for grepping. The plan's four deviations do not cover this, so it is a fifth, silent one. `audit_log.org_id` is already nullable for platform events (`schema/tenancy.ts:63`) and the actor grammar `system:<job>` exists, so it is one `INSERT` inside `withPlatform` (actor `system:${reason}`, action `platform.access`). If the controller prefers to defer (the minute-cadence heartbeat would add 1,440 rows/day), add it to the plan's deviation list with that rationale — the spec says the discrepancy must be flagged.

**I8. `hasKek` presence check + the shipped `.env.example` crashes the worker on first boot.** (Promotes ledger line 160.)
`apps/worker/src/config.ts:12` treats a *present* `AESA_KEK_V1` as "has KEK"; `apps/worker/.env.example:4-5` ships `AESA_KEK_V1=` blank with `AESA_KEK_ACTIVE=1`; `loadKekRing` skips blank values (`envelope.ts:15`) then throws on `ACTIVE`. Reproduced: `cp .env.example .env && pnpm dev` → `AESA_KEK_ACTIVE must name a configured AESA_KEK_V<n>`. That is the documented onboarding path for everyone joining in Phase 1. Fix: `hasKek = Object.entries(env).some(([k, v]) => /^AESA_KEK_V\d+$/.test(k) && v)`.

**I9. The ESLint gate blocks one import path; `pg` and `drizzle-orm/node-postgres` remain open, and `Db`/`Pool` are handed straight into the server.**
`eslint.config.js:14` restricts only `@aesa/db/raw`. Both apps list `pg` as a dependency, so `import pg from 'pg'; new pg.Pool({ connectionString })` anywhere yields a pool with no `-c role` — locally a superuser, RLS bypassed. `apps/api/src/server.ts:6` (`ServerDeps { db: Db; pool: pg.Pool }`) also makes the raw handle ambient for every future route. RLS still protects `deps.db`/`deps.pool` (they run as `aesa_app`), so this is about keeping the gate meaningful before Phase 1 designs the tRPC context. Fix: add `pg` and `drizzle-orm/node-postgres` to `no-restricted-imports` (use `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true` so `import type pg` in `server.ts` stays legal); decide now that request handlers receive a narrow facade (`withOrg`, `withPlatform`, health probe) rather than `Db`.

### Minor (Nice to Have)

- **M1.** `packages/crypto/src/envelope.ts:35-44` — `open()` never checks `blob.length >= 1 + 12 + 16` and does not pass `authTagLength: 16` to `createDecipheriv`; a truncated blob is verified against a shorter tag. Not exploitable without the key; hardening.
- **M2.** `packages/crypto/src/envelope.ts:46-48` — `wrapDek` AAD is `kek:<v>` with no org binding, so one org's wrapped DEK can be transplanted into another org's `org_data_keys` row at the DB layer. Add `orgId` to the wrap AAD (defence in depth; the row AAD `${orgId}:box:v${n}` already binds the private key).
- **M3.** `packages/crypto/src/ssrf/ranges.ts` — NAT64 `64:ff9b::/96` and 6to4 `2002::/16` are not blocked (verified `64:ff9b::7f00:1 → false`); add both. Ruling 93 stands: all v4-mapped spellings (`::ffff:`, `0:0:0:0:0:ffff:`, hex `::ffff:7f00:1`, uppercase) are blocked — verified.
- **M4.** `compose.yaml` — the spec's Phase 0 line lists `minio`; omitted without a flagged deviation. Nothing needs it until uploads; add it to the deviation list or to compose.
- **M5.** `packages/db/drizzle.config.ts:9` — `entities: { roles: true }` without `exclude: ['aesa_owner', 'aesa', …]`. Harmless for `generate` (snapshot diff), but a future `drizzle-kit push` would try to manage every role in the cluster.
- **M6.** `packages/db/migrations/0001_outgoing_zeigeist.sql:1-3` — generated SQL was hand-edited into idempotent `DO` blocks. Fine (the drift check compares snapshots, not SQL), but say so in the README so the next person does not "fix" it back.
- **M7.** `packages/queue/src/define-job.ts:55` — a `ZodError` on `job.data` is retried `retryLimit` times before failing; consider failing immediately for validation errors.
- **M8.** `apps/api/package.json:7` — `@aesa/crypto` is a declared dependency the api never imports.
- **M9.** `packages/db/src/testing.ts:14` — the regex URL rewrite breaks on a `DATABASE_URL` with a query string (`?sslmode=`); use `new URL()` and set `pathname`.
- **M10.** `packages/db/src/schema/helpers.ts:18` — `ORG_ID_PREDICATE_SQL` is exported and unused; either drop it or use it in `rls.test.ts` so the string and the `sql` tag cannot drift.
- **M11.** The worker has no structured logger (`console.log` in `apps/worker/src/index.ts:12`, `console.error` in `startBoss`), so the log-redaction constraint has no enforcement point there yet; `LOG_LEVEL` is parsed and unused (ledger 161).
- **M12.** Tests: `packages/db/test/keys.test.ts` cases are order-dependent (provision → open → refuse); `rls.test.ts:17` "creates both runtime roles" is trivially true because the init script pre-creates them, so the migration-0001-creates-roles path (a non-superuser `aesa_owner` in production) is untested — I verified it manually (see below) and it works.
- **M13.** `apps/api/src/server.ts:12` — the `redact.paths` for headers are dead because the `req` serializer drops headers; keep, but comment (ledger 152).

---

## Deferred minors to promote

| ledger line | finding | verdict |
|---|---|---|
| 39 | `CreateDbOptions.pool` admits `options` | leave deferred |
| 40 | TONES/ONBOARDING_STEPS duplicate check literals | leave deferred |
| 47 | 0002 EXCEPTION branch silent | leave deferred — the production grant path was verified to work (below); a `RAISE WARNING` is still a one-liner |
| 48 | "creates both runtime roles" passes trivially | leave deferred (see M12) |
| 58 | test name overstates ordering | leave deferred |
| 59 | post-`withPlatform` `current_user` check | leave deferred — verified empirically here (`SET LOCAL ROLE` reverts to `aesa_app` after COMMIT on the same connection); still a 3-line test worth adding when someone is in the file |
| 60 | nested `tx.transaction()` loses `.orgId` | leave deferred |
| 67 | Secret ctor / `oauth_nonce` tests | leave deferred |
| 73 | `wrapDek` non-null assertion | leave deferred (`loadKekRing` guarantees the key) |
| 74 | no zeroization | leave deferred |
| 87 | `provisionOrgKeys` check-then-insert race | leave deferred — the PK is the real guard and the failure mode is safe (the second insert aborts before the `workspaces` update runs); only the error text differs |
| 88 | duplicate latest-row query | leave deferred |
| 96 | ssrf test never closes its Agent | **superseded by I1–I3** — the test is tautological and must be replaced, not tidied |
| 108 | redundant `\s+` join | leave deferred |
| 130 | zod unused in queue | resolved (Task 12 uses it) |
| 142 | no invalid-payload / batchSize>1 worker tests | leave deferred |
| 152 | dead header redact paths | leave deferred (M13) |
| 153 | uuid exclusion regex loose | leave deferred |
| 160 | `hasKek` blank-value boot crash | **promote → I8** (reproduced with the shipped `.env.example`) |
| 161 | `logLevel` unused | leave deferred (M11) |
| 168 | plan prose vs code block | leave deferred |
| 175 | drift-script cleanup, no pnpm cache | leave deferred |

## Rulings challenged

None. Specifically:
- **Line 34 (startup `options` instead of `SET ROLE`)** — verified stronger than the plan text: `RESET ROLE` cannot escape it, and the timeouts are present per connection.
- **Line 53 (`WITH INHERIT FALSE`)** — correct and necessary; also verified that on the production path (a non-superuser `aesa_owner` LOGIN running migration 0001's `CREATE ROLE`), PG17 gives the creator `ADMIN` with `SET FALSE`, and migration 0002's guarded `GRANT … WITH INHERIT FALSE` adds a second membership with `SET TRUE`, after which `SET ROLE`/`SET LOCAL ROLE` succeed. So the guarded block is load-bearing in production, not just a no-op behind the init script.
- **Line 93 (dropped `::ffff:0:0/96`)** — verified: Node's `BlockList` normalises every v4-mapped spelling against the IPv4 rules, and the explicit branch handles the rest; nothing slips through.
- **Line 140 (batch fate-sharing)** — reasonable with `batchSize` defaulting to 1 and documented at both the option and the loop.

One **plan-level** gap that no ruling covers: the spec's "audit line per `withPlatform()` call" (I7) and `minio` in compose (M4) are unflagged deviations; the plan's self-review claims full Phase 0 coverage.

## Recommendations

1. Fix C1 and I8 on this branch before merge (both are a few lines with a test each).
2. Fix I1–I3 on this branch as one commit: `all`-aware lookup + `autoSelectFamily: false`, buffered body with a size cap, `destroy()` on the error path, and a socket-level test. Nothing consumes `pinnedFetch` yet, so this could technically follow as the first Phase 1 commit — but the claim in the plan/ledger that it is verified is currently false, and it is easier to fix while the author context is fresh.
3. Add the generic RLS invariant test (I6) now; it is the cheapest possible insurance for Phases 1–7 and it makes `TENANT_TABLES` disappear.
4. Decide I7 explicitly (implement or flag) and correct the README (I5) before Phase 1, because Phase 1 is where the api gets its first LOGIN-role production deployment story.
5. Collapse the duplicated margin constant (I4) and widen the lint gate (I9) before the tRPC context is designed — both become expensive once routes exist.
6. Carry the Minors into the Phase 1 plan's pre-flight; none block.

## Verification performed

All on the checkout at `763eff4` with Postgres already running on :5434; the working tree was not modified (`git status --porcelain` empty before and after).

```
pnpm typecheck        → exit 0 (all 6 packages)
pnpm lint             → exit 0
pnpm test             → exit 0 — 116 tests: core 30, crypto 31, queue 14, db 31, api 6, worker 4 (24 files)
pnpm db:check         → exit 0 — "No schema changes, nothing to migrate" / "migrations in sync with schema"
git status --porcelain → empty after db:check
git log --format='%(trailers:key=Co-Authored-By)' 73a0936..763eff4 → trailer present on all 25 commits
jq del(.id,.prevId) diff 0001_snapshot.json 0002_snapshot.json → identical apart from key order (0002 is a pure custom migration)
diff plan-text vs packages/crypto/test/ssrf.test.ts and src/ssrf/pinned-fetch.ts → both verbatim from the plan
```

Empirical probes (scratch scripts run with the repo's own `tsx`/`pg`/`undici`; scratch roles created with a random suffix and dropped afterwards):

- **Node 22.23.2, shipped `buildPinnedDispatcher('127.0.0.1', 4)` → local http server:** `fetch failed <- TypeError: Invalid IP address: undefined`. Same lookup with `autoSelectFamily: false`: 200, body 5 B. `all`-aware lookup with `close()` before body read: 5 B ok, 16 KB ok, 64 KB hung 4000 ms (my `AbortSignal.timeout`) then body read failed, 1 MB same; 302 rejected promptly. (I1–I3)
- **`isBlockedAddress`:** `::ffff:127.0.0.1`, `::FFFF:10.0.0.1`, `0:0:0:0:0:ffff:127.0.0.1`, `::ffff:7f00:1`, the fully expanded hex form, `255.255.255.255` → blocked; `::ffff:8.8.8.8`, `0:0:0:0:0:ffff:8.8.8.8` → allowed; `64:ff9b::7f00:1`, `2002:7f00:1::`, `192.0.2.1` → allowed. (Ruling 93 confirmed; M3)
- **Postgres, connection with `-c role=aesa_app -c idle_in_transaction_session_timeout=5s -c statement_timeout=30s`:** `current_user=aesa_app, session_user=aesa`; `RESET ROLE` → still `aesa_app`; `SET ROLE aesa_platform` → succeeds; `SET ROLE aesa` → succeeds, `rolsuper=true` (local escape; I5); `BEGIN; SET LOCAL ROLE aesa_platform; … COMMIT` → `current_user` back to `aesa_app`, `app.org_id=''` (ledger 59 property holds); timeouts `5s`/`30s` present.
- **Postgres, non-superuser `zz_owner LOGIN CREATEROLE` creating `zz_app`/`zz_plat`:** membership after CREATE = `admin=true, inherit=false, set=false` → `SET ROLE zz_app` denied (42501); after the 0002-style `GRANT … TO CURRENT_USER WITH INHERIT FALSE` → second membership `admin=false, inherit=false, set=true` → `SET ROLE` and `SET LOCAL ROLE` succeed. (Ruling 53 / migration 0002 production path confirmed.)
- **`buildServer` + a route throwing `DrizzleQueryError(sql, ['tok_SUPER_SECRET_SESSION_TOKEN'], cause)`:** 500 body and the pino error line both contain the parameter verbatim; the URL query value was redacted correctly. (C1)
- **`loadConfig({ DATABASE_URL, AESA_KEK_V1: '', AESA_KEK_ACTIVE: '1' })` (the `.env.example` shape):** throws `AESA_KEK_ACTIVE must name a configured AESA_KEK_V<n>`. (I8)

## Assessment

**Ready to merge?** With fixes

**Reasoning:** The tenancy rails — forced RLS, the NULLIF predicate, `withOrg`/`withPlatform`, the startup-option role switch, owner `INHERIT FALSE` — are correct and proven against real Postgres, and nothing in Phases 1–7 will need to undo them. Two things must be corrected before Phase 1 builds on the skeleton: the api's default error path returns and logs SQL parameters (C1), and `pinnedFetch` is non-functional on Node 22 behind a tautological test (I1–I3) — both cheap to fix now, and both originate in plan text rather than in implementer error.
