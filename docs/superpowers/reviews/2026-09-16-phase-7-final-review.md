# Phase 7 — whole-branch final review record

Branch `phase-7`, base `c999904` (`main`, the PR #7 merge commit) → reviewed at `f12dcd9` (34
commits, 208 files, ~27.8k insertions: the plan `7cfc87b`, Tasks 1–12 with their fix rounds — three pre-review
correctness fixes and nine review-driven fix rounds across Tasks 3, 4, 5, 6, 7, 8, 10, 11 and 12 —
and the close-out's docs commit `f12dcd9`, which the docs half of the review read), then **fixed
through `58afd7a` + `ddf69ac`** (the fix wave, ruling R35) and **`6f40203`** (the re-review's one
residual, ruling R36) — the branch head, **37 commits over `main`**. **Five reviewers on the most
capable model, one area each** — A: `@aesa/db` + `@aesa/core` + `@aesa/contracts` (+ `@aesa/queue`'s
observer and `@aesa/knowledge`'s Phase 7 touches); B: `apps/api`; C: `apps/worker`; D: `apps/app`;
E: the cross-cutting seams — billing state read at every gate (`readBillingState` as the ONE reader,
in the draft job's pre-claim, `send.execute`'s claim, `loadSettingSources`, `billing.get`, the report
cron), the meter split (`ai_handled_conversations_managed` vs the total; `llm_cost_micros` vs
`_byok`), the purge order (`PURGE_ORDER` → `workspaces` → `purgeAuthRows`), every Stripe call
outside every transaction with a guarded write behind it, the spec's Verify list as a whole, every
controller ruling, and the docs/env drift the close-out had to close — each pointed at the execution
ledger's deferred minors (rolled up below) for triage. Then ONE scoped re-review, on the same model,
over `f12dcd9..ddf69ac`.

Gate at the reviewed commit `77f5a5e` + docs (`f12dcd9`): full gate exit 0, **2,998 tests** + 4
conditional skips, 27 web routes, the Playwright smoke green. Gate at the head `6f40203`
(`gate-r36.log`, pasted at the end of this record): exit 0, **3,035 tests** + 4 conditional skips
(+37: core +4, db +4, api +7, worker +10, app +12), `db:check` in sync; the 27 routes, the
Playwright smoke and the Phase 7 E2E's 11/11 stand from the wave's runs at `58afd7a` (the R36
commit touched two `apps/app` files; the app suite ran 542/542 at `6f40203`).

## Verdict

**Approved for the PR after the fix wave; the branch is clean to merge at `6f40203`.** Per area:
A packages **1 Critical / 1 Important / 10 Minor**; B api **1 Critical / 2 Important / 6 Minor**;
C worker **0 / 4 / 11**; D app **0 / 5 / ~11**; E seams+docs **1 Critical / 6 Important / 9 Minor**.
Consolidated after de-duplication across reviewers (E's I2, I3, I4 and I6 are C's I3(c), C's I4,
B's I1 and C's I2 reached from the seam side): **3 Critical, 15 Important** (the fourteen unique
Important findings plus E's domain-quantity-floor minor, elevated by ruling R29), **~13 minors
folded into the wave**, **~12 carries recorded**. Every reviewer's verdict was "with fixes";
**every seam the phase was designed around held**, and the seams reviewer checked all twenty-five
execution-time rulings against the spec and **would reverse none**.

The wave ran as ruling R35 sequenced it — ONE implementer (opus) over the whole brief
(`fix-wave-brief.md`), two commits: **`58afd7a`** (code + tests, 64 files, +1,565/−205) and
**`ddf69ac`** (docs, 5 files) — with RED captured against the pre-wave code for A1–A3, B1, B2,
B4–B6 and B8–B12. The scoped re-review (opus, `f12dcd9..ddf69ac`) verdicted **every A, B and C item
ADDRESSED with tests, D recorded and not implemented, both implementer interpretations RIGHT**,
and left **ONE residual** — B13's pass-through half — plus two latent minors and three observations.
Ruling R36 closed the residual directly (**`6f40203`**, 2 files in `apps/app`); the five minors
below are parked with the ledger's reasons. No second wave.

## What the branch-level review found

### Critical (3), each with its ruling and its fix

- **A-C1 — migration 0023's `billing_subscriptions` backfill was a SILENT NO-OP** (packages;
  **CONFIRMED by the controller on the dev database**). Migrations run as `aesa_owner`, which FORCE
  RLS filters to zero rows of `workspaces` (`client.ts` says so), so 0023's
  `INSERT … SELECT FROM workspaces` inserted nothing — the first tenant-table data write in any
  migration, with no precedent protecting it and `migrations.test.ts` running against an empty
  database. Dev DB: **7 workspaces, 1 billing row** (only the one created AFTER 0023 through
  `workspace.create`). Consequence: every pre-existing enabled workspace read
  `missingRow: true, trialing, trialEndsAt: null` — **a trial that never expires** — and nothing
  recovered it: `ensureBillingRow` inserts a NULL clock which then BLOCKS a later `ON CONFLICT DO
  NOTHING`, and `setAgentEnabled` stamps a FRESH fourteen days on a re-toggle, the opposite of
  deviation 2. A money bug and a plan requirement. **Ruling R33**; fixed in `58afd7a`: migration
  `0025_billing_backfill.sql` re-runs the backfill under `SET ROLE aesa_platform … RESET ROLE`
  (SET ROLE, not SET LOCAL — drizzle runs pending migrations in one transaction) with
  `ON CONFLICT DO UPDATE … COALESCE … WHERE status = 'trialing'` so a NULL-clock row is repaired;
  `migrations.test.ts` drives the file's own SQL through an owner connection, and a GUARD test now
  requires `SET ROLE aesa_platform` + `RESET ROLE` around any INSERT/UPDATE/DELETE against a
  non-`RLS_EXEMPT` table in any migration — proven to catch 0023 as written (0023 is the one
  recorded known no-op). Dev DB after: 7 / 7 the moment the wave applied it, **8 / 8** by the
  re-review (the Playwright smoke creates a workspace per run), 0 with a trial clock — verified
  correct: none of the eight ever enabled its agent (deviation 2: a never-enabled workspace has a
  NULL clock by design).
- **B-C1 — a foreign `customer.subscription.*` event DISPLACED the live subscription** (api;
  **REPRODUCED against a throwaway database with the real `applyStripeEvent`**). Checkout A →
  Checkout B (the row tracks B, `stripe_double_subscription` alerts) → the operator cancels orphan A
  as the alert says → `customer.subscription.deleted` for A → row = `trial/canceled/sub_A`. B's next
  `invoice.paid` is then IGNORED by the foreign-invoice guard (the row names A): the workspace keeps
  PAYING for B while served trial caps with Autopilot stopped, and `startCheckout` permits a THIRD
  subscription; it self-heals only at B's renewal, up to a month later. A flaw in how R8 was
  implemented, not in R8 — the remediation R8 prescribed broke the workspace it protected.
  **Ruling R31**; fixed in `58afd7a`: only `checkout.session.completed` may introduce a subscription
  id different from the row's non-null one (the platform creates every subscription through
  Checkout); a `customer.subscription.created|updated|deleted` whose id ≠ the row's is `ignored` and
  alerts **`stripe_foreign_subscription_event`** (the TWELFTH `ALERT_KINDS` entry, in both apps and
  both list-equality tests) — the same asymmetry the invoice guard already had. The test is the
  reviewer's exact reproduction: A → B → delete A → B's `invoice.paid` still applies.
- **E-C1 — TWO DEFINITIONS OF "MONTH" MET AT THE BILLED NUMBER** (seams). `send.execute` deduped a
  conversation per UTC CALENDAR month (`tickets.ai_handled_month = 'YYYY-MM'`, Phase 3/5's stamp)
  while the allowance and the overage count over the Stripe ANNIVERSARY period on a paid plan
  (`periodOf` + `countManagedConversations`). A thread replied Jan 31 and Feb 1 inside a
  Jan 15 – Feb 15 period billed as TWO conversations; a thread replied Feb 10 and Feb 20 counted
  once, in the earlier period. A trial was unaffected (its period IS the calendar month) — so it
  was wrong exactly where money is charged, both-directionally, and a customer could point at it;
  "overage at conversation 301" was only true when no thread straddled a month end. **Ruling R26**;
  fixed in `58afd7a`: the claim transaction already calls `readBillingState`, so `send.execute`
  stamps `ai_handled_month` with the PERIOD start's date (a `text` column — no migration), with a
  compatibility shim (`handledPeriodStamp` / `handledPeriodStamps` / `isHandledInPeriod` in
  `@aesa/core`) reading a stored `'YYYY-MM'` as that month's 1st so tickets already stamped are not
  double-counted on upgrade; for a trial the stamp is `'YYYY-MM-01'` and nothing changes. Unit
  tests 11/11b/11c, and E2E scenario 3 re-anchors org A's period to the 15th and proves a
  follow-up sent in the next calendar month inside it is the SAME conversation (stamp unchanged,
  `used` 601, the meter event still one).

### Important, by area (fifteen in the wave's B list, all fixed; de-duplicated)

**A — `@aesa/db` / `@aesa/core` / `@aesa/contracts`** (1)

- **`included_conversations_per_domain` (300) and `overage_unit_cents` (12) were schema literals
  nothing wrote and nothing pinned to `BILLING_PRICING`** — change the constant and every standard
  row silently keeps 300 while the screen says otherwise. Fixed (B7, `58afd7a`): the two defaults are
  `BILLING_PRICING.includedPerDomain` / `.overageUnitCents` (drizzle-kit inlines the value, so a
  future change becomes a generated migration `db:check` pins; `generate` emitted nothing now), plus
  a pin test on a bare `ensureBillingRow` row flipped to `standard`.

**B — `apps/api`** (2; E's I4 is the first)

- **`invoice.*` on a `canceled` row RESURRECTED it permanently** (REPRODUCED). `deleted(t=200)` then
  `invoice.paid(t=200)` — the same-second ordering a Portal "cancel immediately + prorate" gives,
  which runbook §2.2 allows — landed `standard/active`, and since a canceled Stripe subscription can
  never become active again nothing ever undid it: a free-forever paid workspace. This upgraded the
  ledger's deferred minor 96 (`invoicePromotesPlan` not excluding a canceled row); the STATUS half
  predated `invoicePromotesPlan`. **Ruling R32**; fixed (B1, `58afd7a`): any `invoice` kind on
  `status === 'canceled'` → `ignored`; the one test that pinned the resurrection as desired flipped;
  a new case proves the same-second pair is ignored AND a later re-subscribe through Checkout applies
  with no `stripe_double_subscription`.
- **`incomplete_expired → canceled` KILLED A RUNNING TRIAL — the plan was self-inconsistent**
  (REPRODUCED: a trial with 10 days left + a deferred Checkout + `incomplete_expired` → `canceled`
  with `trial_ends_at` still future, Autopilot stopped, caps dropped). Deviation 8 said
  `incomplete`/`incomplete_expired` leave the row as it was; Task 4 Step 3's map said
  `canceled + plan trial`; the code took the destructive side. Same family: `invoice.payment_failed`
  on a never-activated subscription paged "Payment failed" onto a trial row, and `startCheckout`'s
  `already_subscribed` did not recognise trialing + a subscription id (R10's deferred state), so an
  owner could start a second Checkout — all reachable only through a delayed payment method.
  **Ruling R30 — Deviation 8 wins**; fixed (B2, `58afd7a`): `incomplete_expired` → null;
  `past_due`/`canceled` land only when `plan === 'standard'`; `startCheckout` treats a non-null id
  on a `trialing` row as **`checkout_pending`** (a new `BILLING_ERROR_MESSAGES` key, "Stripe is still
  confirming your payment"); and — the implementer's interpretation, judged right by the re-review —
  a subscription Stripe itself says is GONE is cleared from a trialing row so a fresh Checkout can
  start (below). Two pre-existing tests that applied `past_due` straight onto a never-activated trial
  row now activate first. Runbook §2.3: "cards only" until the reconciliation arm lands.

**C — `apps/worker`** (4; E's I2, I3 and I6 are among them)

- **The reembed sweep's CHUNK arm never checked the org's daily embed cap** (the answers arm did),
  and a cap-reached refill was NOT self-healing: `recordFailure`'s `failSource` is guarded on
  `processing`, so a `ready` source's document was left with NULL vectors that NO path rediscovers
  (the sweep needs `embedding IS NOT NULL`; the stuck sweep looks only at `processing`/`queued`),
  and a `crawl` source was flipped `failed/cap_reached` with copy saying "resumes after midnight"
  that nothing honoured — so changing `KNOWLEDGE_EMBED_MODEL` on a real workspace silently degraded
  every document past the first day's cap to the lexical leg FOREVER. A plan gap as much as code
  (Task 7 spelled the cap check out for answers only; R17 declined the discovery arm). Fixed (B3,
  `58afd7a`): `atEmbedCap` per org BEFORE nulling anything, an `orgAtCap` memo shared by both arms, a
  capped org counted once in `skippedCap`; **the discovery arm for `ready` sources with
  `embedded_count < chunk_count` and no live job is a carry**, and the runbook (§10) FORBIDS changing
  `KNOWLEDGE_EMBED_MODEL` in production until it lands.
- **`workspace.purge` did not re-check the cancel INSIDE the row-purge transaction** (E's I6 from the
  seam side): `cancelDeletion` clears the stamp with no due-date guard, so a cancel landing between
  phase 1 and phase 3 was lost — objects already gone (unavoidable), rows deleted anyway. A
  seconds-wide data-loss race on the one irreversible job. Fixed (B4, `58afd7a`):
  `SELECT deletion_requested_at … FOR UPDATE` at the top of phase 3, the due predicate re-applied,
  `skipped` + a `purge_failed / cancelled_mid_purge` alert carrying `objectsDeleted` when it no longer
  holds; tested with a cancel injected between phases through the `Proxy`-on-`deps.db` seam. The
  re-review traced the lock order: `cancelDeletion`'s FIRST write is the `workspaces` row itself, so
  either interleaving serialises and no `40P01` path exists.
- **The trial-scope spend stop was PERMANENT while the machinery assumed it reset** (E's I2 is (c)):
  (a) `notifyOrgCapped` keyed on the DAY and fired the operator alert under the same key, so every
  trial-exhausted workspace re-paged the owner AND re-alerted the operator daily forever; (b) the
  refusal left the ticket `triaged` with no stamp, so `ticket.backstop-sweep` arm (a) re-enqueued it
  EVERY MINUTE — ~1,440 no-op jobs per stranded ticket per day; (c) `TRIAL_BUDGET_FROM_DAY =
  '1970-01-01'` summed LIFETIME managed spend, so a DOWNGRADED workspace (deviation 8 sets
  `plan = 'trial'` on cancel) inherited its paid-era spend against the $10 budget and stopped drafting
  on cancel day — contradicting deviation 8's own "behaves like an expired trial" and the spec's
  "drafts continue" (the E2E's downgrade scenario switched to BYOK before drafting, so it never
  exercised this). **Ruling R27**; fixed (B5, `58afd7a`): the budget applies only while the derived
  STATE is `trialing`, summed from `workspaces.agent_enabled_at` (epoch only when null — now on
  `readBillingState`'s view as `agentEnabledAt`, with `SettingSources` exposing the whole `billing`
  view and `ticket.draft`'s duplicated read removed); the refusal lands **`needs_owner/trial_budget`**
  (the NINETEENTH `NEEDS_OWNER_REASONS` entry, at every sibling site — `escalationCopy`,
  `REASON_CHIP`/`REASON_SENTENCE`/`REASON_TONE`, all `Record<NeedsOwnerReason, …>` maps) through
  `escalateTicket`, which stamps the ticket so the backstop stops re-selecting it (test 3c proves it
  with a throwing stub boss) and pages once per ticket; the operator alert is gated by ONE org-level
  `billing` notice `llm_cap:trial:<org>` (no day). Tests: a `canceled` org with $500 of paid-era
  spend drafts `review/subscription_inactive`; spend predating `agent_enabled_at` does not count.
- **`billing.report-usage`'s `ORDER BY org_id LIMIT 500` never rotated** (E's I3) — the EXACT defect
  R15 removed from retention, and worse here: past 500 workspaces the tail's overage was NEVER
  reported (money the platform never collects) and its trial never told it was ending, while the
  result reported a healthy 500. The plan's bound was the plan's error. **Ruling R28**; fixed (B6,
  `58afd7a`): `REPORT_ORGS_PER_RUN` and the LIMIT gone (the collect phase is reads under per-org
  SAVEPOINTs; act and record were already per org); test: 501 orgs, the lexicographically LAST is
  reported.

**D — `apps/app`** (5)

- **"Remember this reply" was offered to a plain MEMBER** (`ticket.tsx` passed `onRemember` for every
  outbound bubble and never read the role) while `memory.rememberReply` is `managerProcedure` — the
  member got `FORBIDDEN` and `rememberErrorText` printed `owner or admin required` VERBATIM. The
  plan's Roles line anticipated the gate; `ticket.tsx` never imported `canManageWorkspace`. Fixed
  (B9, `58afd7a`): gated on `canManageWorkspace(workspace.get.role)` (already cached by the gate); a
  member test asserts `remember-<id>` is absent.
- **A lapsed or CANCELLED workspace read as a PAID plan on the billing screen** (upgrades the
  ledger's deferred minor 172 — the presentation Task 9 flagged for Robert's eyes). `billing.tsx`
  branched only on `trialing`; for `canceled`, `customer.subscription.deleted` keeps `domainQuantity`
  while `allowanceOf` drops to 50 and the stored period is still the `used` window — so the owner saw
  "Trial · 2 domains · $99.98 / month · 301 of 50 · 251 extra at $0.12" with the overage radio still
  offered, for a workspace no longer billed. The data was right; the screen composed it into a
  paid-plan sentence. Fixed (B10, `58afd7a`): the summary and the overage radio are keyed on
  `plan === 'standard'`; `canceled` reads "Cancelled" and `trial_expired` "Trial ended", each with its
  sentence, the usage tile and Subscribe; three state tests.
- **The `?checkout=success` banner thanked for an inactive subscription** (a PLAN-TEXT defect):
  `state === 'trialing' ? confirming : thanks` — an owner subscribing from `trial_expired` or
  `canceled` read "your subscription is active" above a summary still saying Trial with a Subscribe
  button, because R10 leaves the state alone until the webhook lands; Task 9's own text said "while
  the state is still trialing". Fixed (B11, `58afd7a`): `state === 'active' ? thanks : confirming`;
  tested from an expired trial.
- **The inbox `BillingBanner` SWALLOWED every refusal**: no `onError` on either mutation, an awaited
  `openExternal` inside a void `onPress`, and it never read `billing.get`'s `configured`. On an
  unconfigured server an owner in the last three days of a trial pressed Subscribe in the inbox, the
  api returned `not_configured`, the popup flashed and closed, and nothing was shown but an unhandled
  rejection — `billing.tsx` handled all of it; the banner the owner sees FIRST did not. Fixed (B12,
  `58afd7a`): the action is hidden when `!configured`, `onError` renders the api's refusal through
  the `BILLING_ERROR_MESSAGES` whitelist into the existing `blocked` slot, the await is wrapped so
  the handler never rejects (the same `try/catch` in `billing.tsx` and `danger-zone.tsx`); three
  tests including an `unhandledRejection` listener, with the mock `openExternal` now rethrowing like
  the real one.
- **The iOS share relaunch landed on "Page not found."** `expo-share-intent` reopens the app with
  `aesa://dataUrl=aesaShareKey`; Expo Router's `fromDeepLink` yields the path `dataUrl=aesaShareKey`,
  matches no route, renders `+not-found.tsx` — a ROOT route, so `(app)/_layout`'s Shell and
  `useShareIntentRouting` never mount; the owner tapped "Go home" and only then reached `/share`.
  Reasoned from BOTH libraries' sources (`useShareIntent.js`, `utils.js`; `extractPathFromURL.js`,
  `getLinkingConfig.js`), not provable without the EAS build the runbook already calls for. Expo
  Router's documented seam is `+native-intent.ts` with `redirectSystemPath`, excluded from the route
  table by `getRoutesCore.js`, so the count stays 27. **Ruling R34**; fixed (B13, `58afd7a`):
  `apps/app/src/app/+native-intent.ts` returns `'/'` for a path containing `dataUrl=`, with a unit
  test outside `src/app` and the runbook's §11 line "iOS share lands on `/share`, never on Page not
  found — confirm on the dev build, cold start and warm". **Its other half — the un-touched path for
  everything else — was inverted**, the re-review's one residual, closed by ruling R36 below.

**E — the cross-cutting seams and the docs** (2 unique, beside the four reached from the seam side)

- **The runbook's 0023 landing note was MISLEADING and gave an impossible instruction.** Every
  workspace enabled more than 14 days before the migration lands on `trial_expired` the instant the
  backfill runs — Autopilot OFF, not "tighter caps", and `org_settings` cannot lift it — and
  "subscribe before the migration" cannot be done because Checkout needs the table. Fixed (B14,
  `ddf69ac`): §1 rewritten around the truth — 0023's backfill was a silent no-op and 0025 is the one
  that lands; **migrate → deploy → IMMEDIATELY subscribe the design partners or run
  `UPDATE billing_subscriptions SET trial_ends_at = now() + interval '14 days' WHERE org_id IN (…)`**
  as `aesa_platform`; a workspace past `agent_enabled_at + 14 d` reads `trial_expired` the moment
  0025 lands.
- **CLAUDE.md and STATUS carried stale ONE/only claims** — `memory.capture` "produced by the WORKER
  alone" (the api's `rememberReply` sends it since Task 8); `resolve_stripe_customer` "the api's ONE
  cross-org read" (it is the FIFTH fixed-signature resolver, after `resolve_mailbox_connection` and
  `resolve_mailbox_subscription` (0006), `resolve_oauth_flow` (0009) and
  `resolve_draft_action_token` (0011)); "22 sites" (25 at head); the sandbox "passing
  `isAllowanceExhausted`" (it passes a literal `false`, deliberately — a probe is never a billed
  conversation); `memory.capture`'s idempotency naming only the draft column (and
  `resolved_answers_source_message_uidx` for the `messageId` path); `billing_subscriptions`' writers
  omitting `workspace.create`/`setAgentEnabled`; STATUS's "`trialEndsAtFor` is the one formula" (it
  had no production caller — now `setAgentEnabled` computes the clock with it); `boss.ts`'s "never
  sends memory.capture"; "shows the period" (the screen says "this month"). Fixed (B15, `ddf69ac`),
  each with its true value, and `setOverageMode` recorded as `ownerProcedure` — a deliberate
  deviation from the plan's Roles paragraph (owner is the better call for a money mode).

Also in E's Important set, reached independently from the seam side and fixed under the worker's
and api's entries above: the cancelled paying workspace treated as a trial that already spent its
budget (C's I3(c), R27); `report-usage`'s 500 LIMIT (C's I4, R28); `invoice.*` resurrecting a
canceled row (B's I1, R32); the purge's phase-3 re-check (C's I2). E's own minor, **the domain
quantity floor** — the nightly sync wrote `quantity: 0` for a standard workspace with no active
agent while Checkout and `allowanceOf` floor at 1, so two components disagreed about the floor (a
credit/charge pair on the invoice) — was elevated into the wave: **ruling R29**, the floor is 1
everywhere (B8, `58afd7a`; a standard workspace pays for at least one domain, which is what it
subscribed to).

**What the reviewers verified by DOING, not reading:** the api reviewer REPRODUCED both C1 and I1
against a throwaway database with the real `applyStripeEvent`, and PROBED the raw-body Stripe route
at `API_RATE_LIMIT_PER_MINUTE=2` — the third POST is 429, so the global limiter reaches the nested
route and the ledger's untested claim (minor 90) is TRUE; the app reviewer BUILT the web export
(27 routes) and grepped the client bundle — zero `expo-share-intent`, `drizzle`, `fastify` — and ran
the app suite, `tsc` and `eslint` at HEAD; the packages reviewer verified the dead
`knowledge_chunks_embedding_model_idx` with the planner (`enable_seqscan off`); the controller
confirmed A-C1 on the dev database before the wave and 8/8 after it.

### Ledger minors ruled into the wave (the brief's C list, all landed in `58afd7a`)

- `apps/api/test/error-surface.test.ts` — the `@sentry/`/`@opentelemetry/` undici widening REMOVED:
  the probe shows undici resolves exactly once, from `packages/crypto`; the narrow filter passes;
  an unexercised widening is an open door.
- `apps/api/src/workspace/lifecycle.ts` — `requestDeletion` cancels ANY non-null
  `stripe_subscription_id` on every status but `canceled` (a deferred subscription that later
  settles would otherwise bill a purged workspace with no row left to cancel from; the `canceled`
  exclusion is the non-idempotent port, carry D).
- `apps/api/src/trpc/routers/workspace.ts` — `setAgentEnabled(true)` refuses while
  `deletion_requested_at` is set (`PRECONDITION_FAILED`, `WORKSPACE_ERROR_MESSAGES.deletion_pending`;
  off still allowed; `cancelDeletion` lifts it).
- `apps/api/src/billing/stripe.ts` — `timeout: 15_000` and an explicit `maxNetworkRetries: 2` on the
  Stripe client (the SDK's defaults, 80 000 / 2, verified in `node_modules`).
- `apps/worker/src/jobs/sweeps-daily.ts` — arm (g)'s `DELETE` batched in `RETENTION_BATCH` slices
  through `retention-sweep.ts`'s `deleteAged` (exported with a `column` parameter): a Phase 6
  triage-run backlog could exceed the 30 s statement timeout and roll back EVERY arm, every night,
  because the backlog never shrank; arm (b)'s "the run rows themselves are never pruned" comment
  corrected (the ledger's minor 46).
- `apps/worker/src/jobs/keys-rotate.ts` — the stale "Task 11 replaces this" comment deleted.
- `apps/worker/scripts/keys-rotate.ts` — `pathToFileURL(process.argv[1])` instead of
  `new URL('file://…')` (the ledger's minor 131: silently enqueued nothing on a path with a space).
- `packages/core/src/redact.ts` — `redactHeaders` keeps only `typeof value === 'string'` (redacted)
  and deletes anything else: a scrubber never throws.
- `packages/queue/src/observe.ts` — the doc now says the observer runs AFTER `scrubJobError` (it
  does).
- `apps/app/src/screens/share.tsx` — `fileName ?? 'shared-file'`, `mimeType ?? ''`, `size ?? null`
  coerced at the ONE seam (the library can yield null; a null `fileName` threw inside `useUpload`'s
  synchronous `setPending` and the Upload button silently did nothing).
- `apps/app/src/screens/settings/danger-zone.tsx` — `exportStatus` polled only for the owner
  (`enabled: ws.data?.role === 'owner'`).
- `packages/core/src/billing.ts` — `trialEndsAtFor` is now the api's clock: `setAgentEnabled`
  computes it from the row's returned `agent_enabled_at` (`COALESCE(existing, now)`), so the
  migration's formula and the api's agree to the millisecond and a re-toggle can never mint a fresh
  fourteen days; the SQL `COALESCE(trial_ends_at, …)` guard stays.
- The ledger's deferred minors CLOSED by the wave beyond those (struck through in place in STATUS):
  96 (`invoicePromotesPlan` on a canceled row — R32), 110 (the trial spend page re-paging daily —
  R27), 172 (the lapsed-workspace presentation — B10), 131's `new URL` and 46's stale comment above.

## The fix wave

Three commits, one implementer for the first two (ruling R35) and the controller for the third
(ruling R36):

| Commit | Scope | Findings closed |
|---|---|---|
| `58afd7a` | code + tests, 64 files (+1,565/−205): `packages/{contracts,core,db,queue}`, `apps/api`, `apps/worker`, `apps/app`; migration 0025 committed BEFORE `db:check` and applied to the dev DB | A1 (R33), A2 (R31), A3 (R26), B1 (R32), B2 (R30), B3, B4, B5 (R27), B6 (R28), B7, B8 (R29), B9, B10, B11, B12, B13's share landing (R34), the thirteen C items |
| `ddf69ac` | docs, 5 files: `CLAUDE.md`, `docs/STATUS.md`, the runbook, the CASA evidence, `apps/api/src/boss.ts` (a comment) | B14, B15; the twelve D carries recorded (STATUS "Carries recorded by the fix wave"; runbook §2.3 and §10) |
| `6f40203` | `apps/app/src/app/+native-intent.ts`, `apps/app/src/lib/native-intent.test.ts` | B13's pass-through half (R36) |

RED was captured against the pre-wave code for A1, A2, A3, B1, B2, B4, B5, B6, B8, B9, B10, B11 and
B12 (the report pastes each); B3's and B7's tests were written against the fixed code (B7 is a pin,
B3's old behaviour is the reviewer's reproduction); the A3 E2E assertion was written against the
fixed code with 11b as its pre-wave RED. The implementer noted one benign ESM cycle
(`sweeps-daily.ts` ↔ `retention-sweep.ts`, function declarations only) and one first-run E2E
failure under parallel load caused by its own scenario-3 follow-up minting a second learned answer —
rewritten as a reinforcement (approvals 4 → 5, pinned with a `waitFor`), after which the four E2Es
together and then the full suite passed. Full gate at `58afd7a`: exit 0, **3,035 tests + 4
conditional skips** (the wave's report summed its own per-package figures to 3,051 — an arithmetic
slip; the per-package numbers are right and add to 3,035), 27 routes with `+native-intent` not in
the table, Playwright 1/1, the Phase 7 E2E 11/11 solo AND in the suite, `db:check` in sync, the
`e2e-phase3` case-10 flake silent. Full gate at `6f40203`: exit 0, the same 3,035 + 4 — pasted at
the end of this record.

## The re-review and the residuals

The scoped re-review (opus, over `f12dcd9..ddf69ac`) read every item against the diff and the
installed libraries' sources, and verdicted: **A1/A2/A3 ADDRESSED with tests** (A1's guard test
proven to catch 0023 as written; A3 traced end to end including the shim, the trial's own stamp and
the one-`now` claim/landing pair; A2's test is the brief's exact reproduction); **B1–B12 and B14/B15
ADDRESSED**; **all thirteen C items ADDRESSED**; **all twelve D carries RECORDED, none implemented**;
and B13 **NOT ADDRESSED in one half**.

- **The residual — `+native-intent.ts` DROPPED every non-share native url instead of passing it
  through.** The wave's `redirectSystemPath` returned `null` for any path without `dataUrl=`, reading
  the router's contract as "null = no redirect". It is the opposite: both call sites do
  `href = await redirectSystemPath(...)` then `if (href) listener(href)`
  (`expo-router/build/link/linking.js`), and `getLinkingConfig.js` uses the return AS the initial url —
  a falsy return discards the incoming url. Latent today (the app has no associated domains, push
  taps use `router.push`, the connect flow polls, so the share relaunch is the only native url the
  app receives), but the first universal or `aesa://` link added later would have been swallowed at
  launch — and the unit test pinned the wrong behaviour. **Ruling R36**: fixed DIRECTLY by the
  controller (`6f40203` — one expression + three assertion flips, verified against expo-router's
  source) rather than parked or re-waved: `redirectSystemPath` returns the path unchanged for every
  non-share url, `null` only for a non-string. Cost if wrong: none reachable — passing the url
  through is exactly what the router does when no `+native-intent` file exists, so the change is the
  no-op equivalent for every url but the share relaunch. `native-intent.test.ts` 3/3, app `tsc` and
  `eslint` clean, the full gate at that tree green.
- **The two implementer interpretations, both judged RIGHT.** (1) **B5's alert gate** — R27 asked for
  "one page per ticket and a once-per-org operator alert"; the durable once-per-org gate is ONE
  org-level `kind: 'billing'` notice `llm_cap:trial:<org>` (no day), inserted in the SAME transaction
  as the `escalateTicket`, the alert firing only when that INSERT returned a row — so two concurrent
  capped tickets produce exactly one alert (the second `onConflictDoNothing` waits on the first's
  commit); it doubles as the owner's "subscribe to keep the agent drafting" nudge, the only text that
  says what clears the cap; no other durable per-org "once" primitive exists that survives longer;
  the 90-day retention re-arm is unreachable for a real trial (≤ 14 days). The first capped ticket
  therefore lands two notification rows (its page + the org notice) and one alert; every later
  ticket its page alone. (2) **B2's cleared ids** — R30 read literally (a deferred id stays; a
  non-null id on `trialing` = pending) locks a workspace whose deferred Checkout expired out of
  Checkout FOREVER, since nothing else ever nulls the id. The clearing fires only when the event
  passed the R31 guard (its id equals the row's, or the row's is null — a foreign `deleted` can never
  reach it), the subscription is GONE (`deleted`, or `updated` to `canceled`/`incomplete_expired`),
  and the row is `plan !== 'standard' && status === 'trialing'` — a standard row is never cleared,
  and the only subscription a trialing row can hold is a deferred one. The re-reviewer enumerated
  every `stripe_subscription_id` transition (checkout × four states; `subscription.updated`/`deleted`
  × {null, own, foreign} × {trial, standard} × {trialing, canceled}; invoice × the same): no path
  leaves a live subscription the row does not name, and no path leaves a row naming a dead
  subscription with Checkout refused (a `canceled` row keeps its dead id but `startCheckout` admits
  `canceled`).
- **The five minors parked after R36**, verbatim from the ledger:
  - a late `invoice.paid` naming a subscription whose ids B2 already CLEARED from a trialing row
    (created ≥ the clearing event's) passes both the foreign-invoice guard (row id null) and R32 (row
    not canceled) and re-attaches the dead id as trial/active. Needs a customer paying an orphaned
    open invoice of an operator-cancelled subscription (`incomplete_expired` voids its own); recovery
    is the runbook's Dashboard + hand fix; the reconciliation-arm carry (D) is the real answer.
  - the A3 legacy shim honours `'YYYY-MM'` only for a period starting on the 1st — a paid mid-month
    period with pre-wave `'2026-09'` stamps would count those threads once more on upgrade. Moot at
    merge (no paid workspace exists before launch); recorded so the narrowness is a known choice.
  - a pre-wave `trial/past_due` row (an `invoice.payment_failed` that landed before R30) receiving a
    `deleted` keeps `past_due` — unreachable post-wave, no such row pre-launch.
  - `readBillingState` costs one extra PK lookup on `workspaces` per call (B5's `agentEnabledAt`) at
    25+ sites — negligible.
  - the B5 org notice and the ticket page share the title "Trial AI budget reached", so the first
    capped ticket lands two same-titled pushes in the same second.

## The spec's Phase 7 Verify list, item by item (reviewer E)

The proving test column is a fact of the branch; the verdict column is E's, with what the review
added.

| Spec Verify item | Proving test | Verdict |
|---|---|---|
| An overage record appears at conversation 301 (with 2 domains × 300, the 601st) | `apps/worker/test/e2e-phase7.test.ts` scenario 3 — four real sends through `completeSend` on the MANAGED meter, the nightly pass reports nothing at 600, exactly ONE unit at 601 with identifier `<org>:<periodStartIso>:1`, the watermark moves, a re-run reports nothing — and, since the wave, a follow-up in the next calendar month inside a 15th-anchored period is the same conversation; `apps/worker/test/billing-report-usage.test.ts`; `packages/core/test/billing.test.ts` (the worked example 600 / 601→1 / 650→49 / 650→0) | **Proven — after the wave.** E verified the meter split and the one billing reader, then found the Critical that made "301" true only when no thread straddled a month end (the calendar-month dedupe vs the Stripe period); R26 fixed it and the E2E now proves the period case. |
| A downgrade lowers caps the same day | `e2e-phase7.test.ts` scenario 6 — `customer.subscription.deleted` → `canceled`, `plan = 'trial'`, `knowledge.max_sources` back to 10 the same instant; scenario 2 for the upward direction; `packages/db/test/settings.test.ts` | **Proven.** E verified plans from one source and zero `{ org }`-only sites. The same seam surfaced C's I3(c): a downgraded workspace inherited its paid-era spend against the trial budget and stopped drafting on cancel day — R27 makes deviation 8's "behaves like an expired trial" true (test 3d). |
| An unpaid subscription suspends auto-send (drafts continue; a human approval still sends) | `e2e-phase7.test.ts` scenario 5; scenario 1 for the trial clock; `apps/worker/test/send-execute.test.ts` (the eighth lever); `packages/core/test/autonomy.test.ts` | **Proven.** C verified the send path's lock order, the CAS, the lever after `category_off` and `decide()` untouched; the wave's R30 keeps `past_due` off a never-activated trial row. |
| Kill a worker mid-send → exactly one email; kill Postgres for two minutes with mail arriving → cursors intact, no duplicate ticket | The mock-tier cases in `apps/worker/test/e2e-phase3.test.ts`; the real-provider walk is the Phase 7 runbook §5 | **A runbook step, recorded as such** — the review could not run it (Robert's checks, below). |
| Design partners two weeks with zero cross-org rows and zero double sends | The Phase 7 runbook §6 (the daily checks and the cross-org query); `packages/db/test/rls.test.ts` and `purge.test.ts` | **A runbook step; the structural guarantees verified** — RLS on every tenant table, `PURGE_ORDER` pinned AND respecting the global lock order, every runbook column resolving. |
| Gmail behind CASA, Microsoft first | The Phase 7 runbook §6 and `docs/security/2026-09-casa-evidence.md` | **Recorded.** E read the evidence package: all 178 cited paths exist ("unusually honest"). |

Phase 7 scope items checked beyond the Verify list, each with a named proving test: the retention
sweep (`retention-sweep.test.ts` — two orgs at 180 vs 30 days; E2E scenario 7); delete with grace
(`workspace-lifecycle.test.ts`, `workspace-purge.test.ts` — the reverse order raises `23503`, and
since the wave a mid-purge cancel wins; `purge.test.ts`; E2E scenario 8 with the foreign-key skip);
export (`workspace-export.test.ts` — the secret grep over the produced bytes); `keys.rotate`
(`keys-rotate.test.ts`; E2E scenario 9); "Remember this reply" (`memory-capture.test.ts`,
`memory-router.test.ts`; E2E scenario 10; the member gate since the wave); the two knowledge sweeps
(`knowledge-stuck-sweep.test.ts`, `knowledge-reembed-sweep.test.ts` — the chunk arm under the cap
since the wave; E2E scenario 11); the admission pool (`drafting-admission.test.ts`, the call-site
tests); Sentry with org attribution and the PII boundary (`apps/{api,worker}/test/observability.test.ts`
— twelve kinds); the share sheet (`share.test.tsx`, `share-routing.test.ts`, `native-intent.test.ts`,
the emitted web bundle grepped); the Billing screen, banner and danger zone (`billing.test.tsx`,
`billing-banner.test.tsx`, `danger-zone.test.tsx` — the lapsed states and the surfaced refusals since
the wave); and migration 0025's backfill through an owner connection with the SET ROLE guard
(`migrations.test.ts`).

## Rulings verdict (reviewer E, against the spec) — R1–R25, and the wave's R26–R36

E read all twenty-five execution-time rulings against the spec and **would reverse none**: "none of
the 25 narrows spec text". The load-bearing verdicts, then every ruling:

| # | Ruling | E's verdict |
|---|---|---|
| R1 | Task 6 imports `auditPerOrgArm` from `sweeps-daily.ts` instead of copying it | Upheld (A verified) |
| R2 | `PlanId` lives once in `@aesa/contracts`; `core/plans.ts` re-exports it | Upheld (A verified) |
| R3 | `includedConversationsPerDomain` keeps its name on both tiers; `allowanceOf` documents the flat trial reading | Upheld (A verified) |
| R4 | The baseline is accepted modulo the known `e2e-phase3` case-10 flake; a gate failing ONLY there is re-run solo before it counts as red | Upheld (the flake fired in no gate of the review, the wave or R36) |
| R5 | `knowledge_sources.failure_reason` has no CHECK; `abandoned`/`stuck` need no DDL | Upheld |
| R6 | **AMENDS deviation 5's mechanism**: the trial allowance is a FLAT CONSTANT, never a stored column | **UPHELD** — the spec's 300/domain governs the $49.99 plan; it states no trial allowance, so a flat constant narrows nothing |
| R7 | The mailbox connection cap counts LIVE SYNC SLOTS, not `reauth_required` | Upheld |
| R8 | A double completed Checkout ACCEPTS the newer subscription and ALERTS with both ids | Upheld as a ruling — its IMPLEMENTATION was B's Critical (following the alert displaced the live subscription), closed by R31 |
| R9 | One Minor folded into Task 4's fix round (a Checkout must not seed `active` for `incomplete`) | Upheld |
| R10 | Fulfil on the session's own `payment_status`; `invoice.paid` for the row's own subscription establishes `plan = 'standard'` again | Upheld; the deferred state it created is what R30's `checkout_pending` and the cleared-ids interpretation now handle |
| R11 | The `allowance_reached` page follows `isAllowanceExhausted` | Upheld |
| R12 | `decide()` is NOT reordered: `subscription_inactive` before the guardrail branch is the spec's order | **UPHELD as a ruling, with a recommendation that Robert AMEND THE SPEC** — moving `subscription_inactive` alone would be inconsistent with the kill-switch/agent-disabled branches, which mask the same three reasons today; `category_off` (and `dmarc_fail`) join the question |
| R13 | `audit_log_created_idx` in migration 0024 | Upheld (A verified) |
| R14 | A mismatched `export_key` lands `failed` + alert; `exportObjectKey` lives in `@aesa/contracts` | Upheld (`exportObjectKey` imported on both sides) |
| R15 | `retention.sweep` takes ONE SHORT transaction PER ORG and visits every workspace | Upheld — and E/C found its reasoning had NOT been applied to `billing.report-usage` (R28) |
| R16 | The R14 shape stands; `requestExport` refuses while `queued` | Upheld |
| R17 | The re-embed sweep's stranded document is an alert; no recovery arm | Upheld as a ruling; C found the cap-check gap beside it (B3) and the rediscovery arm is now a named carry |
| R18 | `not_pending`'s message moves into `WORKSPACE_ERROR_MESSAGES` | Upheld |
| R19 | The deletion notification is DAY-scoped | Upheld |
| R20 | A remembered reply's skip is audited by the job with a reason | Upheld |
| R21 | `exportStatus` stays `orgProcedure` for STATE; the download URL is the OWNER's | Upheld |
| R22 | The deletion copy stops promising a reversal: the Stripe cancel is immediate | **UPHELD** — not a narrowing, but harsher than the 30-day grace implies; `cancel_at_period_end` would make the money follow the grace (a later improvement, carried) |
| R23 | Two billing signals with two names | Upheld |
| R24 | **OVERRULES Task 9's Important**: the danger zone stays OWNER-only in the UI | **UPHELD**; its cost recorded — a manager on a paused workspace sees nothing (a read-only "Paused by the owner" inbox line would close it) |
| R25 | ONE home for the redaction helpers (`packages/core/src/redact.ts`) | Upheld (A verified; the two `billing/stripe.ts` scrub copies are the same class, carried) |
| R26 | **(wave)** A billed conversation is deduped on the BILLING PERIOD, never the calendar month — `ai_handled_month` carries the period start's date, with the `'YYYY-MM'` shim | The controller's answer to E's Critical; AMENDS the calendar-month stamp Phase 3/5 established |
| R27 | **(wave)** The trial budget applies only while the derived STATE is `trialing`, from the trial's own clock; the refusal is `needs_owner/trial_budget` through `escalateTicket` with a once-per-org alert | The answer to C's I3 / E's I2; makes deviation 8's "behaves like an expired trial" TRUE |
| R28 | **(wave)** `billing.report-usage` drops its 500-org window | The answer to C's I4 / E's I3 (R15's reasoning; here the promise is money) |
| R29 | **(wave)** The domain-quantity floor is 1 everywhere | E's own minor, elevated |
| R30 | **(wave)** Deviation 8 wins over Task 4's status map: `incomplete_expired` moves nothing; `past_due`/`canceled` land only on a `standard` row; a subscription id on a `trialing` row is a pending Checkout | The answer to B's I2; the plan's self-inconsistency resolved in the spec's non-destructive direction |
| R31 | **(wave)** Only `checkout.session.completed` may introduce a different subscription id; a foreign `customer.subscription.*` is ignored + alerts `stripe_foreign_subscription_event` | The answer to B's Critical; ALERT_KINDS becomes 12 |
| R32 | **(wave)** Any `invoice.*` on a `canceled` row is ignored | The answer to B's I1 / E's I4 |
| R33 | **(wave)** Migration 0025 re-runs the backfill under `SET ROLE aesa_platform … RESET ROLE`, with the guard test | The answer to A's Critical |
| R34 | **(wave)** `+native-intent.ts` redirects a `dataUrl=` system path to `/` | The answer to D's I5 |
| R35 | **(sequencing)** One implementer, two commits, one scoped re-review; residuals adjudicated, not re-waved | Followed exactly |
| R36 | **(post-re-review)** B13's residual fixed DIRECTLY by the controller: `redirectSystemPath` returns the path unchanged for every non-share url, `null` only for a non-string | The re-review's one residual, closed at `6f40203` |

## The execution ledger's deferred minors, rolled up for triage

Thirty-five `minor (deferred)` lines from the SDD ledger, grouped by area. Each reviewer triages
their area's list — **fix in the wave**, **carry in STATUS**, or **not a defect** — and the
disposition is recorded in the findings sections above (fixed in the wave, carried, or not a defect).

**A — db / core / contracts / queue**

- `billing.test.ts` never pins `trialEndsAt === now` (the code uses `<=`, correct). *(T2)*
- `periodOf`'s fallback has no December→January rollover case. *(T2)*
- The worked example's day-2/3 tests hardcode allowance 600 instead of `allowanceOf(...)`. *(T2)*
- Two files outside Task 2's brief touched (`source-list.tsx` labels; `contracts/test/autonomy.test.ts` exact array) — mechanical, disclosed. *(T2)*
- `purge.ts`: the between-function order (`purgeWorkspace` BEFORE `purgeAuthRows`) was undocumented and untested at Task 3 — Task 6 documented it in `workspace-purge.ts`'s header and `workspace-purge.test.ts` purges an org with a `workspaces` row; the ledger line predates that. *(T3, likely closed)*
- `purge.test.ts:88` seeds tickets without `agentId`/`categoryId`, so two of the four restricting tenant FKs are ordered by inspection only. *(T3)*
- `rewrapOrgDek` throws (does not return) when the ring lacks the row's `kek_version` — undocumented on a three-outcome contract at Task 3; `keys-rotate.ts`'s header now states it. *(T3)*
- `countManagedConversations` truncates period bounds to UTC days; the boundary day lands wholly in the later period — a deliberate attribution rule, undocumented. *(T3)*
- `resolve_stripe_customer` returns ZERO ROWS for an unknown customer (carried into Task 4, handled). *(T3, closed)*
- Task 3's report prose said 30 `PURGE_ORDER` tables; the code lists 31 (code correct). *(T3, cosmetic)*
- `auditPerOrgArm`'s `action` widened to `string`, losing the compile-time check at its three existing call sites. *(T6)*

**B — api**

- `serviceDeps` duplicated over `ServerDeps` and the tRPC context; `webhook.ts` inlines the clock instead of `service.ts`'s `clock()`. *(T4)*
- Dead `AUDIT_ACTIONS[event.type] ?? 'billing.event'` fallback; redundant `?? null` on a non-nullable `ctx.user.email`. *(T4)*
- `startCheckout` audits AFTER the Stripe session exists, so a failing third transaction gives a 500 with a live session in Stripe. *(T4)*
- `recordWebhookEvent` precedes application, so a throw after it loses the event to the dedupe on Stripe's retry (plan-mandated; a lost checkout is recovered by the following `invoice.paid`) — runbook §2.3. *(T4)*
- No test asserts `@fastify/rate-limit` covers `/webhooks/stripe`; the global 300/min per IP limiter vs Stripe's small delivery IP set — runbook §2.3. *(T4)*
- **`invoicePromotesPlan` does not exclude an already-`canceled` row**, so a late dunning `invoice.paid` on a cancelled subscription promotes `plan` to standard as well as `status` to active — a one-line guard (`&& state.status !== 'canceled'`); the test that names the scenario asserts only `status`. The ledger asked the FINAL REVIEW to triage it. *(T4, introduced in fix round 2)*
- No reconciliation sweep recovers a workspace whose deferred checkout never receives a follow-up `invoice.paid`/`subscription.updated` (a general webhook-only-billing risk). *(T4)*
- An already-cancelled subscription inside the webhook window yields `billing_cancel_failed`, so a broken webhook makes deletion impossible (belongs with the reconciliation gap). *(T8)*
- A retry from `ready` orphans the previous export bundle while its link stays valid. *(T8)*
- The deletion audit detail records neither side effect, so "who stopped the agent" is unanswerable on that path. *(T8)*
- The writes-nothing proofs assert different tables in different cases. *(T8)*
- `setRetentionDays` is untested at its legal bounds (the DB CHECK agrees with the contracts constants — coverage only). *(T8)*
- `unwrapRemember`'s three sentences are router-local literals where R18 moved the workspace half into contracts. *(T8)*
- `cancelDeletion` re-derives `!isBillingActive(billing.state)` when `readBillingState` already returns `billing.active`. *(T8)*
- `stripe_webhook_rejected` lost its stack frames and per-request child logger to the alert helper's scalar-only signature — runbook §2.3. *(T11)*

**C — worker**

- `sweeps-daily.ts` arm (b)'s inline comment "the run rows themselves are never pruned" is now false (arm (g) prunes them). *(T1)*
- `outcomes.ts` `import type { TicketDraftDeps }` from `ticket-draft.ts` is a type-only reversed dependency; a narrower `{ db, logger, enqueueNotify }` shape would remove it. *(T1)*
- `ticket-triage.ts` carries its own private `escalateProviderUnavailable`/`killCredential`-shaped copies (pre-existing); consider consuming `outcomes.ts`'s. *(T1)*
- The BYOK→managed fallback call bypasses the admission pool — the one managed call the deployment ceiling does not see. *(T5)*
- The trial spend page uses a daily key on a budget that never resets, so it re-pages every day forever. *(T5)*
- `billing_subscriptions` is read twice per transaction at every migrated site (`loadSettingSources` calls `readBillingState` internally). *(T5)*
- The managed meter resolves the model config at SEND time, so a draft that sat in review across a managed↔BYOK switch is counted under the wrong mode (plan-mandated; `confidence_breakdown.mode` records what ran). *(T5)*
- `trialNotices` counts the allowance page too; `billing-report-usage.test.ts:469`'s title promises a failing org the body lacks (the per-org SAVEPOINT catch untested); a waiting `acquire` holds a pooled client for the whole 60 s, spent from the 240 s watchdog — runbook §8. *(T5)*
- `countingAdmission('none')` is dead code; a redundant `down = false` reset in the new report-usage test. *(T5)*
- `Buffer.concat` doubles peak memory at the 200 MB export ceiling (runbook §7); an aborted/expired export reads to the owner as "could not be finished"; no export case proves a second org's rows are absent from a bundle (doubly protected in code); `new URL(file://…)` instead of `pathToFileURL` in `scripts/keys-rotate.ts` breaks the entry-point check on a path with a space or `#`; `workspace.purge-sweep`'s select has no LIMIT. *(T6)*
- `retention.sweep` loads the whole workspace list in one SELECT and runs N sequential transactions — the accepted consequence of R15 (runbook §7); a missing paragraph break in `workspace-export.ts`'s header. *(T6)*
- The answers arm's global `ORDER BY id LIMIT 128` lets one org at its embed cap starve every other until the UTC day rolls (`fairSelectSql` exists for this shape); arm 1 increments counters inside the savepoint and arm 2 outside; neither vector UPDATE carries the redundant `org_id` predicate the embed-batch write adds; memory idempotency is proven at the application level twice and never through the partial unique index; an inbound or body-less `messageId` was a silent skip (closed by R20); `boss` is unused in the reembed sweep. *(T7)*
- `localVariablesIntegration` would attach stack-frame locals outside `beforeSend`'s reach under `--inspect` — inert today; runbook §3.1. *(T11)*
- E2E: scenario 9 length-checks the post-rotation DEK rather than comparing bytes; `afterAll` is unguarded if `beforeAll` throws between `createTestDatabase` and `startBoss`; the harness helpers are re-copied across four E2E files (~300 lines worth a shared `e2e-harness.ts`); a local `Breakdown` re-declaration hides drift from the worker's shape; the plan's scenario-3 heading says "301" where 2 domains × 300 makes it 601. *(T12)*

**D — app**

- **Flag for Robert's live walk:** `trial_expired`/`canceled` fall into `billing.tsx`'s paid-plan branch, so a lapsed workspace reads "trial · 0 domains · $0.00 / month" beside a Subscribe button — correct data, undignified presentation, untested. *(T9)*
- `rememberErrorText` renders `error.message` verbatim with no whitelist (no `MEMORY_ERROR_MESSAGES` catalog exists); `DangerZone`'s independent `workspace.get` causes one extra background refetch; `formatDate`/`daysUntil` duplicated across three screens. *(T9)*
- No ESLint rule stops a future file importing `expo-share-intent` directly outside the split (systemic to the drop-zone convention too); both provider tests use a passthrough mock, so a regression that silently drops the real wrap would pass. *(T10)*

**Two api-surface carries from Task 12** (for B): `setAgentEnabled` is router-only, so the E2E
replays its two COALESCE statements — a `@aesa/api/workspace` service for it is the right carry;
`applyStripeEvent` is not re-exported by the api's `./billing` entry point
(`export { applyStripeEvent } from './webhook.ts'` in `service.ts` closes it).

**One process note** (for C): Task 5's implementer reported that only 2 of its 6 suites were
genuinely test-first (`drafting-caps`, `billing-report-usage`); `drafting-admission`, `ticket-draft`,
`send-execute` and `config` were test-after with mutation evidence substituted. The final review
should weigh whether the four test-after suites actually pin behaviour.

## What the review verified holds

**The seams (reviewer E).** One billing reader — `billingStateOf` is called only inside
`packages/db/src/billing.ts`, and `billing.get`, the draft, sandbox, send and report jobs,
`loadSettingSources` and the E2E all go through `readBillingState`; the meter split —
`ai_handled_conversations_managed` is the only meter the allowance and the overage read, and
`llm_cost_micros_byok` never enters a cap; plans from one source, with zero `{ org }`-only
`resolveSetting` sites (25 at head, every one on `loadSettingSources`); every Stripe call outside
every transaction in BOTH apps, each with a guarded write behind it; `PURGE_ORDER` pinned to the
migration table list AND respecting the global lock order; the four-places rule complete for all
three new queues; `exportObjectKey` imported on both sides; `ALERT_KINDS` tallying exactly the
`alert()` call sites (eleven at review, twelve since R31); the PII boundary with ONE home; and the
record itself — all 178 paths the CASA evidence cites exist, every runbook SQL column resolves, and
the commit-trailer history is stated exactly.

**The worker (reviewer C).** The send path's lock order and its CAS are untouched; the eighth lever
sits after `category_off` in `firstKillLever`; the managed meter bumps inside the existing
`ai_handled_month` stamp (now the period's, R26); `decide()` is byte-identical and its two new inputs
are facts; the cap rule holds (`costMicros` alone feeds the daily cap and the trial budget); the
admission pool never loses a draft and never admits a BYOK call; the four-places rule; and the
E2E's eleven scenarios each drive the real job or service they name with before/after row counts on
the bystander orgs — none can pass under a no-op.

**The app (reviewer D).** All three app rules hold at HEAD, not only in the diff — no value import of
a server package or `node:*`, no `fontWeight`, no literal colour outside `theme.ts`; the web export
has 27 routes and its client bundle carries zero `expo-share-intent`, `drizzle` or `fastify`; the
app suite, `tsc` and `eslint` were run clean at HEAD.

**The api (reviewer B).** The Stripe port boundary (the SDK never leaves `billing/stripe.ts`);
transaction discipline at every Stripe site; the raw-body parser's encapsulation (its own
`register()`, the app-wide parser untouched elsewhere) with the global limiter PROBED to reach the
nested route; owner-only roles on every money and lifecycle mutation; and the PII boundary — B could
find no default Sentry integration path that escapes `beforeSend`.

**The packages (reviewer A).** R2/R3/R6/R13/R25 verified in its area; RLS enabled, forced and
two-policied on `billing_subscriptions` (`org_id` the PK); the purge's table pin; `rewrapOrgDek`'s
byte guard; the redaction helpers' one home — and the one thing no test could see, the backfill
that ran as the wrong role, which is why the guard test now exists.

**Robert's manual checks before real tenants** — what the review could not run — are in
`docs/runbooks/2026-09-phase-7-external-setup.md`: **the EAS dev build for the iOS share relaunch**
(it must land on `/share` directly, never on Page not found — cold start and warm; D reasoned R34
from both libraries' sources but only a build proves it), **the Stripe test-mode flow end to end**
(subscribe with a test card — cards only until the reconciliation arm lands — watch
`checkout.session.completed` land, force `past_due`, cancel through the Portal and cancel ONLY the
orphan a `stripe_double_subscription` alert names, never the survivor, read the meter after
`billing.report-usage`), **the Sentry DSN in both apps with `SENTRY_RELEASE` from the deploy SHA and
alert rules on the twelve kinds**, the migration order (migrate → deploy → IMMEDIATELY subscribe or
extend the design partners' trial clocks — 0025 lands them on `trial_expired` the instant it runs if
their agent was enabled more than 14 days earlier), the four-step KEK rotation, the chaos walk, the
two-week design-partner run with its daily checks, and the standing prohibition: **do not change
`KNOWLEDGE_EMBED_MODEL` in production until the rediscovery arm lands.**

## The final gate

Raw output at the head `6f40203` (`gate-r36.log`), with `S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1 S3_BUCKET=aesa-dev S3_ACCESS_KEY_ID=aesa S3_SECRET_ACCESS_KEY=aesaaesa
S3_FORCE_PATH_STYLE=true` exported and minio up. The web export, the Playwright smoke and the
Phase 7 E2E's standalone run below it are from the wave's own gate at `58afd7a` (the R36 commit
touched two `apps/app` files; the app suite ran 542/542 at `6f40203`).

### `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check` — exit 0

```
$ pnpm typecheck && pnpm lint && pnpm test && pnpm db:check

# typecheck: Scope: 15 of 16 workspace projects — every project "Done".
# lint:      eslint . — clean, no output.
# test (pnpm -r test), per package:
packages/contracts test:  Test Files  10 passed (10)
packages/contracts test:       Tests  42 passed (42)
packages/crypto test:  Test Files  6 passed (6)
packages/crypto test:       Tests  52 passed (52)
packages/platform-mail test:  Test Files  3 passed (3)
packages/platform-mail test:       Tests  19 passed (19)
brand test:  Test Files  6 passed (6)
brand test:       Tests  110 passed (110)
packages/core test:  Test Files  13 passed (13)
packages/core test:       Tests  300 passed (300)
packages/llm test:  Test Files  12 passed (12)
packages/llm test:       Tests  158 passed (158)
packages/agent test:  Test Files  6 passed (6)
packages/agent test:       Tests  71 passed (71)
packages/db test:  Test Files  22 passed (22)
packages/db test:       Tests  119 passed (119)
packages/queue test:  Test Files  6 passed (6)
packages/queue test:       Tests  29 passed (29)
packages/mail test:  Test Files  12 passed (12)
packages/mail test:       Tests  242 passed (242)
packages/knowledge test:  Test Files  14 passed (14)
packages/knowledge test:       Tests  165 passed (165)
packages/test-kit test:  Test Files  2 passed (2)
packages/test-kit test:       Tests  39 passed | 4 skipped (43)
apps/api test:  Test Files  33 passed (33)
apps/api test:       Tests  398 passed (398)
apps/app test: Test Suites: 66 passed, 66 total
apps/app test: Tests:       542 passed, 542 total
apps/worker test:  ✓ test/e2e-phase7.test.ts (11 tests) 156457ms
apps/worker test:  Test Files  50 passed (50)
apps/worker test:       Tests  749 passed (749)

# TOTAL: 3,035 passed + 4 conditional skips (test-kit's) —
#   42 + 52 + 19 + 110 + 300 + 158 + 71 + 119 + 29 + 242 + 165 + 39 + 398 + 542 + 749 = 3,035.

# db:check
No schema changes, nothing to migrate 😴
migrations in sync with schema
EXIT=0

# NOTE — the known `e2e-phase3` case-10 flake did not fire in this run, in the wave's runs, or in
# the close-out's.
```

### `pnpm --filter @aesa/app export:web` and `pnpm e2e` — at `58afd7a`, exit 0

```
› Static routes (27):
/ (index) /share /terms /privacy /_sitemap /post-auth /+not-found /(app)/inbox /invite/[id]
/(auth)/verify /(app)/activity /(auth)/sign-in /create-workspace /(app)/settings/ai
/(app)/ticket/[id] /onboarding/[step] /(app)/settings/team /(app)/settings /(app)/settings/agents
/(app)/settings/memory /(app)/settings/billing /(app)/settings/autopilot /(app)/settings/knowledge
/(app)/settings/mailboxes /(app)/settings/workspace /(app)/settings/agents/[id]
/(app)/settings/notifications
Exported: dist
# 27 — `+native-intent` is not in the table.

Running 1 test using 1 worker
  ✓  1 e2e/signup.spec.ts:28:5 › sign up with an email code, create a workspace, finish the profile
     step, and reach the gated mailbox step (878ms)
  1 passed (3.4s)

# The Phase 7 E2E alone (npx vitest run test/e2e-phase7.test.ts):
Test Files  1 passed (1)   Tests  11 passed (11)   Duration  180.13s
```

The dev database after the wave: `DATABASE_URL=… pnpm --filter @aesa/db migrate` → "migrations
applied"; before, 7 workspaces / 1 billing row; after, 7 / 7, then 8 / 8 at the re-review with 0
trial clocks — correct, since none of the eight ever enabled its agent.
