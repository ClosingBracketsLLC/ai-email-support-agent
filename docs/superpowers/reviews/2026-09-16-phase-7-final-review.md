# Phase 7 — whole-branch final review record

Branch `phase-7`, base `c999904` (`main`, the PR #7 merge commit) → reviewed at `77f5a5e` (33
commits, 202 files, ~26.0k insertions: the plan `7cfc87b`, Tasks 1–12 with their fix rounds — three
pre-review correctness fixes and nine review-driven fix rounds across Tasks 3, 4, 5, 6, 7, 8, 10, 11
and 12) plus this close-out's docs commit. **Five reviewers on the most capable model, one area
each** — A: `@aesa/db` + `@aesa/core` + `@aesa/contracts` (+ `@aesa/queue`'s observer and
`@aesa/knowledge`'s Phase 7 touches); B: `apps/api`; C: `apps/worker`; D: `apps/app`; E: the
cross-cutting seams — billing state read at every gate (`readBillingState` as the ONE reader, in the
draft job's pre-claim, `send.execute`'s claim, `loadSettingSources`, `billing.get`, the report cron),
the meter split (`ai_handled_conversations_managed` vs the total; `llm_cost_micros` vs `_byok`), the
purge order (`PURGE_ORDER` → `workspaces` → `purgeAuthRows`), every Stripe call outside every
transaction with a guarded write behind it, the spec's Verify list as a whole, every controller
ruling, and the docs/env drift the close-out had to close — each pointed at the execution ledger's
deferred minors (rolled up below) for triage.

Gate at the reviewed commit `77f5a5e` (Task 12's report): full gate exit 0, worker 739 / api 391 /
app 530 / total 2,998 + 4 conditional skips, 27 web routes, the Playwright smoke green. The
close-out's own gate run at `77f5a5e` + docs is in STATUS.md's Phase 7 record and in
`.superpowers/sdd/2026-09-12-phase-7-billing-caps-launch-hardening/task-13-report.md`.

<!-- FINDINGS: filled after the whole-branch review -->

## Verdict

_(filled after the whole-branch review: the Critical / Important / Minor counts per area, whether a
fix wave ran and which commits it landed in, and the scoped re-review's verdict)_

## What the branch-level review found

### Critical

_(filled after the review)_

### Important, by area

**A — `@aesa/db` / `@aesa/core` / `@aesa/contracts`**

_(filled after the review)_

**B — `apps/api`**

_(filled after the review)_

**C — `apps/worker`**

_(filled after the review)_

**D — `apps/app`**

_(filled after the review)_

**E — the cross-cutting seams**

_(filled after the review)_

### Ledger minors ruled into the wave

_(filled after the review)_

## The fix wave

_(filled after the review: one table — commit, scope, findings closed — and the gate at the wave's
head)_

## The re-review and the residuals

_(filled after the review)_

<!-- END FINDINGS -->

## The spec's Phase 7 Verify list, item by item (for reviewer E)

The proving test column is a fact of the branch; the verdict column is E's.

| Spec Verify item | Proving test | Verdict |
|---|---|---|
| An overage record appears at conversation 301 (with 2 domains × 300, the 601st) | `apps/worker/test/e2e-phase7.test.ts` scenario 3 — four real sends through `completeSend` on the MANAGED meter, the nightly pass reports nothing at 600, exactly ONE unit at 601 with identifier `<org>:<periodStartIso>:1`, the watermark moves, a re-run reports nothing; `apps/worker/test/billing-report-usage.test.ts` (19 cases); `packages/core/test/billing.test.ts` (the worked example 600 / 601→1 / 650→49 / 650→0) | _E_ |
| A downgrade lowers caps the same day | `e2e-phase7.test.ts` scenario 6 — `customer.subscription.deleted` → `canceled`, `plan = 'trial'`, `knowledge.max_sources` back to 10 the same instant; scenario 2 for the upward direction (100 where the trial refused an 11th paste); `packages/db/test/settings.test.ts` (`loadSettingSources` org > plan > default) | _E_ |
| An unpaid subscription suspends auto-send (drafts continue; a human approval still sends) | `e2e-phase7.test.ts` scenario 5 — `invoice.payment_failed` → `past_due`, ONE "Payment failed" page, the queued auto send HOLDS on `subscription_inactive`, an owner-approved review draft still goes out; scenario 1 for the trial clock (`trial_expired` → `review/subscription_inactive`); `apps/worker/test/send-execute.test.ts` (the eighth lever); `packages/core/test/autonomy.test.ts` (the order untouched) | _E_ |
| Kill a worker mid-send → exactly one email; kill Postgres for two minutes with mail arriving → cursors intact, no duplicate ticket | The mock-tier cases in `apps/worker/test/e2e-phase3.test.ts`; the real-provider walk is the Phase 7 runbook §5 (a runbook step, not a test — recorded as such) | _E_ |
| Design partners two weeks with zero cross-org rows and zero double sends | The Phase 7 runbook §6 (the daily checks and the cross-org query); `packages/db/test/rls.test.ts` and `purge.test.ts` are the structural guarantees | _E_ |
| Gmail behind CASA, Microsoft first | The Phase 7 runbook §6 (the launch order) and `docs/security/2026-09-casa-evidence.md` (the evidence package) | _E_ |

Phase 7 scope items checked beyond the Verify list, each with a named proving test: the retention
sweep (`retention-sweep.test.ts` — two orgs at 180 vs 30 days; E2E scenario 7); delete with grace
(`workspace-lifecycle.test.ts`, `workspace-purge.test.ts`, `purge.test.ts` — the reverse order
raises `23503`; E2E scenario 8 with the foreign-key skip); export (`workspace-export.test.ts` — the
secret grep over the produced bytes); `keys.rotate` (`keys-rotate.test.ts` — a real mailbox token and
a real BYOK key decrypt after the re-wrap; E2E scenario 9); "Remember this reply"
(`memory-capture.test.ts`, `memory-router.test.ts`; E2E scenario 10); the two knowledge sweeps
(`knowledge-stuck-sweep.test.ts`, `knowledge-reembed-sweep.test.ts`; E2E scenario 11); the
admission pool (`drafting-admission.test.ts`, the call-site tests in `ticket-draft.test.ts`); Sentry
with org attribution and the PII boundary (`apps/{api,worker}/test/observability.test.ts` — a fake
transport reads back the event `beforeSend` produced); the share sheet (`share.test.tsx`,
`share-routing.test.ts`, the emitted web bundle grepped for `expo-share-intent`); the Billing screen,
banner and danger zone (`billing.test.tsx`, `billing-banner.test.tsx`, `danger-zone.test.tsx`).

## Rulings during execution, for reviewer E (against the spec)

The twenty-five controller rulings, in order — STATUS.md's Phase 7 record carries the same list with
one line each and the plan's appendix carries the rationale. E reads every one against the spec and
records "ratify", "ratify with a condition" or "reverse" per ruling; the load-bearing ones for the
seams are **R6** (the flat trial allowance), **R7** (the connection cap counts live sync slots),
**R8/R10** (the webhook's double-subscription and `payment_status` handling), **R11** (the
allowance page follows `isAllowanceExhausted`), **R12** (`decide()` not reordered — with the spec
question for Robert), **R14/R16** (the export-key mismatch and the api contract that makes it
correct), **R15** (retention per-org transactions), **R20** (a remembered reply's skip is audited),
**R21/R24** (the export URL is the owner's, at the api AND in the UI), **R22/R23** (the two billing
signals named apart) and **R25** (one redaction implementation).

| # | Ruling | E's verdict |
|---|---|---|
| R1 | Task 6 imports `auditPerOrgArm` from `sweeps-daily.ts` instead of copying it | _E_ |
| R2 | `PlanId` lives once in `@aesa/contracts`; `core/plans.ts` re-exports it | _E_ |
| R3 | `includedConversationsPerDomain` keeps its name on both tiers; `allowanceOf` documents the flat trial reading | _E_ |
| R4 | The baseline is accepted modulo the known `e2e-phase3` case-10 flake; a gate failing ONLY there is re-run solo before it counts as red | _E_ |
| R5 | `knowledge_sources.failure_reason` has no CHECK; `abandoned`/`stuck` need no DDL | _E_ |
| R6 | **AMENDS deviation 5's mechanism**: the trial allowance is a FLAT CONSTANT (`BILLING_PRICING.trialIncludedConversations`), never a stored column; `defaultRow` sets the per-domain field to 300 so a missing row and a real row are identical | _E_ |
| R7 | The mailbox connection cap counts LIVE SYNC SLOTS (`connected`, `pending_claim`), not `reauth_required` — an owner can always repair their only mailbox | _E_ |
| R8 | A double completed Checkout ACCEPTS the newer subscription and ALERTS with both ids (`stripe_double_subscription`) | _E_ |
| R9 | One Minor folded into Task 4's fix round: a Checkout must not seed `active` for an `incomplete` subscription | _E_ |
| R10 | Fulfil on the session's own `payment_status`; `invoice.paid` for the row's own subscription establishes `plan = 'standard'` again | _E_ |
| R11 | The `allowance_reached` page follows `isAllowanceExhausted` (a trial pages under `automatic` too; a standard+automatic workspace never does) | _E_ |
| R12 | `decide()` is NOT reordered: `subscription_inactive` before the guardrail branch is the spec's order; a spec question for Robert is recorded | _E_ |
| R13 | `audit_log_created_idx` in migration 0024 (the plan's omission over the largest of the three tables) | _E_ |
| R14 | A mismatched `export_key` lands `failed` + alert, not a silent `skipped`; `exportObjectKey` lives in `@aesa/contracts` | _E_ |
| R15 | `retention.sweep` takes ONE SHORT `withPlatform` transaction PER ORG and visits every workspace (no `LIMIT`); Minor 5 (the counts-map overload) folded in | _E_ |
| R16 | The R14 shape stands; its contract — `requestExport` refuses while `queued` — is enforced by Task 8 (`export_in_progress`) | _E_ |
| R17 | The re-embed sweep's stranded document is an `error` + `knowledge_reembed_stranded` alert; no recovery arm (a design question, carried) | _E_ |
| R18 | `not_pending`'s message moves into `WORKSPACE_ERROR_MESSAGES` | _E_ |
| R19 | The deletion notification is DAY-scoped, not lifetime | _E_ |
| R20 | A remembered reply's skip is audited by the job with a reason (`no_question`, `not_outbound`, `empty_after_scrub`, `already_remembered`); the api contract stays | _E_ |
| R21 | `exportStatus` stays `orgProcedure` for STATE; the download URL is minted for the OWNER only | _E_ |
| R22 | The deletion copy stops promising a reversal: the Stripe cancel is immediate, and `cancelDeletion` says the plan is dead | _E_ |
| R23 | Two billing signals with two names: `requestDeletion.subscriptionCancelled` ("this call cancelled it") and `cancelDeletion.needsResubscribe` (`!isBillingActive && stripeSubscriptionId !== null`) | _E_ |
| R24 | **OVERRULES Task 9's Important**: the danger zone stays OWNER-only in the UI; R21 is an api-layer ruling and stays load-bearing as built | _E_ |
| R25 | ONE home for the redaction helpers (`packages/core/src/redact.ts`); both `observability.ts` files import them | _E_ |

## The execution ledger's deferred minors, rolled up for triage

Thirty-five `minor (deferred)` lines from the SDD ledger, grouped by area. Each reviewer triages
their area's list — **fix in the wave**, **carry in STATUS**, or **not a defect** — and the
disposition is recorded in the FINDINGS section above.

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

_(filled after the review — the tenancy/secrets walk, the single-sourced seams, the untouched
invariants, the E2E's standing, Robert's manual checks)_

## The final gate

_(filled after the review: the raw output at the post-wave head, in the Phase 6 record's shape)_
