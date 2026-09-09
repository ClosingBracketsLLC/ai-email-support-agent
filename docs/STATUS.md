# Project status

Updated 2026-09-09. The spec (`docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md`)
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
  carried into Phase 3 below (DMARC first-match re-exam, claim-time notification email,
  `push_subscription_id` index, `use-gate` `setActive` regression test, malformed-cursor degraded
  marking).

## Next: Phase 3 — draft, review, send

**Where to start.** Phases 1 and 2 are merged; `main` is the base. Check out `main`, pull, and
branch `phase-3` off it. Start with `superpowers:writing-plans` against the spec's *Build phases →
Phase 3* section. Run the local setup from `CLAUDE.md` and confirm the 816-test baseline above
before writing the plan. When the phase is done, it lands on `main` through a GitHub PR with a
merge commit (the standing flow from Robert's 2026-09-09 instruction) — opening and merging the PR
still happens on his go-ahead per phase, or per any standing instruction he gives in that session.

Rulings the Phase 3 planner needs, carried from this phase's execution:

- The send path must consume `SendReplyInput.replyToProviderMessageId`/`existingDraftId` (Graph's
  two-phase send needs the first to create a reply and the second to resume a crashed one) and
  persist `outbound_sends.provider_draft_id` — both fields already exist on the Phase 2 port/types
  (`packages/mail/src/types.ts`) with no consumer yet; Phase 3's send executor is that consumer.
- `notify.digest` gains the email channel (Phase 2 deviation 6) — worker → Resend (or the api's
  `MailTransport`, if that boundary is worth crossing) once the review pages exist for a digest
  email to link to.
- The inbox's `awaiting_review` section joins `to_review` (Phase 2's inbox only has `to_review` =
  `needs_owner`, per the plan's own note that Phase 3 extends this) once drafts exist to review.
- The `llm` ladder (limiter, registry, probe, pricing) and the metering wrapper (`withMetering`,
  `llm_calls`) land here — Phase 2's triage runtime uses only a fail-closed `usage_counters` spend
  guard, deliberately omitting all of this per deviation 5.
- Carry-overs still open (deferred again at Phase 2's close; fix in the first Phase 3 task that
  touches the file, or record why it moves again):
  - The api's rate limiters (Better Auth's in-memory limiter, `@fastify/rate-limit`, `team.invite`'s
    per-org throttle) are all in-memory and therefore per-replica — move to shared/database storage
    before the api scales past one instance (carried since Phase 1).
  - `platform.access` audit rows have no retention rule; Phase 2's per-sync credential-read audit
    trail (`getAccessToken`'s `withPlatform` call on every mailbox poll) meaningfully raises the row
    volume beyond Phase 1's heartbeat-only baseline — the retention rule is Phase 7's sweep, but
    note the volume now, before it's a production surprise.
  - `pnpm-lock.yaml` still carries a duplicate TypeScript variant (Task 1's `pnpm dedupe` pass was
    peer-driven and could not fully collapse it) — worth a second look once Phase 3's dependencies
    settle rather than chasing it now.
  - Better Auth 1.7.3 still declares a peer of `drizzle-orm ^0.45.2` against the workspace's pinned
    `^0.44.0` (pnpm warns only, carried since Phase 1) — bump both together in a dedicated task,
    since drizzle snapshots may shift.
  - `packages/db/test/keys.test.ts` is still order-dependent (file untouched this phase).
  - The remaining `apps/app` accessibility/UX minors from Phase 1's residuals list, on screens this
    phase didn't touch, are still open.
  - Promoted from the final review, not must-fix for the fix wave above: re-examine the DMARC
    first-match semantics `autonomy.ts` will need once Phase 5 lands (this phase's own DMARC parser
    is clause-anchored per the Task 6 ruling above, but autonomy's own first-match reasoning over
    multiple `Authentication-Results` instances hasn't been checked against it yet); send a
    claim-time notification email (today a claimed connection has no email trail, only the app's own
    poll); add an index on `mailbox_connections.push_subscription_id` (poll-sweep's sub-sweep (a)
    filters on it with no supporting index); a regression test for `use-gate`'s `setActive` path
    (Phase 1's carry-over gate logic, never covered by a dedicated test); mark a ticket's inbox
    listing as degraded (not merely silent) when a malformed keyset cursor is presented.

### Carry-overs resolved during Phase 2

Findings deferred during Phase 1 (from the task-review ledger and the still-open Phase 0 items),
now folded into Phase 2's own tasks: `pnpm dedupe` + re-export + smoke, `pinned-fetch.ts`'s HEAD
`content-length` rewrite, the worker's structured logger, and `defineJob`'s zod-invalid-payload
fail-fast all landed in Task 1; the duplicate `organization.slug` unique index and the non-superuser
LOGIN role exercising the privilege boundary landed in Task 3; the Better Auth `APIError` → tRPC
code mapping (the `organizationLimit` masked-500) landed in Task 17; `session.cookieCache` landed
in Task 19. What did NOT fully resolve is carried forward above, under Phase 3's carry-overs.

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

The Phase 1 external-setup runbook (`docs/runbooks/2026-09-phase-1-external-setup.md`) lists
everything that phase needed that CI cannot do: the Better Auth secret and production env, the
Google and Microsoft OAuth consent-screen/publisher-verification steps, the Resend sending domain,
and the EAS project/dev-build/hosting setup.

The Phase 2 external-setup runbook (`docs/runbooks/2026-09-phase-2-external-setup.md`) lists what
this phase needs the same way: the Gmail OAuth client + Pub/Sub topic/push subscription, starting
the CASA Tier 2 submission now (independent of code — a 4–12 week clock), the Microsoft Entra app
registration, the live verification walk against a real Gmail test user and an M365 sandbox, and
recording real fixtures from that walk.
