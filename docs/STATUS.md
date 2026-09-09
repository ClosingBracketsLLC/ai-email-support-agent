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

### Phase 1 — accounts and the app shell (complete on branch `phase-1`; not yet merged)

- Plan: `docs/superpowers/plans/2026-09-08-phase-1-accounts-and-app-shell.md` (14 tasks, executed
  with subagent-driven development). Commits `ba7bde5..f3f8e71` (28 commits) on `phase-1`, branched
  from `main` at `ab07316`, followed by this documentation commit. Gate on the branch: typecheck
  and lint clean across all 8 packages/apps; `pnpm test` green with 221 tests (`@aesa/contracts` 8,
  `@aesa/core` 30, `@aesa/crypto` 40, `@aesa/db` 33, `@aesa/queue` 14, `apps/api` 47, `apps/worker`
  6, `apps/app` 43 across 13 jest suites — no database); `db:check` reports no drift; the Expo web
  export produces 17 static routes (`/privacy` and `/terms` now included); the Playwright signup
  smoke passes. Robert decides how and when `phase-1` lands on `main`
  (`superpowers:finishing-a-development-branch`) — never push, merge or open a PR without him.
- What exists now: `@aesa/contracts` (zod inputs and enums shared by api, db and app); the Better
  Auth tables plus `notification_devices`; `audit()`; Better Auth + tRPC mounted in the api; the
  Expo app (`apps/app`) with sign-in (email one-time code, optional Google/Microsoft), the
  resumable four-step onboarding scaffold, the responsive shell, a Settings skeleton, team invites
  and roles, push registration, a Playwright signup smoke, and a CI web export.
- Deviations from the plan (full text in the plan header):
  1. Business name is asked on the create-workspace screen, not sign-in, so a returning owner or an
     invited teammate never sees a business-name field.
  2. Org data keys are not provisioned at workspace creation — the api enqueues nothing;
     `workspaces.box_public_key` stays NULL through Phase 1, and Phase 2 provisions keys in the
     worker before the first mailbox credential is written.
  3. Microsoft sign-in requests `openid profile email` only (no `User.Read`; Better Auth reads the
     profile from the id token); Google keeps its default `openid email profile` scopes with no
     offline access.
  4. Roles are Better Auth's defaults (owner/admin/member); no custom access-control statements yet.
  5. Screen tests are minimal; the Playwright signup smoke and the Expo web export are the app's
     real gates, per the spec's Phase 1 verification.
  6. EAS dev builds, EAS Hosting deploys, store/consent-screen verifications and the Resend domain
     are Robert's manual steps — this task's runbook (`docs/runbooks/2026-09-phase-1-external-setup.md`).
  7. The sign-in screen offers Google/Microsoft buttons only when `GET /meta` reports those
     providers configured, so local development works with OTP alone.
- Execution-time rulings recorded during the build, by area:
  - **auth/api**: `trustedOrigins`/`AUTH_TRUSTED_ORIGINS` are normalized once and trailing-slash
    stripped, so a slash in an env var can't silently reject browser requests; `advanced.disableOriginCheck`
    is forced `false` (Better Auth otherwise skips its origin/CSRF check whenever `NODE_ENV=test`);
    Better Auth's logger is routed through the api's pino logger with the same redaction as the
    request path (`apps/api/src/logging.ts`), so a bound session token or a SQL parameter tail
    can't reach stdout on an adapter failure; `TRUST_PROXY` is required at boot in production when
    `AUTH_RATE_LIMIT=on` (Better Auth keys its limiter on `x-forwarded-for` and otherwise buckets
    every client together); `UTC` was added to the supported-timezone set (Node's
    `Intl.supportedValuesOf('timeZone')` omits the alias some devices report).
  - **app gate**: `useGate` gained a distinct `error` target with a Retry screen after three plan
    defects surfaced — a failed org activation re-fired on every render, an unclassified
    `workspace.get` error spun forever, and a deep-link path read in a layout's render body (not an
    effect) was dropped by Strict Mode's double render. A fresh sign-in has no active organization
    until `createOrganization`/`setActive` runs, so "activate the user's first membership" lives in
    the app's gate, not the api. The same in-flight guard was then applied to every onboarding
    submit (create-workspace, sign-in, verify, `ProfileForm`) once Enter-key submits and rapid taps
    were found to bypass the `Button` component's own loading guard. `ProfileForm` specifically
    re-seeds its local state from a `workspace.get` refetch only while the form is pristine (no edit
    since mount), clears that `dirty` flag only once the invalidation's refetch has actually landed
    and only if the form's edit-version is unchanged (so a save typed mid-refetch is never silently
    discarded), and its own save press is pending-guarded the same way. The Playwright smoke later
    surfaced a fourth defect: after sign-out, an in-flight `workspace.get` could still resolve to its
    cached error, so `useGate`'s error branch now fires only while `session && active` — a
    signed-out user lands back on sign-in instead of being stranded on "Could not load your
    workspace."
  - **shell**: `ResponsiveShell` renders one element tree with the sidebar conditional inside it, so
    crossing the responsive breakpoint no longer remounts (and resets) the tab navigator; the
    sidebar's `Link asChild` crashed on first real-browser mount
    (`Failed to set an indexed property on 'CSSStyleDeclaration'`) and was replaced with a plain
    `Pressable` calling `useRouter().push`; every team/settings mutation press now guards on the
    mutation's pending state, the same rule already applied to the onboarding forms.
  - **invitation**: `team.cancelInvitation` is scoped to the caller's active organization (Better
    Auth's own endpoint authorizes against the invitation's org, not the caller's, so a manager of
    two workspaces could otherwise cancel the wrong one's invite); the invite screen shows a
    distinct "this invitation is for a different email address" state, matched only on Better
    Auth's recipient-mismatch signal — not on any 403 — so the organization-membership-limit error
    and email-verification errors keep their own generic states instead of being misread as a wrong
    account.
  - **push**: `push.ts` keeps its static `import * as Notifications from 'expo-notifications'` — the
    brief's own test mock, not the production module, was the actual defect (a `jest.mock` factory
    that closed over a test-file `const` returned `undefined` on the hoisted import); fixed with a
    self-contained mock factory instead, so the repo keeps zero `eslint-disable` comments. The
    Notifications screen's mount-time `registerForPush({ ask: false })` and `enable()` now catch
    failures instead of leaving an unhandled rejection, and `enable()` has a local busy guard against
    a double tap during the await window.
  - **CI**: the Playwright reporter is `[['github'], ['html', { open: 'never' }]]` — `'github'`
    alone writes no `playwright-report/`, so the failure-artifact upload step was a silent no-op. The
    smoke itself surfaced two real app defects that no unit test caught during Phase 1 — the
    sidebar's `Link asChild` crash and `useGate`'s post-sign-out stranding, both above — which is why
    it is a hard gate rather than a nice-to-have.

## Next: Phase 2 — mailboxes, agents, ingest, triage

Start with `superpowers:writing-plans` against the spec's *Build phases → Phase 2* section. Scope
from the spec: `packages/mail` (port, Gmail + Microsoft Graph adapters, credentials with lease
refresh, rfc2822/address/body/threading ports, sync, mock, limiter), `packages/test-kit`
(MockMailbox, scrubbed fixture recorder, conformance suite), `packages/llm` core + Anthropic adapter
(triage role) + FakeProvider, `packages/agent/triage.ts`; tables `oauth_flows`,
`mailbox_connections`, `mailbox_credentials`, `agents`, `categories`, `agent_category_policies`,
`tickets`, `messages`, `webhook_events`, `notifications`; the mailbox connect flow (claim step,
address selection, alias round-trip verification, admin-consent and Gmail early-access branches);
jobs `mailbox.sync`, `mailbox.poll-sweep`, `mailbox.renew-watch`, `ticket.triage`, `notify.dispatch`,
`notify.digest`, health rollup; screens for connect mailbox + health, agents (presets, persona text,
reply-from choice), the read-only inbox (To review / Auto-sending / Recent) and ticket thread;
escalation push.

Verify (from the spec): the mock-tier E2E ported from the reference implementation (inbound →
ticket; re-poll zero side effects; reopen only for DMARC-pass; cursor-expired bounded resync; no
reopen storm); the conformance suite green on mock and fixtures for both providers; live, a Gmail
test user and an M365 sandbox each show a triaged ticket in under 60 s via push.

Rulings the planner needs:

- The `SECURITY DEFINER` resolvers deferred from Phase 0 (`resolve_mailbox_connection(provider, email)`,
  `resolve_subscription(id)`, `resolve_stripe_customer(id)`) land here — they stay the api's only
  cross-org read path; the api still never holds `aesa_platform`.
- `mailbox_credentials` holds sealed-then-DEK-encrypted refresh/access tokens; grant column access
  to the worker role only via an explicit `REVOKE`, the same pattern a worker-only table already
  needs against migration 0002's default `aesa_app` DML grants.
- Org data keys are not provisioned yet (Phase 1 deviation 2): the worker must call
  `provisionOrgKeys` before the first mailbox credential is written for an org — not the api at
  workspace creation.
- Start the CASA Tier 2 submission alongside this phase's build; the spec expects the evidence this
  design produces to accompany it, and the review is a 4–12 week process independent of the code.

### Phase 2 pre-flight carry-overs

Findings deferred during Phase 1 (from the task-review ledger and the still-open Phase 0 items).
Fix each in the first Phase 2 task that touches the file, or record why it moves again.

- `@aesa/contracts`: Task 1's own implementation report describes its RED-phase evidence as a
  paraphrase rather than a captured test-failure transcript — a reporting-hygiene note with no code
  impact.
- `@aesa/db`: `organization.slug` still has both `.unique()` and a `uniqueIndex('organization_slug_uidx')`
  (copied verbatim from Better Auth's CLI output) — dropping the redundant one needs a new
  migration; `audit()` has no test for the default `detail`/`ip`/`userAgent` values or a boundary
  `user:` actor; `packages/db/test/keys.test.ts` cases are still order-dependent; `platform.access`
  audit rows still have no retention rule (the heartbeat alone adds ~1,440 rows a day); an earlier
  task report miscounted the RLS invariant's coverage as 8 tenant tables where the code and test
  correctly cover 6 (14 total minus 8 `RLS_EXEMPT`) — a reporting-hygiene note, not a code defect.
- `@aesa/crypto`: `packages/crypto/src/ssrf/pinned-fetch.ts` still rewrites `content-length` to the
  buffer size, turning a `HEAD` response's length into 0 — Phase 2's mailbox adapters are the first
  consumer that could notice.
- `apps/worker` / `@aesa/queue`: the worker still has no structured logger (`LOG_LEVEL` is parsed
  and unused); `defineJob` still retries a payload that fails zod validation instead of failing
  fast — fix both in the first Phase 2 task that opens `apps/worker`.
- CI/infra: CI still never runs the tenant suite through a non-superuser LOGIN role, so the
  production privilege boundary is documented but not exercised — `mailbox_credentials`'
  worker-only grants make this load-bearing, so do it in Phase 2; `apps/app/playwright.config.ts`
  spells out `expo serve --port 8081` instead of reusing the `serve:web` script.
- `apps/api`: `.env.example` sets `EMAIL_TRANSPORT=devsink` even though that is the non-production
  default (a deliberate documentation choice from the plan, not a defect, but worth a comment
  before someone copies it into a deploy config); better-auth 1.7.3 declares a peer of
  `drizzle-orm ^0.45.2` against the workspace's pinned `^0.44.0` (pnpm warns only) — bump both
  together in a dedicated task since drizzle snapshots may shift; `AUTH_TRUSTED_ORIGINS` entries
  aren't validated as http(s)/scheme URLs; Better Auth's in-memory rate limiter is per replica —
  move to `rateLimit.storage: 'database'` or secondary storage before the api scales past one
  instance; the error handler's `err.headers` copy only handles the plain-object `HeadersInit`
  shape, not a real `Headers` instance; no test posts an empty or malformed JSON body to the auth
  route, and the custom content-type parser also drops Fastify's `FST_ERR_CTP_INVALID_JSON` code on
  malformed JSON (the manually thrown `Error` carries no `.code`); the team self-removal guard and
  the admin/member role restriction have no tests; `devices.register` cannot clear a previously set
  `deviceName` (an empty string is treated as omitted); the `export type { ServerDeps }` re-export
  in `server.ts` has no consumer; the `ServerDeps` facade is a convention, not an enforcement —
  Better Auth's own adapter (`auth.$context`/`auth.options.database`) still closes over the raw
  `Db` handle; `createOrganizationWithFreshSlug`'s `throw` after the slug-retry loop is unreachable
  (the 5th collision rethrows inside the `catch`); `auth.test.ts`'s console spies are restored
  outside a `try`/`finally`.
- `apps/app`: `team.remove` does not clear the removed user's `activeOrganizationId` in an open
  session on another device (the gate handles it as FORBIDDEN → create-workspace; a friendlier
  "you were removed" state is UX polish); the app still ships placeholder art; `ListRow`'s
  `accessibilityLabel` omits subtitle/badge, `TextField`'s error/hint text isn't associated with
  the input, and `Loading`'s `ActivityIndicator` has no `accessibilityLabel`; `verify.tsx` with no
  `email` param renders "code to ." and would submit an empty email instead of redirecting to
  sign-in; `(auth)/_layout` casts the deep-link path `as never` for typed routes, and that fix is
  verified only by inspection (jest-expo does not exercise Strict Mode's double invocation);
  TanStack Query's focus/online managers aren't wired to `AppState`/`NetInfo` on native (no
  `refetchOnReconnect`); double-submit protection on sign-in/verify relies on `Button`'s `loading`
  disabling presses (true today, per Task 8's test, but not independently tested here); `use-gate.ts`
  computes a redundant `'missing' | undefined` classification that's discarded whenever the error is
  real; `useAdvance` can fire a harmless duplicate navigation after `invalidateQueries` races
  `[step].tsx`'s own mismatch redirect; `ProfileForm` validation and `create-workspace`'s
  conditional name field have no unit tests beyond the Stepper test (the Playwright smoke covers
  the flow); the state-based `isPending`/`busy` guards leave a sub-macrotask window (TanStack Query
  notifies via `setTimeout(0)`) that a synchronous `useRef` flag would close; `sign-in.tsx`/
  `verify.tsx` have no unit tests for their `busy` guards; the team screen has no back-out from a
  primed "Confirm remove", the invite role radios lack a `radiogroup` container, and a failed
  `team.list` spins forever with no retry; the sign-out case in `use-gate.test.tsx` also flips the
  `organizations` mock, which is inert once the session is null (test tidiness only); an
  intermittent `act()` console error was seen once in six runs of `use-gate.test.tsx` (a flake to
  pin down); `push.ts`'s Android-notification-channel branch and the registration hook/screen
  remain untested beyond the two cases the brief specified.

## Later phases (see the spec for scope and verification)

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

The external-setup runbook (`docs/runbooks/2026-09-phase-1-external-setup.md`) lists everything
Phase 1 needs that CI cannot do: the Better Auth secret and production env, the Google and
Microsoft OAuth consent-screen/publisher-verification steps, the Resend sending domain, and the
EAS project/dev-build/hosting setup.
