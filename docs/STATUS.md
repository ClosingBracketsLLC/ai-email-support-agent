# Project status

Updated 2026-09-12. The spec (`docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md`)
defines Phase 0 (rails and tenancy) plus seven build phases, Phases 1–7; this file records where the
build stands against them. As of 2026-09-12: Phases 0–5 and the brand are on `main` (Phase 4 via PR #5,
merge commit `ef81169`; Phase 5 via PR #6, merge commit `99a852d`). **Phase 6 (provider choice / BYOK)
is COMPLETE on branch `phase-6`** — gate green, whole-branch review done and its fix wave landed — and
lands on `main` through a GitHub PR merged with a merge commit, on Robert's go-ahead. Only Phase 7
(billing, caps, launch hardening) remains, starting at `superpowers:writing-plans` from the spec's
*Build phases → Phase 7* paragraph.

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

### Phase 1 — accounts and the app shell (complete; merged into `main` via PR #1 on 2026-09-09)

- Plan: `docs/superpowers/plans/2026-09-08-phase-1-accounts-and-app-shell.md` (14 tasks, executed
  with subagent-driven development). Commits `ba7bde5..aac485c` on `phase-1`, branched from `main`
  at `ab07316`: the plan, 14 task commits with their fix rounds, two documentation commits, and the
  7-commit final fix wave `b0ff5d2..aac485c`, followed by the commit that added the review record.
  Gate on the branch after the fix wave: typecheck and lint clean across all 8 packages/apps;
  `pnpm test` green with 234 tests (`@aesa/contracts` 8, `@aesa/core` 30, `@aesa/crypto` 40,
  `@aesa/db` 33, `@aesa/queue` 14, `apps/api` 60, `apps/worker` 6, `apps/app` 43 across 13 jest
  suites — no database); `db:check` reports no drift; the Expo web export produces 17 static routes
  (`/privacy` and `/terms` included); the Playwright signup smoke passes. Merged into `main` by
  merge commit `1a8ccec` (PR #1, Robert's 2026-09-09 instruction); the `phase-1` branch was deleted.
  All branch SHAs cited here remain reachable from `main`.
- Review: `docs/superpowers/reviews/2026-09-08-phase-1-final-review.md` — the whole-branch review
  (verdict "with fixes": one Critical, the `/trpc` error surface returning raw messages and stacks;
  five Important: no `/trpc` rate limit, `withPlatform` on the api facade, the untested CSRF guard,
  `TRUST_PROXY` missing from the runbook, extra web origins half-wired), what the fix wave changed,
  the scoped re-review that confirmed it, and the four residual minors parked with rulings (listed
  under the Phase 2 carry-overs below).
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

### Phase 2 — mailboxes, agents, ingest, triage (complete; merged into `main` via PR #2 on 2026-09-09)

- Plan: `docs/superpowers/plans/2026-09-08-phase-2-mailboxes-ingest-triage.md` (23 tasks, executed
  with subagent-driven development). Commits `f5210cc..48c656c` plus this merge-record commit on
  `phase-2`, branched from `phase-1` at `1b0fc34` (Phase 1 unmerged at branch time; both phases
  merged 2026-09-09 on Robert's instruction): the plan, 23 task commits with their fix rounds, the
  E2E suite/external-setup runbook/status commit (`abedbc1`), a package-count/docstring fix
  (`024cf80`), the whole-branch final-review fix wave (`0015a74` — one Critical plan defect plus 4
  Important and 1 promoted-minor finding; see the residuals addendum below) with its docs commit
  (`e00a339`), and the review-record commit (`48c656c`). The per-task execution ledger and fix-wave
  report were ephemeral SDD workspace artifacts, deleted after the review record was committed (per
  `superpowers:subagent-driven-development`); the review record and git history are the durable
  account, and everything load-bearing from the ledger is distilled below. Gate on the
  branch after the fix wave: typecheck and lint clean across all 12 packages/apps; `pnpm test` green
  with **816 tests** (`@aesa/contracts` 12, `@aesa/core` 30, `@aesa/crypto` 42, `@aesa/agent` 9,
  `@aesa/llm` 26, `@aesa/db` 46, `@aesa/queue` 15, `@aesa/mail` 227, `@aesa/test-kit` 43 [39 run + 4
  conditional skips], `apps/api` 135, `apps/worker` 124 [including the 8-scenario
  `e2e-phase2.test.ts`], `apps/app` 107 jest — no database); `db:check` reports no drift; the Expo
  web export produces 21 static routes; the Playwright signup smoke passes (ends at the gated
  mailbox step, per Task 20's ruling below — the spec does not mark that step skippable
  providerless). Merged into `main` by merge commit for PR #2 (Robert's 2026-09-09 instruction,
  immediately after PR #1); the `phase-2` branch was deleted. Standing rule from that instruction:
  **every phase branch lands on `main` through a GitHub PR with a merge commit** (SHAs stay
  reachable), from here on.
- Review: `docs/superpowers/reviews/2026-09-09-phase-2-final-review.md` (committed at `48c656c`) —
  the whole-branch verdict ("with fixes"), the fix wave that resolved its findings — one Critical
  plan defect (C1) and four Important (I2–I5) plus one promoted minor, all fixed in `0015a74` and
  verified by a scoped re-review — the deferred-minors triage, and the Phase 3 carries.
- What exists now: `@aesa/mail` (the provider-agnostic mailbox port — Gmail + Microsoft Graph
  adapters, credential lease/refresh, rfc2822/address/body/threading ports, the sync walk,
  `MockMailbox`, the send limiter); `@aesa/test-kit` (fixture recorder + conformance suite);
  `@aesa/llm` (chat port, Anthropic adapter, `FakeProvider`); `@aesa/agent` (the triage prompt + one
  model call); the eleven new tables (`oauth_flows`, `mailbox_connections`, `mailbox_credentials`,
  `agents`, `categories`, `agent_category_policies`, `tickets`, `messages`, `webhook_events`,
  `notifications`, `gmail_access_requests`); the mailbox connect flow (claim step, address
  selection, alias round-trip verification, admin-consent and Gmail early-access branches); worker
  jobs `mailbox.sync`, `mailbox.poll-sweep`, `mailbox.renew-watch`, `mailbox.store-credentials`,
  `mailbox.revoke`, `ticket.triage`, `notify.dispatch`, `notify.digest`; app screens for connect
  mailbox + health, agents (presets, persona text, reply-from choice), the read-only inbox (To
  review / Auto-sending / Recent) and ticket thread, escalation push; CASA Tier 2 submission started
  (runbook, `docs/runbooks/2026-09-phase-2-external-setup.md`).
- Deviations from the spec's Phase 2 list, all recorded in the plan header:
  1. `resolve_stripe_customer(id)` does not land here — it needs Phase 7's `billing_subscriptions`
     table. Phase 2 lands `resolve_mailbox_connection(provider, email)` and
     `resolve_mailbox_subscription(subscription_id)` only.
  2. `mailbox_credentials` is platform-role-only; the api never touches the table (no third DB
     role). The api seals the token set to the org's box public key at the OAuth callback and hands
     the sealed blob to the worker in a `mailbox.store-credentials` job payload; the worker writes
     the row and re-wraps under the org DEK on first open.
  3. `MockMailbox` lives in `packages/mail/src/mock.ts`, not `packages/test-kit` (avoids a
     dependency cycle); `@aesa/test-kit` holds the conformance suite and fixture recorder, and
     re-exports the mock.
  4. The Anthropic adapter uses forced-tool structured output (doge-buddy's proven mechanism), not
     `messages.parse`/`zodOutputFormat`; the full fallback ladder arrives with Phase 3's draft role.
  5. Phase 2's `packages/llm` slice omits the limiter, registry, probe, pricing, metering wrapper
     and streaming (Phase 3/6 per the spec's own phase list); the triage runtime writes its own
     fail-closed spend-guard row into `usage_counters` before each call.
  6. `notify.digest` collapses into a push, not an email, in Phase 2 — the email channel joins in
     Phase 3, once the review pages exist for it to link to.
  7. The reference's repeat-complainant escalation and order-number linking are not ported (no
     commerce in v1; the per-sender flood fold covers volume abuse instead).
  8. Live verification is Robert's runbook step (`docs/runbooks/2026-09-phase-2-external-setup.md`)
     — CI proves the mock tier and (once recorded) the fixture tier only.
  9. `sync.ts` lives in `packages/mail` and takes `OrgTx`-scoped store functions — `@aesa/mail`
     depends on `@aesa/db` (the ESLint gate only bans raw `pg`/`drizzle-orm/node-postgres` handles,
     not `@aesa/db` itself); the walk never opens a transaction around network I/O.
  10. Triage stores `questions[]` on the ticket (`tickets.triage_questions text[]`) so Phase 3's
      pre-retrieval can read them.
  11. Org data keys are provisioned by a `keys.provision` job the api enqueues from
      `mailboxes.startConnect`, which returns `PRECONDITION_FAILED` until the key exists and the app
      retries briefly — only the worker ever holds the KEK.
  12. Gmail scopes are `gmail.readonly` + `gmail.send` only — no label machinery, since the product
      never mutates the mailbox.
  13. Agent statuses are `pending_verification | active | disabled`; a primary-address agent
      activates immediately, an alias activates on the sync walk's verification-code round trip.
- Execution-time rulings recorded during the build, by area (full detail in the ledger cited above):
  - **db (Task 3)**: the resolver functions are `OWNER TO aesa_platform` with `PUBLIC` `EXECUTE`
    revoked and re-granted in the correct ACL order (the initial migration's REVOKE/GRANT was a
    no-op against a function it didn't yet own — reviewer-caught, fixed same task); `oauth_flows`'
    status CHECK gained the `'expired'` value the poll-sweep needs.
  - **mail (Task 6)**: the DMARC parser ports the reference's clause-anchored `dmarcPasses`
    semantics (splitting on `;` before matching `dmarc=pass`), not the plan's lossy
    `/dmarc=pass\b/i` regex — the plan's version is bypassable by a quoted-local-part forgery
    (`"x;dmarc=pass"@evil`) the reference's mechanism defeats.
  - **mail (Task 7)**: `findSentByMarker`'s scan contract, pinned for both the mock and the real
    adapters: scan up to `scanLimit` candidates newest-first; a match returns its id; no match with
    older candidates still unexamined throws `MailApiError` 429 (refuse to guess — a wrong `null`
    risks a duplicate send); no match with the scan exhausted returns `null`.
  - **mail (Task 11)**: the sync walk drops (no insert, no ticket) any inbound whose `From` is the
    platform's own `MAIL_FROM` — platform mail must never become a customer ticket. Accepted
    trade-off: this drop carries no DMARC gate, so a forged platform-`From` message is silently
    dropped too; a DMARC-gated variant would re-open the exact noise-ticket hole this closes for our
    own mail on a day it fails DMARC. Flood fold: the count is org-wide (protects the owner's
    attention as a whole) but the fold TARGET is connection-scoped (a ticket's thread belongs to one
    connection; folding a message from another connection would leave it unreplyable).
  - **worker (Task 14)**: the escalation notification's dedupe key is
    `escalation:${ticketId}:${utcDay}`, not a lifetime key — a lifetime key would let the first
    escalation ever sent for a ticket permanently win the dedupe index, silently swallowing every
    later re-escalation (a resolve-then-reopen-then-anger cycle) forever.
  - **worker (Task 15)**: the triage-cap re-entry never resets a ticket's status directly
    (`needs_owner → new` is not a legal edge in `@aesa/core`'s transition matrix, superseding the
    implementer's draft, which did). Instead `ticket.triage`'s own selection (Task 14) extends to
    `needs_owner`/`triage_cap`, and the verdict write lands through the legal
    `needs_owner → triaged/resolved` edges — the poll-sweep only ever enqueues, never mutates status.
  - **api (Task 17)**: the connect flow's `/start` route no longer forwards a caller-supplied PKCE
    challenge; it generates and owns the challenge itself server-side (the original shape let an
    unauthenticated caller inject one, opening a bounce/replay angle the fix closed).
  - **api (Task 19)**: the consent gate is hardened so a verification code is issued only once
    `consent_required_from_user_id IS NULL` — a gated alias never gets a code at `addAddress` time
    regardless of the UI state, `consentAddress`'s approve path issues a fresh code afterward, and
    the sync walk's verification interception independently skips any agent still gated as defense
    in depth. The inbox list's keyset cursor orders and pages on
    `COALESCE(last_inbound_at, created_at) DESC` so a ticket that has never received a reply is
    never excluded once any cursor exists.
  - **app (Task 20)**: the Playwright signup smoke's gate stops at the mailbox-connect step (assert
    the connect UI renders and the gate holds) rather than skipping past it — the spec never marks
    that onboarding step optional, so a providerless CI environment proves the gate exists rather
    than routing around it.
  - **worker/app (Tasks 16, 22)**: every push payload's `data` is stamped with a `kind` field by the
    worker (both `notify.dispatch` and `notify.digest`) so the app's tap-routing reads `data.kind`
    directly instead of inferring the notification's kind from which payload field happens to be
    present — the ambiguous `{ticketId, connectionId}` shape a bare escalation push carries had no
    reliable inference otherwise.
- Deferred-minors summary: dozens of minor findings were raised and either fixed in a task's own fix
  round or deliberately parked — the full per-task list lives in the execution ledger cited above and
  will be triaged into a residuals list in the forthcoming final review record
  (`docs/superpowers/reviews/2026-09-09-phase-2-final-review.md`). Nothing parked is believed to
  block the mock-tier gate or the live verification walk.
- **Final fix-wave residuals addendum** (`0015a74`, after the whole-branch review closed): the
  review's one Critical plan defect and four Important findings are fixed — C1 (mailbox.poll-sweep's
  sub-sweep (b) keyed claim-expiry on `created_at`, which a same-org reconnect never resets, so a
  reconnected row was deletable immediately, and deleting a row that already has tickets aborted the
  entire platform-wide sweep via `tickets`' `ON DELETE NO ACTION` FK — now keyed on `updated_at`, a
  ticketed row reverts to `reauth_required` instead of being deleted, and each row's handling runs in
  its own SAVEPOINT so one row can never abort the sub-sweeps around it); I2 (the settings Mailboxes
  screen hid `ConnectMailboxCard` once any connection existed, so a reauth banner or claim-expired
  push had nowhere to send the owner — the card now always renders, retitled "Connect another
  mailbox"); I3 (no sync-level test for the spec's "draft churn zero rows" verify item — added to
  `packages/mail/test/sync.test.ts`); I4 (`mailbox.sync`'s `retryLimit`/`retryBackoff` was dead
  config since the handler never rethrows — removed); I5 (a `null` return from
  `enqueue(storeCredentials)` left a `pending_claim` connection with no credentials row and no way to
  recover — now reverted to `reauth_required` on a reconnect or deleted outright on a fresh connect,
  with the flow marked failed either way). One promoted minor also landed:
  `mailboxes.addAddress`'s uncaught `agents` unique-violation now surfaces as `CONFLICT` instead of a
  raw 500 (`isUniqueViolation` moved to a shared `apps/api/src/pg-error.ts`). Full detail lives in
  the fix-wave commits themselves (`0015a74`, `e00a339`) and the review record (the ephemeral
  fix-wave report was deleted with the SDD workspace). The review's own remaining findings — not
  must-fix for this wave — are
  carried into Phase 3 (DMARC first-match re-exam, claim-time notification email,
  `push_subscription_id` index, `use-gate` `setActive` regression test, malformed-cursor degraded
  marking) — all but the DMARC re-exam resolved there; see the Phase 3 record below.


### Carry-overs resolved during Phase 2

Findings deferred during Phase 1 (from the task-review ledger and the still-open Phase 0 items),
now folded into Phase 2's own tasks: `pnpm dedupe` + re-export + smoke, `pinned-fetch.ts`'s HEAD
`content-length` rewrite, the worker's structured logger, and `defineJob`'s zod-invalid-payload
fail-fast all landed in Task 1; the duplicate `organization.slug` unique index and the non-superuser
LOGIN role exercising the privilege boundary landed in Task 3; the Better Auth `APIError` → tRPC
code mapping (the `organizationLimit` masked-500) landed in Task 17; `session.cookieCache` landed
in Task 19. What did NOT fully resolve is carried forward below, under Phase 4's carry-overs.

<details>
<summary>Original Phase 1 carry-over text (superseded by the resolution note above; kept for
the record)</summary>

- Final-review residuals (parked with rulings in the review record): `pnpm-lock.yaml` grew by
  roughly 300 lines during the fix wave with a second Expo toolchain variant resolved against
  `typescript@5.9.3` next to the `6.0.3` one — run `pnpm dedupe`, re-export and re-run the smoke in
  Phase 2's first task; `organizationLimit: 5` counts memberships rather than creations (an invitee
  of five workspaces cannot create one) and the limit surfaces as the masked generic 500 — map
  Better Auth `APIError`s to tRPC client codes and revisit the cap; the per-org invite throttle
  records a slot before `createInvitation` succeeds and never evicts idle organizations; with
  `AUTH_RATE_LIMIT=off` and `TRUST_PROXY=false` in production the global limiter keys on the proxy's
  address (one bucket — the runbook's CIDR-list recommendation covers it). Also deferred from that
  review: a network failure after a successful `workspace.create` invites a second organization on
  retry (idempotency key or a "you already have a workspace" pre-check); a boot log line stating the
  resolved `env` and mail transport; the web sidebar lost its `<a href>` semantics with
  `router.push` (try `<Link href><View/></Link>` without `asChild`); a build-time assert that
  `EXPO_PUBLIC_API_URL` is set for production profiles; decide the cookie topology before the first
  deploy (`app.<domain>` + `api.<domain>` keeps `SameSite=Lax`; a cross-domain split needs
  `AUTH_CROSS_SITE_COOKIES=true` and, later, CHIPS/`Partitioned`); enable Better Auth's
  `session.cookieCache` once the inbox screens poll (`orgProcedure` costs two round trips per call).
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
  aren't validated as http(s)/scheme URLs; Better Auth's in-memory rate limiter, the api's own
  global `@fastify/rate-limit` (`config.rateLimit`/`API_RATE_LIMIT_PER_MINUTE`) and `team.invite`'s
  per-org throttle are all in-memory and therefore per replica — move to shared/database storage
  before the api scales past one instance; the error handler's `err.headers` copy only handles the
  plain-object `HeadersInit` shape, not a real `Headers` instance; no test posts an empty or
  malformed JSON body to the auth route, and the custom content-type parser also drops Fastify's
  `FST_ERR_CTP_INVALID_JSON` code on malformed JSON (the manually thrown `Error` carries no
  `.code`); `devices.register` cannot clear a previously set `deviceName` (an empty string is
  treated as omitted); the `export type { ServerDeps }` re-export in `server.ts` has no consumer;
  the `ServerDeps` facade (now `withOrg` only — Phase 1 final review, Important 3) is a convention,
  not an enforcement — Better Auth's own adapter (`auth.$context`/`auth.options.database`) still
  closes over the raw `Db` handle; hitting `organizationLimit` (a 6th workspace) surfaces to the
  client as a masked generic 500 rather than a friendly error, since Better Auth's raw `APIError`
  from `createOrganization` isn't translated to a specific `TRPCError` code; `auth.test.ts`'s
  console spies are restored outside a `try`/`finally`.
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

</details>


### Phase 3 — draft, review, send (complete; merged into `main` via PR #3 on 2026-09-11, carrying the brand)

- Plan: `docs/superpowers/plans/2026-09-09-phase-3-draft-review-send.md` (23 tasks, executed with
  subagent-driven development). Commits `acf1f4f..HEAD` on `phase-3`, branched from `main` at
  `a613a22` — the plan, the Phase 2 carry-over task, the 23 tasks' implementation and fix-round
  commits, the Task 23 close-out (the mock-tier E2E, the cache-hit recorder, the external-setup
  runbook and the docs), the two pre-final fixes that E2E surfaced (`883ecac`), the review-fix
  commit (`3c76a8a`) and the whole-branch fix wave's five commits (`176f717`, `b776159`, `2aebfde`,
  `0e444c6`, `0cf7c1c` — see the fix-wave paragraph at the end of this record) plus this docs
  commit. The per-task execution ledger and the fix-wave workspace were ephemeral SDD artifacts;
  everything load-bearing from them is distilled below, and the git history plus the review record
  are the durable account. Gate on the branch after the fix wave: typecheck and lint clean across
  all 13 packages/apps; `pnpm test` green with **1,641 tests** plus 4 conditional skips (`@aesa/contracts` 21,
  `@aesa/crypto` 42, `@aesa/platform-mail` 18, `@aesa/core` 204, `@aesa/llm` 98, `@aesa/agent` 65,
  `@aesa/db` 72, `@aesa/queue` 17, `@aesa/mail` 237, `@aesa/test-kit` 43 [39 run + 4 conditional
  skips], `apps/api` 210, `apps/worker` 357 [including the 8-scenario `e2e-phase2.test.ts` and
  `e2e-phase3.test.ts`, 21 cases covering the twenty scenarios of the spec's Phase 3 *Verify* list
  — scenario 6 is split into 6a and 6b], `apps/app` 261 jest across 33 suites — no database);
  `db:check` reports no drift; the Expo web export produces **21 static routes** (unchanged — Phase
  3 added no route file; `activity.tsx` already existed); the Playwright signup smoke passes (still
  ending at the gated mailbox step — providerless CI cannot reach go-live, per Phase 2's Task 20
  ruling).
- Review: `docs/superpowers/reviews/2026-09-10-phase-3-final-review.md` — the six-way whole-branch
  verdict ("approve with fixes": 0 Critical, 13 Important), the fix wave that resolved every
  Important finding, the deferred-minors triage and the Phase 4 carries. It is written after this
  docs commit, per `superpowers:subagent-driven-development`.
- What exists now:
  - `packages/contracts` — the draft/decision/reject/sandbox/activity contracts, twelve new
    `needs_owner` reasons, the `draft_review` notification kind, `APPROVE_UNDO_SECONDS` and
    `DRAFT_EXPIRE_DAYS`.
  - `packages/db` — six new tables (`drafts`, `draft_action_tokens`, `outbound_sends`, `agent_runs`,
    `agent_run_events`, `llm_calls`), the one-live-draft partial unique, the
    `resolve_draft_action_token(text)` SECURITY DEFINER resolver, `escalateTicket` (the single entry
    into `needs_owner`), `withOrgIdentity`, and the meter home (`LLM_METERS`, `SEND_METERS`,
    `SANDBOX_METERS`, `bumpMeter`, `createMeterSink`).
  - `packages/core` — the guardrails validator (eight screens over a per-tenant `WorkspacePolicy`,
    one implementation run at all three gates, over one policy built in one place —
    `@aesa/agent/policy`), `decide()` (the spec's autonomy order, with the `auto`
    branch written, table-tested and unreachable), the reject resolver, `clearRedraftCycle`,
    `appendSignature`, and the outbound-send/draft/agent-run transition matrices.
  - `packages/llm` — the structured-output fallback ladder, the per-model limiter, the metering
    wrapper, the code-seeded price table, `createManagedProvider`, and the Anthropic adapter's
    native structured output, `effort` and stability-driven `cache_control` placement.
  - `packages/agent` — the six prompt layers (platform hard rules → workspace profile → persona →
    knowledge → guidance → the thread as untrusted JSON lines), `DraftDecision`, `runDraftCall`, the
    usage accumulator, the run watchdog, the `Retriever` seam (`emptyRetriever` until Phase 4), and
    the pure second entry point `@aesa/agent/policy` (`buildReplyPolicy` / `personaFor` — the one
    construction of a tenant's `WorkspacePolicy`, reached by `ticket.draft`, `agent.sandbox` and
    `send.execute` through a one-line re-export shim at `apps/worker/src/drafting/policy.ts`, and
    directly by the api's approve gate; it pulls in `@aesa/core` and this package's own prompt-text
    modules and nothing else, which is what keeps the Anthropic SDK out of the api's module graph).
  - `packages/mail` — `SendReplyInput.onDraftCreated` on the port, the Graph two-phase send's
    `existingDraftId` re-entry, the mock's draft ledger and crash hooks, and `draft_id` on ingested
    sent copies.
  - `packages/platform-mail` — NEW: the `MailTransport` port (Resend + devsink) and the templates,
    lifted out of the api so the worker can send the digest email.
  - `apps/worker` — `ticket.draft` (the ported claim protocol: row-locked CAS on
    `last_agent_run_at`, three watermarks, stuck-run recovery, a failure ceiling, advisory-locked
    caps, the one automatic redraft, `decide()` and the outcome table), `send.execute` (marker
    recovery scan first; the kill levers re-read in the claim and applied there for a fresh
    `approved` draft, but deferred past that scan on a crash re-entry so a delivered reply is never
    reported as held; staleness on `thread_snapshot_at`, the atomic pre-send flip, the `Message-ID`
    read-back, one outbound row, the dead-letter),
    `agent.sandbox`, the crons `ticket.backstop-sweep` (five arms: missed/stuck draft runs, tickets
    stranded at the agent failure ceiling, stuck run rows, orphaned tickets, due sends — the pass
    reads `platform_state['killswitch.global']` once and skips the first arm, and only that arm,
    while it is set) and `sweeps.daily` (draft expiry, run-event and action-token retention), and
    the daily digest email with per-recipient single-use action tokens.
  - `apps/api` — the `drafts` router (approve, hold, resume, reject, mark viewed), the session-less
    `/a/:draftId?t=` review pages and `inbox`'s draft view/resolve over ONE service module — whose
    approve gate screens the owner's body through the same `@aesa/agent/policy` the draft and send
    gates use; a separate `activity` router reading its own aggregates; the master switch and
    go-live completion; and the sandbox start/get procedures.
  - `apps/app` — the review panel on the ticket screen (viewed-before-approve, inline Edit, the
    reject sheet with redraft-with-reason and "I'll handle it", the 15-second undo, `A`/`E`/`R` on
    web), the "On hold — …" and "Not sent — …" banners with their one "Back to review" button
    (`holdReasonLabel` / `sendFailureLabel` turn the send row's machine `last_error` into copy, and
    a raw `last_error` is never rendered), draft rows in To review, Review/Hold notification
    actions, the go-live test-email box and master switch, Activity v1 and the "Try it" sandbox
    card.
  - Verification: `apps/worker/test/e2e-phase3.test.ts` — the twenty scenarios of the spec's Phase 3
    *Verify* list in 21 cases (scenario 6 is split into 6a and 6b), driven
    through real pg-boss jobs and the real api draft service; `packages/llm/scripts/record-cache-hit.ts`
    — the live, hand-run recorder for the one fixture CI cannot fake; and
    `docs/runbooks/2026-09-phase-3-external-setup.md`.
- Deviations from the spec's Phase 3 list, all recorded in the plan header:
  1. **The `llm.probe` job and the capability registry's probe path move to Phase 6.** STATUS.md's carry lists "limiter, registry, probe, pricing"; the spec's own phase list puts `llm.probe` with BYOK in Phase 6. Phase 3 lands the limiter, the structured ladder, the metering wrapper, the pricing seed and `createManagedProvider` (the registry for the one managed provider); `capabilities(model)` is a preset table with no probe override until Phase 6.
  2. **No `model_pricing` table yet.** The spec lists it under Phase 6's tables. `llm_calls.cost_micros` is computed from the code seed in `packages/llm/src/pricing/seed.ts` (Anthropic list prices verified 2026-09-09: opus-5 $5/$25 per MTok, sonnet-5 $2/$10, haiku-4-5 $1/$5; cache reads 0.1×, cache writes 1.25× for 5-minute and 2× for 1-hour TTL); `llm_calls` has no `pricing_id` column until the table exists.
  3. **The `MeterSink` lives in `packages/db/src/metering.ts`** exactly as the spec says, importing only the `MeterSink` type from `@aesa/llm` (a new `@aesa/db → @aesa/llm` type-only edge; no cycle — `@aesa/llm` depends on `@aesa/crypto` alone).
  4. **Platform admission control is per-process, not an advisory-lock slot pool.** `ticket.draft` runs one job at a time per worker process (`batchSize: 1`, one `work` registration); the per-org gate (concurrency 2, the daily caps) is serialized under a transaction-scoped `pg_advisory_xact_lock(hashtext('draft-gate:' || org_id))`. The `pg_try_advisory_lock` slot pool sized to our Anthropic tier is Phase 7's caps hardening.
  5. **`memory.capture` is not enqueued** (Phase 5 owns `resolved_answers`). `send.execute` exposes an `onSent(orgId, ticketId, draftId)` seam that Phase 5 wires; Phase 3 passes a no-op.
  6. **`ai_handled_conversations` is metered at send, once per ticket per UTC month** via `tickets.ai_handled_month` (spec §Send); `review_sends` and `draft_runs` meters join it. Escalated-without-draft mail is never counted.
  7. **Confidence in Phase 3 is the model's self-assessment alone.** `drafts.confidence = model_confidence`; `confidence_breakdown` records the blocker booleans plus `{ model, memory: null, grounding: null, evidence: null }`. `decide()`'s auto branch is written and table-tested but unreachable: with `evidence === null` every `auto` category resolves to `review/below_threshold`. The chip shows the percent only; "would auto-send at N%" arrives with Phase 5's evidence score.
  8. **Triage keeps its `usage_counters` spend guard and writes no `agent_runs` row.** `agent_runs.kind` admits `'triage'` for Phase 6's dashboards, but only draft and sandbox runs create rows. Triage calls DO get `llm_calls` rows: the agent role wraps its one provider with the metering sink, so every model call the worker makes is metered.
  9. **`MailboxClient.getDraftState` is not added.** The Graph adapter's `sendReply({ existingDraftId })` re-entry already reads `isDraft` and returns without sending when the draft was sent; the port instead gains `SendReplyInput.onDraftCreated(providerDraftId)` — the Graph adapter calls it between `createReply` and the PATCH so the send job can persist `outbound_sends.provider_draft_id` BEFORE the send (the spec's "persist draft id" step is impossible with today's one-call adapter). Gmail ignores it.
  10. **`messages.draft_id` stays an FK-less uuid** (a real FK creates a `support.ts ↔ drafts.ts` module cycle). The sync walk now writes it from `X-Aesa-Draft` on outbound rows and the send job's outbound upsert sets it too.
  11. **The digest email is daily, not every five minutes.** `notify.digest` keeps its 5-minute push collapse; the email channel sends at most one email per org per local day (08:00 in the workspace's timezone, `notifications.digest_email` setting, default on) to every owner/admin, listing pending drafts and open escalations with per-recipient single-use `/a/:draftId?t=` links (Approve / Hold / Open in app). The spec's "email digest" wording never states a cadence; a 5-minute email would be spam.
  12. **The `draft_review` push carries Review and Hold, and Hold acts only on an approved-not-yet-sent draft** (the undo window now; auto-sends from Phase 5). A pending draft has nothing to hold — the matrix has no `pending → held` edge — so Hold on one just opens the ticket. The app registers the category at startup; the worker stamps `categoryId` on the push.
  13. **Web-only extras deferred:** the three-pane review layout, J/K queue navigation and multi-select. Phase 3 ships the phone composition on every platform plus `A`/`E`/`R` keyboard shortcuts on web (the draft must be on screen). The Playwright smoke keeps stopping at the mailbox gate (providerless CI cannot reach go-live); the mock-tier vitest E2E proves the flow end to end, and a stubbed-provider Playwright walk is a Phase 7 hardening item.
  14. **Guardrail hard failure stores the draft as `pending` with `decision: 'escalate'`** and routes the ticket to `needs_owner/guardrail_failed` — visible, editable, never sendable until the edited body passes the validator at the approve gate (spec §Decision). The agent's own `escalate` outcome and `no_reply` store no draft row; their rationale lives on `agent_runs.output` and the audit row.
  15. **"I'll handle it" lands the ticket in `needs_owner/owner_handling`, pre-stamped silent**, and a new `inbox.resolve` mutation lets the owner close it after replying by hand (doge-buddy's terminal reject is `escalated/owner_rejected_draft`; the SaaS's `needs_owner` is that state).
  16. **`kill_switch` is read, not exposed.** `decide()` and `send.execute` honour `workspaces.kill_switch`; the Settings toggle for it is Phase 7 (spec: Settings → Billing/hardening). The master switch (`agent_enabled`) IS exposed (`workspace.setAgentEnabled`) and gates sends: a human approve while the agent is off is refused with a clear message, and the send job holds as defense in depth.
  17. **Live verification is Robert's runbook step** (`docs/runbooks/2026-09-phase-3-external-setup.md`): approve from the phone → reply in Gmail and outlook.com in the same conversation, follow-up threads, redeploy mid-thread. CI proves the mock tier; the `cacheReadTokens > 0` assertion runs against a recorded response fixture.
- **Carry-overs resolved during Phase 3.** The five Phase 2 residuals folded into this phase's
  own tasks all landed: the claim-time mailbox notification email and the `use-gate` `setActive`
  regression test (Task 1, `1ee18c5`, with the `pnpm dedupe` pass alongside), the
  `mailbox_connections.push_subscription_id` partial index (Task 3's hardening migration 0011),
  and the malformed-cursor degraded marking on `inbox.list` (Task 17, `parseCursor` → the
  response's `degraded` flag). The sixth, the DMARC first-match re-examination, moves to Phase 5
  with `decide()`'s auto branch — see below.
- Execution-time rulings recorded during the build, by area:
  - **process**: no git worktree — the repo's documented flow is a phase branch in the main working
    tree, and the branch is the isolation.
  - **contracts (Task 2)**: the sandbox inputs live in `contracts/src/drafts.ts` (the brief's code
    block), not `agents.ts` (its file list) — both re-exported from the index; Task 2 also carried
    Task 20's chip words and reason sentences for the twelve new `needs_owner` reasons forward into
    the app's two typed `Record<NeedsOwnerReason, …>` maps, so typecheck could not break between the
    two tasks; the `guardrail_failed` reason sentence stays TWO sentences, which is the copy the
    plan's Task 20 mandates.
  - **core/guardrails (Task 5)**: the brief's "24 phrases" was a miscount — the reference has 22 and
    all 22 were ported; the warning screens live in `validator.ts` rather than `screens.ts` to avoid
    an import cycle.
  - **llm (Tasks 6-8)**: native structured output uses `messages.create` + `output_config.format`
    plus the adapter's own envelope `safeParse`, never `messages.parse` — that helper throws an
    `AnthropicError` on a schema-violating response, which would break this package's never-throw
    parse contract (same wire request either way); a `structuredOutput: 'none'` provider making zero
    calls is accepted for Phase 3 as unreachable (Anthropic models are native, unknown models
    `json_mode`) with Phase 6's OpenAI-compatible adapter to revisit it; a pg-boss retry cannot reuse
    an idempotency key, because a failure clears `last_agent_run_at`, the retry re-claims, and
    `gateAndRecordRun` mints a NEW run id — so `draft:${runId}:${attempt}` differs per attempt and
    the rungs suffix `:native`/`:json_mode`/`:repair`; the send meters got named constants
    (`SEND_METERS`) in `packages/db/src/metering.ts` beside `LLM_METERS`, and
    `SANDBOX_METERS = { runs: 'sandbox_runs' }` joined them — one home for meter names.
  - **agent (Task 9)**: prompt-text contradictions cost a redraft cycle per affected reply, so three
    of them were fixed rather than parked — the sales persona mandating an offer to have someone
    reach out (a callback the hard rules forbid), a bullet reading "say X and escalate" (unsatisfiable:
    an `escalate` decision has no body), and the concierge persona's "name the policy" nudge toward a
    `trusted_text_leak`.
  - **db (Task 10)**: `escalateTicket` gained an optional `dedupeKey?` (default
    `escalationDedupeKey(ticketId, day)`) so a same-day second escalation for a DIFFERENT reason is
    not deduped away — the draft job, the sweeps and the send job all pass reason-prefixed keys;
    `ClaimResult`'s `claimed: false` variant gained `notificationId?` (set on `stuck_escalated`) so
    the job dispatches that page immediately instead of waiting on the poll sweep's 10-minute
    re-enqueue; the tripwire notification body stands as deliberate copy.
  - **worker drafting (Task 11)**: all six disclosed deviations were accepted — the `outcomes.ts`
    split, the `escalateReason` detail key (a plain `reason` key would clobber `escalateTicket`'s
    own), ONE watchdog spanning retrieval and both model attempts, the prompt trace event storing
    block sizes plus a thread count and never bodies, a retrieval throw counting as a run failure
    (else the run row stays `running` until the sweep), and a failed automatic redraft counting as
    skipped rather than charging the ticket a failure (the same end state a second guardrail failure
    produces); `finishRun` is guarded on `status = 'running'` and returns false when the backstop
    sweep already aborted the run, so the job logs and continues instead of throwing.
  - **mail (Task 12)**: the sync walk writes `messages.draft_id` only when the `X-Aesa-Draft` value
    is a syntactically valid uuid (else null) — the column is `uuid`, and a malformed header on an
    owner-sent message would otherwise make every sync of that mailbox throw.
  - **worker send (Task 13)**: the kill levers run at step 1 only for an `approved` draft; for a
    `sending` draft (a crash re-entry) they are deferred past the recovery scan — a scan HIT
    completes regardless (the customer already has the mail) and a MISS applies them before
    staleness — with `draftTransitions.sending` gaining `held` so a send and its draft always move
    together, and a reauth on a `sending` draft releasing the claim and throwing instead of holding
    (delivery is unverified). Dead-lettering a send whose delivery could not be verified marks it
    failed and pages the owner with the real reason. The brief's "no enqueueDraft" line for the
    recovery-before-staleness case contradicted its own step 11, so step 11 wins: a recovered send
    that lands the ticket on `triaged` enqueues `ticket.draft`. The task review then added three
    more: a null agent holds at step 1 for ANY draft status, `landStale` must accept a `sending`
    draft (`sending → failed` is legal), and every landing must be test-driven with a `sending`
    draft as well as an `approved` one.
  - **worker sweeps (Task 14)**: `OrgTx` is the drizzle tx plus an `orgId` property, so a platform
    sweep lends a ticket's identity to its per-row SAVEPOINT tx — never the outer platform tx —
    through a new exported `withOrgIdentity(tx, orgId): OrgTx`; the platform role bypasses RLS, so
    the identity feeds only `audit()`/`escalateTicket`, whose writes are keyed by ticket id.
  - **api (Tasks 16-19)**: ONE lock order for every transaction touching more than one of the three
    row kinds, in the api AND the worker — **`outbound_sends → drafts → tickets`** — chosen over the
    reviewer's `send → ticket → draft` because it leaves `send.execute` untouched; ~~the approve
    gate screens FAILS only (`trustedTexts: []`, no `groundedNumbers`), since an owner may
    legitimately paste the workspace's own guidance wording into a reply and the draft gate already
    screened the model's body against the full policy~~ — **REVERSED by the fix wave** (see the
    whole-branch paragraph below): the send gate screened the same body against the full policy
    moments later, so this only moved the refusal to where it destroyed the reply instead of letting
    the owner fix it; tRPC's default error shape carries no `cause`, so
    `drafts.approve`'s BAD_REQUEST `guardrail` surfaces its findings through an `errorFormatter`
    branch that copies them to `data.findings` for a non-500 error (the 500 masking untouched, with
    an error-surface test pinning it); the digest email pluralises its subject, renders the
    escalation's customer (`subject · customer · reason`), and takes its category label from the
    draft's own `category_id` with the ticket's as fallback (matching the `draft_review` push);
    `agents.sandboxGet` returns the stored output parsed through a zod `SandboxOutputView` in
    contracts (an unparsable stored output is null, never a 500) so the app consumes a contract type
    rather than a worker type, and the api never value-imports `@aesa/agent`, so the sandbox run's
    model id comes from contracts too.
  - **api/app (Tasks 17, 20)**: a draft the send job parked on `held` had no way back in the plan, so
    Task 17 added `resumeDraft` (`held → pending`; the send row stays `held` and the next approve
    revives that same ledger row through the existing ON CONFLICT path, keeping its attempts and
    provider ids) exposed as `drafts.resume`, with `DraftView.send.lastError` and a "Back to review"
    button; `HOLD_REASON_LABEL` maps the send row's machine `last_error` strings
    (`held:<lever>`, `reauth_required`, `held:ticket_resolved`) to banner copy with a generic
    fallback; and the review screen seeds its undo window from `draft.undoUntil` (a server value)
    with the approve mutation's result overriding it, so a reload inside the 15 s keeps the Undo
    button.
  - **app (Task 21)**: `resolveGate` admits the `/ticket/[id]` route while
    `onboardingStep === 'go_live'` — that step exists to look at the first draft, and approve on it
    refuses with `agent_disabled` until the master switch is on; every other step and route keep
    today's redirect.
  - **deferred during the build (Task 16)**: the digest mints action tokens for EVERY pending draft,
    not only the ten rendered (a bounded fetch when backlogs grow), and the email pass scans every
    workspace on each 5-minute tick. *(The first half was fixed in the fix wave — the digest now
    slices to `DIGEST_MAX_ITEMS` before minting and passes the remainder as a `moreDrafts` count so
    the "…and N more" line still speaks for the whole backlog. The 5-minute scan carries.)*
  - **pre-final fixes (`883ecac`)**: Task 23's mock-tier E2E surfaced two real defects, both fixed
    before the whole-branch review — `llm_calls.latency_ms` is an `integer` column while both
    producers handed it a `performance.now()` float, so EVERY insert failed inside
    `createMeterSink`'s deliberate swallow and the four LLM meters never moved (which silently
    disabled `autonomy.daily_llm_usd_cap`, the org's daily spend cap, since it reads
    `llm_cost_micros`); the value is now rounded at both producers, rounded again defensively in the
    sink, and the worker routes the sink's `onError` to its own logger instead of `console.error`.
    And `reopenIfEligible` reset the failure budgets but left `last_agent_run_at` standing, so a
    reopened ticket whose follow-up's PROVIDER timestamp did not strictly postdate the previous run's
    WALL-CLOCK claim stamp was never re-drafted and never escalated (the stuck branch cannot rescue a
    run that finished) — it now clears the stamp too, the same way `send.execute`'s hand-backs do.
    Four regression tests came with them.
  - **whole-branch fix wave (2026-09-10)**: six rulings, one of them a reversal.
    1. **REVERSED — ledger ruling 28 (the approve gate screens fails only, `trustedTexts: []`).**
       The approve gate now screens against the SAME policy as the draft and send gates — the four
       trusted texts in the same order (platform hard rules, persona block, workspace operating
       guidance, agent guidance extra) plus `expectedLanguage: ticket.language` — built by the one
       `buildReplyPolicy` in the new pure sub-path `@aesa/agent/policy`. The original ruling's
       recorded cost ("an owner-edited reply could quote internal guidance") was wrong in the other
       direction: `send.execute` screened the same body against the full policy moments later, so a
       `trusted_text_leak` in an owner edit passed approve and then destroyed the reply at send with
       no way back. The gates now differ in exactly one deliberate way: no `groundedNumbers` at
       approve (the owner is the grounding for their own edit; `unbacked_number` is a `warn` that
       flips no outcome). The api depends on `@aesa/agent` only through `@aesa/agent/policy`, and
       two module-graph tests hold the line that the SDK never enters the api's graph.
    2. **A dead-lettered (`failed`) draft has a way back to review.** `draftTransitions.failed`
       gains `pending` and `ticketTransitions.needs_owner` gains `awaiting_review` (the first
       production caller of `ticketTransitions.assert`); `resumeDraft` accepts `held|failed`, and a
       `failed` draft on a `needs_owner/send_failed` ticket walks the ticket back to
       `awaiting_review` in the same transaction. The send row is left alone, so the next approve
       revives that SAME `outbound_sends` row (`attempts` 0, `last_error` cleared). A resume is
       REFUSED (`not_resumable`) while any other live draft exists on the ticket — `failed` is
       outside `drafts_live_per_ticket_uidx` and `pending` is inside it, so without the guard a
       resume beside a landed re-draft raised a bare 23505 — and refused unless the ticket is still
       the owner's to act on: `needs_owner/send_failed` or `triaged`. `inbox.ticket` falls back to
       the ticket's newest `failed` draft when no live draft exists **and the ticket is in one of
       those two statuses**, which is what makes the button reachable at all; anything else
       (`resolved`, a reopened `new`, `waiting_on_customer`) serves `draft: null`, because nothing
       ever retires a `failed` draft and a leftover one would otherwise render a permanent
       "Not sent — …" banner on a ticket nobody is reviewing. `inbox.list` is unchanged.
    3. **`resolveTicket` retires EVERY live draft and holds a claimed send.** `pending|approved →
       superseded`, `held → expired` (the legal edge — `held → superseded` is not in the matrix),
       one audit row per retired draft named for where it landed; the send pre-lock widens to the
       live draft's send in any status and holds `queued|claimed` sends with
       `last_error = 'held:ticket_resolved'`. `sending` is deliberately left alone: a reply is in
       flight and only the send job may say what happened to it. The other half is in the worker —
       the pre-send flip now requires the draft `IN ('approved','sending')` with `RETURNING`, and 0
       rows releases the send row and lands `draft not approved` without paging.
    4. **The backstop sweep reads the global killswitch once and skips arm (a), and only (a).** The
       recovery arms — stuck runs, orphans, due sends and the new (a2) — keep running: the lever
       pauses the agent, not the owner's visibility into what is stuck. (a2) is the rescue for a
       ticket stranded at the agent failure ceiling (`triaged` with
       `agent_failure_count >= AGENT_FAILURE_ESCALATE_AT`, which nothing could draft and nothing
       escalated); it escalates to `needs_owner/agent_failed` per-row in its own SAVEPOINT, deduped
       per ticket per UTC day, under its OWN `ESCALATIONS_CAP_PER_CYCLE` budget rather than one
       shared with (c) — the two arms select disjoint sets, so a shared budget would let one starve
       the other. The org-cap half of the same busy loop is NOT fixed and carries.
    5. **`policy: 'short'` on the four Phase 3 queues.** Verified against a real boss first:
       pg-boss 10 gates its singleton indexes on the queue's policy, `defineJob` defaulted to
       `standard`, and on `standard` no index applies — so `enqueue()`'s `singletonKey` was inert
       and every place reasoning from a `null` return described an event that could not occur.
       `ticket.draft`, `send.execute`, `agent.sandbox` and `notify.dispatch` now declare
       `policy: 'short'`, which collapses a duplicate only while the first job is still `created`
       (a job that has gone `active` — or that is sitting in `retry` — never swallows a newer
       event). `ticket.triage` and `mailbox.sync` stay `standard` and keep debouncing through
       `singletonSeconds`, which is policy-independent.
    6. **A resume of a stale-`failed` draft onto a `triaged` ticket is allowed while a re-draft may
       still be in flight** — it self-corrects (approving it hits `send.execute`'s staleness check
       and lands `landStale` again) at the cost of one wasted run. Narrowing `resumeDraft` to refuse
       every `triaged` ticket would close it but would also make a `landStale` failed draft
       permanently un-resumable, which may be the wrong trade. **A carry**, not a fix.
- **Whole-branch review and fix wave** (`176f717`, `b776159`, `2aebfde`, `0e444c6`, `0cf7c1c`, on
  top of the pre-wave `883ecac`). The branch was reviewed six ways at `3c76a8a` — A1 (drafting and
  the sweeps), A2 (`send.execute` and the digest), B (`packages/{core,llm,agent,db,mail}` and the
  migrations), C (the api and the review pages), D (`apps/app`), E (the seams between them, the
  rulings and the documents) — for a verdict of **approve with fixes: 0 Critical, 13 Important**,
  plus the per-area minors and a consolidated triage of the ledger's 24 deferred minors. The wave
  landed in five commits, one per area, each with the full gate green: `176f717` packages,
  `b776159` api, `2aebfde` worker, `0e444c6` app, `0cf7c1c` a second api round from the re-review.
  The thirteen Important findings — two pairs of which are one mechanism seen from two areas — one
  sentence each:
  - **B-I1** every 5-minute cache write was priced at the 1-hour rate — `ChatUsage` now carries the
    `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` split, `computeCostMicros` prices 5m
    at 1.25× and 1h at 2×, and the configured TTL is the fallback rate for an unattributed
    remainder (no migration: `cache_write_tokens` stays the total).
  - **B-I2** the guardrail strip removed only `\p{Cf}`, so a U+FE0F or U+034F inside a promised
    action, a phone number, a URL host, an `sk-` secret or an HTML tag defeated six of the eight
    fail screens — it now strips `\p{Default_Ignorable_Code_Point}` on both sides of NFKC.
  - **B-I3** `JSON.stringify` leaves U+2028/U+2029 raw, so a customer body could render a second
    line inside the thread's one-JSON-line-per-message containment — `thread.ts` re-escapes every
    line terminator (U+0085 included) on both the thread line and the prior-draft line.
  - **E-I1 / C-I2** the two guardrail policies — ruling 1 above.
  - **C-I1 / E-I4** `resolveTicket` — ruling 3 above (`resolveTicket` left a `held` draft live,
    which permanently broke the next draft cycle on that ticket, and could not stop an
    already-claimed send).
  - **E-I2** the runbook's dead-letter recovery told the operator to do something the code made
    impossible — ruling 2 above made it real, and §6 now names the actual flow.
  - **E-I3** the backstop sweep under the killswitch — ruling 4 above.
  - **A1-I1** a `triaged` ticket at the failure ceiling was stranded silently forever — both
    `send.execute` hand-backs now reset `agent_failure_count`, and sweep arm (a2) rescues anything
    already stranded.
  - **A2-I1** `RELEASE_RETRY_SECONDS` (60 s) outran pg-boss's first retry (30 s), so the two
    release-and-throw paths never reached `lastAttempt` and never dead-lettered or paged — the
    delay is now `INVARIANTS.SEND_RELEASE_RETRY_SECONDS` (15) with a boot-asserted invariant that
    it stays below `SEND_RETRY_DELAY_SECONDS` (30).
  - **D-I1** after a reject→redraft the ticket screen never refetched, so the promised draft never
    appeared — the poll now also covers a `triaged` ticket that has no live draft (or only a
    `failed` one, once `inbox.ticket` started serving those).
  - **D-I2** a failed `drafts.markViewed` disabled Approve for the whole visit, silently — it now
    retries itself once per draft id and otherwise shows "Could not open the draft — tap to retry"
    with a Retry button.
  Two more Important-adjacent fixes came from the section-A re-review (`0cf7c1c`): `resumeDraft`
  refusing while a live draft exists, and `inbox.ticket`'s failed-draft fallback (both in ruling 2);
  a third round bounded both of those by the ticket's own status and completed the app's hold-reason
  label map with `held:superseded_by_redraft`.
  Also landed: five of the ledger's deferred minors (69, 70, 71, 79, 129) plus 39, 112, 136 and
  89b, and the per-area minors each section carried — the token-minting slice, the `orgId` brace on
  `sandboxStart`, `@fastify/formbody` scoped to the review routes, a fresh clock per deadlock
  retry, the claim-time email firing only on a first claim, `errorMessage(err)` instead of `{ err }`
  on the sandbox recovery logs, the `completeSend` NULL-watermark flip, the three landings gating on
  their guarded UPDATE's `RETURNING`, the draft insert retiring every live draft except `sending`,
  and the app's five copy/state minors.

### Brand — the aesa identity (complete; merged into `phase-3` via PR #4 and landed on `main` with PR #3 on 2026-09-11)

- Plan: `docs/superpowers/plans/2026-09-10-brand-system.md` (7 tasks, executed with
  subagent-driven development). Commits `0f3efbe..1d843c7` on `brand`, branched from `phase-3` at
  `7a40be2` — the spec commit (`0f3efbe`), the derivation-record and STATUS hand-off commit
  (`963d21e`), the plan commit (`d604089`), and six task commits with no fix-wave commit (each
  task reviewed clean): `b736516` (Task 1, the `@aesa/brand` package, `tokens.json`, the pinned
  WCAG pairs), `e564be4` (Task 2, the mark and wordmark sources plus the wordmark derivation and
  the eight Lucide-based icons), `b2fa0c9` (Task 3, the build — lockups, colourways, OG card,
  rasters, ICO, the generated `BRAND` module), `073e9f5` (Task 4, the api's favicons/social
  card/review-page CSS), `658b70e` (Task 5, the app's theme, bundled fonts, `app.json`),
  `1d843c7` (Task 6, the app's SVG mark/wordmark/lockup, the eight icons, brand-toned chips and
  banners) — plus the docs commit that closes it (this commit, Task 7). The whole-branch review
  record is `docs/superpowers/reviews/2026-09-10-brand-final-review.md` (verdict, the three
  Important findings, the fix wave `4a7f110`/`78e8ec4`/`9b50dcd`, the parked residuals and the
  rulings); its fix wave is the paragraph at the end of this record. Gate at this commit: typecheck and lint clean across all 14
  packages/apps (`brand` added); `pnpm test` green with **1,787 tests** plus 4 conditional skips
  (`@aesa/contracts` 21, `@aesa/crypto` 42, `brand` 110, `@aesa/platform-mail` 18, `@aesa/core`
  204, `@aesa/llm` 98, `@aesa/agent` 65, `@aesa/db` 72, `@aesa/queue` 17, `@aesa/mail` 237,
  `@aesa/test-kit` 43 [39 run + 4 conditional skips], `apps/api` 221, `apps/worker` 357, `apps/app`
  286 jest across 40 suites); `db:check` reports no drift; the Expo web export produces **21
  static routes** (unchanged — no new route file); `pnpm e2e` passes (still ending at the gated
  mailbox step, per Phase 2's Task 20 ruling).
- What exists now: the root-level `@aesa/brand` workspace package (`brand/`) — its four sources
  (`tokens.json`, `mark.svg`, `wordmark.svg`, `icons/*.svg`), the Python derivation
  (`scripts/derive/`, reproducible byte for byte against the spec's Appendix A), `scripts/{svg,
  compose,ico,build}.ts`, and `pnpm brand:build`'s 18 generated outputs (the other three mark
  colourways, the two lockups and the OG card SVG under `brand/`; five PNGs in
  `apps/app/assets/`; six files in `apps/api/public/`; `packages/contracts/src/brand.ts`'s
  `BRAND`); the api's six-file asset allowlist (`src/brand/assets.ts`, ETag, a day of caching),
  the token-built review CSS and inline SVG wordmark (`src/brand/css.ts`), and the review pages
  restyled on both (`src/review/pages.ts`); the app's theme (`src/theme.ts`'s
  `palettes`/`font`/`typeScale` over `BRAND`), the five bundled Fraunces/Plus Jakarta Sans faces
  behind the splash hold (`src/lib/fonts.ts`), the `Mark`/`Wordmark`/`Lockup` SVG components and
  the `Icon` component's eight product icons (`src/components/{brand,icon}.tsx`), the brand-toned
  `Chip`, the shell's sidebar lockup and SVG tab icons (no `@expo/vector-icons` import remains),
  and `app.json` built on the tokens. `brand/brand.md` is the guide; `brand/README.md` is the
  short version.
- Deviations from the spec, all recorded in the plan's deviations list:
  1. **`@resvg/resvg-js` is a devDependency of `@aesa/brand`, not the root** — the native N-API
     build (same Rust renderer as `@resvg/resvg-wasm`, no system libraries, faster).
  2. **Fraunces optical size 36 is not used in the app.** The `@expo-google-fonts/fraunces`
     statics are cut at the axis default (opsz 144); nothing in the app sets display type in the
     18–27 px range the spec reserves for opsz 36. The landing page can use the variable font.
  3. **The Android adaptive-icon foreground draws the mark at 35% of the tile height, not 56%** —
     56% clips on Android's 66/108 safe-circle mask; iOS and the Apple touch icon keep 56% (iOS
     only rounds corners).
  4. **The splash "20% of the short edge" becomes `imageWidth: 108` in `app.json`** —
     `expo-splash-screen` sizes by width in dp regardless of device, fixed against a 390-pt
     reference phone.
  5. **Two dark-theme tokens the spec's prose omits are added:** `lineOnNight` (borders on night)
     and `liftedOn` (text on a lifted-blue button, 9.11).
  6. **`primary` text on `primaryTint` is 4.46 — below AA for body text**, pinned as a
     large-text-only pair (≥ 18.66 px bold); chips and selected cards use `ink` text instead.
  7. **The mark, wordmark, horizontal-lockup geometry and the eight icon path lists all ride in
     the generated `BRAND`** (`BRAND.paths`, `BRAND.icons`) — no second generated file in the app,
     and the app's lockup is byte-identical in geometry to `brand/lockup-horizontal.svg`.
  8. **`brand/mark.svg` and `brand/wordmark.svg` carry TIGHT viewBoxes**, not the spec appendix's
     40-unit padded box — padding is a placement decision (clear space), not baked into an asset.
  9. **The colourway marks, the two lockups and `og-image.svg` are build OUTPUTS**, not sources —
     one rebuild after a mark change propagates everywhere, proven byte-for-byte by a test.
  10. **The lockup geometry is made exact:** the mark's top meets the wordmark's ascender line
      (1484 font units), the gap is one stem width (240 units); the stacked lockup's gap is half
      the mark's height.
  11. **No dark-mode social card and no dark favicon variant.** `og.png` already IS the night card
      the spec asks for; the favicon SVG (azure on transparent) has no text/background pair to
      screen.
  12. **Sign-in copy changes from "Sign in to aesa" to "Sign in"** under the new header lockup —
      the name is now the lockup, so repeating it in the title read as a stutter.
  13. **No pixel/screenshot test of the rendered SVG components** (jest-expo has no SVG
      rasteriser) — structural assertions (which paths, transforms, fills) plus the
      rebuild-and-diff build test plus the Playwright smoke are the visual gate.
  14. **Spec §6's header lockup is met on wide layouts (the sidebar) and the sign-in screen only.**
      On a phone the tabs run `headerShown: false` (`responsive-shell.tsx`), so after sign-in the
      phone shows no brand chrome in the inbox/activity/settings tabs — unchanged from the
      pre-branch app; see *Open items for Robert*.
- Execution-time rulings recorded during the build: no separate worktree (the repo's standing
  practice); the SVG regex helpers (`allPathData`, `pathData`, `viewBox`, `hullBounds`) live in
  `brand/scripts/svg.ts`, imported by both `brand/test/*` and `scripts/build.ts` rather than
  duplicated into the latter; a legitimate literal colour caught by the app-typography guard would
  move into `theme.ts` as a role sourced from an existing token rather than a new one
  (`tokens.json`'s key sets are pinned by the contrast test); Task 5's four test-tightening minors
  folded into Task 6's dispatch; and — the two load-bearing for this record — `brand.test.tsx` and
  `icon.test.tsx` mock `react-native-svg` through one shared factory
  (`apps/app/src/test-utils/svg-mock.ts`: `Svg`/`Path`/`G` → `View` keeping every prop) because
  RNTL 14 removed `UNSAFE_getByType` and the host `RNSVGPath` carries `fill` as a processed brush
  object rather than the hex string the component passed, so even a host-props approach could not
  read the value under test; the components themselves and `responsive-shell.test.tsx` still
  render the real library.
- Carry-overs for later: the public landing page is its own plan — it should use the variable
  Fraunces with opsz 36 for mid sizes; a dark-mode social card if the landing page wants one; a
  `success` button variant on `successSolid` when a screen needs one; screenshot tests if a
  renderer becomes available; renaming the `aesa` codename in package scopes and roles was NOT
  requested and is untouched. One more from execution: the bottom tab bar's active state is now
  colour-only — one icon variant per name (spec §5) — a WCAG 1.4.1 point for the whole-branch
  review or a later pass; the sidebar keeps a tint as a second channel alongside colour.
- **Fix wave** (whole-branch review, "with fixes"): `4a7f110` (app: the three Important findings
  below), `78e8ec4` (api: a comment-only fix), and `9b50dcd` (brand/docs). The three Important
  findings: the font bundle went from 32 bundled faces to the 5 the theme names — `fonts.ts` now
  imports each face from its own per-weight subpath (`@expo-google-fonts/fraunces/500Medium` etc.)
  instead of the package barrel, verified by the web export's `.ttf` count; the sidebar's active
  label was `primary` text on `primaryTint` (4.46, below AA) and is now `c.text` at
  `typeScale.bodyStrong` (14.78), which also resolves the carry-over above — the bottom tab bar's
  `tabBarLabel` now renders `font.uiStrong` on the focused tab as its own second channel alongside
  colour (WCAG 1.4.1), replacing the outline/filled icon pair this branch removed. Also in this
  wave: `brand/icons/LICENSE` (Lucide's ISC text, verbatim, plus the derivation note), both
  `brand.md` §9 and `README.md` pointing at it; the `agent-edit.tsx` category pills now render
  through `Chip`; `brand.tsx`'s mark/wordmark aspect ratios derive from their viewBox strings; the
  app-typography colour guard tightened to catch 3–8-digit hex and `hsla?()` too (still zero
  offenders); three doc corrections (`brand.md`'s `Mark`/`Wordmark`/`Lockup` default heights, the
  `_layout.tsx` splash comment, one `pages.ts` comment); the README's rebuild sentence on
  `resvg`'s native build being platform-specific. Re-run gate: typecheck and lint clean across all
  14 packages/apps; `pnpm test` green with **1,788 tests** plus 4 conditional skips (`@aesa/app`
  287, up 1 from the review baseline; every other package/app unchanged from the review's count —
  see that record above); `db:check` reports no drift; the Expo web export still produces **21
  static routes** and now **5 `.ttf` files** (down from 32); `pnpm e2e` passes. One flake noted,
  not fixed here: `apps/worker/test/e2e-phase3.test.ts`'s test 10 (`send.execute`'s follow-up
  draft) intermittently misses its `waitFor` window under the full monorepo `pnpm test`'s CPU
  contention — reproduced on the pre-fix-wave tree too, passes reliably standalone
  (`pnpm --filter @aesa/worker test test/e2e-phase3.test.ts`), and `apps/worker` has no dependency
  on anything this wave touched.

### Phase 4 — knowledge (complete; merged into `main` via PR #5 on 2026-09-11, merge commit `ef81169`)

- Plan: `docs/superpowers/plans/2026-09-10-phase-4-knowledge.md` (11 tasks, executed with
  subagent-driven development). Commits **`de35bf9..HEAD`** on `phase-4`, branched from `main` at
  `de35bf9` — the plan commit, the Phase 3 carry-over task, ten implementation tasks with their
  per-task fix commits, the Task 11 close-out (the E2E, the external-setup runbook and the docs)
  and this docs commit. The per-task list, newest last:
  `8586ea2` plan · `f7e722d` T1 carries (the `short` queues' pre-create policy, the `boss.send`
  lint, the review pages' CSP/frame/nosniff headers) · `202b1bf` T2 contracts+core ·
  `d283136`+`a2e2218` T3 the three `knowledge_*` tables · `cdb6340`+`f171c0a` T4 parsers, the
  bounded child, the chunker, the injection screen · `e29e510`+`05f60cf` T5 the `Embedder` and
  `ObjectStore` ports, minio in compose and CI · `0aafc2f`+`8bf9315`+`18ee8c7` T6 hybrid per-org
  retrieval and the relaxed tsquery · `52b53ff`+`aebe431`+`fcb2e72`+`50b97f4` T7 `prepareDocument`
  and the SSRF-safe crawler · `837f612`+`2aada9a`+`be4b333` T8 the three jobs, the `knowledge`
  role, the real retriever in the `agent` role, grounding on the draft, `claim_token` ·
  `a4946c7`+`7a2d18d` T9 the knowledge router/service and the two pure sub-paths ·
  `4797688`+`6c7782f` T10 the Knowledge screen · `2e7a2c6` T11 the E2E. The per-task execution
  ledger was an ephemeral SDD artifact; everything load-bearing from it is distilled below, and the
  git history plus the review record that follows are the durable account.
  Gate at the close-out commit (minio up, `S3_*` exported so the storage suite runs): typecheck and
  lint clean across all **15** packages/apps (`@aesa/knowledge` added); `pnpm test` green with
  **2,077 tests** plus 4 conditional skips (`@aesa/contracts` 24, `@aesa/crypto` 44,
  `@aesa/platform-mail` 18, `brand` 110, `@aesa/core` 205, `@aesa/llm` 98, `@aesa/agent` 65,
  `@aesa/db` 77, `@aesa/queue` 17, `@aesa/mail` 237, `@aesa/knowledge` 129, `@aesa/test-kit` 43
  [39 run + 4 conditional skips], `apps/api` 244, `apps/worker` 426 [including the 8-scenario
  `e2e-phase2`, `e2e-phase3` and `e2e-phase4` files], `apps/app` 344 jest across 50 suites — no
  database); `db:check` reports no drift; the Expo web export produces **22 static routes** (up
  from 21 — `(app)/settings/knowledge` is the one new route file); the Playwright signup smoke
  passes (still ending at the gated mailbox step, per Phase 2's Task 20 ruling). The pre-existing
  `e2e-phase3.test.ts` case-10 timing flake did NOT fire in this run.
- What exists now:
  - `packages/contracts` — the knowledge kinds/statuses/failure reasons, the upload/paste/crawl
    inputs and the four size limits (20 MiB upload, 50k paste chars, 3,000 chunk chars, 50 default
    crawl pages), and the guidance input.
  - `packages/core` — the three `knowledge.*` settings (`max_sources`, `max_crawl_pages`,
    `daily_embed_tokens_cap`) in the catalog, with per-plan values alongside them in `plans.ts`.
    The plan values are **constants, not yet a resolution layer**: `planSettingDefaults` has no
    caller and every knowledge `resolveSetting` site passes `{ org }` only, so today every org sits
    on the catalog defaults — **100 sources, 200 crawl pages, 5,000,000 embed tokens a day** —
    unless an `org_settings` row overrides it. Plan tiers arrive with Phase 7's billing, which owns
    the org's `plan` column and the `{ plan }` argument at every site.
  - `packages/db` — `knowledge_sources` / `knowledge_documents` / `knowledge_chunks` with
    `vector(1024)`, a generated `tsvector`, FORCE RLS and the tenant policies, the partial
    unembedded index, `knowledge_sources.claim_token` (migration 0015), `bumpKnowledgeVersion` and
    `KNOWLEDGE_METERS` (`embed_tokens`, `crawl_pages`). Migrations 0012–0015.
  - `packages/knowledge` — the new package: the HTML/Markdown/text/PDF/DOCX block parsers and the
    bounded forked parser child, the heading-aware chunker, the injection screen, `prepareDocument`,
    the `Embedder`/`Reranker` ports (Voyage + the deterministic hash fallback) and the `ObjectStore`
    port (S3/minio + in-memory), the SSRF-safe crawler (robots, sitemap-first, re-validated
    redirects, first-20 batches, politeness), and hybrid per-org retrieval (`createRetriever`,
    exact cosine + the relaxed prefix-OR tsquery, RRF fusion, `assertSameOrg`, optional rerank).
    Two PURE sub-paths (`./storage`, `./url`) plus `./testing`'s `fakeSite`.
  - `apps/worker` — the `knowledge` role and its three jobs (`knowledge.ingest`, `knowledge.crawl`,
    `knowledge.embed-batch`), `knowledge/sources.ts`'s `guardedSourceWrite`/`failSource`,
    `knowledge-deps.ts` as the ONE place the store/embedder/reranker are chosen, the REAL retriever
    in the `agent` role, and `confidence_breakdown.grounding` + `retrieved_chunk_ids` /
    `cited_chunk_ids` on every draft.
  - `apps/api` — the `knowledge` router over one service module (`src/knowledge/service.ts`,
    `@aesa/api/knowledge`): presigned uploads, paste, crawl/refresh, list (with `caps` and
    `canManage`), delete, flagged chunks, unflag/delete chunk, gaps — plus
    `workspace.updateGuidance`. The api imports `@aesa/knowledge` only through the two pure
    sub-paths, so neither the parsers nor an LLM client enter its module graph.
  - `apps/app` — the Knowledge screen (crawl card with the plan page cap, paste, upload via the web
    drop zone and the native picker, the source list with per-row status and failure copy, the
    flagged-chunk view, the guidance editor and the gaps card), and the onboarding knowledge step.
- Deviations from the spec's Phase 4 list, as recorded in the plan (the spec wins on everything
  else):
  1. Uploads are a presigned **PUT plus a post-hoc size/type check**, not an S3 POST policy — POST
     policies are not portable across S3, minio and R2.
  2. **Rerank is wired but off** (`KNOWLEDGE_RERANK=on` routes the fused top-20 through Voyage
     `rerank-2.5`), tested against a fake and never live in CI.
  3. A **deterministic hash embedder (`hash-v1`)** is the dev/test fallback so the whole pipeline
     runs with no Voyage key; production refuses to boot without one on `agent`/`knowledge`.
  4. **`knowledge_version` has no cache to bust** (Phase 3 made the knowledge block volatile) — it
     is bumped in the same transaction as every chunk-set change and recorded on the draft's
     grounding as the provenance Phase 5's staleness rule needs.
  5. **The gaps report is a card on the Knowledge screen**, not an Analytics dashboard.
  6. **Crawl page caps are a setting** (`knowledge.max_crawl_pages`) and "first 20 pages fast" is
     the first persisted batch. The spec's "per plan" half is DEFERRED, not built: `plans.ts`
     carries the per-plan numbers but nothing resolves against them, so the effective cap is the
     org's own `org_settings` override or the catalog default (200) — see the `packages/core` line
     above and runbook §1.6.
  7. **One `knowledge.embed-batch` job per document**, not per arbitrary chunk batch.
  8. **Parsers:** `pdfjs-dist` (no OCR — an image-only PDF fails `no_text`) and `mammoth` → HTML →
     the same block extractor; the "zip bounds" are the byte cap plus the child's heap and clock.
  9. **Per-org crawl concurrency is 1** (an advisory lock around the claim); platform parallelism is
     the `knowledge` role's pg-boss `teamSize`.
  10. **The web drag-drop zone is a `.web.tsx` platform file**; native uses `expo-document-picker`;
      share-sheet intake is Phase 7.
  11. **Carries folded in (Task 1):** the `short` queues' pre-creation now carries `policy: 'short'`
      in both lists; a bare `boss.send` is banned by ESLint outside `packages/queue` and tests; the
      review pages gained CSP/`X-Frame-Options`/`X-Content-Type-Options`. The rest of Phase 3's
      carry list moves on unchanged — see *Next: Phase 5*.
  12. **`RetrievalResult.answers` stays `[]`** — resolved answers are Phase 5; the shape carries the
      slot.
  13. **The Playwright smoke still ends at the mailbox step** (providerless CI cannot reach the
      knowledge step); the knowledge UI is proven by jest and by the worker E2E.
- The E2E: `apps/worker/test/e2e-phase4.test.ts`, **8 scenarios**, one throwaway database, one
  pg-boss schema of its own, the REAL api knowledge service, the REAL three knowledge jobs, the
  REAL sync walk and the REAL retriever — (1) paste → ingest → embed-batch → ready, one embedded
  chunk, `knowledge_version` 1, `embed_tokens` metered; (2) an inbound returns question drafts with
  that chunk retrieved AND cited, `grounding.score > 0` / `mode: 'hybrid'` / `knowledgeVersion: 1`,
  and the model's own knowledge block carries the passage text; (3) a crawl of the fake site
  ingests 3 pages, refuses the `.internal` link and the 302 to the metadata address without
  fetching either, meters `crawl_pages` 3, lands `ready`, and a shipping question cites the crawled
  chunk; (4) an injection page is chunked, flagged `override_instructions`, never retrieved, listed
  by `knowledge.flaggedChunks`, and retrievable again after `unflagChunk` (which bumps the
  version); (5) the embedder failing on the QUERY still lands a draft, `mode: 'lexical'`, the
  Returns chunk cited from the tsvector leg alone; (6) `deleteSource` takes the chunks and the
  stored object with it, bumps the version, and the next draft retrieves nothing with a null
  grounding score; (7) an object over the 20 MiB cap fails the source `too_large` with the object
  deleted and `storage_key` cleared, and an abandoned `queued` upload contributes no ready chunks;
  (8) org B's identical FAQ is never retrieved for org A, proven by ids in both directions. No
  wall-clock sleeps: every wait polls for the state it expects under a bounded deadline.
  **Observed numbers worth pinning:** `knowledge_version` is bumped by `knowledge.ingest` (once per
  ingest), by `knowledge.crawl` (once per persisted batch), by `deleteSource`, `unflagChunk` and
  `deleteChunk` — and NOT by `knowledge.embed-batch`, which only fills vectors in. So a paste alone
  leaves the workspace at version **1**, not 2.
- Execution-time rulings recorded during the build (the owner's words, one line each):
  1. Work in the main checkout on branch `phase-4` — the repo's standing practice; no worktree.
  2. `fakeSite` lives in `packages/knowledge/src/testing.ts` behind a `./testing` subpath (the
     `@aesa/db/testing` pattern), so the worker suites and the E2E never reach into another
     package's `test/`.
  3. The knowledge write/read logic lives in `apps/api/src/knowledge/service.ts` exported as
     `@aesa/api/knowledge` (the `drafts/service.ts` pattern), the router being a thin wrapper; the
     E2E calls the service with `{ api, enqueue, store, logger }` rather than a tRPC caller.
  4. The queue-policy test uses throwaway queue names and never deletes shared `pgboss_test`
     queues; the four real names' policy is proven by reading both pre-create lists in review.
  5. `parseHtml` collects `<a href>` everywhere except inside `script`/`style`/`template`; only
     TEXT is dropped inside nav/footer/header/aside.
  6. If `pnpm db:up --wait` ever fails on compose's `mc ready local` minio healthcheck, switch to
     `curl -f http://localhost:9000/minio/health/live` and say so.
  7. The knowledge jobs get their own `guardedSourceWrite` rather than widening the drafting
     helper.
  8. The Task 1 evidence gap does not enter a fix loop; from there every implementer dispatch
     demands PASTED gate output, not a summary.
  9. Fold minors 2, 4 and 7 into fix round 1 — including `createTestDatabase` installing pgvector
     itself, which removes the stale-volume failure mode for the test suite.
  10. Loose text (outside the eight block tags, not in a skipped subtree) accumulates into a
      `paragraph` block flushed at the next boundary — the spec's "a crawled page yields its text"
      wins over the brief's tag list.
  11. `invisible_text` counts only zero-width and bidi format characters, never U+00AD — hyphenated
      PDF/Word exports stay retrievable.
  12. The parser child's stderr is `'ignore'` (a `'pipe'` nobody reads is a hang vector), and a
      heading block ALWAYS flushes the current chunk.
  13. Task 4's fix loop ends with six parser/chunker carry-overs riding into Task 7's dispatch in
      the same package (anchor labels as text, a second `<title>`, `dl/dt/dd`, `<p>` inside `<li>`,
      the chunker's sentence-window overlap, a stale comment).
  14. Local and CI minio CORS is server-wide (`MINIO_API_CORS_ALLOW_ORIGIN`), `s3-init` tolerates
      ONLY minio's 501 from `PutBucketCors` and rethrows everything else, and the minio-gated
      storage test issues a real cross-origin preflight against the presigned URL.
  15. The lexical leg queries a RELAXED tsquery built in TypeScript (content words ≥ 3 chars minus
      a ~60-word stop list, each a prefix match, OR-joined, bound as one parameter); the stored
      `tsv` stays `simple`, and the lexical-only golden hit rate is asserted ≥ 0.75 — a Voyage
      outage only means something if the lexical leg answers real questions.
  16. Fold minors 2 and 9 into fix round 1; `@aesa/agent` stays a type-only devDependency of
      `@aesa/knowledge` with a comment at the import — a deferred minor.
  17. `PinnedFetchInit` gains `redirect?: 'error' | 'manual'` (default unchanged) so the crawler can
      re-validate each hop itself; a crypto test pins both modes.
  18. `parseHtml` inserts a single space at an `<a>` open/close boundary so adjacent anchors do not
      run together.
  19. Fold seven crawler minors into fix round 1 (a shared content-hash helper, a typed refusal
      reason union, `invalid_location` for a rejected redirect target, robots re-checked on a
      redirect, whitespace-only blocks → `no_text`, an empty `<title>` → null, two missing tests).
  20. A `claim_token uuid` column on `knowledge_sources` (migration 0015) is the ownership proof:
      the claim mints one, every later guarded write of that run adds `AND claim_token = $mine`, and
      ready/failed/hand-back clear it.
  21. A crawl abort hands the claim back to `queued` (progress kept) and THROWS so pg-boss retries;
      the crawl lease is 300 s AND the queue's `retryDelay` is 300 with no backoff, so a retry
      always finds a crashed run stale. True resume is a carry-over.
  22. `CrawlError` gains `origin: 'engine' | 'consumer'`: a consumer-origin error (our own
      persistence) is retryable and its message never reaches `failure_detail`; only engine-origin
      errors are terminal.
  23. For a CRAWL source, `knowledge.embed-batch` never changes status — it writes
      `failure_reason`/`failure_detail` only, and the crawl's end transition lands `failed` when a
      reason is present, else `ready`.
  24. `@aesa/knowledge` gains two PURE sub-paths (`./storage`, `./url`) and the api imports ONLY
      those; `error-surface.test.ts` gains a second module-graph probe asserting no
      `@anthropic-ai/*`, `@aesa/llm`, `pdfjs-dist` or `mammoth` specifier reaches the api.
  25. The api stores and matches a crawl URL through `normalizeUrl` (null → `bad_request`, "Crawls
      need an https:// address"), which also closes the `http://` seam without touching contracts.
  26. `startCrawl` on a `ready` match re-queues with the CALLER's clamped `maxPages`; `refreshCrawl`
      keeps the row's stored budget. The source cap's read-then-insert race and concurrent
      same-URL inserts are accepted and commented (a failed crawl must stay re-addable).
  27. `knowledge.list` returns `caps: { maxSources, maxCrawlPages }` and `canManage`; the crawl card
      hides page options above the cap with a "Plan cap: N pages" hint, the counter reads "N of M
      sources", and non-managers see the screen read-only.
  28. The web drop target binds imperatively — an exported pure `bindDropZone(node, handlers)`
      attached through a ref, tested with a fake EventTarget, because React Native Web forwards no
      drag props.
  29. `useUpload().start(files)` resolves `{ stoppedBy: 'cap' | null }` and stops the batch at the
      first refusal; every per-file reason is rendered in the owner's words, an absent picker size
      is refused client-side and an absent MIME is inferred from the extension first.
  30. **Amends ruling 24** (from Task 9's re-review): the "api imports ONLY the two pure sub-paths"
      rule binds **production sources only** — `apps/api/src/**`. A test file may import the
      `@aesa/knowledge` root (`knowledge-router.test.ts` takes `vectorLiteral` from it), because
      what the rule protects is the api's shipped module graph, which
      `error-surface.test.ts`'s probes walk from `config.ts` and `trpc/router.ts`, not from `test/`.
- **Carried into the final review** (the ledger's deferred items, as they stood at the close-out
  commit; the whole-branch review below triaged all three — the ingest lease SHIPPED, the other two
  parks HELD):
  - `knowledge.ingest` has **no lease** — a hard death mid-parse strands the source at `processing`
    (the claim token prevents damage, not the stall); copy the crawl's lease pattern, with Phase 7's
    sweep.
  - `knowledge.embed-batch` holds **no claim token** (by ruling) — its ingest-source status flips are
    guarded on status alone.
  - `@aesa/agent` is a type-only **devDependency** of `@aesa/knowledge`; a consumer typechecking
    `@aesa/knowledge` without `@aesa/agent` would fail (none exists today).
- **Whole-branch final review (2026-09-11).** Reviewed at **`8ee8da3`** by four reviewers reading in
  parallel — `@aesa/knowledge` (A), `apps/worker` + `packages/db` (B), `apps/api` + `apps/app` (C),
  and the cross-cutting seams (D). Verdict **approve with fixes**: **0 Critical, 21 Important**
  across the four, overlapping into **18 distinct fixes** (three overlaps between reports; one of the eighteen is record-only — the plan-tier statement), plus two whole classes of minor. All 12
  seams held and no execution-time ruling was found to contradict the spec. The fix wave ran as ONE
  wave with THREE implementers in sequence on a shared index — **`97357bb`** (knowledge +
  contracts), **`cfb4fd2`** (worker), **`bdf5767`** (api + app + eslint + the one remaining worker
  line) — and this docs commit, which records the wave.
  The scoped re-review (most capable model, over `8ee8da3..d7e29f8`) verdicted every wave item addressed and
  found two Important items the wave itself introduced — the imperative anchor on the injection
  verb rules dropped "Please / You must / Now / Then / Always + verb" attack phrasings, and the
  runbook quoted an alert string that did not match the retriever's warn — plus three doc nits; all
  five were fixed by the controller in the adjudication commit that carries the review record,
  `docs/superpowers/reviews/2026-09-11-phase-4-final-review.md`.
  - **`@aesa/knowledge`.** The injection screen was quarantining ordinary support prose: "We will
    never email you your password", "we send a one-time token to the address on file" and two more
    probed sentences all flagged. The `override_instructions` and `exfiltration` verbs now have to
    stand in IMPERATIVE position (a line start, a sentence-ending mark, or "and …"), so a verb with
    a subject in front of it does not match, and the four sentences are CLEAN fixtures. The eight
    reason codes moved to `@aesa/contracts` as `KNOWLEDGE_INJECTION_REASONS` — the app renders a
    label per code and may not value-import a server package. The forked parser child's IPC reply is
    now bounded by the chunker's own ceiling (2,000 × `KNOWLEDGE_CHUNK_MAX_CHARS` = 6 MB, with a
    `truncated` flag), so a 20 MiB PDF can no longer inflate to ~100 MB the parent has to buffer and
    `JSON.parse`. Off-site links are dropped SYNTACTICALLY at discovery rather than occupying
    frontier slots and costing a DNS lookup each — 500 outbound links on a `maxPages: 5` plan no
    longer starve same-site discovery. And a crawl wave is `Promise.allSettled`ed with a failure
    latch, so once `crawlSite` has rejected, nothing fires again (the engine's own contract, which
    the claim protocol assumes). Minors: the `::vector` probe is a bound parameter, `\p{M}` joins the
    tokenizer classes, a ZWNJ between two letters is no longer "invisible text", the batcher gained
    a character ceiling for CJK, and three unused dependencies went.
  - **`apps/worker`.** `knowledge.embed-batch`'s five retries fired at ~1/2/4/8/16 s — one minute of
    Voyage outage exhausted the job, and the handler's final rethrow left the ingest source
    `processing` with its claim token and nothing to release it. `retryDelay: 30` widens that to
    ~15 minutes, and on the LAST attempt the job now lands `failed`/`embed_failed` instead of
    rethrowing. A crawl's embed verdict arriving after the walk had already landed `ready` matched
    nothing at all (the guard was `processing`-only), leaving chunks with no vectors and no failure
    reason; it now flips `ready → failed` with the reason. `knowledge.ingest` gained the crawl's
    300 s lease — the deferral is REVERSED, deploys being routine — plus an advisory lock on the
    claim, and its second transaction hands the claim back before it throws. The crawl's end
    transition is one `CASE` write returning its own post-image, so the status and the reason it
    describes can no longer disagree. No crawled page text reaches a log line: a `DrizzleQueryError`
    carries the page in both `message` and `params`, so the warn logs the CrawlError's own fixed
    message plus a driver summary, and the consumer-origin rethrow is a fixed-message wrapper with
    the real error on a NON-enumerable `cause` — serialize-error copies own enumerable properties
    into `pgboss.job.output`, and `cause` from the options bag is not one.
  - **`apps/api` + `apps/app`.** The web drop zone unbound its four listeners while `disabled`, so a
    second drop during an upload navigated the tab to the dropped file and killed every in-flight
    `completeUpload`; it is now bound for the life of the zone, `preventDefault` is unconditional,
    and `disabled` is read through a ref at event time. A failed PUT or `completeUpload` left the
    minted `queued` row behind — "Queued for processing" forever, a `max_sources` slot held, and the
    screen polling with no job coming — so the pipeline now deletes that row best-effort, and the
    poll only counts `queued` rows younger than the presigned URL's own 10 minutes. A bad crawl URL
    showed zod 4's stringified issue JSON under the field; the contract is parsed client-side first
    and a server `BAD_REQUEST` renders fixed copy. Only a `FORBIDDEN` raises the plan-cap banner now
    — any other failure said "your plan is full" and sent the owner off to delete sources they still
    needed. Injection reasons render as sentences in the owner's words (with `role_marker`'s pasted
    -transcript false positive said out loud), Allow/Delete invalidate `knowledge.list`, and
    `Banner` gained a `warning` tone for the onboarding Skip confirmation. On the api: `refreshCrawl`
    also accepts `queued`, the presign runs before the transaction so a presign failure strands no
    row, the cap message names the limit rather than the settings key, `unflagChunk` returns
    `embedding IS NULL` instead of a 1024-dimension vector, the review pages' CSP gained
    `base-uri 'none'`, and cross-org `NOT_FOUND` is pinned for all four id-taking mutations.
  - **Seams and docs.** `@aesa/knowledge` and its sub-paths joined ESLint's app-bundle block (the one
    server package the rule had never named), and the `boss.send` ban gained a second selector so
    `deps.boss.send(` is caught as well as a bare `boss.send(`. `S3_CORS_ORIGIN` — read by
    `pnpm s3:init` alone, defaulting to `http://localhost:8081` — was undocumented, and the runbook's
    "run `s3:init` with production `S3_*` exported" would have written a localhost origin onto the R2
    bucket's CORS rule; it is now in CLAUDE.md, the runbook's command and both `.env.example`s.
    `KNOWLEDGE_EMBED_MODEL` joined `MAIL_FROM`/`APP_BASE_URL`/`APP_WEB_ORIGIN` as a value that must
    be IDENTICAL across replicas, with the retriever warning once per process per org when its
    vector leg comes back empty and a different `embedding_model` is stored. And the docs stopped
    describing a plan tier that is not live (see the `packages/core` line and deviation 6 above).
  - **Rulings the review added:**
    1. **ONE wave, THREE implementers run SEQUENTIALLY** on `phase-4` over a shared index, each
       committing its own area; the last one's docs commit records the wave.
    2. **REVERSED — the Task 8 deferral of the ingest lease.** `knowledge.ingest` claims with the
       crawl's 300 s stale-`updated_at` window (plus an advisory lock, since the status is
       `processing` on both sides of a stale re-claim). A deploy that stops pg-boss with its 30 s
       default and exits is routine, and the fix was the crawl's own six lines.
    3. **`refreshCrawl` also accepts `queued`** — a second job is harmless, because the two race for
       the same claim and the loser's guarded write matches zero rows. It is the owner's only way
       out of a crawl stranded by an exhausted retry until the Phase 7 sweep ships, so the source
       list offers Refresh on every crawl that is not `processing`.
    4. **Off-site links are filtered at discovery**, replacing the Task 7 park that preserved a
       `private_address` classification nothing ever consumed. The DNS-classifying order stays for
       the start URL and redirect hops, where it is load-bearing.
    5. **`knowledge.embed-batch` does NOT bump `knowledge_version`.** The version tracks the set of
       RETRIEVABLE chunks, and a chunk is lexically retrievable from ingest onward; "fully embedded"
       is `embedded_count = chunk_count`, a different question.
  - **Residuals after the final review** (parked, each with its reason):
    - **Queue options reach `pgboss.queue` only at a queue's FIRST-EVER registration.** `createQueue`
      inserts NULLs and ignores a second call; `insertJob` captures `COALESCE(job, queue, boss
      default)`, so a job sent before the first registration carries `retry_limit` 2, delay 0 and a
      15-minute expiry. Benign for crawl, an Important-1 in miniature for embed-batch in a
      first-deploy window. The fix is a `QUEUE_OPTIONS` table in `@aesa/queue` consumed by
      `defineJob` and BOTH pre-create lists — Phase 5.
    - **The Phase 7 stuck-source sweep now has three named customers:** a `queued` crawl with no job
      (after its retry is exhausted — `refreshCrawl` is today's manual escape), a `processing`
      source with unembedded chunks, and a `queued` upload that was never completed.
    - **The source cap can land one row over.** Read-then-insert with no lock, deliberately unlike
      the sandbox cap's advisory lock: this guards a count in the hundreds, not a real-money call. A
      partial unique index `(org_id, url) WHERE kind = 'crawl' AND status <> 'failed'` would also
      make `startCrawl`'s fresh insert and `refreshCrawl`'s resurrect consistent for a `failed` URL —
      Phase 5 polish.
    - **Crawler semantics recorded as deviations:** `sameSite` is the same hostname modulo `www.`
      (subdomains excluded, stricter than the plan's "registrable host"); CJK is Voyage-only for
      lexical purposes; a trailing slash is kept as a distinct URL.
    - **`knowledge.embed-batch` still holds no claim token** (the Task 8 ruling stands): its
      ingest-source status flips are guarded on status alone, and its crawl-source writes now also
      on `failure_reason IS NULL`.
    - **`EmbedError.retryAfterMs` is not honoured.** pg-boss computes a retry's `start_after` from
      the QUEUE's `retry_delay` inside `failJobs`; a handler cannot ask for a longer wait, and
      sleeping in-handler would hold the worker slot and burn the job's own expiry. The 30 s base is
      the answer instead; recorded in the module docstring.
    - **The `registerJob`-level drizzle-error scrub is parked for Phase 5.** Every job that rethrows
      a `DrizzleQueryError` puts its `query` and `params` into `pgboss.job.output`; the two knowledge
      paths that could carry customer text are fixed at the call site, and the general fix (rethrow a
      scrubbed error for every queue) is a `@aesa/queue` change worth doing once, deliberately.
    - **Parked Task 4–9 minors, by name:** `td`/`th` cells as separate blocks; the `push()`-returns
      -false branch; `@napi-rs/canvas` for PDF image extraction; the lockfile churn from A's
      dependency removal; `<br><br>` as a paragraph break; the preflight test's `'*'` branch; the
      content cap dropping the lowest-reranked passage; the retrieval coverage notes; the
      clamped-cosine-0 case; `relaxedTsQuery`'s English-shaped stop list; the `org_id` predicates
      that are not falsifiable under RLS; the lexical leg ignoring `embedding_model`; `ANALYZE`
      needing an owner; `collapse()` and French spacing; NXDOMAIN labelled `private_address`; the
      homepage fetched after the sitemap; `onProgress.ingested` counting buffered chunks;
      `child-runner`'s exit-vs-close race (never reproduced). On the api/app side: `deleteSource` on
      a `processing` source; `detail.title` as free text in an audit row; `gaps-card`'s unused
      `lastTicketId`.
  - **Gate after the wave** (minio up, the CI `S3_*` exported so the storage suite runs): typecheck
    and lint clean across all 15 packages/apps; `pnpm test` green with **2,129 tests** plus 4
    conditional skips (`@aesa/contracts` 25, `@aesa/crypto` 44, `@aesa/platform-mail` 18, `brand`
    110, `@aesa/core` 205, `@aesa/llm` 98, `@aesa/agent` 65, `@aesa/db` 77, `@aesa/queue` 17,
    `@aesa/mail` 237, `@aesa/knowledge` 144, `@aesa/test-kit` 43 [39 run + 4 conditional skips],
    `apps/api` 251, `apps/worker` 435 [including the three E2E files], `apps/app` 364 jest across 52
    suites — no database); `db:check` reports no drift; the Expo web export still produces **22
    static routes**; the Playwright signup smoke passes. The `e2e-phase3` case-10 timing flake did
    not fire.

### Phase 5 — autonomy and learning (complete; merged into `main` via PR #6 on 2026-09-11, merge commit `99a852d`)

- Review: `docs/superpowers/reviews/2026-09-11-phase-5-final-review.md` — the whole-branch review
  (0 Critical, 6 Important, one fix wave `03d2d2a` + `add8ad3`, the scoped re-review clean), the
  parked residuals with their rulings, and what the review verified holds.
- Plan: `docs/superpowers/plans/2026-09-11-phase-5-autonomy-and-learning.md` (11 tasks, executed with
  subagent-driven development). Commits **`93bc1d0..fb95d3b`** (22) on `phase-5`, branched from
  `main` at `ef81169` and merged as `99a852d` — the plan commit, a carry-over task, nine
  implementation tasks with their per-task fix commits, the Task 11 close-out (the E2E, the
  external-setup runbook and the docs), the whole-branch fix wave and its docs, the folded-in Phase 4
  hand-off correction, and the review record. The per-task list, newest last:
  `93bc1d0` plan · `ea7c4cc` T1 carries (the inbox keyset cursor as a row comparison; Gmail's
  `Authentication-Results` trusted only with its own authserv-id) · `8e0da6b` T2 contracts+core
  (autonomy/memory vocabulary, the evidence maths, three new `decide()` blockers) ·
  `6641c26` T3 the three new tables plus the draft/policy/workspace columns and the autonomy helpers ·
  `a2ba717` T4 `scrubForMemory` and the retriever's answers leg · `7a1aac1` T5 the `guidance_suggest`
  call · `1718b6d`+`cc16ba9` T6 evidence on every draft, the auto landing, `send.execute` from
  `auto_sending`, sandbox parity · `09ad6da`+`d745c66` T7 `memory.capture` / `guidance.suggest` and
  the `onSent` seam · `7d0dd15`+`065703d` T8 `stats.rollup` and `sweeps.daily`'s memory arms ·
  `ca5feaa`+`75411d5` T9 the api (Hold cancels an auto-send, `flagAutoSent`, inline demotion,
  `setCategoryPolicy`, the memory router) · `59ee73f`+`814345c` T10 the app (Autopilot, Learned
  answers, the Auto-sending countdown and Hold) · the T11 close-out commit · `03d2d2a` the FINAL FIX
  WAVE (the whole-branch review's seven fixes) and the docs commit after it. The per-task execution
  ledger was an ephemeral SDD artifact; everything load-bearing from it is distilled below, and the
  git history is the durable account.
  Gate at the FINAL FIX WAVE commit `03d2d2a` (minio up, the dev `S3_*` exported so the storage suite
  runs): typecheck and lint clean across all **15** packages/apps; `pnpm test` green with
  **2,364 tests** plus 4 conditional skips (`@aesa/contracts` 29, `@aesa/crypto` 44,
  `@aesa/platform-mail` 19, `brand` 110,
  `@aesa/core` 244, `@aesa/llm` 98, `@aesa/agent` 68, `@aesa/db` 85, `@aesa/queue` 17,
  `@aesa/mail` 242, `@aesa/knowledge` 162, `@aesa/test-kit` 43 [39 run + 4 conditional skips],
  `apps/api` 285, `apps/worker` 501 [including the four E2E files], `apps/app` 421 jest across 56
  suites — no database); `db:check` reports no drift; the
  Expo web export produces **24 static routes** (up from 22 — `(app)/settings/autopilot` and
  `(app)/settings/memory` are the two new route files; **25 since Phase 6**, which is the current
  baseline — this line records the Phase 5 gate); the Playwright signup smoke passed at the
  close-out commit and is untouched by the fix wave (still ending at the gated mailbox step, per
  Phase 2's Task 20 ruling — it runs against the SHARED dev database, so
  `DATABASE_URL=… pnpm --filter @aesa/db migrate` has to be run once after this phase's 0016/0017
  land or `workspace.create` fails with a 42703). The pre-existing `e2e-phase3.test.ts` case-10
  timing flake did NOT fire in either the close-out run or the fix wave's.
- What exists now:
  - `packages/contracts` — `autonomy.ts` (`CATEGORY_MODES`, `AUTONOMY_THRESHOLD_PRESETS`
    cautious 90 / balanced 80 / eager 70, `DEFAULT_AUTO_SEND_THRESHOLD`, `AUTO_SEND_DELAY_CHOICES`
    2/5/15, `SetCategoryPolicyInput`, `DEMOTION_REASONS`) and `memory.ts` (the four answer statuses,
    the retired/review reasons, the list/id/delete inputs, the guidance-suggestion vocabulary), three
    new `DECISION_REASONS` (`memory_conflict`, `unresolved_questions`, `thread_too_long`), four new
    notification kinds (`auto_send`, `graduation`, `demotion`, `memory_sample`),
    `RejectDraftInput.addToGuidance` and `FlagAutoSentInput`.
  - `packages/core` — `evidence.ts`: `memoryBand` / `memoryScore` / `evidenceScore`
    (`max(memory, grounding) × model`), `DEMOTION_RULES` + `evaluateDemotion`, `GRADUATION_RULES` +
    `evaluateGraduation`, and the memory constants (retrieve floor 0.70, 365-day expiry, 30-day
    candidate life, two strikes, six-message thread ceiling). `decide()` gained its three new
    blockers between `guardrail_warning` and `cold_start`; the settings catalog gained
    `notifications.push_auto_sends` (false) and `guidance.daily_suggest_cap` (50).
  - `packages/db` — `resolved_answers` (`vector(1024)`, the four statuses, approvals/strikes/reuse,
    the salted `source_customer_hash`, a self-referencing `supersedes_id`, a FIXED `expires_at`),
    `category_stats_daily` (eight counters, PK `(agent_id, category_id, day)`) and
    `guidance_suggestions`; `drafts.auto_decided_at` / `auto_held_at` / `flagged_at` / `flagged_by` /
    `memory_captured_at`; `agent_category_policies.suggested_at` / `_would_send` / `_of`;
    `workspaces.customer_hash_salt`; `customerHash` / `ensureCustomerHashSalt`; the autonomy helpers
    (`countHumanDecisions`, `readDemotionSignals`, `demoteCategory`, `graduateCategory`);
    `SEND_METERS.autoSends` and `GUIDANCE_METERS`. Migrations 0016–0017.
  - `packages/knowledge` — `scrubForMemory` (greeting line, sign-off block, email/phone/long-digit
    masks, the customer's own name) and the retriever's **answers leg**: vector-only, `status =
    'active'`, `embedding_model`-filtered, cosine ≥ 0.70, top 3, never fused into the chunk ranking
    and empty on the degraded path. `RetrievedAnswer` gained `approvals`.
  - `packages/agent` — `guidance/suggest.ts`: one Haiku call that turns one edited approval into one
    short general rule, or `null`.
  - `apps/worker` — evidence, the four new blockers and the **auto landing** on `ticket.draft` (an
    `approved` draft with `decision_source: 'auto'` beside a `queued` send due the agent's hold
    window, on an `auto_sending` ticket); `send.execute` delivering from `auto_sending` and metering
    `auto_sends` vs `review_sends` off `decision_source`; `memory.capture` (scrub → embed → insert or
    reinforce; a candidate for an auto-send; superseding on an edited reuse) behind `send.execute`'s
    post-commit `onSent`; `guidance.suggest`; the nightly `stats.rollup` (02:15 UTC — the sole writer
    of `category_stats_daily`, the Autopilot suggestion and `auto_graduate` graduation, the demotion
    backstop, the Monday sampling nudge); three new `sweeps.daily` arms (expired answers, unsampled
    candidates, answers whose source chunks moved); and the backstop's orphan arm widened to
    `auto_sending`.
  - `apps/api` — Hold cancels an auto-send and returns the ticket to review (`auto_held_at`, the
    guarded `auto_sending → awaiting_review` flip); `drafts.flagAutoSent`; the inline demotion check
    inside every owner correction (reject, flag, an edited approve of a held auto-send), so a
    category comes off Autopilot in the rejecting transaction rather than overnight;
    reject-to-guidance; `agents.setCategoryPolicy` with the cold-start lock; the `memory` router over
    `src/memory/service.ts` (`@aesa/api/memory`: summary, list, keep/retire, confirm/reject a
    candidate, delete-by-customer); the guidance-suggestion surface; the inbox's countdown data and a
    real `activity.autoSent`.
  - `apps/app` — the **Autopilot** screen (Off/Review/Auto per category with the cold-start lock and
    its live count, threshold presets, `auto_graduate`, the hold-window choice, the graduation
    suggestion banner and the demotion notice), the **Learned answers** screen (three tabs, sampling,
    keep/retire, *Forget one customer*), the inbox's Auto-sending countdown chip and Hold, the
    evidence line on the draft panel, "Should not have sent", reject-to-guidance, the suggested-rules
    card, and the `auto_send` push category with its Hold action.
- Deviations from the spec's Phase 5 list, as recorded in the plan (the spec wins on everything
  else):
  1. **`drafts.confidence` keeps meaning the model's self-assessment.** The chip is rendered from
     `confidence_breakdown.evidence` / `.threshold`; the stored column is not redefined, so no Phase 3
     surface changes meaning. The evidence number IS the number the auto gate compares.
  2. **Answers are retrieved workspace-wide, not per agent.** `resolved_answers.agent_id` is recorded
     for statistics and graduation; a `sales@` answer is reference material for `support@`'s prompt,
     which the persona block re-tones. Per-agent scoping is a `WHERE` away.
  3. **`push_auto_sends` is an org setting** (`notifications.push_auto_sends`, default false), not a
     `member_prefs` row — no such table exists yet. Per-member preferences arrive with Phase 7.
  4. **The Hold window is the agent's `auto_send_delay_min`** (default 2, UI offers 2/5/15), and an
     auto-send whose delay elapsed but whose `send.execute` job never ran is picked up by the backstop
     sweep's existing arm (d) — no new sweep. The E2E shortens the window through `ticket.draft`'s
     `enqueueSend` seam rather than allowing a 0-minute delay in the contract.
  5. **The weekly sampling nudge is a Monday-morning `memory_sample` notification** from
     `stats.rollup` (one per org per ISO week, only when a candidate exists), deep-linking to the
     Learned answers screen's *To check* tab. Unsampled candidates are retired after **30 days**
     (`unsampled`) so the queue stays bounded — the spec says only that they are never retrieved.
  6. **Windows the spec leaves open are fixed in one object** (`DEMOTION_RULES`): two rejections in
     7 days, two "should not have sent" flags in 30 days, the edit-rate rule over 30 days.
  7. **A reject's reason becomes a guidance rule only when the owner ticks "Also add this to your
     operating guidance"** — a direct, LLM-free append bounded by the 8,000-char cap. The LLM-drafted
     `guidance_suggest` runs only after an **edited** approval.
  8. **A model-flagged memory conflict parks the answer at `needs_review` at draft-landing time**,
     on every landing kind (one guarded `UPDATE` inside `applyDraftOutcome`'s transaction), not only
     when a draft is sent — which is what makes the Verify list's "contradiction → `needs_review`"
     true even for a draft that is then rejected.
  9. **An edited approval that reused an answer supersedes it**: the new answer carries
     `supersedes_id`, the old one goes `needs_review` with one strike (two strikes retire). Straight
     retirement was rejected — an edit can be tone, not fact.
  10. **`category_stats_daily` is recomputed for the trailing 30 days every night**, not incremented
      by every writer; the api reads the table for the 30-day line and the live `drafts` rows for the
      cold-start count and every demotion check, so a demotion never waits for the rollup.
  11. **Carries folded in (Task 1):** the inbox keyset cursor and the DMARC authserv-id check (see
      *Carries closed* below).
  12. **Sandbox parity is informational.** `agent.sandbox` computes evidence and passes the three new
      blockers so its verdict matches a real draft's; it never creates an answer and never auto-sends.
- Execution-time rulings recorded during the build (the owner's words, one line each):
  1. Work in the main checkout on branch `phase-5` — the repo's standing practice; no worktree.
  2. The Learned-answers screen calls the router procedures `memory.keep` / `memory.retire` while the
     service functions stay `keepAnswer` / `retireAnswer` — a naming split fixed once, in the plan.
  3. The guidance-suggestion schema keeps `.trim().min(1)`: an empty-string rule is meaningless and
     `null` is already the "no rule" signal.
  4. **The plan's rollup recipe was defective against the spec's per-day table.** The trailing window
     is the UTC MIDNIGHT of `now − 30 d`, and the `drafted` counter is guarded on
     `created_at >= cutoff`; a test seeds a complete older row and proves the pass leaves it intact.
     Without it, every night's full-replace upsert overwrote historical rows and the instant cutoff
     shaved the oldest in-window day.
  5. **The global lock order gains a FOURTH position** — `outbound_sends → drafts → tickets →
     resolved_answers/workspaces` — matching the worker, because `applyDraftOutcome` locks the ticket
     and then flags a conflicting answer in one transaction. `rejectDraft` was reordered (ticket
     branches first, learning writes after, on both branches) and wrapped in `withDeadlockRetry`.
  6. `deleteByCustomer` audits even the no-salt path: "every tRPC mutation writes one audit row" is a
     rule, and "someone asked us to forget this customer and there was nothing to forget" is exactly
     what a privacy trail has to show.
  7. `drafts.edit_distance_ratio` is always a number on approve (0 or the levenshtein ratio), and
     rejected and auto drafts are excluded from the human-decision counters — so the rollup's `?? 0`
     cannot inflate graduation.
  8. `expo export --platform web` prints **Static routes (24)** at this phase's close (Phase 6 took
     it to 25); `inbox.test.tsx`'s four `act()`
     warnings are pre-existing on `main` (verified with `git stash -u`).
  Deviations the task reviews accepted: `MockMailbox`'s default `Authentication-Results` became
  `mx.google.com; dmarc=pass` (T1); the CHECK-violation assertion uses
  `toMatchObject({ cause: { constraint } })` and the migrations are `0016_cool_phalanx` +
  `0017_autonomy_hardening` (T3); the scrub's sign-off window widened from the back third to the back
  half and `PHONE_RE` now requires a separator so a bare digit run masks as `[number]` (T4);
  `landDeadLetter` reads the ticket status live, `SandboxOutputView.evidence` is required, and both
  older E2E harnesses gained a no-op `enqueueSend` (T6); one extra org-cap-override test and an
  inline org-settings read (T7); `agents.categories` answers NOT_FOUND for a foreign agent id,
  `RejectInput.addToGuidance` is required (four `e2e-phase3` call sites updated),
  `setCategoryPolicy` locks the policy row `FOR UPDATE`, and `memory.summary` is a flat shape (T9);
  `DraftView` gained `flaggedAt` (T10). Five tasks needed a fix round — one item each except T9's,
  which addressed TWO: T6 (the backstop's orphan arm now covers `auto_sending`), T7
  (`guidance.suggest` honours the global killswitch), T8 (the day-aligned cutoff above), T9 (the
  lock-order reorder AND the no-salt audit) and T10 (one shared `m:ss` countdown for the bar and the
  chip).
- The E2E: `apps/worker/test/e2e-phase5.test.ts`, **8 scenarios**, one throwaway database, one
  pg-boss schema of its own, the REAL `mailbox.sync` → `ticket.triage` → `ticket.draft` →
  `send.execute` → `memory.capture` chain, the REAL api draft and memory services, and the REAL
  retriever sharing ONE hash embedder with `memory.capture` — (1) three customers ask the same
  question and three plain approvals teach ONE answer (approvals 1→3, `reuse_count` 2), the memory
  score it lends the next draft rising 0 → 1/3 → 2/3 and the third draft's evidence landing at
  `(2/3) × 0.9`; (2) with ten human decisions behind it and the category on Auto at 80%, the fourth
  question lands `approved` / `decision send` / `decision_source auto` on an `auto_sending` ticket
  beside a `queued` send, goes out marked and signed, meters `auto_sends` 1 with `review_sends`
  unchanged, and becomes an UNSAMPLED candidate; (3) Hold inside the window holds the send, returns
  the draft to `pending` with `auto_held_at` and the ticket to `awaiting_review`, and `send.execute`
  then finds nothing claimable; (4) the candidate is invisible to retrieval until `confirmCandidate`,
  proven from the recorded `ChatRequest`'s own knowledge block before and after; (5) a
  `memoryConflictIds` flag parks that answer at `needs_review`/`model_conflict` and lands the draft in
  `awaiting_review` with `decision_reason memory_conflict` even in Auto; (6) two rejections in a day
  demote the category (`demoted_reason rejections`, ONE `demotion` notification) and strike the reused
  answer twice, retiring it; (7) back on Autopilot, a tripwire phrase still parks the ticket at
  `needs_owner/tripwire` with no model call at all and a DMARC failure still lands `dmarc_fail` in
  review, neither auto-sent; (8) delete-by-customer erases exactly that customer's answers, leaves
  the rest, and audits a COUNT rather than the address. No wall-clock sleeps: every wait polls for the
  state it expects under a bounded deadline, and the hold window is collapsed by the `enqueueSend`
  seam (plan deviation 4) with a test-controlled gate so scenario 3's Hold provably runs first.
- **Carries CLOSED by this phase:**
  - **The inbox keyset cursor** (open since Phase 2, named again in Phase 3's whole-branch review):
    the predicate is now a row comparison `(sortKey, id) < (cursorTs, cursorId)` over an opaque
    base64url cursor carrying the RAW `timestamptz` text, so same-millisecond rows no longer drop.
  - **The DMARC first-match re-examination** (deferred from Phase 3 to "Phase 5, with `decide()`'s
    auto branch"): the Gmail adapter now trusts the topmost `Authentication-Results` only when it
    carries Gmail's own authserv-id (`mx.google.com;`). Graph's header has no authserv-id by design
    and is trusted as the topmost header, as before.
  - **The push's Hold action** (Phase 3 whole-branch review: "cannot succeed until Phase 5"). It can
    now: `auto_send` is its own push category carrying Review + Hold, `draft_review` keeps Review
    alone, and `holdDraft` accepts exactly the `approved` draft + `queued` send an auto landing
    writes.
  - **`memory.capture`** itself (Phase 3 plan deviation 5): `send.execute`'s `onSent` seam is wired,
    and the no-op is gone.
  - **The whole-branch final review's SEVEN fixes**, all in the final fix wave (`03d2d2a`) — the first
    two are the findings this phase's own close-out had left open:
    - **`scrubForMemory` could erase a short reply outright.** The sign-off cut now has three bounds,
      not one: the trailing HALF as before, PLUS it never removes the message's first content line,
      and a candidate sign-off line qualifies only when at most three non-blank lines follow it (a
      sign-off block is short). "Thanks for getting in touch. I have checked …" now scrubs to itself,
      and `packages/knowledge/test/scrub.test.ts` pins that body and the "answer, then a real
      sign-off block" shape; a greeting-plus-sign-off message still scrubs to the empty string.
    - **`activity.summary.autoSent` is rendered.** The Activity screen carries an **Auto-sent** tile
      beside **Sent** (`stat-auto-sent`), with its own test row.
    - **An auto-send survived its category's demotion.** `send.execute` gained a seventh kill lever,
      `category_not_auto` (right after `category_off`): an auto-decided draft whose category is no
      longer on Autopilot lands `held` through `landHeld`, with the owner's sentence in the app's
      `HOLD_REASON_LABEL`. A human-approved draft is untouched — a Hold + re-approve already rewrites
      `decision_source` to `app`.
    - **"Should not have sent" was unreachable from the ticket screen.** `loadLiveDraftView` now
      serves the newest `sent` + `decision_source = 'auto'` draft on a `waiting_on_customer` ticket
      when no live draft is left, bounded by the ticket status exactly like the `failed` fallback.
    - **The autonomy helpers had no `org_id` predicate** while running under `withOrgIdentity` in
      `stats.rollup` (platform role, no RLS): `readDemotionSignals` takes `orgId` and filters on it,
      and both guarded policy UPDATEs match it too.
    - **A lost update on `workspaces.operating_guidance`.** Both appenders — `rejectDraft`'s
      "add this to your guidance" and `workspace.acceptSuggestion` — read the row `FOR UPDATE`; the
      workspace row is the LAST position in the global lock order, so nothing inverts.
    - **Auto-sent activity now folds into the daily digest email** (spec §Notifications): one line,
      "N replies went out on their own in the last 24 hours.", counted in the same short read
      transaction as the digest's items and omitted at zero. It never decides whether a digest is
      sent — a workspace fully on Autopilot with nothing pending still gets no mail.
- **Carries still open** *as of Phase 5's close* — this list is a record of that moment, not the
  current one. **The live list is the Phase 6 record's own "Carries still open" below**, which is this
  list with what Phase 6 closed removed. Everything below that points at "Phase 6" has since been
  either closed or re-pointed there. Grouped:
  - **From Phase 4, unchanged:** the stuck-source sweep (a `queued` crawl with no job, a `processing`
    source with unembedded chunks, an abandoned `queued` upload) → **Phase 7**; the source cap's
    read-then-insert race and two concurrent `startCrawl` calls for one new URL (both accepted and
    commented); a crawl does not resume, so a re-entry re-walks from the start URL.
  - **Phase 4 residuals that named Phase 5 and did NOT land** — all three move to **Phase 6**: queue
    options reaching `pgboss.queue` only at a queue's FIRST-EVER registration (the fix is a
    `QUEUE_OPTIONS` table in `@aesa/queue` consumed by `defineJob` and both pre-create lists); the
    partial unique index `(org_id, url) WHERE kind = 'crawl' AND status <> 'failed'` that would make
    the source cap and `refreshCrawl`'s resurrect consistent; and the `registerJob`-level
    drizzle-error scrub, so no job's rethrow can put a `query`/`params` pair into `pgboss.job.output`.
  - **Long-standing, unchanged:** the api's three in-memory rate limiters (per-replica since Phase 1);
    `platform.access` audit retention → **Phase 7**; the Better Auth 1.7.3 ↔ `drizzle-orm` peer bump;
    `packages/db/test/keys.test.ts`'s order-dependence; the `apps/app` accessibility minors including
    the draft panel's "Blocked: …" lines rendering as plain `Text`; the three-pane review layout,
    J/K navigation, multi-select and the stubbed-provider Playwright walk → **Phase 7**; the
    `pg_try_advisory_lock` slot pool → **Phase 7**; the `workspaces.kill_switch` Settings toggle →
    **Phase 7**; `agent_runs.kind = 'triage'` rows → **Phase 6**; `notify.digest`'s email pass scanning
    every workspace on each 5-minute tick; the org-cap arm of the backstop busy loop; emoji
    presentation flattening; `blocks.ts` still telling the model bidi controls are "rejected"; a
    re-approve inside the undo window landing up to ~2 minutes late; `sweeps.daily` holding write
    locks across every expiring draft for the whole pass; the hand-authored cache-hit fixture;
    `sendFailureLabel`'s untested coupling to worker-owned literals; and Phase 3's list of smaller
    review minors, unchanged.
  - **The ledger's deferred minors**, one line per area. *Contracts/core:* no test pins the precedence
    among the three new `decide()` branches themselves; `GUIDANCE_SUGGESTION_STATUSES` has no
    companion type alias; `memoryScore` floors `approvals` (not in the spec's literal formula).
    *db:* `readDemotionSignals` has no boundary test for `decisionWindowDays` (the other two windows
    do). *knowledge/mail:* the scrub's sign-off window is the back HALF (now with two further
    bounds — see *Carries CLOSED* above); the keyset test spaces rows 100 µs apart so the id-tiebreaker path itself is uncovered; the cursor
    predicate checks both halves though `parseCursor` returns them together; the DMARC re-examination
    note landed on `parseAuthResults`' JSDoc rather than the `DMARC_METHOD_RE` block; `MockMailbox`'s
    Gmail authserv-id default is inert in graph mode. *worker:* the evidence maths is duplicated
    between `ticket-draft.ts` and `agent-sandbox.ts` (a pure helper in `drafting/` would be better);
    `ticket-draft.ts` re-implements `caps.ts`'s private `meterValue`; a stale "Guarded on
    awaiting_review" comment in `send-execute.ts`; `SandboxOutputView.evidence` is required, so a
    stored pre-Phase-5 sandbox output `safeParse`s to null; the daily auto-send cap reads the
    DELIVERED-count meter, so a burst inside one hold window can overshoot it; the 8-blocker
    `it.each` asserts the reason but not the matching `blockers.*` flag; `sweeps.daily` expires a
    `held` draft without escalating (arm (c) now compensates on a delayed clock); two definitions of
    "edited" (`memory.capture` strikes above ratio 0, `guidance.suggest` skips under 0.05); the
    reinforce UPDATE is not re-guarded on `status = 'active'`; `memory.skipped` audits
    `empty_after_scrub` even when it was the embedder that returned nothing; no test kills
    `memory.capture`'s `&& !auto` gate; `guidance.suggest`'s source-draft and `decision_source` skips
    are untested; `agent-role.ts`'s missing-key warning string still names only three jobs;
    **`memory.capture`'s embed spend is neither metered nor capped**; `ensureCustomerHashSalt` mints
    a salt even when the ticket has no customer email; the graduation sample's ordering is not proven
    by a test; `auto_sent_flagged` bumps on `flagged_at` alone; the `held` counter is gated on
    `auto_decided_at`'s window rather than `auto_held_at`'s; `stats.rollup` queues notification ids
    before `maybeNudge` runs in the same SAVEPOINT; the singular nudge copy is untested and the
    per-org draft load is unbounded. *api:* `rejectCandidate` returns ok for a candidate retired
    mid-call; `retireAnswer`'s `returning({ status })` is unused; `src/drafts/service.ts` is over
    1,100 lines with `src/drafts/learning.ts` named as the next split seam.
    *app:* the mode/delay/auto-graduate radios
    give no in-flight feedback; the suggestion CTA is not disabled under the cold-start lock (inert —
    a suggestion needs 20 decisions); one screen-level error banner serves every category and the
    code is not cleared on an agent switch; "Deleted 1 answers"; the delete-by-customer armed state
    survives a tab switch; a fourth copy of `relativeTime`; `autopilot.tsx` writes
    `AUTONOMY_THRESHOLD_PRESETS.balanced` where `DEFAULT_AUTO_SEND_THRESHOLD` would say why;
    `formatCountdown` has no NaN guard (unreachable); and several error/empty-state strings are
    untested. *Reports only:* Task 5's index-ordering claim and Task 7's claim that the shared
    embedder is test-asserted (only its definedness is).
  - **From the WHOLE-BRANCH final review, what the fix wave did NOT take** (the seven it did take are
    in *Carries CLOSED* above, in commit `03d2d2a`). Several of these restate a ledger minor; they are
    grouped here because they are what the final review itself chose to leave standing.
    *Structure:* `apps/api/src/drafts/service.ts` is still one file — the `src/drafts/learning.ts`
    split is **Phase 6 cleanup**, not a Phase 5 item; the evidence maths still has no shared helper
    (`ticket-draft.ts` and `agent-sandbox.ts` each compute it); `relativeTime`, the reason-label
    `lookup` and `meterValue` each exist in several copies.
    *Coverage:* no E2E exercises the **`flags`** demotion trigger (two "should not have sent" flags in
    30 days) — only the `rejections` one.
    *Worker:* `memory.capture`'s embed spend is neither metered nor capped (→ **Phase 6**, with BYOK);
    the reinforce UPDATE is not re-guarded on `status = 'active'`; `memory.skipped` audits
    `empty_after_scrub` even when it was the embedder that returned nothing; `sweeps.daily`'s arm (f)
    joins without an `org_id` predicate and scans unbounded; `stats.rollup` bumps its counters and
    queues its notification ids before `maybeNudge` runs in the same SAVEPOINT;
    `category_stats_daily`'s PK does not lead with `org_id` (the convention, not a test).
    *api/contracts:* `activity.summary` still leans on `edit_distance_ratio IS NULL` to keep auto
    drafts out of the approved split rather than on `decision_source`; `guidance.suggest` reads the
    PLATFORM killswitch but not the workspace's own; `SandboxOutputView.evidence` is required, so a
    stored pre-Phase-5 sandbox output `safeParse`s to null.
    *App polish:* the mode/delay/auto-graduate radios give no in-flight feedback; the suggestion CTA
    is not disabled under the cold-start lock; one screen-level error banner serves every category;
    "Deleted 1 answers"; the delete-by-customer armed state survives a tab switch; `formatCountdown`
    has no NaN guard; `autopilot.tsx` writes `AUTONOMY_THRESHOLD_PRESETS.balanced` where
    `DEFAULT_AUTO_SEND_THRESHOLD` would say why.

### Phase 6 — provider choice (BYOK) (complete on branch `phase-6`; PR pending Robert)

- PR #7 (https://github.com/ClosingBracketsLLC/ai-email-support-agent/pull/7) is open against
  `main`, CI green. Two CI-only commits sit above the reviewed head `25aad56` and are not part of the
  record below: `021d66e` (Docker Hub's `minio/minio:latest` became unpullable on 2026-09-12 — `main`'s
  own last CI run failed the same way — so `compose.yaml` and `ci.yml` pull the pinned
  `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`) and `92b1a77` (a 20 s jest `testTimeout` for
  `apps/app`: a suite's FIRST test pays jest-expo's cold start on a loaded runner and hit the 5 s
  default; a passing test never waits on it).
- Review: `docs/superpowers/reviews/2026-09-12-phase-6-final-review.md` — the whole-branch review
  (four area reviewers, 0 Critical, 12 Important, one fix wave `f5df280`+`a079dde`+`7a3b77f`, the
  scoped re-review clean with four Low residuals), the parked residuals with their rulings, and what
  the review verified holds.
- Plan: `docs/superpowers/plans/2026-09-12-phase-6-provider-choice.md` (11 tasks, executed with
  subagent-driven development). Commits **`0449596..`** (43) on `phase-6`, branched from `main` at
  `99a852d`, the last of them this close-out's docs commit — the Phase 5 hand-off cherry-pick, the
  plan commit, ten implementation tasks with their
  per-task fix rounds, the whole-branch fix wave, and the Task 11 close-out. The per-task list,
  newest last:
  `0449596` the Phase 5 hand-off cherry-pick · `266532f` plan ·
  `41d78c1`+`985cadc`+`fd7bb6b` T1 the three Phase-4 carries (the crawl partial unique index 0018;
  `QUEUE_OPTIONS` as the ONE source of queue options read by `defineJob` and both pre-create lists;
  `registerJob`'s `DrizzleQueryError` scrub) ·
  `7775535`+`3bb21e8` T2 contracts+core (the LLM vocabulary and provider catalog, quality tiers and
  their caps, `provider_unavailable` / `provider_health` / `model_changed`) ·
  `1fb72a6`+`797ef34` T3 the four tables (migrations 0019–0020), `resolveModelConfig`,
  `loadModelPricing`, the BYOK cost meter ·
  `5567762`+`15649a8`+`c5cf3a4`+`253488d`+`335c450` T4 `createPinnedFetch`, the port's `listModels`
  and `'plain'` rung, the OpenAI-compatible adapter, `probeProvider` / `createByokProvider`, the
  two-adapter contract suite ·
  `6e7db0e`+`9c98b39`+`8bb13b2`+`8bcfc45`+`b5bfaaf`+`0513b25` T5 `provider-resolver.ts`, the
  `llm.probe` job and the `llm.reprobe-sweep` cron, the agent role's KEK gate, `provider_health`
  push routing ·
  `0321a79`+`543fc22`+`0db1dd3`+`509e16d`+`9b10465`+`29e1e2e` T6 the model in the prompt input,
  `drafting/evidence.ts`, `ticket.draft` on the resolver (`provider_unavailable`,
  `fallback_to_managed`, the tier-capped breakdown), the sandbox/triage/`guidance.suggest` on it,
  `agent_runs.kind='triage'`, `memory.capture`'s embed metered and capped ·
  `bb1b491`+`d147d1f` T7 graduation by quality tier and the `model_generation_at` window ·
  `fae00ad`+`69bf221`+`e007d31`+`9c223e5` T8 the api's `llm` service and router, `agents.list`'s
  Model line ·
  `0870066`+`a7d54a8`+`6bb827f` T9 Settings → AI (**route 25**), the agent's Model card, the model
  in the agent list row ·
  `799cefa`+`30bc655`+`3018e71` T10 the Phase 6 E2E and the Phase 5 `flags` scenario, then the late
  ruling that the probe may RAISE a preset ·
  `f5df280`+`a079dde`+`7a3b77f` the FINAL FIX WAVE (the whole-branch review's twelve Important
  findings, deduplicated to ten changes, plus two ledger minors) · `024ff65` the re-review's two
  one-line Low residuals · the Task 11 close-out commit (this record, the runbook, CLAUDE.md, the
  env examples, the plan's execution rulings, the review record). The per-task execution ledger was
  an ephemeral SDD artifact; everything load-bearing from it is distilled below, and the git history
  is the durable account.
  Gate at the close-out commit (minio up, the dev `S3_*` exported so the storage suite runs):
  typecheck and lint clean across all **15** packages/apps; `pnpm test` green with **2,599 tests**
  plus 4 conditional skips (`@aesa/contracts` 36, `@aesa/crypto` 52, `@aesa/platform-mail` 19,
  `brand` 110, `@aesa/core` 247, `@aesa/llm` 158, `@aesa/agent` 71, `@aesa/db` 95, `@aesa/queue` 23,
  `@aesa/mail` 242, `@aesa/knowledge` 162, `@aesa/test-kit` 43 [39 run + 4 conditional skips],
  `apps/api` 301, `apps/worker` 586 [including the five E2E files], `apps/app` 458 jest across 58
  suites — no database); `db:check` reports no drift; the Expo web export produces **25 static
  routes** (up from 24 — `(app)/settings/ai` is the one new route file); the Playwright signup smoke
  passes (still ending at the gated mailbox step, per Phase 2's Task 20 ruling — it runs against the
  SHARED dev database, so `DATABASE_URL=… pnpm --filter @aesa/db migrate` has to be run once after
  this phase's 0018–0020 land or it fails). The pre-existing `e2e-phase3.test.ts` case-10 timing
  flake did NOT fire in the close-out run.
- What exists now:
  - `packages/contracts` — `llm.ts`: `LLM_PROVIDERS` (anthropic, openai, deepseek, groq, together,
    openrouter, custom) and `PROVIDER_PRESETS` (base URL, consent name, key hint, suggested models
    with their tiers), `MANAGED_MODELS` — now the ONE source `DRAFT_MODEL_ID` aliases —
    `QUALITY_TIERS` / `qualityTierFor` / `presetModel`, `AddCredentialInput` / `SetAgentModelInput` /
    `CredentialIdInput`, `ProbeResult` / `ProbeResultView`, `LLM_MAX_CREDENTIALS` (5), and
    `LLM_ERROR_MESSAGES` (the ONE source of Settings → AI's soft-refusal sentences, thrown by the
    router and keyed on by both screens). Plus the new `provider_unavailable` needs-owner reason, the
    `provider_health` notification kind and the `model_changed` demotion reason.
  - `packages/core` — `quality.ts`: `QUALITY_CAPS` (calibrated 1.0 / standard 0.9 / limited 0.6),
    `cappedModelConfidence`, `graduationRulesFor` (20 / 40 / never); `evaluateGraduation` takes an
    optional rules override. `decide()` itself is untouched.
  - `packages/crypto` — `createPinnedFetch`: a `fetch`-shaped transport an SDK accepts for its
    `fetch` option, re-validating and re-resolving on EVERY call (so a rebinding hostname is refused
    on the second request) and refusing a redirect rather than following it.
  - `packages/queue` — `QUEUE_OPTIONS` / `queueOptionsFor` (`queue-options.ts`), the ONE source of
    every queue's policy/retry/backoff/expiry, read by `defineJob` AND both pre-create lists;
    `RegisteredJobDefinition` (so a hand-built definition without queue options is a compile error);
    `scrubJobError`, keeping a `DrizzleQueryError`'s `query`/`params` out of `pgboss.job.output` for
    every job at once.
  - `packages/db` — `llm_credentials` (api-visible metadata: health, `key_fingerprint`,
    `last_probe`, `consecutive_failures`, `last_error`), `llm_credential_secrets` (platform-role-only,
    `REVOKE`d from `aesa_app` outright), `agent_model_config` (per agent × role, `NULLS NOT DISTINCT`
    unique) and the platform table `model_pricing`; `resolveModelConfig` / `managedConfig` /
    `ResolvedModelConfig` (`model-config.ts` — the ONE reader of an agent's model choice, api AND
    worker), `loadModelPricing` (`pricing.ts`), `LLM_METERS.costMicrosByok`, `llm_calls`'s
    `mode` / `credential_id` / `cost_unknown`, `DEMOTION_COPY.model_changed`,
    `escalationCopy.provider_unavailable`. Migrations 0018–0020.
  - `packages/llm` — a SECOND adapter (`adapters/openai-compatible/`: one dialect, six presets, a
    per-model capability seed), the port's optional `listModels` and `ChatMeta.mode`/`.credentialId`,
    the ladder's missing `'plain'` rung (the `'none'` capability, carried since Phase 3),
    `core/shared.ts` as the ONE scrub/envelope implementation, `probeProvider` (models list, one tiny
    chat, a structured probe driving the RAW adapter's rungs), `createByokProvider` + `withMeta`
    (pinned fetch by default, the limiter keyed `byok:${orgId}:${credentialId}`), the BYOK pricing
    rows, and `runProviderContract` on the `@aesa/llm/testing` sub-path run against BOTH adapters.
    `openai@7.15.0`, pinned exactly, is the phase's one new runtime dependency.
  - `packages/agent` — the MODEL moved out of the package: `DraftPromptInput.model` (and `effort`
    widened to include `'low'`), `runGuidanceSuggestCall`'s `model` parameter, and
    `runTriageCallDetailed` (+ `TriageCallResult`) so the worker can record which provider answered.
  - `apps/worker` — `provider-resolver.ts`, the ONE way a worker gets a provider
    (`createProviderResolver` with its freshness-keyed per-credential cache, `staticResolver` /
    `staticRefusal`, `openCredentialKey`, `secretAad`, `markCredentialDead`, `FALLBACK_CODES`,
    `cacheTtlFor`); the `llm.probe` job (store the sealed key, probe, land the verdict, re-wrap under
    the org DEK) and the `llm.reprobe-sweep` cron (`15 */6 * * *`, `cron` role);
    `provider-health-notify.ts`; `drafting/evidence.ts` as the ONE home of the evidence maths, where
    the tier cap bites; `ticket.draft` / `ticket.triage` / `agent.sandbox` / `guidance.suggest` all on
    the resolver, with `provider_unavailable` landings and the opt-in `fallback_to_managed`;
    `ticket.triage` writing its own `agent_runs.kind = 'triage'` rows; `memory.capture`'s embed
    metered on `KNOWLEDGE_METERS.embedTokens` and gated by `knowledge.daily_embed_tokens_cap`;
    `stats.rollup` graduating by tier and windowing on `model_generation_at`; the KEK ring now gating
    the `agent` role at boot.
  - `apps/api` — an `llm` router over `src/llm/service.ts` (`@aesa/api/llm`): add a connection (seal
    the pasted key, enqueue `llm.probe`), probe, remove, per-agent model get/set with the
    `model_changed` demotion in the same transaction as the generation bump, and per-credential
    30-day usage from `llm_calls`; a `model` line on `agents.list`; a `sandboxStart` that stamps the
    agent's RESOLVED provider/model; Activity's cost tile carrying the BYOK half.
  - `apps/app` — **Settings → AI** (route 25: Managed AI vs provider connections, add/probe/remove,
    health chips, the models list and structured verdict, per-credential 30-day usage, the BYOK
    consent sentence), the agent edit screen's **Model** card (provider, model, effort, fall back to
    Managed AI, with the pre-save "this demotes your Autopilot categories" banner), the model each
    agent runs on in the agent list row, and `provider_health` push routing to `/settings/ai`.
- Deviations from the spec's Phase 6 list, as recorded in the plan (the spec wins on everything
  else):
  1. **`org_data_keys` is reused unchanged** (Phase 0): a BYOK key is sealed to the org's box public
     key, rides the `llm.probe` payload and is re-wrapped under the org DEK by the worker — the exact
     `mailbox.store-credentials` shape. The spec's `key_ciphertext`/`key_nonce`/`data_key_version`
     collapse to `key_ciphertext` + `encryption` (`sealed`|`dek`) + `data_key_version`.
  2. **`agent_model_config` is per agent × role (`draft`, `triage`) in v1.** `guidance_suggest`
     follows the agent's `triage` row; `probe` has no config row. The `agent_id IS NULL`
     workspace-default row the spec admits is allowed by the schema but written by no v1 surface.
  3. **`model_generation` semantics.** Changing an agent's draft provider, model or mode bumps it,
     stamps `model_generation_at`, demotes every `auto` category of that agent to `review` with the
     reason `model_changed` and clears pending graduation suggestions, all in one transaction;
     `stats.rollup` evaluates graduation only over decisions at or after `model_generation_at`.
  4. **No `echo` tool probe** (tools are off in v1). The probe is: models list, one tiny chat, and a
     2-field structured probe. *Amended during execution* — see ruling 16 below: the probe tries
     `native` first for every non-Anthropic provider regardless of the preset, and the stored verdict
     overrides in BOTH directions.
  5. **`egress_allowlist[]` is cut.** A credential's `base_url` host IS its allowlist — validated at
     write and pinned at every call. `transport` lands as a `text` column (`direct` only, CHECK) as
     the spec's on-prem seam; no bridge, no `extra_headers`.
  6. **Tier numbers and rules are fixed here** (the spec gives "capped at 0.6" and "scale with a
     model-quality tier" without numbers): three tiers, caps 1.0 / 0.9 / 0.6, graduation
     `minDecisions` 20 / 40 / never, all in `QUALITY_CAPS` and `graduationRulesFor`.
  7. **Error policy, narrowed to what lands.** `auth` on a BYOK credential → `dead`, ONE
     `provider_health` notification (day-deduped per credential), the ticket to `needs_owner` with
     `provider_unavailable` and no retry. `rate_limit`/`transient` keep the existing job retry.
     **`context_too_long`'s "halve retrieval, retry once" is NOT implemented** (carried).
     `fallback_to_managed` is one managed retry on `auth`/`rate_limit`/`transient` when the flag is on
     AND the replica has `ANTHROPIC_API_KEY`, metered as `mode = 'managed'`.
  8. **Re-probe cadence is a `cron`-role cron** `llm.reprobe-sweep` every 6 hours for every credential
     not `dead` and not probed in the last 6 hours; `degraded` after 2 consecutive failures, `dead`
     only on `auth` (and sticky); a `dead` credential is re-probed only by the owner's Test connection.
  9. **`model_pricing` is a platform table seeded by migration** (RLS_EXEMPT), loaded once at worker
     boot, falling back to `PRICING_SEED` when empty. No admin UI; a price change is a migration.
     BYOK cost lands in the separate meter `llm_cost_micros_byok`.
  10. **Settings → AI is ONE new route** (24 → 25); the per-agent override is a Model card on the
      existing agent edit screen, not a route. Onboarding is untouched.
  11. **Local endpoints need https and a public address in v1** (non-standard ports allowed):
      `http://localhost:11434` Ollama is unreachable until the spec's bridge lands, and Ollama/vLLM/
      LM Studio are ONE catalog entry, `custom`, not three presets.
  12. **OpenAI `json_schema` is sent non-strict** (strict mode would rewrite the draft schema's
      optional fields); the ladder's lower rungs cover a non-strict miss. Recorded as the preset quirk
      `strictJsonSchema: false`.
  13. **Carries folded in.** T1: `QUEUE_OPTIONS`, the `registerJob`-level drizzle scrub, the crawl
      partial unique index. T6/T7: `agent_runs.kind = 'triage'` rows, `memory.capture`'s embed metered
      AND capped, the shared evidence helper. T10: the `flags` demotion E2E scenario.
- Execution-time rulings recorded during the build, in order (one line each):
  1. Task 4's probe test drives the RAW fake, not `withStructuredLadder` — the probe's contract is
     "drive the raw adapter's rungs itself"; through the ladder it would test the ladder.
  2. `push-routing.ts`'s `provider_health` entry is Task 5's edit and Task 9 asserts it, so one task
     owns each file edit.
  3. The brief's "label map" IS `REASON_CHIP` (1–2 word labels), so `'AI provider unavailable'` stays
     there and `REASON_SENTENCE` gets a sentence in its siblings' voice.
  4. Keep the `deepseek-chat`/`deepseek-reasoner` catalog ids and pricing rows for now — an unverified
     web claim should not drive a mid-phase catalog churn; the probe on a real key shows the truth,
     and the runbook (ruling 23) tells Robert to re-verify before DeepSeek is offered.
  5. Task 4's shape ratified: `runProviderContract` on the `@aesa/llm/testing` sub-path (the root
     would drag vitest into production graphs), `withCauseMessage` lifted to `core/shared.ts`, the
     brief's non-existent "none makes zero calls" case replaced by `structured-none.test.ts`.
  6. **`createByokProvider` must DEFAULT `fetchFn` to `createPinnedFetch`** — "SSRF at every call"
     must not depend on every caller remembering to pass it.
  7. Task 5's four-deps shape, `runLlmProbe`'s `'unknown'` fifth return and the `fetchFn?` seam stand:
     `memory.capture` never chats, `'unknown'` is the honest health for a never-probed credential that
     500s, and a fetch seam keeps the real composition under test.
  8. Task 5's fix round promoted two minors: a re-wrap guarded on `encryption = 'sealed'` alone would
     silently revert a key after a double rotation (correctness), and `JSON.parse` on decrypted
     plaintext can echo the key into an unscrubbed error (secrets discipline).
  9. `managed = anthropicApiKey ? createManagedProvider(...) : null`; when null (dev/test only —
     production still throws) `llm.probe` IS still registered, while the five model-calling jobs keep
     their transitional warn-and-skip until Task 6 puts them all on the resolver.
  10. Task 6's fix round carried the fallback call's own idempotency key (it was colliding with the
      primary's error row, so the fallback call was unmetered) plus per-attempt provenance, the triage
      fallback's trace, the sandbox's effort, `cacheTtlFor`, `FALLBACK_CODES`' home and the run clock.
  11. `confidence_breakdown.modelGeneration` identifies the **agent's** configured generation — a
      fallback is an event inside it, recorded by `mode`/`provider`/`modelId`; the rollup's window keys
      on `resolveModelConfig(...).modelGenerationAt`, which is authoritative.
  12. The in-transaction `llm.probe` enqueue stands: pg-boss `send` is one INSERT on the boss pool, not
      external network I/O, and it is the transaction's last statement — a throwing enqueue takes the
      credential row with it, which is the property that matters.
  13. `agentsUsing` = `countDistinct(agent_id)` — the plan's "config rows" wording was wrong; the
      screen says "N agents" and `agentsReset` already counts agents.
  14. Task 9's fix round took six UX/secrets items: the save that reverted itself, a 2-minute cap on
      the probe wait with its own copy, an error state for the card, `gcTime: 0` on the add mutation, a
      required-field hint for a custom connection, and a Cancel beside Confirm remove.
  15. `probeTimedOut`'s banner may greet an owner whose connection sat `unknown` since before the
      screen opened — kept: it is accurate and actionable.
  16. **The spec wins over plan deviation 4.** `probeProvider` tries `native` first for every
      non-Anthropic provider regardless of the preset, and `createByokProvider`'s override applies the
      stored verdict to the OpenAI-compatible adapter in BOTH directions (`native` raises an unknown
      model, `json_mode`/`none` narrow); the Anthropic adapter is never overridden and the quality tier
      is untouched by it. The spec says `json_schema` is "treated as `json_mode` unless probe passes"
      and that "presets are overridden by the stored probe result".
  17. The whole-branch fix wave carries all twelve Important findings (deduplicated to ten changes)
      plus two ledger minors, in one wave of three commits grouped by package.
  18. Activity's headline cost = managed + BYOK, with the subtitle "$X of this on your own provider
      keys" when BYOK spend is non-zero — the owner asks "what is this costing me" and the answer is
      the total; the METER separation stays, because the managed daily cap must never charge a tenant's
      own spend.
  19. The ladder catches a `permanent` `LlmError` on the NATIVE rung only and falls through to
      `json_mode`, so a probe verdict that is wrong for one model on a credential costs one call, never
      a draft.
  20. An `auth` failure on a BYOK primary ALWAYS marks the credential dead and pages once, whether or
      not the fallback then lands the draft; only the ticket escalation is skipped when the fallback
      succeeded.
  21. `credential_dead` is refused only when a save SELECTS a *different* credential than the agent's
      current one — re-saving the current (dead) credential to flip fallback or effort is allowed,
      because that is the one remedy the product offers for a dead key.
  22. No second fix wave: of the re-review's four Low residuals, `keyByCredential`'s LRU trim and
      triage's docblock folded into Task 11's own commit; the rest are carried below.
  23. The Phase 6 runbook names the DeepSeek model-id/pricing re-verification as its own line item
      (D's condition on ruling 4).
- The E2E: `apps/worker/test/e2e-phase6.test.ts`, **8 scenarios** against a real OpenAI-compatible
  mock server, one throwaway database, the REAL api `llm` service, the REAL `llm.probe` job, the REAL
  resolver and the REAL adapter — connect/probe (the models list, the structured verdict, the tier),
  BYOK drafting end to end, the ladder landing on whatever rung the probe found and walking down as
  the endpoint does (native → json_mode with no native attempt after a narrowing → `plain` → prose →
  repair → extract → refusal), a dead key (credential `dead`, one `provider_health` page, the ticket
  on `provider_unavailable`, and the NEXT inbound refused by the resolver before any run row or model
  call), `fallback_to_managed`, the tier cap keeping a 0.9-grounding draft off Autopilot
  (0.9 × 0.6 = 0.54 < Eager 0.70), hostile base URLs refused at write time with no row, no secret and
  no request, and credential removal resetting its agents. `e2e-phase5.test.ts` gained scenario 9, the
  **`flags`** demotion trigger the phase list had carried since Phase 5.
- **Carries CLOSED by this phase:**
  - **The three Phase 4 residuals that named Phase 5 and did not land** (Task 1): `QUEUE_OPTIONS` in
    `@aesa/queue` is now the ONE source of queue options, read by `defineJob` and BOTH pre-create
    lists, so a queue's policy can no longer depend on which process booted first; the
    `registerJob`-level `DrizzleQueryError` scrub keeps every job's `query`/`params` out of
    `pgboss.job.output`; and migration 0018's partial unique index
    `(org_id, url) WHERE kind = 'crawl' AND status <> 'failed'` makes the source cap's
    read-then-insert and `refreshCrawl`'s resurrect consistent (`startCrawl` catches the race).
  - **`agent_runs.kind = 'triage'` rows** (deferred from Phase 3 to Phase 6): `ticket.triage` now
    opens and settles its own run row, so the dashboards see triage as well as drafting.
  - **`memory.capture`'s embed spend** (Phase 5 residual): metered on `KNOWLEDGE_METERS.embedTokens`
    and gated by `knowledge.daily_embed_tokens_cap` like every other embed.
  - **The shared evidence helper** (Phase 5 structural residual): `apps/worker/src/drafting/evidence.ts`
    is now the ONE `computeEvidence`, imported by both `ticket.draft` and `agent.sandbox`, so sandbox
    parity is structural — and it is where the quality-tier cap is applied, in one place.
  - **The `flags` demotion E2E** (Phase 5 coverage gap): `e2e-phase5.test.ts` scenario 9.
  - **The whole-branch final review's twelve Important findings**, all in the fix wave
    (`f5df280` llm/crypto/queue, `a079dde` contracts/api/app, `7a3b77f` worker/db):
    - **A probe-raised `native` rung that the endpoint rejects hard-failed the draft.** Rung 1 had no
      `try`, so a server answering 400 to `json_schema` threw `permanent` — not retryable, not in
      `FALLBACK_CODES` — and every draft and triage on that credential landed `agent_failed`. The
      ladder now catches a `permanent` error on the NATIVE rung only and continues to `json_mode`.
    - **The probe's one unscrubbed error path.** `new LlmError(String(err), …)` bypassed
      `scrubSecrets` and that string is persisted into `llm_credentials.last_probe`, which the api
      returns. Scrubbed.
    - **`createPinnedFetch` dropped a non-string body silently** and still sent the request. It throws
      `PinnedFetchError('unsupported_body')` now.
    - **`ticket.triage` had no `auth` landing at all**: a rejected key parked the ticket as
      `triage_failed`, never paged, and left the credential `healthy` until the 6-hourly sweep. It now
      kills the credential, pages once and escalates `provider_unavailable` — **through
      `escalateTicket`**, with the same reason-scoped dedupe key `ticket.draft` uses (the landing
      writes no verdict columns, so the grandfathered carve-out does not apply and CLAUDE.md's
      Escalation rule stays at three).
    - **With `fallback_to_managed` on, an `auth` failure was swallowed** — the one configuration where
      the symptom is invisible: the draft lands, and every later ticket costs a failed BYOK call plus
      a full managed draft on the platform's allowance for up to six hours. The kill-and-page now runs
      regardless of the fallback.
    - **The provider cache had no freshness in its key and `invalidate` is process-local.** On the
      shipped multi-replica topology the replica that probes is usually not the one that drafts. The
      cache is keyed `${credentialId}:${lastProbedAt}` with a 15-minute ceiling, so any replica's
      probe retires every replica's entry — which is what makes a future key-rotate surface safe.
    - **The spec's BYOK stop-loss was unimplemented and unflagged.** `STOP_LOSS_BYOK_OUTPUT_TOKENS`
      (30,000) sits beside the managed `$0.40`, which matters because a model with no `model_pricing`
      row records cost 0 and makes the dollar stop-loss inert for exactly those models.
    - **A first "Managed AI" save demoted every Autopilot category.** `changed` compared against
      `!existing`, but an agent that has only ever run Managed AI HAS no config row — so a no-op save
      bumped the generation, moved the graduation window and demoted everything with the (untrue)
      reason "the agent's model was changed". It now compares against the RESOLVED current config.
    - **A dead credential was refused for every BYOK save**, blocking the one remedy the product
      offers (turning on Fall back to Managed AI on that very connection). Refused only when the save
      selects a different credential.
    - **Owner-facing copy was keyed on the api's exact English sentences** in three files with nothing
      holding them together — and the app's tests mock tRPC, so a reword broke nothing in CI and
      silently collapsed the SSRF refusal (the one message an owner can act on) to "try again".
      `LLM_ERROR_MESSAGES` in `@aesa/contracts` is now the one source.
    - **Activity read "$0.00" for a workspace spending real money on BYOK.** The headline sums both
      meters with a BYOK subtitle; the meter separation (the cap rule) is untouched.
    - Two ledger minors rode along: the missing `defineJob` `QUEUE_OPTIONS` unit tests, and the
      pinned-fetch body throw above.
  - **NOT closed: the `src/drafts/learning.ts` split.** Phase 5's review named it "Phase 6 cleanup";
    Phase 6 did not do it. `apps/api/src/drafts/service.ts` is still one file, and
    `apps/worker/src/jobs/ticket-draft.ts` joined it at ~1,021 lines. Both are carried below.
- **Carries still open**, grouped:
  - **From Phase 4, unchanged:** the stuck-source sweep (a `queued` crawl with no job, a `processing`
    source with unembedded chunks, an abandoned `queued` upload) → **Phase 7**; the source cap's
    read-then-insert race (the crawl half is closed by 0018; the cap itself is still cap ± 1); a crawl
    does not resume, so a re-entry re-walks from the start URL.
  - **Long-standing, unchanged:** the api's three in-memory rate limiters (per-replica since Phase 1);
    `platform.access` audit retention → **Phase 7**; the Better Auth 1.7.3 ↔ `drizzle-orm` peer bump;
    `packages/db/test/keys.test.ts`'s order-dependence; the `apps/app` accessibility minors including
    the draft panel's "Blocked: …" lines rendering as plain `Text`; the three-pane review layout,
    J/K navigation, multi-select and the stubbed-provider Playwright walk → **Phase 7**; the
    `pg_try_advisory_lock` slot pool → **Phase 7**; the `workspaces.kill_switch` Settings toggle →
    **Phase 7**; `notify.digest`'s email pass scanning every workspace on each 5-minute tick; the
    org-cap arm of the backstop busy loop; emoji presentation flattening; `blocks.ts` still telling
    the model bidi controls are "rejected"; a re-approve inside the undo window landing up to
    ~2 minutes late; `sweeps.daily` holding write locks across every expiring draft for the whole
    pass; the hand-authored cache-hit fixture; `sendFailureLabel`'s untested coupling to worker-owned
    literals; and Phase 3's list of smaller review minors, unchanged.
  - **Structure (named again, still open):** `apps/api/src/drafts/service.ts` is one file with
    `src/drafts/learning.ts` the named split seam — ruled "Phase 6 cleanup" by Phase 5's review and
    NOT done; `apps/worker/src/jobs/ticket-draft.ts` is ~1,021 lines and
    `escalateProviderUnavailable`/`killCredential` belong in `drafting/outcomes.ts`;
    `relativeTime` still exists in four app files and `lookup()` in two; `ticket.draft` still
    re-implements `caps.ts`'s private `meterValue`.
  - **From Phase 5, untouched by Phase 6:** `context_too_long`'s "halve retrieval, retry once" (also
    Phase 6 deviation 7); the `KNOWLEDGE_EMBED_MODEL` re-embed job → **Phase 7**; the reinforce
    UPDATE not re-guarded on `status = 'active'`; `memory.skipped` auditing `empty_after_scrub` even
    when the embedder returned nothing; `sweeps.daily` arm (f) joining without an `org_id` predicate
    and scanning unbounded; `stats.rollup` bumping counters and queuing notification ids before
    `maybeNudge` in the same SAVEPOINT; `category_stats_daily`'s PK not leading with `org_id`;
    `activity.summary` leaning on `edit_distance_ratio IS NULL` rather than `decision_source`;
    `guidance.suggest` reading the platform killswitch but not the workspace's;
    `SandboxOutputView.evidence` required, so a pre-Phase-5 stored output parses to null; the daily
    auto-send cap reading the DELIVERED-count meter; `auto_sent_flagged` on `flagged_at` alone; the
    `held` counter gated on `auto_decided_at`'s window; `ensureCustomerHashSalt` minting a salt with
    no customer email; `memoryScore` flooring approvals; and the Phase 5 coverage gaps (the three new
    `decide()` branches' precedence, `readDemotionSignals`'s `decisionWindowDays` boundary, the
    graduation sample's ordering, the `&& !auto` reinforce gate, `guidance.suggest`'s two skips).
    Its knowledge/mail minors are unchanged too: the scrub's sign-off window is the back HALF (with
    the two further bounds the Phase 5 fix wave added); the keyset test spaces rows 100 µs apart so
    the id-tiebreaker path itself is uncovered; the cursor predicate checks both halves though
    `parseCursor` returns them together; the DMARC re-examination note sits on `parseAuthResults`'
    JSDoc rather than the `DMARC_METHOD_RE` block; `MockMailbox`'s Gmail authserv-id default is inert
    in graph mode. And the contracts/core/db ones: no test pins precedence among the three new
    `decide()` branches themselves; `GUIDANCE_SUGGESTION_STATUSES` has no companion type alias;
    `ticket.draft` re-implements `caps.ts`'s private `meterValue`; a stale "Guarded on
    awaiting_review" comment in `send-execute.ts`; `sweeps.daily` expires a `held` draft without
    escalating (arm (c) compensates on a delayed clock); the 8-blocker `it.each` asserts the reason
    but not the matching `blockers.*` flag; two definitions of "edited" (`memory.capture` strikes
    above ratio 0, `guidance.suggest` skips under 0.05); `rejectCandidate` returns ok for a candidate
    retired mid-call; `retireAnswer`'s `returning({ status })` is unused.
    The Phase 5 app-polish list is unchanged: no in-flight feedback on the mode/delay/auto-graduate
    radios; the suggestion CTA not disabled under the cold-start lock; one screen-level error banner
    for every category; "Deleted 1 answers"; the delete-by-customer armed state surviving a tab
    switch; `formatCountdown` with no NaN guard; `autopilot.tsx` writing
    `AUTONOMY_THRESHOLD_PRESETS.balanced` where `DEFAULT_AUTO_SEND_THRESHOLD` would say why.
  - **Phase 6's own deferred minors**, one line per area. *queue/contracts/core:*
    `define-job.test.ts`'s "registerJob scrubs" test calls `scrubJobError` directly, never the catch
    wiring; `scrubJobError` replaces the whole error, so a failed job's output loses the stack and the
    pg `constraint`/`table`; `err instanceof DrizzleQueryError` depends on one resolved copy of
    `drizzle-orm` across the workspace; `SetAgentModelInput`'s byok + real-credentialId happy path is
    untested; `ProbeResult.probedAt`/`error.code` are free strings rather than an ISO check and the
    `LlmErrorCode` union; `QUALITY_CAPS[tier]` yields `NaN` for a tier value outside the union (the
    tier arrives from a DB column — `?? QUALITY_CAPS.limited` would fail safe);
    `DEMOTION_COPY.model_changed` and `REASON_TONE.provider_unavailable = 'danger'` are unreviewed
    product copy. *crypto/llm:* `scrubSecrets`' unanchored `sk-` over-redacts ordinary words
    ("risk-assessment"); `structured.ts` computes the JSON schema twice on the plain→repair path and
    leaves zod's `$schema` key in the prompt; `openai-compatible/index.ts`'s `if (refusal)` treats an
    empty-string refusal as absent; `probe.ts` reports chat ok on a refusal or an empty reply;
    `registry.ts`'s `preset.structuredOutput === 'none'` arm is unreachable; the shared contract suite
    only ever exercises the `json_mode` rung and never `listModels`; the OpenAI SDK would read
    `OPENAI_ORG_ID`/`OPENAI_PROJECT_ID` from the process env and send them to a CUSTOMER endpoint
    (none is set today; `organization: null, project: null` would make that independent of a future
    environment); `pinned-fetch.ts`'s `transport` option is a documented "TEST-ONLY seam" nothing
    enforces; Together and OpenRouter have no seeded pricing rows, so their BYOK calls write
    `cost_unknown` and a zero cost column (runbook §5). *db:* `loadModelPricing`'s dedupe picks by
    pattern length before `effective_from`, so a re-pricing that also changes a pattern's length could
    pick a stale row. *worker:* `provider-resolver.ts`'s `baseUrlFor` throws where the header promises
    a typed refusal; `llm.probe` builds its own limiter instead of sharing the resolver's
    per-credential slots; the probe's connect-store runs before the credential read, so a credential
    deleted in that window is an FK violation and a failed job after retries (same shape as
    `mailbox.store-credentials`); `memory.capture`'s embed tokens are still unmetered when the
    idempotency gate loses; **`agent_runs` now gains one row per inbound (triage) and nothing sweeps
    it → Phase 7 retention**; `llm-reprobe-sweep.ts`'s due-credential select has no `LIMIT` and
    enqueues serially; the backstop's arm (b) sweeps triage run rows at the DRAFT expiry threshold
    (660 s) though `ticket.triage`'s queue expires at 120 s (bookkeeping only);
    `guidance.suggest` ignores `resolved.fallback`, so `fallback_to_managed` does not cover
    suggestions; `stats-rollup.ts`'s local `unchangedApprovals` shadows the `CategorySignals` field it
    filters; a probe against a server that refuses `json_schema` now costs three calls and lands one
    error row in `llm_calls` that the card's "last error code" could show. *api:* the credential cap's
    count-then-insert is not atomic (soft cap, manager-only); two concurrent first saves of an agent's
    model both compute generation 1 (cosmetic); `agents.list` issues two extra queries per agent via
    `resolveModelConfig` (an N+1 on a hot list, documented and bounded); `createEnqueue`'s throwaway
    definition still carries a dead `queue` option; `error-surface.test.ts` does not walk
    `./src/llm/service.ts` as its own entry point; `packages/llm` declares `@aesa/contracts` in
    `dependencies` though it imports it type-only. *app:* `busy` disables Test/Remove on every card
    while one probe runs; the key field's `maxLength` 512 truncates silently; Test on card B disarms
    card A's Remove; with two never-probed connections the within-cap banner masks the timed-out one.
  - **From the fix wave's re-review, the residuals ruled not worth a second wave** (two of the four
    were folded into the close-out commit `024ff65`): the draft job's credential kill no longer
    carries the `!aborted` guard, so an abort maps to transient (implausible — an abort during an
    `auth` failure); the token stop-loss keys off `config.mode` even when attempt 1 fell back to
    managed, which only costs "no free redraft"; and, out of scope under ruling 21, an agent sitting
    on a dead credential may also change its MODEL on that key, bumping the generation and demoting
    while the key is still rejected — the resolver refuses it at run time regardless.

## Next: Phase 7 — billing, caps, launch hardening

**Where to start.** Phase 6 is complete on branch `phase-6` and lands on `main` through a GitHub PR
merged with a merge commit, on Robert's go-ahead (the standing flow from his 2026-09-09 instruction);
until that merge, `main` carries Phases 0–5 and the brand. Once it lands, check out `main`, pull, and
branch `phase-7` off it. Start with `superpowers:writing-plans` against the spec's *Build phases →
Phase 7* (and the seams listed under **The hand-off** below). Run the local setup from `CLAUDE.md` —
including `pnpm db:up && pnpm s3:init` and the `S3_*` exports, so the minio-gated storage suite
actually runs; a dev Postgres created before Phase 6 needs
`DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev pnpm --filter @aesa/db migrate` once for
migrations **0018–0020** before `pnpm e2e` — and confirm the baseline before writing the plan:

- **2,599 tests** plus 4 conditional test-kit skips with `S3_*` exported (`@aesa/contracts` 36,
  `@aesa/crypto` 52, `@aesa/platform-mail` 19, `brand` 110, `@aesa/core` 247, `@aesa/llm` 158,
  `@aesa/agent` 71, `@aesa/db` 95, `@aesa/queue` 23, `@aesa/mail` 242, `@aesa/knowledge` 162,
  `@aesa/test-kit` 43, `apps/api` 301, `apps/worker` 586, `apps/app` 458 jest across 58 suites);
- **25 web routes** from `pnpm --filter @aesa/app export:web`;
- `db:check` clean;
- the Playwright signup smoke green (still ending at the gated mailbox step).

A dev Postgres volume created before Phase 4 still needs `pnpm db:down && pnpm db:up` once to pick up
pgvector, and in production the `vector` extension must be installed by a superuser before Phase 4's
migrations run (`docs/runbooks/2026-09-phase-4-external-setup.md`). Two lessons carried forward from
Phase 5 and re-earned in Phase 6: walk any recipe that recomputes a table against one worked example,
and give the close-out task the whole-branch review record explicitly. Phase 6 adds a third — **when
a plan narrows a behaviour the spec states twice, the spec wins**: deviation 4's "the probe overrides
downward only" survived nine tasks before the E2E made it visible, and reversing it late cost a fix
round (ruling 16).

**The hand-off.** Phase 7 is billing, caps and launch hardening: `billing_subscriptions` + Stripe
Checkout/Portal/webhooks + `billing.report-usage` (domain quantity, automatic overage, blocked mode);
the trial policy (14 days from `agent_enabled_at`, no card; at trial end or `past_due` decisions
become `review` with a banner — drafts continue, nothing sends automatically); per-org caps from
`usage_counters` everywhere including the daily LLM USD cap and trial budgets; the retention sweep;
workspace export/delete with a 30-day grace; the `keys.rotate` runbook; Sentry + a log drain + alerts
with org attribution; the CASA evidence package finalized; store submissions (EAS Build);
`scripts/smoke-tenant.ts`; native share-sheet intake and "Remember this reply" (the backfill of past
conversations arrives here, not at connect). Load testing is deferred until the first paying
customers. The seams already in place and waiting for it:

- **The `plan` column and the `{ plan }` argument at every `resolveSetting` site.** `PLANS` and
  `planSettingDefaults` exist in `@aesa/core` and have had no caller since Phase 4: every org sits on
  the catalog defaults (100 sources, 200 crawl pages, 5,000,000 daily embed tokens, 50 guidance
  suggestions a day) and `PLANS.trial` is inert. Billing is the phase that makes them real, and
  `list.caps` already reports what the api actually enforces rather than a tier.
- **`billing_subscriptions` is the missing table**; `usage_counters` is already the meter store every
  cap reads, and `SEND_METERS` / `LLM_METERS` / `SANDBOX_METERS` / `KNOWLEDGE_METERS` /
  `GUIDANCE_METERS` already carry the quantities an invoice would price.
- **The daily USD cap now reads only MANAGED spend.** Phase 6 split BYOK cost into
  `llm_cost_micros_byok` precisely so a tenant's own key can never trip the platform's allowance —
  which means the cap Phase 7 turns into a billing control is already the right number, and the
  screens that answer "what is this costing me" already sum both. A per-plan managed budget is a
  `resolveSetting` away.
- **`agent_runs` retention is now due.** Phase 6 made `ticket.triage` write its own run row, so the
  table gains **one row per inbound email** and nothing sweeps it. `sweeps.daily` already owns
  run-event and action-token retention; triage rows are the next arm, beside the
  `platform.access` audit retention that has been carried since Phase 1.
- **The stuck-source sweep** (carried since Phase 4) has exactly three customers waiting: a `queued`
  crawl with no job, a `processing` source whose embed retries are exhausted, and an abandoned
  `queued` upload. `refreshCrawl` accepts `queued` so the owner has a manual path out in the meantime.
- **The `keys.rotate` runbook has a new tenant.** Phase 6's provider cache is deliberately
  **freshness-keyed** (`${credentialId}:${lastProbedAt}`, 15-minute ceiling) so that any replica's
  probe retires every replica's cached provider — the property a rotate surface needs and the reason
  it was fixed before one existed. The rotate story now covers the KEK ring, `mailbox_credentials`
  AND `llm_credential_secrets`, and the ring must be identical on every `sync`, `send` and `agent`
  replica.
- **Workspace delete must cascade the learning and provider tables.** `resolved_answers` was named in
  Phase 5; Phase 6 adds `llm_credentials`, `llm_credential_secrets` and `agent_model_config`.
  Delete-by-customer is still the interim erasure route for a single customer's answers.

**Carries still open.** The Phase 6 record above groups all of them — Phase 4's remainder, the
long-standing list, the structure carries (the `src/drafts/learning.ts` split, now named for a third
time, and `ticket-draft.ts` at ~1,021 lines), Phase 5's untouched list, Phase 6's own deferred minors
and the fix wave's residuals. Four items are explicitly addressed to **Phase 7** and are the ones
most worth folding into its first task: **`agent_runs` retention** (new, and growing per inbound),
the **stuck-source sweep**, **`platform.access` audit retention**, and the
**`KNOWLEDGE_EMBED_MODEL` re-embed job** without which that value can never be changed on a live
workspace. Robert's manual list for Phase 6 is
`docs/runbooks/2026-09-phase-6-external-setup.md`.

## Later phases (see the spec for scope and verification)

- Phase 7 — billing, caps, launch hardening, and the last phase in the spec. Owes the `plan` column and the `{ plan }` argument at every `resolveSetting` site: until then every org sits on the catalog defaults (100 sources, 200 crawl pages, 5,000,000 daily embed tokens, 50 guidance suggestions a day) and `PLANS.trial` is inert (Phase 4 final review, seams D1). It also owes `agent_runs` retention, which Phase 6 made urgent by writing one triage run row per inbound email. See **Next: Phase 7** above for the full hand-off.

## Open items for Robert

Defaults are stated in the spec's *Open items for Robert* section and do not block implementation:
product name (codename `aesa` until then), pricing numbers, the assumed third-party services,
the managed drafting model per plan, and launch order (Microsoft 365 first, Gmail behind the
test-user gate until CASA clears).

The Phase 1 external-setup runbook (`docs/runbooks/2026-09-phase-1-external-setup.md`) lists
everything that phase needed that CI cannot do: the Better Auth secret and production env, the
Google and Microsoft OAuth consent-screen/publisher-verification steps, the Resend sending domain,
and the EAS project/dev-build/hosting setup.

The Phase 2 external-setup runbook (`docs/runbooks/2026-09-phase-2-external-setup.md`) lists what
this phase needs the same way: the Gmail OAuth client + Pub/Sub topic/push subscription, starting
the CASA Tier 2 submission now (independent of code — a 4–12 week clock), the Microsoft Entra app
registration, the live verification walk against a real Gmail test user and an M365 sandbox, and
recording real fixtures from that walk.

The Phase 3 external-setup runbook (`docs/runbooks/2026-09-phase-3-external-setup.md`) is what
Phase 3 needs before a real reply leaves the building: the `send`-role environment (and the
`MAIL_FROM` / `APP_BASE_URL` / `APP_WEB_ORIGIN` values that must be identical in both apps), an
Anthropic Console workspace spend limit as the backstop to the in-product caps, the live
send/reply/follow-up walk against both providers from both a Gmail and an outlook.com sender,
recording the cache-hit fixture (`LLM_RECORD=1 … tsx packages/llm/scripts/record-cache-hit.ts`) and
committing it, an EAS dev build to verify the Review/Hold push actions on iOS and Android, and
confirming the 08:00-local digest email with working one-click links.

The Phase 4 external-setup runbook (`docs/runbooks/2026-09-phase-4-external-setup.md`) is what
Phase 4 needs before a real customer document is ever embedded or stored: the `vector` extension
installed once by a superuser BEFORE the migrations run (migration 0012 runs as `aesa_owner` and
cannot install it itself), the Voyage AI account and `VOYAGE_API_KEY` on every `knowledge`/`agent`
replica (plus `KNOWLEDGE_EMBED_MODEL`, which cannot be changed on a live workspace without hiding
every existing chunk from the vector leg, and a Voyage console billing limit as the backstop to
`knowledge.daily_embed_tokens_cap`), the Cloudflare R2 bucket + API token + the six `S3_*` values
identical in BOTH apps and the bucket's `PUT`/`GET` CORS rule for `APP_WEB_ORIGIN` (a missing rule
is a browser upload that fails with no server-side error anywhere), the crawler's User-Agent
(`aesa-crawler/1.0 (+https://aesa.app)`, robots token `aesa-crawler`) published on the public site
so a customer can opt out, the live walk (crawl a real site, upload a real PDF and DOCX from the web
AND from a phone, ask a question the document answers and check the draft's
`confidence_breakdown.grounding`), and the DPA/privacy-policy update — **Voyage and the object store
are new sub-processors, and customer documents are now stored at rest.**

The Phase 5 external-setup runbook (`docs/runbooks/2026-09-phase-5-external-setup.md`) is the first
one that needs **nothing provisioned**: no new vendor, no new key, no new environment variable. What
it needs is the live walk — teach one answer with three unchanged approvals in Review, graduate the
category to Auto, watch the fourth reply go out on its own from BOTH a Gmail and an outlook.com
sender, **Hold one from the phone's push** (turn `notifications.push_auto_sends` on in `org_settings`
first), sample an auto-sent candidate on the Learned answers screen, and flag one "Should not have
sent" twice to see the category demote itself — plus one privacy edit: `resolved_answers` keeps a
scrubbed customer question and the business's reply for up to 365 days, keyed by a salted customer
hash, and the retention section of the privacy policy has to say so. Phase 7's org-delete path must
cascade that table; delete-by-customer is the interim erasure route.

The Phase 6 external-setup runbook (`docs/runbooks/2026-09-phase-6-external-setup.md`) adds **no new
vendor and no new environment variable** — but it has the one deployment change of the phase and the
one legal one. The deployment change: **`AESA_KEK_V<n>`/`AESA_KEK_ACTIVE` are now required in
production on any replica whose `WORKER_ROLES` includes `agent`**, and it must be the SAME ring
everywhere (a key sealed under one ring cannot be opened by a replica holding another, and the only
symptom is `provider_unavailable`); the boot refusal catches the missing case loudly, not the drifted
one. The legal change: under BYOK, a customer's email content goes to **the provider that customer
chose, under that provider's terms, on that customer's own account** — the product already says so at
the moment of choosing, and **the privacy policy and DPA have to say the same thing**, as a structural
clause (a customer connecting their own key thereby appoints that provider as their own
sub-processor), not a per-vendor list. The rest is the live walk that no gate can stand in for: add a
real key, watch the probe land `healthy` with a models list and a structured verdict, point an agent
at it, send a real customer email from BOTH a Gmail and an outlook.com sender, approve from the phone,
confirm the `llm_calls` rows say `byok` — then **revoke the key in the provider's console** and
confirm the `provider_health` push, the `dead` chip and the `needs_owner`/`provider_unavailable`
ticket. Three named chores ride with it: **re-verify DeepSeek's live model ids and prices** (the
catalog names `deepseek-chat`/`deepseek-reasoner` and migration 0020 seeds their prices UNVERIFIED —
a probe on a real key shows the live list, and two catalog ids plus two pricing rows follow if they
have moved), pre-check `knowledge_sources` for duplicate live crawl rows before migration 0018's
non-concurrent unique index takes `ACCESS EXCLUSIVE`, and tell any self-hosting customer that a local
Ollama/vLLM needs a **public https hostname** in v1. Like every screen before them, **Settings → AI**
(route 25) and the agent edit screen's **Model** card have never rendered outside jest — open both
signed in, at wide and phone widths and on a real phone, and check the key paste, the two-minute probe
wait and its copy, Remove's armed confirm *and* its Cancel, the `provider_health` push deep-linking to
`/settings/ai` from the notification shade, and dark mode on both.

Open the Knowledge screen in a browser once, signed in, and once on a phone. No gate renders it: the
Playwright smoke still ends at the gated mailbox step, and jest-expo exercises the components but
not the real DOM. Six things only a real device can prove, all of them touched by the final fix
wave:

- **Drag and drop for real** — `bindDropZone`'s four events against an actual `DataTransfer`, and
  then **a second drop while the first upload is still going**: the zone must swallow it (the fix
  keeps the listeners bound and only skips `onFiles`), and the tab must not navigate away.
- **Cancel the file-picker dialog** without choosing anything. The throwaway `<input>` is hidden and
  removes itself on `cancel` as well as on `change`; `cancel` is the event with the least uniform
  browser support of the two.
- **Drop a `.md` file in Chrome against minio** — the one combination that exercises both the
  extension-first MIME inference (Chrome reports an empty `File.type` for `.md`) and the presigned
  PUT's CORS preflight (`MINIO_API_CORS_ALLOW_ORIGIN` must equal the Expo web origin).
- **A phone picker with a size-less asset**, then `uploadAsync` against a real R2 bucket — the
  native path shares no code with the web one past `useUpload`.
- **VoiceOver / TalkBack on the crawl page-cap control** — it is a hand-rolled `radiogroup` of
  `Pressable`s with `role="radio"` and `accessibilityState.checked`, never a platform control.
- **Dark mode** on the whole screen, including the new `warning` Banner tone.

Neither the web drag-drop path nor the phone upload path has ever run outside jest.

Brand deviation 14: whether the phone inbox should get a small header lockup, now that spec §6's
header lockup is met only on wide layouts and the sign-in screen — a phone shows no brand chrome
in the inbox/activity/settings tabs, unchanged from the pre-branch app.

Open the web export signed in at a wide window and at phone width once — the tab icons, the
sidebar lockup and the sign-in lockup have not been rendered in a browser by any gate (the
Playwright smoke ends at the gated mailbox step, per Phase 2's Task 20 ruling).
