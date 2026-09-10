# Project status

Updated 2026-09-10. The spec (`docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md`)
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


### Phase 3 — draft, review, send (complete on branch `phase-3`; PR not yet opened)

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

## Next: Phase 4 — knowledge

**Where to start.** `phase-3` is complete on its branch and lands on `main` through a GitHub PR with
a merge commit on Robert's go-ahead (the standing flow from his 2026-09-09 instruction). Once it is
merged, check out `main`, pull, and branch `phase-4` off it. Start with
`superpowers:writing-plans` against the spec's *Build phases → Phase 4* section. Run the local setup
from `CLAUDE.md` and confirm the 1,641-test baseline above before writing the plan.

**The hand-off.** Phase 4 is knowledge: the document parsers, the site crawler, Voyage embeddings,
retrieval, and the `minio`/R2 upload path. Two seams are already in place and waiting for it:

- **`Retriever` in `@aesa/agent`.** `ticket.draft` and `agent.sandbox` both call
  `deps.retriever.retrieve({ orgId, questions, text, signal })` OUTSIDE every transaction, before the
  prompt is built, and both already thread the result through the knowledge block, the
  `retrieved_chunk_ids`/`cited_chunk_ids`/`retrieved_answer_ids`/`used_answer_ids` columns on
  `drafts`, and `collectGroundedNumbers`' sources. Phase 3 wires `emptyRetriever`; Phase 4 replaces
  it and nothing above it changes shape. Two Phase 3 behaviours become load-bearing the moment it
  returns anything: the draft job re-filters every id the model cites against what retrieval
  actually returned (a model must not be able to make a draft look grounded by inventing an id), and
  `confidence_breakdown.grounding` is the `null` slot Phase 4 fills.
- **`knowledge_version`.** The prompt's knowledge block is the cacheable per-org layer, so a
  knowledge change has to bust that cache; Phase 4 owns the version column and threading it into the
  block's stability hint.

**Carries still open** (fix in the first Phase 4 task that touches the file, or record why it moves
again):

- The api's rate limiters (Better Auth's in-memory limiter, `@fastify/rate-limit`, `team.invite`'s
  per-org throttle) are all in-memory and therefore per-replica — move to shared/database storage
  before the api scales past one instance (carried since Phase 1).
- `platform.access` audit rows still have no retention rule, and Phase 3 raises the volume again:
  `send.execute` adds ONE credential-read audit row per send on top of Phase 2's per-sync row. The
  retention rule is Phase 7's sweep; note the volume now, before it is a production surprise.
- Better Auth 1.7.3 still declares a peer of `drizzle-orm ^0.45.2` against the workspace's pinned
  `^0.44.0` (pnpm warns only, carried since Phase 1) — bump both together in a dedicated task, since
  drizzle snapshots may shift.
- `packages/db/test/keys.test.ts` is still order-dependent (file untouched this phase).
- The remaining `apps/app` accessibility/UX minors from Phase 1's residuals list, on screens this
  phase didn't touch, are still open — and Phase 3 adds one on a screen it did: the draft panel's
  "Blocked: …" guardrail lines render as plain `Text` rather than a `Banner`, so a screen reader
  hears the generic sentence below them but not the specific reason.
- The DMARC first-match re-examination moves to **Phase 5**, with `decide()`'s auto branch: this
  phase's `decide()` consumes a single boolean, and the multi-`Authentication-Results` reasoning only
  becomes load-bearing once that branch is reachable.
- The three-pane review layout, J/K queue navigation, multi-select and the stubbed-provider
  Playwright walk move to **Phase 7** (plan deviation 13). Phase 3 ships the phone composition on
  every platform plus `A`/`E`/`R` on web, and the Playwright smoke still stops at the mailbox gate.
- The `pg_try_advisory_lock` slot pool sized to our Anthropic tier moves to **Phase 7** (plan
  deviation 4). Phase 3's admission control is per-process (`batchSize: 1`) plus a
  transaction-scoped `pg_advisory_xact_lock` per org.
- The `workspaces.kill_switch` Settings toggle moves to **Phase 7** (plan deviation 16). The lever is
  read by `decide()` and by `send.execute`; only the master switch (`agent_enabled`) is exposed.
- `memory.capture` moves to **Phase 5** (plan deviation 5). `send.execute` already exposes the
  `onSent({ orgId, ticketId, draftId })` seam, called post-commit and never allowed to fail a
  delivered send; Phase 3 passes a no-op.
- `agent_runs.kind = 'triage'` rows move to **Phase 6** (plan deviation 8). The enum admits the
  value for Phase 6's dashboards, but only draft and sandbox runs create rows today; triage calls DO
  get `llm_calls` rows, since the agent role wraps its one provider with the metering sink.
- Deferred from Task 16: `notify.digest`'s email pass still scans every workspace on each 5-minute
  tick (two `withPlatform` audit rows per tick plus a full `workspaces` scan). The token-minting
  half of this carry was fixed in the fix wave. A due-orgs pre-filter needs a local-hour index that
  does not exist yet.

**Carried out of the whole-branch review** — one line each; none is believed to block the live
verification walk:

- **The org-cap arm of the backstop-sweep busy loop.** The fix wave closed the killswitch arm only.
  An org that has hit its daily draft or spend cap keeps satisfying sub-sweep (a)'s predicate, so
  the sweep enqueues up to `SELECT_CAP_PER_CYCLE` (50) `ticket.draft` jobs every minute until UTC
  midnight, each of which does one read transaction and exits at rule 3's org-cap gate. Nothing is
  written and the owner is paged once per day, so this is wasted work, not a defect; the fix needs a
  `usage_counters` join plus per-org settings in the sweep's own predicate.
- **`structuredOutput: 'none'` moves to Phase 6** (ruling ledger 74): a provider declaring `'none'`
  makes zero calls today. It is unreachable — Anthropic models are native, unknown models take
  `json_mode` — and Phase 6's OpenAI-compatible adapter has to give it a real rung (a plain call
  with a JSON instruction, then repair/extract).
- **Emoji presentation flattens.** The wider default-ignorable strip (B-I2) removes U+FE0F, so a
  heart-with-VS16 is stored and sent as its bare text-presentation glyph. Consistent with what
  already happened to ZWJ sequences (U+200D is `\p{Cf}`) and the price of closing the bypass, but it
  is a visible change to a sent reply.
- **`blocks.ts` still tells the model bidi controls are "rejected"** when the validator silently
  strips them (same for `GUARDRAIL_CODE_TEXT`). It is prompt text inside the cached static prefix,
  so correcting it belongs with a deliberate prompt change, not a docs pass.
- **A re-approve inside the undo window can be up to ~2 minutes late.** On the now-`short`
  `send.execute` queue, a re-approve whose previous job is still `created` gets a `null` back
  instead of a second job; the already-scheduled job runs, finds `send_after` still in the future
  and returns, and the backstop sweep's arm (d) re-picks the row on its next pass. No send is lost.
- **Two KEYLESS `boss.send` calls on a `short` queue collapse into one.** `short`'s index is over
  `COALESCE(singleton_key,'')`. Production never does that — everything goes through `enqueue()`,
  which always sets `${orgId}:${entityId}` — and the E2E's raw triggers now mint a throwaway key
  each, but a future bare `boss.send` on one of the four queues would dedupe silently. A lint rule
  making `enqueue` the only send path is the Phase 4 option.
- **The four queues' pre-creation does not carry the policy.** `apps/worker/src/index.ts` and
  `apps/api/src/boss.ts` pre-create them with no options, so a queue first created by an api-only
  boot stays `standard` until a worker replica that registers the job runs `updateQueue`.
  Correctness never depends on the dedupe, so this is a cold-start inefficiency only.
- **A resume of a stale-`failed` draft onto a `triaged` ticket is wasteful when a re-draft is
  already in flight** — see fix-wave ruling 6: it self-corrects at the send gate, at the cost of one
  run.
- **`sweeps.daily` holds write locks on every expiring draft across every org for the whole pass**,
  including its per-row escalation loop and both retention deletes. A locked draft blocks a
  concurrent approve/hold/reject for the duration; the api's 30 s statement timeout would surface it
  as a failed button, not a hang. Fix when it bites: move the escalation loop and the deletes out of
  the bulk transaction. (Same file: the two retention `DELETE`s materialize every deleted id via
  `.returning({ id })` purely to produce a count.)
- **The push's Hold action cannot succeed until Phase 5.** A `draft_review` notification is only
  ever created for a freshly created `pending` draft, and `holdDraft` refuses anything that is not
  `approved` with a `queued` send — so every Hold tap is a guaranteed `not_holdable`, swallowed,
  with the ticket simply opening. Plan deviation 12 accepts the refusal; it did not observe that it
  is unconditional. Either drop the action from the category until auto-send exists, or surface the
  refusal.
- **The inbox keyset cursor can silently drop rows** (inherited from Phase 2, untouched here): the
  predicate is `sortKey < cursor` with no `id` tiebreaker while the `ORDER BY` carries one, and the
  cursor is a millisecond ISO string cut from a microsecond `timestamptz`. Fix as a row-comparison
  keyset `(sortKey, id) < (cursorTs, cursorId)` carrying the raw value.
- **The review pages set no `Content-Security-Policy` / `X-Frame-Options` / `X-Content-Type-Options`.**
  Defense in depth only — every interpolation is escaped and the pages have no script and no
  external resource — but `default-src 'none'; form-action 'self'`, `DENY` and `nosniff` on
  `reviewReply` cost one line each and keep the four failure pages header-identical.
- **The cache-hit fixture is still hand-authored.** `packages/llm/test/fixtures/anthropic/draft-cache-hit.json`
  pins the field mapping and the pricing, not that Anthropic really returned those numbers. The
  runbook's `LLM_RECORD=1` recorder step is the only thing that proves caching end to end, and
  re-running it will need the two `anthropic.test.ts` cache assertions' expected numbers updated.
- **`sendFailureLabel` maps worker-owned literals.** The app's "Not sent — …" copy keys off four
  fixed `landTerminal` reason strings plus the `guardrail:`/`stale:` prefixes; if `send-execute.ts`
  ever rewords one, the label degrades to the generic sentence rather than leaking raw text — safe,
  but a coupling with no test spanning the two packages.
- **Smaller review minors, still open**, by area: the "the page that rendered the body IS the read"
  comments claim more than the code enforces (nothing binds the review POST to a prior GET); the
  approve gate's edit-distance ratio compares a normalized string against a raw one; `rejectDraft`
  leaves an inert orphan `held` `outbound_sends` row; Activity's approved counts drop `failed` and
  `pending` drafts so the summary rows do not reconcile; `LIVE_DRAFT_STATUSES` has three copies
  (`workspace.ts` still re-declares it); the token-race throw logs as "review page failed" at `warn`
  with a stack for an expected race; `claim.ts:229`'s `detail` comment invites a body into a run
  event that must never hold one; the agent-cache rate count includes the run doing the counting;
  `createFakeProvider` ignores `opts.kind` in the result it returns; `PLAUSIBLE_TLDS` is an 18-entry
  allowlist so a bare domain on any other TLD is not screened; the phone screens are ASCII-digit
  only; the subject and triage questions are interpolated raw into the user message; ladder rung 4
  extracts only from the repair reply, never from the original; the digest subject drops the
  business name when there are no drafts; `(a2)` escalates under the global killswitch by design, so
  the lever does not silence owner pages for stuck tickets; and the E2E never drives the digest
  through `runNotifyDigest`'s own cron branch.

**The ledger's deferred minors still carried** — the whole-branch review triaged 24, the fix wave
cleared nine of them (69, 70, 71, 79, 129 from that triage, plus 39, 112, 136 and 89b picked up by
the sections that were already in those files), one (47) turned out to be moot and is dropped, and
these 18 carry:

- 40 — `use-gate.test.tsx` near-duplicates the `setActive`-rejection scaffold (the two tests assert
  different things; the review's own triage says drop rather than merge).
- 41 — the Task 1 report's rationale is imprecise about the `provider as MailProvider` cast
  precedent; the code is safe by the DB CHECK. Report text only.
- 47 (dropped, not carried) — `ticket-row.test.tsx`'s `it.each` title says "one-word chip"; the
  review confirmed the block it titles carries only genuinely one-word chips, so the recorded minor
  no longer applies.
- 48 — the Task 2 report miscounts `DECISION_REASONS` as 20 (it is 21). Report text only.
- 53 — the Task 3 report mischaracterises migration 0010's per-table index split (the total, 12, is
  right). Report text only.
- 58 — `autonomy.test.ts` asserts the absence of `quiet` implicitly through `toEqual` rather than an
  explicit per-row check.
- 76 — the Task 7 report claims a fake-provider test edit that is not in its diff. Report accuracy.
- 77 — `ZERO_USAGE` is duplicated in `structured.ts` and `with-metering.ts`.
- 78 — ladder rungs 1–2 repeat the `isRefusal`/parsed shape; a small shared helper would do.
- 84 — the lockfile regen added unrelated transitive churn under `@react-native/metro-config`, and
  the default meter `onError` wraps `console.error` with a prefix (the worker overrides it).
- 89a — the workspace profile block's `contactUrls` are not cross-checked against
  `allowedUrlHosts`; the assertion belongs where the two are assembled.
- 89c — an empty `categoryKeys` renders `"from: ."` in the prompt.
- 89d — the prior-draft body is sliced (a benign extra beyond what the brief asked for).
- 89e — one `as GuardrailCode` cast in `thread.ts`, type-safe by construction.
- 92 — a prompt bullet's either/or packs two clauses with a comma; a semicolon would read cleaner.
- 126 — the job-level `MessageGone` catch in `send.execute`'s recovery scan is unreachable today
  (both adapters and the mock swallow it inside `findSentByMarker`); kept deliberately, since
  removing it would make a future adapter that does surface it send blind.
- 127 — the crash-recovered path reconstructs the outbound `messages` row from this run's
  body/subject with `sent_at = now` rather than the provider's record. Activity reads
  `outbound_sends.sent_at`, so the skew is bounded by the retry window; re-check when Phase 4 adds
  a thread view.
- 130 — on `send.execute`'s fresh path the kill-lever check sits below the draft-status/null-body
  refusals, so a rejected draft plus a lever lands `draft not approved` instead of a hold. The
  owner's own disposition winning is the better outcome; it wants a sentence in the file header.
- 183 — no test renders a NEW undo window after an expired one (correct by inspection: the latch is
  keyed to the `undoAt` value, and both ends are pinned by the two existing tests).

## Later phases (see the spec for scope and verification)

- Phase 4 — knowledge (parsers, crawler, Voyage embeddings, retrieval, `minio`/R2 uploads).
- Phase 5 — autonomy and learning (resolved-answer memory, evidence score, graduation).
- Phase 6 — provider choice (BYOK adapters, probes, per-agent model config).
- Phase 7 — billing, caps, launch hardening.

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
