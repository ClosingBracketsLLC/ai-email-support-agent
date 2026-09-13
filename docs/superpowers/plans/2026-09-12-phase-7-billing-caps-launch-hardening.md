# Phase 7 — Billing, Caps, Launch Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace can pay for the product and be held to what it paid for — a card-less 14-day trial that starts when the agent is first switched on, a $49.99-per-domain Stripe subscription bought through Checkout and managed through the Portal, 300 Managed-AI conversations per domain per month with the 301st billed at $0.12 through a Stripe Billing Meter (or held for review when the owner prefers "blocked"), every per-org cap finally resolved from the workspace's plan, an expired trial or a failed payment that parks decisions on Review with a banner while drafts keep coming — plus the launch hardening the spec lists: the retention sweep, workspace export and delete with a 30-day grace, the `keys.rotate` job and its runbook, Sentry with org attribution, the CASA evidence package, store submission, `scripts/smoke-tenant.ts`, the native share sheet, and "Remember this reply".

**Architecture:** `packages/db` gains `billing_subscriptions` (one row per workspace from creation; the `plan` column lives there), `readBillingState` (the ONE reader of a workspace's plan and status), `loadSettingSources` (the ONE loader that hands `resolveSetting` both an `org` and a `plan` source, replacing the two `loadOrgSettings` twins), `purgeWorkspace` (the ordered walk of every tenant table, pinned by a test against the migration list) and `rewrapOrgDek`. `packages/core` gains the pure billing maths (`billingStateOf`, `allowanceOf`, `overageOf`, `isAllowanceExhausted`) beside `PLANS`, which finally gets callers. The api grows an `ownerProcedure` rung, a `billing` service + router over a small `StripePort` (Checkout, Portal, cancel, signature verification — the SDK never leaks past `src/billing/stripe.ts`), a raw-body Stripe webhook in its own encapsulated `register()`, and the workspace lifecycle mutations (kill switch, retention, export, delete). The worker wires `readBillingState` into `ticket.draft`'s `decide()` inputs and `send.execute`'s levers, meters Managed-AI conversations separately so BYOK never counts, adds the `billing.report-usage`, `retention.sweep`, `workspace.purge-sweep`, `knowledge.stuck-sweep` and `knowledge.reembed-sweep` crons and the `workspace.export`, `workspace.purge` and `keys.rotate` jobs, and takes a managed-draft admission slot before every managed model call. The app gets Settings → Billing (route 26), the billing banner, the Workspace danger zone, "Remember this reply" on the thread, and the share route (route 27) fed by `expo-share-intent`.

**Tech Stack:** unchanged repo toolchain (Node 22, TypeScript 5.9, pnpm 10, Postgres 17 + pgvector, drizzle 0.44, Fastify 5, pg-boss 10, zod 4, vitest 3, Expo SDK 57 + jest-expo + Playwright). **THREE new runtime dependencies, each pinned exactly:** `stripe@22.6.2` (`apps/api` AND `apps/worker` — API version `2026-08-26.dahlia`, where usage records no longer exist and overage is a Billing Meter event, and `current_period_start/end` live on the subscription ITEM), `@sentry/node@10.74.0` (`apps/api` and `apps/worker`), `expo-share-intent@8.0.1` (`apps/app`; peer `expo ^57`, needs a config plugin and a dev/EAS build — it cannot run in Expo Go). Two new root devDependencies for the smoke script: `@trpc/client` and `superjson` (versions matching `apps/app`'s).

**Spec:** `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md` — *Build phases → Phase 7* (scope and the Verify list), *Decisions locked → Usage / pricing* and *→ Billing unit & price*, *Pricing economics*, *Data model → Billing, audit, notifications*, *Queue and job model* (`keys.rotate`, `billing.report-usage`), *Cross-cutting rules → PII posture* (retention 180 days, org-delete cascade), *Product → After onboarding* (Settings → Billing), *UX → Knowledge base* (share-sheet intake in Phase 7) and *→ Improve* ("Remember this reply" arrives in Phase 7), *Agent runtime → Budgets* (trial $3 / standard $60 daily caps, the admission slot pool), *Decision* (`subscription inactive → review`, `allowance exhausted → review`), *Launch risks*, *Verification*. STATUS.md's *Next: Phase 7* hand-off lists the seams already waiting.

## Global Constraints

- Node `>=22`; strict NodeNext ESM with explicit `.ts` imports, `tsx` at runtime, runtime deps in `dependencies`, zod 4, vitest 3; `apps/app` extends `expo/tsconfig.base` (extensionless imports, jest-expo). The CI gate stays `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check`; run it before every commit with the six `S3_*` exported (`S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 S3_BUCKET=aesa-dev S3_ACCESS_KEY_ID=aesa S3_SECRET_ACCESS_KEY=aesaaesa S3_FORCE_PATH_STYLE=true`); the database and minio must be running (`pnpm db:up && pnpm s3:init`). **Commit migrations before running `pnpm db:check`** (it `git clean`s the migrations directory).
- **Tenancy.** Every new tenant table carries `org_id uuid NOT NULL` first in its indexes, declares `...tenantPolicies(t.orgId, '<table>')`, and gets `ALTER TABLE "<t>" FORCE ROW LEVEL SECURITY;` in the hand-written hardening migration; `packages/db/test/rls.test.ts` demands exactly the two policies and `packages/db/test/migrations.test.ts`'s `EXPECTED_TABLES` is an exact sorted list (41 today; 42 after `billing_subscriptions`). The ONE new table, `billing_subscriptions`, is tenant data (the api reads and writes it through `withOrg`; the webhook resolves the org first through a SECURITY DEFINER function, then writes through `withOrg` like every other tenant write). No new platform table.
- **Data access.** Tenant reads/writes through `withOrg(db, orgId, fn)` (branded `OrgTx`) or `withPlatform(db, reason, fn)`; raw handles only from `@aesa/db/raw`. **A `withOrg` transaction never spans network I/O**: every Stripe call (customer, Checkout session, Portal session, cancel, meter event, quantity update) happens BEFORE or AFTER a transaction, never inside one, and the write that records its result is guarded on the state that was read (`stripe_customer_id IS NULL`, `overage_reported = <read value>`, `domain_quantity = <read value>`).
- **Jobs.** `defineJob(name, z.object-with-orgId, …)`, `enqueue` sets `singletonKey = ${orgId}:${entityId}`, handlers get an `AbortSignal`. **A new queue is added in FOUR places:** `JOB_NAMES` (+ its `QUEUE_OPTIONS` row), the worker's `apps/worker/src/index.ts` pre-create list, the api's `apps/api/src/boss.ts` pre-create list, and `apps/worker/test/queue-preflight.test.ts`'s `it.each`. Phase 7's THREE new queues — `workspace.export` (`short`), `workspace.purge` (`short`) and `keys.rotate` (`standard`) — go in all four. The FIVE new crons — `billing.report-usage`, `retention.sweep`, `workspace.purge-sweep`, `knowledge.stuck-sweep`, `knowledge.reembed-sweep` — are `registerCron` and belong in none of them.
- **Escalation, guarded writes, lock order.** Unchanged. Every status write is guarded on the status it was read at and zero rows is a soft outcome; lock order `outbound_sends → drafts → tickets → resolved_answers / workspaces` holds. `billing_subscriptions` is never touched in a transaction that holds a draft or a ticket; `readBillingState` is a READ that the draft job takes in its pre-claim transaction beside `org_settings`, and that `send.execute` takes in its claim transaction beside `workspaces` (the fourth position's neighbour, read-only).
- **Decision order is the spec's.** `decide()` does not change. Phase 7 changes exactly TWO of its inputs from literals to facts: `subscriptionActive` (= `readBillingState(...).active`) and `allowanceExhausted` (= `isAllowanceExhausted(...)`). `DECISION_REASONS` already carries `subscription_inactive` and `allowance_exhausted`; no contract change.
- **Metering (the cap rule).** `LLM_METERS.costMicros` is the platform's money and the ONLY input to the daily USD cap and the trial budget; `costMicrosByok` never trips either. Phase 7 adds ONE send meter, `SEND_METERS.aiHandledManaged` (`ai_handled_conversations_managed`), bumped beside `aiHandledConversations` only when the sending agent's resolved draft mode is `managed`; the allowance and the overage read the managed meter alone — **a BYOK conversation never counts toward the allowance and is never billed as overage** (spec: "BYOK customers pay the subscription only").
- **Billing state has ONE reader.** `readBillingState(tx, now)` (`@aesa/db`) is the only code that turns a `billing_subscriptions` row into `{ plan, state, active, allowance, period }`; the api's `billing.get`, the worker's draft/send/report jobs, `loadSettingSources` and the E2E all go through it. `billingStateOf`/`allowanceOf`/`overageOf`/`isAllowanceExhausted` (`@aesa/core`) are the pure maths it and the report job call, table-tested with worked examples.
- **Plans have ONE source.** `PLANS` (`@aesa/core`) references `BILLING_PRICING` (`@aesa/contracts`, the numbers the app renders); `planSettingDefaults(plan)` is the ONLY way a plan becomes a `resolveSetting` source, and `loadSettingSources` is the only caller. **After Task 5 no production code passes `{ org: … }` alone to `resolveSetting`** — a grep for `resolveSetting(` with `{ org:` outside tests is a review failure.
- **Secrets / PII.** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `SENTRY_DSN` are `Secret`s; a Stripe customer id, subscription id and price ids are NOT secrets and may be stored, audited and returned. Message bodies purged by retention are set to NULL and stamped, never logged; an export bundle goes to the object store under `orgs/<orgId>/exports/` and is served by a presigned GET minted on demand — **never a URL in a push payload or a notification body**. Sentry receives no bodies: `beforeSend` strips `req.body` and every `detail`/`payload` key; org attribution is a tag.
- **App.** `apps/app` never value-imports a server package or `node:*`; every billing/lifecycle enum and copy string lives in `@aesa/contracts`; no `fontWeight`, no literal colour outside `theme.ts`. **TWO new route files** — `src/app/(app)/settings/billing.tsx` (route 26) and `src/app/share.tsx` (route 27) — and every doc that pins 25 is updated to 27. App tests: `await render()`, self-contained `jest.mock` factories, no fake timers.
- **Audit.** Every tRPC mutation writes `audit(tx, entry)` with actor `user:<id>`; the jobs and the webhook write `system:<job>` rows for every transition an owner can see (a checkout completing, a status change, an overage report, a body purge count per org, an export landing, a purge, a re-wrap).
- **Roles.** `ownerProcedure` (new, `role === 'owner'`) gates buying, cancelling, deleting and exporting a workspace and flipping its kill switch or retention; `managerProcedure` (owner or admin) gates everything else Phase 7 adds; `orgProcedure` reads.
- Commits end with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; work on branch `phase-7` (off `main` at `c999904`, the PR #7 merge commit); never push, merge or open a PR without Robert.

## Deviations from the spec's Phase 7 list (flagged; the spec wins on everything else)

1. **The `plan` column lives on `billing_subscriptions`, and every workspace has exactly one row from creation.** The spec lists `plan trial|standard` under `billing_subscriptions`; STATUS's hand-off speaks of "the `plan` column". They are the same column: `workspace.create` inserts the `billing_subscriptions` row (`plan = 'trial'`, `status = 'trialing'`, no Stripe ids) in the same transaction as the `workspaces` row, the migration backfills one for every existing workspace, and `readBillingState` treats a missing row as the trial defaults so a workspace can never be bricked by its absence. No `plan` column on `workspaces`.
2. **The trial is card-less and local — Stripe's trial machinery is unused.** `trial_ends_at = agent_enabled_at + 14 days`, stamped by `setAgentEnabled` on the FIRST enable (COALESCEd like `agent_enabled_at` itself) and backfilled for workspaces already enabled. Before the agent is first switched on the row is `trialing` with `trial_ends_at NULL` and never expires — nothing is being spent. A Checkout completing writes `plan = 'standard'`, `status = 'active'`.
3. **Overage is a Stripe Billing Meter event, and ONLY overage units are reported.** `stripe@22.6.2` (API `2026-08-26.dahlia`) has no usage records; `billing.report-usage` reports `billing.meterEvents.create({ event_name, identifier, payload: { stripe_customer_id, value } })` where `value` is the DELTA of `max(0, used − allowance)` since the last report for the current period, the allowance (300 × active domains) is computed locally, and `identifier = ${orgId}:${periodStartIso}:${overageTotal}` makes a retried report idempotent on Stripe's side while the guarded `overage_reported` write makes it idempotent on ours. The spec's "overage record appears at conversation 301" is exactly that first delta of 1.
4. **Two prices, one subscription.** `STRIPE_PRICE_DOMAIN` (licensed, recurring monthly, quantity = active domains) and `STRIPE_PRICE_OVERAGE` (metered, on the meter named by `STRIPE_METER_EVENT_NAME`, default `ai_conversation_overage`). Checkout is `mode: 'subscription'` with both line items. `domain_quantity` is synced to Stripe **daily** by `billing.report-usage` (and set at Checkout), with `proration_behavior: 'create_prorations'` — not on every agent add/remove.
5. **Trial numbers.** `PLANS.trial.includedConversationsPerDomain` goes 0 → **50** (flat, not per domain — a trial that can never auto-send could never demonstrate Autopilot), and the trial gains `llmUsdBudget: 10`, a TOTAL Managed-AI budget over the trial beside the $3 daily cap (spec §Budgets "trial budget"). Both live in `BILLING_PRICING`/`PLANS` for Robert to change.
6. **What "inactive" holds.** `subscriptionActive = state ∈ {trialing, active}`; `trial_expired`, `past_due` and `canceled` are inactive. Inactive makes `decide()` return `review/subscription_inactive` (drafts continue) and makes `send.execute` hold an AUTO send with the new eighth lever `subscription_inactive` — **a human approval still sends** ("nothing sends automatically" is the spec's wording, and an owner who approved a reply while past due must not be silently ignored).
7. **`allowanceExhausted`** is `mode === 'managed' && used ≥ allowance && (plan === 'trial' || overageMode === 'blocked')` — under `automatic` overage nothing is ever exhausted, and a BYOK agent never is. It blocks only the auto branch, exactly where `decide()` puts it (after evidence and attachments).
8. **Downgrade = cancellation through the Portal.** `customer.subscription.deleted` (or `updated` with `status = canceled`) writes `status = 'canceled'`, `plan = 'trial'`; caps fall to the trial tier at the next `loadSettingSources` (the spec's "same day"), and — because `trial_ends_at` is in the past — the workspace behaves like an expired trial: Review with a "subscribe to resume Autopilot" banner. `past_due`/`unpaid` map to `past_due`; `incomplete`/`incomplete_expired` leave the row as it was; `paused` maps to `past_due`.
9. **Workspace delete is soft, then a sweep.** `workspace.requestDeletion({ confirm: <business name> })` (owner) cancels the Stripe subscription immediately (network, before the transaction; a failure refuses the deletion), then in ONE transaction stamps `deletion_requested_at`/`deletion_requested_by`, sets `kill_switch = true` and `agent_enabled = false`, audits and pages. `workspace.purge-sweep` (daily) enqueues `workspace.purge` for every workspace past `deletion_requested_at + 30 days`; the job deletes the org's objects from the store, then in one platform transaction runs `purgeWorkspace` (every tenant table in FK order, pinned by a test against `EXPECTED_TABLES`) and finally — **the ONE documented exception to "Better Auth tables only through Better Auth"** — NULLs `session.active_organization_id` for that org and deletes the `organization` row (cascading `member`/`invitation`) by raw SQL, because the plugin's deletion is disabled and the worker holds no Better Auth instance. `cancelDeletion` clears the stamps; the agent stays off until the owner turns it on.
10. **Export is an NDJSON bundle in the object store.** `workspace.export` (`knowledge` role, it owns the store) writes `orgs/<orgId>/exports/<exportId>.ndjson` — one line per row across the profile, settings, agents, categories and policies, tickets, messages, decided drafts, learned answers, knowledge sources (metadata + pasted text) and the org's audit rows — bounded at 200 MB, then stamps `workspaces.export_key`/`export_ready_at` and pages `export_ready`. `workspace.exportStatus` presigns a 7-day GET on demand. Uploaded knowledge files are NOT bundled (the owner has them); the bundle lists their names.
11. **`keys.rotate` re-wraps the DEK only.** Every row secret is encrypted under the org DEK, which never changes; a KEK rotation therefore touches `org_data_keys.wrapped_dek`/`kek_version` alone, guarded on the exact bytes read (the `llm.probe` guard), through the existing `rewrapDek`. The job is per org (`{ orgId }`, `sync` role — the ring's home), enqueued by `pnpm --filter @aesa/worker keys:rotate` for every org whose `kek_version ≠ ring.active`; the runbook is the four-step ring rollout.
12. **Retention.** `retention.sweep` (daily, 03:45 UTC): per org, `messages.body_text` → NULL + `body_purged_at` for rows older than the workspace's `retention_days` (default 180; subject and headers stay so the ticket list still reads), the same for finished drafts (`body`, `final_body`, `rationale` → purged, new `drafts.body_purged_at`); platform-wide, `llm_calls` older than 400 days, `notifications` older than 90 days, `audit_log` older than 730 days. `sweeps.daily` gains two arms in Task 1: `agent_runs` older than 90 days (the triage-row growth Phase 6 created) and `platform.access` audit rows older than 30 days. `resolved_answers` keep their own 365-day expiry.
13. **Admission slots are prevention with a reactive floor.** `MANAGED_DRAFT_SLOTS` (worker env, default 4, `0` disables): `ticket.draft` and `agent.sandbox` take a session-level `pg_try_advisory_lock(hashtext('managed-slot'), i)` on a dedicated pool client before a MANAGED model call and release it after; when no slot frees within 60 s the run proceeds with an `admission_slot_timeout` alert rather than failing — a draft is never lost to admission control. BYOK calls bypass the pool (their limiter is per credential).
14. **Observability.** `SENTRY_DSN` (optional in every environment; unset = no-op) initialises `@sentry/node` in both apps; org attribution is `setTag('org_id')` inside `withIsolationScope` — the api's tRPC `onError` and Fastify handler, the worker's job wrapper through a module-level `setJobObserver` in `@aesa/queue` (no Sentry dependency there). "Alerts" are the named `alert(kind, ctx)` calls (`captureMessage` at `error` + a pino `alert: true` line) for the events an operator must see: `platform_killswitch_on`, `admission_slot_timeout`, `stripe_webhook_rejected`, `stripe_unknown_customer`, `stripe_report_failed`, `org_spend_capped`, `keys_rotate_failed`, `purge_failed`, `export_failed`. The log drain is deployment configuration (runbook), not code.
15. **Share-sheet intake is ONE route.** `expo-share-intent` with `ShareIntentProvider` at the root layout and a `useShareIntentRouting()` hook beside `usePushRouting()`; `/share` (route 27) shows what arrived — a URL becomes a crawl, text becomes a paste (with a title field), a file becomes an upload through the existing `useUpload` — then resets the intent and lands on Knowledge. On web the route says sharing works from the iOS and Android apps. The route is a static export like every other, so the count is 27.
16. **"Remember this reply" is the backfill.** `memory.rememberReply({ messageId })` (manager) on any OUTBOUND message in a ticket enqueues `memory.capture` with the new `messageId` payload variant; the job pairs the reply with the latest inbound before it, scrubs both, embeds, and inserts an `active` answer with `approvals = 1` and the new `source_message_id` (partial unique — idempotent). `memory.capture` stays the ONLY writer of a new `resolved_answers` row. There is no connect-time backfill (spec); every owner reply already ingested is one tap away.
17. **`member_prefs` is not built.** Phase 5 parked it as "if wanted"; `org_settings` covers `notifications.push_auto_sends`. Carried as a product decision, not a gap.
18. **Stripe lives in BOTH apps.** The api holds the secret for Checkout, Portal, cancel and webhook verification; the worker holds it for meter events and quantity sync (`billing.report-usage`, `cron` role). Both are all-or-none groups, required in production (the api always; the worker when `WORKER_ROLES` includes `cron`), inert with a warn otherwise.
19. **`mailboxes.max_connections` gets its first caller** (`startConnect` refuses beyond the plan's count of non-disabled connections) — closing the gap the api map found — and `MAX_AGENTS_PER_DOMAIN` stays a constant (both tiers say 3).
20. **Carries folded in.** Task 1: the `src/drafts/learning.ts` split (named for the fourth time — a pure move), `escalateProviderUnavailable`/`killCredential` into `drafting/outcomes.ts`, the `agent_runs` and `platform.access` retention arms. Task 5: the `pg_try_advisory_lock` slot pool. Task 7: the stuck-source sweep and the `KNOWLEDGE_EMBED_MODEL` re-embed sweep. Task 8: the `workspaces.kill_switch` Settings toggle (its reads are unchanged). **Carried again** (record at close): the stubbed-provider Playwright walk, the three-pane review layout, J/K, multi-select, `context_too_long` retrieval halving, the in-memory rate limiters, and the rest of Phase 5/6's minor lists. **Load testing** stays deferred until the first paying customers (spec).

## File structure

```
apps/api/src/drafts/learning.ts          NEW (the reject/flag learning writes moved out of service.ts — a pure move)               Task 1
apps/worker/src/drafting/outcomes.ts     MODIFY (escalateProviderUnavailable, killCredential move in from ticket-draft.ts)          Task 1
apps/worker/src/jobs/sweeps-daily.ts     MODIFY (arms (g) agent_runs 90 d, (h) platform.access audit 30 d)                          Task 1
packages/db/migrations/0021_retention_indexes.sql  NEW (agent_runs (started_at))                                                    Task 1
packages/contracts/src/billing.ts        NEW (PLAN_IDS, BILLING_STATUSES, BILLING_STATES, OVERAGE_MODES, BILLING_PRICING, BillingView, inputs, BILLING_ERROR_MESSAGES)  Task 2
packages/contracts/src/workspace.ts      MODIFY (SetKillSwitchInput, SetRetentionDaysInput, RequestDeletionInput, WorkspaceLifecycleView)  Task 2
packages/contracts/src/memory.ts         MODIFY (RememberReplyInput) · notify.ts (+ 'billing', 'workspace') · knowledge.ts (+ 'abandoned', 'stuck')  Task 2
packages/core/src/plans.ts               MODIFY (PLANS from BILLING_PRICING; trial llmUsdBudget) · billing.ts NEW (the pure maths) · invariants.ts (+2 rules)  Task 2
packages/db/src/schema/billing.ts        NEW (billing_subscriptions) · schema/tenancy.ts (workspaces + deletion/export columns) · schema/drafts.ts (body_purged_at) · schema/memory.ts (source_message_id) · schema/knowledge.ts (sweep_attempts)  Task 3
packages/db/src/billing.ts               NEW (readBillingState, ensureBillingRow, countManagedConversations, countActiveDomains)    Task 3
packages/db/src/settings.ts              NEW (loadSettingSources, SettingSources) · metering.ts (+aiHandledManaged, sumMeter) · keys.ts (+rewrapOrgDek) · purge.ts NEW (PURGE_ORDER, purgeWorkspace, purgeAuthRows)  Task 3
packages/db/migrations/0022_<generated>.sql, 0023_billing_hardening.sql + meta/_journal.json                                        Task 3
apps/api/src/trpc/init.ts                MODIFY (ownerProcedure) · deps.ts (resolveStripeCustomer; stripe?: StripePort) · config.ts (STRIPE_*, SENTRY_*)  Task 4
apps/api/src/billing/{stripe,service,webhook}.ts  NEW (@aesa/api/billing) · trpc/routers/billing.ts NEW · trpc/router.ts · server.ts (webhook register, /meta)  Task 4
apps/api/src/trpc/routers/workspace.ts   MODIFY (create inserts the billing row; setAgentEnabled stamps trial_ends_at) · routers/mailboxes.ts (max_connections) · org-settings.ts DELETED  Task 4
apps/worker/src/billing/{stripe,report-usage}.ts  NEW (StripeUsagePort; the billing.report-usage cron) · config.ts (STRIPE_*, SENTRY_*, MANAGED_DRAFT_SLOTS)  Task 5
apps/worker/src/drafting/{caps,admission}.ts  MODIFY/NEW (plan sources, the trial budget, the slot pool) · knowledge/sources.ts (loadOrgSettings DELETED)  Task 5
apps/worker/src/jobs/{ticket-draft,agent-sandbox,send-execute,ticket-triage,guidance-suggest,notify-digest,knowledge-crawl,knowledge-embed-batch,memory-capture}.ts, digest-email.ts  MODIFY (loadSettingSources; billing inputs; the lever; the managed meter)  Task 5
apps/worker/src/jobs/retention-sweep.ts  NEW · jobs/workspace-export.ts NEW · jobs/workspace-purge.ts NEW (job + purge-sweep cron) · jobs/keys-rotate.ts NEW · scripts/keys-rotate.ts NEW  Task 6
apps/worker/src/jobs/knowledge-stuck-sweep.ts  NEW · jobs/knowledge-reembed-sweep.ts NEW · jobs/memory-capture.ts (messageId variant)  Task 7
apps/api/src/trpc/routers/workspace.ts   MODIFY (setKillSwitch, setRetentionDays, requestDeletion, cancelDeletion, requestExport, exportStatus; WorkspaceView widened) · memory/service.ts + routers/memory.ts (rememberReply)  Task 8
apps/app/src/app/(app)/settings/billing.tsx  NEW (route 26) · screens/settings/billing.tsx NEW · screens/inbox/billing-banner.tsx NEW · screens/settings/{index,workspace}.tsx · screens/inbox/ticket.tsx (+ message-bubble.tsx) · lib/push-routing.ts  Task 9
apps/app/src/app/share.tsx               NEW (route 27) · screens/share.tsx NEW · lib/share-routing.ts NEW · app/_layout.tsx (ShareIntentProvider) · app/(app)/_layout.tsx · app.json (plugin) · app-config.test.ts  Task 10
apps/api/src/observability.ts NEW · apps/worker/src/observability.ts NEW · packages/queue/src/observe.ts NEW (setJobObserver) · define-job.ts · scripts/smoke-tenant.ts NEW · package.json (root devDeps)  Task 11
apps/worker/test/e2e-phase7.test.ts      NEW · test/helpers/fake-stripe.ts NEW                                                      Task 12
docs/runbooks/2026-09-phase-7-external-setup.md NEW · docs/security/2026-09-casa-evidence.md NEW · docs/STATUS.md · CLAUDE.md · apps/{api,worker}/.env.example · apps/app/eas.json · docs/superpowers/reviews/  Task 13
```

## Repo facts the tasks rely on (surveyed 2026-09-12; do not re-derive)

- `resolveSetting(key, { org?, plan? })` (`packages/core/src/settings-catalog.ts:24`) resolves `org > plan > default`; `planSettingDefaults(plan)` (`packages/core/src/plans.ts`) maps 8 of the 15 catalog keys and has NO production caller. The 22 call sites all pass `{ org: … }` alone: `apps/worker/src/{digest-email.ts:87-88, drafting/caps.ts:110,113, jobs/guidance-suggest.ts:117, jobs/knowledge-crawl.ts:136, jobs/knowledge-embed-batch.ts:149, jobs/memory-capture.ts:68, jobs/notify-digest.ts:65, jobs/ticket-draft.ts:320-321,864,914,945, jobs/ticket-triage.ts:321,326}` and `apps/api/src/{knowledge/service.ts:159-160,196,380,462, trpc/routers/agents.ts:299}`. The two `loadOrgSettings` twins are `apps/worker/src/knowledge/sources.ts:109-120` and `apps/api/src/org-settings.ts:13-24`; `guidance-suggest.ts` and `notify-digest.ts` read one `org_settings` row by hand. `mailboxes.max_connections` has no reader.
- `@aesa/db` depends on `@aesa/contracts` and `@aesa/crypto` only; `@aesa/core` depends on `@aesa/contracts` and zod only — **adding `@aesa/core` to `packages/db`'s dependencies creates no cycle** (Task 3 does it for `planSettingDefaults`).
- `usage_counters` is `(org_id, day date, meter text, value bigint)` PK `(org_id, day, meter)`; `bumpMeter(tx, orgId, day, meter, delta)` is the one upsert; every read is hand-rolled (`activity.ts:56-65` sums a day range with `gte(usageCounters.day, cutoffDay)`). `SEND_METERS.aiHandledConversations` is bumped in `send-execute.ts:761-767` inside `completeSend`'s transaction, guarded by the `tickets.ai_handled_month` stamp (once per ticket per UTC month). Three meters are literal strings outside `metering.ts`: `DRAFT_METER = 'draft_runs'` (`caps.ts:28`), `TRIAGE_METER` (`ticket-triage.ts:41`), `PUSH_METER` (`notify-dispatch.ts:19`).
- `decide()` (`packages/core/src/autonomy.ts:44-70`) takes `subscriptionActive` (4th branch) and `allowanceExhausted` (3rd from last); `ticket-draft.ts:842-866` passes `subscriptionActive: true` and `allowanceExhausted: false` as literals, `agent-sandbox.ts:~465-489` the same. `DECISION_REASONS` (`packages/contracts/src/drafts.ts:14`) already lists both reasons.
- `send-execute.ts`: `claimSend` (251-344) is ONE `withOrg` tx reading `outbound_sends → drafts → tickets → agents → mailbox_connections → workspaces → platform_state → policy`; `firstKillLever` (352-367) has seven levers in order, `LEVER_WORDS` (120-130) their owner copy, `landHeld(l, lever)` the landing. `CompleteSendInput` (~640) carries `aiHandledMonth` and `decisionSource`; `completeSend` computes `month` and bumps the meters.
- `drafting/caps.ts`: `gateAndRecordRun(tx, p: GateParams)` under `pg_advisory_xact_lock(hashtext('draft-gate:' || orgId))` with five ordered branches (`ticket_capped`, `org_busy`, `org_draft_capped`, `org_spend_capped`, proceed); `readCapsUnlocked(tx, { orgId, ticketId, settings, now })` is the pre-claim mirror; `usdCapToMicros` is duplicated inline at `ticket-draft.ts:322`. `PreClaim.settings: Partial<Record<SettingKey, unknown>>` (`ticket-draft.ts:193-195`), loaded in `loadPreClaim` (211-242).
- `sweeps-daily.ts` is ONE `withPlatform` pass with six arms and no org loop; `RUN_EVENT_RETENTION_DAYS = 30` (line 46) with the comment "`agent_runs` rows themselves are never pruned"; `auditMemoryArm(tx, arm, action, rows)` (72-83) writes one audit row per org per arm; cron `'30 3 * * *'`. `stats-rollup.ts:348-379` is the per-org SAVEPOINT idiom (`selectDistinct` org ids `ORDER BY org_id LIMIT 500`, `withOrgIdentity(tx2, orgId)`, every query carrying an explicit `eq(orgId)` because `withOrgIdentity` sets no GUC).
- `agent_runs` indexes both lead with `org_id` (`runs.ts:24-25`) — a platform-wide age delete needs `agent_runs (started_at)`. `messages` has no index leading with `created_at` and `body_purged_at` (`support.ts:113`) is written by nothing today; `drafts` has no purge stamp. `llm_calls_org_created_idx (org_id, created_at)` exists.
- `org_data_keys` is `(org_id, version) PK, wrapped_dek, kek_version, box_public_key, box_private_key_ciphertext` with readers taking `max(version)`; `rewrapDek(wrapped, kekVersion, ring, orgId)` (`packages/crypto/src/envelope.ts:62`) exists with no production caller; `keys-provision.ts` is the job template (`KeysProvisionDeps { db; ring: KekRing }`, registered under `sync` only when `config.kekRing` is set). The bytes-guard to copy is `llm-probe.ts:170-181` (`eq(keyCiphertext, opened.ciphertext)`).
- No tenant table has an FK on `org_id`; only `workspaces.org_id → organization.id` (`ON DELETE no action`). The full parent-FK map (which rows cascade, set null, or restrict) is in Task 3's `PURGE_ORDER`; `member`/`invitation` cascade from `organization`. There is no `deleted_at` column anywhere. `packages/db/test/migrations.test.ts:8`'s `EXPECTED_TABLES` is exact (41); `rls.test.ts:7`'s `RLS_EXEMPT` is `['platform_state','webhook_events','model_pricing', ...AUTH_TABLES]`.
- The SECURITY DEFINER template is `0006_mail_hardening.sql:26-89` (`resolve_mailbox_connection`): CREATE → `REVOKE ALL … FROM PUBLIC` → `GRANT EXECUTE … TO "aesa_app"` → `GRANT CREATE ON SCHEMA public TO "aesa_platform"` → `ALTER FUNCTION … OWNER TO "aesa_platform"` → `REVOKE CREATE ON SCHEMA public FROM "aesa_platform"`, and the facade method is a raw `handle.pool.query('SELECT * FROM resolve_…($1)')` (`deps.ts:68-74`). `packages/db/test/mail-schema.test.ts:188` pins the resolver list. `stubDeps` (`apps/api/test/helpers/app.ts:61-69`) and `error-surface.test.ts:44-52` hand-mirror `ApiFacade`.
- The api's procedure ladder is `publicProcedure → authedProcedure → orgProcedure → managerProcedure` (`apps/api/src/trpc/init.ts:57-88`); `canManageWorkspace` (`packages/contracts/src/team.ts:4`) is owner-or-admin; there is no owner-only rung. `workspace.create` inserts the `workspaces` row imperatively (`routers/workspace.ts:83-86`); `setAgentEnabled` (149-166) COALESCEs `agent_enabled_at`. `toWorkspaceView` (line 33) omits `killSwitch` and `retentionDays` on purpose; Task 8 widens it.
- The api's global JSON parser (`server.ts:34-38`) discards raw bytes; `@fastify/formbody` and the review pages sit in their own `register()` (`server.ts:158-171`) — the precedent for a scoped parser. Webhooks register inside the shared nested `register()` (`server.ts:96, 152-153`) so `@fastify/rate-limit`'s `onRoute` wraps them; the CSRF hook matches `/trpc` only. `recordWebhookEvent(provider, externalId, envelope)` (`deps.ts:89-95`) is the dedupe (`webhook_events` is free-text `provider`, RLS-exempt, pruned at 7 days by `mailbox.poll-sweep`). `webhooks/gmail.ts:63` returns 404 when the provider is unarmed.
- `notifications.kind` has a DB CHECK last rewritten in `0020_provider_hardening.sql` (DROP + ADD); `NOTIFICATION_KINDS` (`packages/contracts/src/notify.ts`) has nine kinds; `PUSH_DAILY_CAP = 30`. Notification inserts are `tx.insert(notifications).values({...}).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id })` with day-scoped dedupe keys, dispatched post-commit through `deps.enqueue(JOB_NAMES.notifyDispatch, { orgId, notificationId }, { entityId: notificationId })` (`llm/service.ts:550-555`). `apps/app/src/lib/push-routing.ts:25-44` maps `data.kind` to a path.
- `memory.capture`'s payload is `{ orgId, draftId }` (`memory-capture.ts:20`), idempotent on `drafts.memory_captured_at`; `load()` (49-80) reads the draft, its ticket and the latest inbound body; the insert (~150-156) writes `status: auto ? 'candidate' : 'active'`, `approvals`, `sourceTicketId`, `sourceDraftId`, `sourceCustomerHash`. `apps/api/src/memory/service.ts` exports `summary/list/keepAnswer/retireAnswer/confirmCandidate/rejectCandidate/deleteByCustomer` over `MemoryServiceDeps { api; enqueue; logger }`; the router's `unwrap` maps `{ ok: false }` to `NOT_FOUND`.
- `knowledge_sources` has `status` (`queued|processing|ready|failed`), `claim_token`, `updated_at` and NO lease/attempt columns; `CRAWL_LEASE_SECONDS = 300` (`knowledge-crawl.ts:58`) and the staleness predicate is `updated_at < now() - make_interval(secs => 300)` (line 120); `guardedSourceWrite(tx, sourceId, fromStatuses, patch, claimToken?, onlyWhen?)` and `failSource(db, {...})` live in `apps/worker/src/knowledge/sources.ts`. `knowledge-embed-batch.ts:138-143` selects `embedding IS NULL` (partial index `knowledge_chunks_unembedded_idx`), writes `embeddingModel: deps.embedder.model` (256-273); `KnowledgeRoleDeps { boss; db; logger; config; enqueueEmbedBatch? }`; `createKnowledgeDeps`/`createKnowledgeStore`/`createKnowledgeEmbedder` (`knowledge-deps.ts`). `ObjectStore` is `{ presignPut, head, get, delete }` (`packages/knowledge/src/storage/types.ts`) — **no `put` and no `presignGet`**; Task 6 adds both to the port and to the S3 and memory adapters.
- `registerJob` (`packages/queue/src/define-job.ts:85-120`) wraps `def.handler` in `try { … } catch (err) { throw scrubJobError(err) }`; `registerCron(boss, name, cron, handler, opts?)` (`pg-boss.ts:80-99`). `JOB_NAMES` has 15 entries; `QUEUE_OPTIONS` is `Record<JobName, JobQueueOptions>` (a missing row is a type error). The worker pre-creates 12 queues (`index.ts:61-80`), the api 14 (`boss.ts:30-48`).
- `apps/api/test/helpers/app.ts`: `createTestApi(envOverrides, depsOverrides: Partial<Pick<ServerDeps,'enqueue'|'mailProviders'|'verifyGoogleJwt'|'store'>>)` → `{ app, config, mail, api, handle, lines, store, close }`; router tests go over real HTTP with `createTRPCClient` + `httpBatchLink` + `origin: WEB`; `signInWithOtp(app, mail, email)` returns a cookie; `insertConnectedMailbox`, `insertAgent`, `insertTicket`, `seedPendingDraft` exist. `error-surface.test.ts` walks `./src/trpc/router.ts`, `./src/config.ts`, `./src/memory/service.ts` and `./src/drafts/service.ts` and bans `@anthropic-ai/`, `@aesa/llm`, `pdfjs-dist`, `mammoth`, the `@aesa/knowledge` root, and `undici` from any parent outside `/packages/crypto/`.
- App: settings routes are one-line re-exports (`src/app/(app)/settings/ai.tsx` → `@/screens/settings/ai`) registered in `settings/_layout.tsx`'s `<Stack>`; `screens/settings/index.tsx:56` already renders `<ListRow title="Billing" subtitle="Plan, domains, usage" badge="Phase 7" />`; the inbox's banner slot is `screens/inbox/inbox.tsx:49` beside `<AgentOffBanner />` (`agent-off-banner.tsx` is the template); the popup-before-await pattern for an external URL on web is `screens/settings/connect-card.tsx:105-117,145` (`window.open('', '_blank')` synchronously, then `webWindow.location.href = url`; native `WebBrowser.openAuthSessionAsync`). `Banner` children must be a string; `Button`, `ListRow`, `SwitchRow`, `Chip`, `TextField`, `StatTile` props are in Task 9. Tests mock `'@/lib/trpc'` with `mock`-prefixed closures (`ai.test.tsx:28-55`) and `expo-router` (`settings/index.test.tsx:8-11`). `ticket.tsx:323-341` renders messages inline; `useUpload().start(files: PickedFile[])` (`screens/knowledge/use-upload.ts`) is the upload pipeline; `knowledge.startCrawl({ url, maxPages })` / `knowledge.paste({ title, text })` are the intake mutations. `app.json` has no `app.config.*`; `app-config.test.ts` finds plugins by name. There is no automated route-count test — the 25 is pinned in prose (`CLAUDE.md`, `STATUS.md`).
- `stripe@22.6.2` (verified in a scratch install): `new Stripe(key, { apiVersion? })`; `stripe.customers.create({ email, name, metadata })`; `stripe.checkout.sessions.create({ mode: 'subscription', customer, client_reference_id, line_items: [{ price, quantity }, { price }], success_url, cancel_url, subscription_data: { metadata } })` → `.url`; `stripe.billingPortal.sessions.create({ customer, return_url })` → `.url`; `stripe.subscriptions.cancel(id)`; `stripe.subscriptions.update(id, { items: [{ id, quantity }], proration_behavior })`; `stripe.billing.meterEvents.create({ event_name, identifier, payload: { stripe_customer_id, value } })`; `stripe.webhooks.constructEventAsync(rawBody, signatureHeader, secret)`. Subscription `status` ∈ `active|canceled|incomplete|incomplete_expired|past_due|paused|trialing|unpaid`; `current_period_start/end` are on `subscription.items.data[i]` (NOT the subscription); an invoice's subscription id is `invoice.parent.subscription_details.subscription`. Event types used: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`. **Verify against `node_modules/stripe/esm/resources/*.d.ts` before writing the port**, as Phase 6 did for `openai`.
- `@sentry/node@10.74.0` exports `init`, `withIsolationScope`, `setTag`, `captureException`, `captureMessage`, `flush`, `isInitialized`, `setupFastifyErrorHandler(app)`, `pinoIntegration`. `expo-share-intent@8.0.1` exports `ShareIntentProvider`, `useShareIntentContext()` → `{ hasShareIntent, shareIntent: { type: 'media'|'file'|'text'|'weburl'|null, text, webUrl, files: [{ path, mimeType, fileName, size }] | null }, resetShareIntent, error }`, plugin options `iosActivationRules`, `androidIntentFilters`.

---

### Task 1: Branch, plan commit, and the folded structure carries (`learning.ts`, `outcomes.ts`) plus `sweeps.daily`'s two retention arms

**Files:**
- Create: `apps/api/src/drafts/learning.ts`, `packages/db/migrations/0021_retention_indexes.sql`
- Modify: `apps/api/src/drafts/service.ts` (imports the moved functions; `rejectDraft`/`flagAutoSent` call them; the header's lock-order paragraph names `learning.ts`), `apps/worker/src/jobs/ticket-draft.ts` (imports `escalateProviderUnavailable`/`killCredential` from `../drafting/outcomes.ts`), `apps/worker/src/drafting/outcomes.ts`, `apps/worker/src/jobs/sweeps-daily.ts`, `packages/db/migrations/meta/_journal.json`, `apps/worker/test/sweeps-daily.test.ts`
- Test: the existing `apps/api/test/drafts-service.test.ts`, `apps/api/test/drafts-router.test.ts`, `apps/worker/test/ticket-draft.test.ts`, `apps/worker/test/e2e-phase5.test.ts`, `apps/worker/test/e2e-phase6.test.ts` must pass UNCHANGED (the moves are pure); `sweeps-daily.test.ts` gains two cases

**Interfaces:**
- Consumes: `withDeadlockRetry`, the private helpers `rejectDraft` and `flagAutoSent` call for their fourth-position writes (the answer strikes, the guidance line append, `maybeDemote`, the `guidance.suggest` enqueue list).
- Produces: `apps/api/src/drafts/learning.ts` exporting exactly what `service.ts` needs — `strikeUsedAnswers(tx: OrgTx, orgId: string, answerIds: string[], now: Date): Promise<number>`, `appendGuidanceLine(tx: OrgTx, orgId: string, line: string): Promise<'appended' | 'full'>`, `maybeDemote(tx: OrgTx, p: { orgId; agentId; categoryId; categoryLabel; now; day; actor }): Promise<{ demoted: boolean; notificationId?: string }>` — with whatever names the current private functions carry (rename nothing; move them). `apps/worker/src/drafting/outcomes.ts` exporting `escalateProviderUnavailable` and `killCredential` with their current signatures. `AGENT_RUN_RETENTION_DAYS = 90` and `PLATFORM_ACCESS_AUDIT_RETENTION_DAYS = 30` exported from `sweeps-daily.ts`; `runSweepsDaily` returns two more counts, `runsDeleted` and `platformAuditDeleted`.

- [ ] **Step 1: Branch and commit the plan**

```bash
git checkout main && git pull --ff-only && git checkout -b phase-7
git add docs/superpowers/plans/2026-09-12-phase-7-billing-caps-launch-hardening.md
git commit -m "docs(plan): Phase 7 — billing, caps, launch hardening

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: The `learning.ts` split — a pure move**

Read `apps/api/src/drafts/service.ts` lines 348–418 ("Phase 5: the two writes every owner correction shares") and 790–1022 (`rejectDraft`, `flagAutoSent`). Everything that writes to `resolved_answers`, `workspaces.operating_guidance`, `agent_category_policies` or `notifications` from those two procedures (the fourth lock position — the file header's paragraph "`rejectDraft` takes the draft, then the ticket, and only THEN the learning writes") moves to `apps/api/src/drafts/learning.ts` as exported functions with their bodies unchanged. `service.ts` imports them. The header of `learning.ts`:

```ts
/**
 * The learning writes every owner correction shares (Phase 5): the strike on the answers a rejected or
 * flagged draft relied on, the guidance line a reject-with-reason appends, and the inline demotion check.
 * Every function here runs INSIDE the caller's transaction at the FOURTH lock position — after
 * `outbound_sends`, `drafts` and `tickets` (CLAUDE.md, Lock order) — and never opens one of its own.
 * Split out of service.ts in Phase 7 (named in the Phase 4, 5 and 6 reviews); nothing was reworded.
 */
```

Run: `pnpm --filter @aesa/api test` — every existing draft test passes; `git diff --stat` shows `service.ts` shrinking by what `learning.ts` gained and no other line changing (a reviewer diffs the moved bodies with `git diff --color-moved`).

- [ ] **Step 3: `escalateProviderUnavailable` and `killCredential` into `drafting/outcomes.ts`**

The same discipline: move the two functions from `apps/worker/src/jobs/ticket-draft.ts` into `apps/worker/src/drafting/outcomes.ts` (beside the outcome table they belong to), export them, import them back. `pnpm --filter @aesa/worker test test/ticket-draft.test.ts test/e2e-phase6.test.ts` green.

- [ ] **Step 4: Failing tests for the two retention arms**

Append to `apps/worker/test/sweeps-daily.test.ts` (its `NOW`/`daysAgo` helpers and the seeded org already exist):

```ts
it('arm (g): deletes finished agent_runs older than AGENT_RUN_RETENTION_DAYS and keeps younger ones and their events (cascade only from the deleted parent)', async () => {
  // seed: one draft run finished 91 days ago with an event row; one finished 89 days ago with an event row; one `running` run started 91 days ago (abandoned)
  // run: runSweepsDaily(boss, deps)
  // assert: result.runsDeleted === 2; the 89-day run and its event survive; agent_run_events for the 91-day runs are gone (FK cascade)
})
it('arm (h): deletes platform.access audit rows older than PLATFORM_ACCESS_AUDIT_RETENTION_DAYS and touches no tenant audit row of the same age', async () => {
  // seed: two audit_log rows with org_id NULL, action 'platform.access', created 31 and 29 days ago; one tenant row (org_id set, action 'draft.expired') 31 days ago
  // assert: result.platformAuditDeleted === 1; the tenant row and the 29-day platform row remain
})
```

Run: `pnpm --filter @aesa/worker test test/sweeps-daily.test.ts` → FAIL (`runsDeleted` undefined).

- [ ] **Step 5: The migration, then the arms**

`packages/db/migrations/0021_retention_indexes.sql` (hand-written; append the journal entry `{ "idx": 21, "version": "7", "when": 1789182726696, "tag": "0021_retention_indexes", "breakpoints": true }`):

```sql
-- Phase 7: the platform-wide age sweeps need an index that does not lead with org_id.
-- agent_runs gained one row per inbound email in Phase 6 (triage runs) and nothing pruned it.
CREATE INDEX IF NOT EXISTS "agent_runs_started_idx" ON "agent_runs" ("started_at");
```

Commit the migration immediately (`git add packages/db/migrations && git commit -m "db: agent_runs (started_at) index for the retention sweep"`). Then in `sweeps-daily.ts`, after arm (c):

```ts
// (g) agent_runs retention — Phase 6 made ticket.triage write one run row per inbound email; a run
//     older than AGENT_RUN_RETENTION_DAYS is bookkeeping nobody reads (Activity and the rollup read
//     drafts; llm_calls carries the money). A `running` row that old is an abandoned crash, not a run.
const runCutoff = new Date(now.getTime() - AGENT_RUN_RETENTION_DAYS * 24 * 60 * 60_000)
const deletedRuns = await tx.delete(agentRuns).where(lt(agentRuns.startedAt, runCutoff)).returning({ id: agentRuns.id })
// (h) platform.access rows — every withPlatform() call writes one; they are provenance for 30 days,
//     then noise beside the 2-year tenant trail (which retention.sweep owns from Phase 7).
const platformCutoff = new Date(now.getTime() - PLATFORM_ACCESS_AUDIT_RETENTION_DAYS * 24 * 60 * 60_000)
const deletedPlatformAudit = await tx.delete(auditLog)
  .where(and(isNull(auditLog.orgId), eq(auditLog.action, 'platform.access'), lt(auditLog.createdAt, platformCutoff)))
  .returning({ id: auditLog.id })
```

Update the header's arm list and the `RUN_EVENT_RETENTION_DAYS` comment (it no longer says "never pruned"). Run the test file → PASS.

- [ ] **Step 6: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "refactor(api,worker): the drafts learning.ts split and the outcomes move (pure moves); sweeps.daily arms (g) agent_runs 90 d and (h) platform.access 30 d

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `@aesa/contracts` — the billing and lifecycle vocabulary; `@aesa/core` — plans from one source, the pure billing maths, two invariants

**Files:**
- Create: `packages/contracts/src/billing.ts`, `packages/core/src/billing.ts`, `packages/contracts/test/billing.test.ts`, `packages/core/test/billing.test.ts`
- Modify: `packages/contracts/src/index.ts` (export), `packages/contracts/src/workspace.ts`, `packages/contracts/src/memory.ts`, `packages/contracts/src/notify.ts`, `packages/contracts/src/knowledge.ts`, `packages/core/src/plans.ts`, `packages/core/src/invariants.ts`, `packages/core/src/index.ts`, `packages/core/test/invariants.test.ts`, `packages/core/test/settings-catalog.test.ts` (its `planSettingDefaults('trial')` expectations follow the new numbers)

**Interfaces:**
- Produces (`@aesa/contracts/billing.ts`, zod + constants only):

```ts
export const PLAN_IDS = ['trial', 'standard'] as const
export type PlanId = (typeof PLAN_IDS)[number]
/** The stored Stripe-driven status. `trial_expired` is DERIVED (see BILLING_STATES), never stored. */
export const BILLING_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const
export type BillingStatus = (typeof BILLING_STATUSES)[number]
/** What the owner sees and what decide() keys off: the status plus the derived trial expiry. */
export const BILLING_STATES = ['trialing', 'trial_expired', 'active', 'past_due', 'canceled'] as const
export type BillingState = (typeof BILLING_STATES)[number]
export const OVERAGE_MODES = ['automatic', 'blocked'] as const
export type OverageMode = (typeof OVERAGE_MODES)[number]
/** The numbers the product renders and the plan tiers reference — ONE source (spec §Usage / pricing; defaults to validate). */
export const BILLING_PRICING = {
  perDomainCents: 4999,
  includedPerDomain: 300,
  overageUnitCents: 12,
  trialDays: 14,
  /** Flat per trial, not per domain (plan deviation 5). */
  trialIncludedConversations: 50,
  /** Total Managed-AI spend a trial may cost the platform, USD (spec §Budgets "trial budget"). */
  trialLlmUsdBudget: 10,
} as const
export interface BillingView {
  plan: PlanId; state: BillingState; trialEndsAt: Date | null
  domainQuantity: number; allowance: number; used: number; overageUnits: number
  periodStart: Date; periodEnd: Date
  overageMode: OverageMode; overageUnitCents: number; perDomainCents: number
  hasStripeCustomer: boolean; hasSubscription: boolean; cancelAtPeriodEnd: boolean
  /** The api has STRIPE_* configured; false in dev without keys — the screen hides Subscribe. */
  configured: boolean
}
export const SetOverageModeInput = z.object({ mode: z.enum(OVERAGE_MODES) })
export const BILLING_ERROR_MESSAGES = {
  not_configured: 'Billing is not set up on this server yet.',
  no_customer: 'Subscribe first, then manage billing.',
  already_subscribed: 'This workspace already has a subscription — use Manage billing.',
  stripe_unavailable: 'Stripe did not answer. Try again in a minute.',
  connection_limit: 'Your plan allows no more mailbox connections. Upgrade or disconnect one.',
} as const
```

- `@aesa/contracts/workspace.ts` additions: `SetKillSwitchInput = z.object({ on: z.boolean() })`, `RETENTION_DAYS_MIN = 30`, `RETENTION_DAYS_MAX = 730`, `SetRetentionDaysInput = z.object({ retentionDays: z.number().int().min(30).max(730) })`, `RequestDeletionInput = z.object({ confirm: z.string().trim().min(1).max(120) })` (must equal the business name — checked by the service), `WORKSPACE_DELETE_GRACE_DAYS = 30`, `EXPORT_STATES = ['none','queued','ready','failed'] as const`, and `WORKSPACE_ERROR_MESSAGES = { confirm_mismatch: 'Type the workspace name exactly to confirm.', deletion_pending: 'Deletion is already scheduled.', export_in_progress: 'An export is already running.', billing_cancel_failed: 'Could not cancel the subscription — deletion was not scheduled.' }`.
- `@aesa/contracts/memory.ts`: `RememberReplyInput = z.object({ messageId: z.uuid() })`. `notify.ts`: `NOTIFICATION_KINDS` gains `'billing'` and `'workspace'`. `knowledge.ts`: `KNOWLEDGE_FAILURE_REASONS` gains `'abandoned'` (a queued upload whose bytes never arrived) and `'stuck'` (re-queued three times without landing).
- `@aesa/core/plans.ts`: `PLANS.trial` = `{ …, includedConversationsPerDomain: BILLING_PRICING.trialIncludedConversations, trialDays: BILLING_PRICING.trialDays, llmUsdBudget: BILLING_PRICING.trialLlmUsdBudget }`, `PLANS.standard.includedConversationsPerDomain: BILLING_PRICING.includedPerDomain`, `llmUsdBudget: null` (no total budget on a paid plan); `planSettingDefaults` unchanged in shape.
- `@aesa/core/billing.ts` (pure):

```ts
export interface BillingRowLike {
  plan: PlanId; status: BillingStatus; trialEndsAt: Date | null
  currentPeriodStart: Date | null; currentPeriodEnd: Date | null
  domainQuantity: number; includedConversationsPerDomain: number; overageMode: OverageMode
}
export function billingStateOf(row: BillingRowLike, now: Date): BillingState
  // 'trialing' && trialEndsAt !== null && trialEndsAt <= now → 'trial_expired'; else row.status
export const isBillingActive = (state: BillingState): boolean => state === 'trialing' || state === 'active'
/** trial → the flat trial allowance; standard → includedPerDomain × max(1, domains). */
export function allowanceOf(row: BillingRowLike): number
/** The Stripe period when the row has one; otherwise the UTC calendar month containing `now`. */
export function periodOf(row: BillingRowLike, now: Date): { start: Date; end: Date }
export const overageOf = (used: number, allowance: number): number => Math.max(0, used - allowance)
export function isAllowanceExhausted(p: { mode: 'managed' | 'byok'; plan: PlanId; overageMode: OverageMode; used: number; allowance: number }): boolean
  // mode === 'managed' && used >= allowance && (plan === 'trial' || overageMode === 'blocked')
export function trialEndsAtFor(agentEnabledAt: Date): Date   // + BILLING_PRICING.trialDays × 86_400_000
```

- `@aesa/core/invariants.ts` gains two numeric rules in `INVARIANTS` and `checkInvariants`: `TRIAL_LLM_USD_BUDGET <= TRIAL_DAILY_LLM_USD_CAP * TRIAL_DAYS` (10 ≤ 3 × 14 — a budget above what the daily cap can ever let through is unreachable) and `WORKSPACE_DELETE_GRACE_DAYS >= 7` (the runbook promises a week of regret room); the values are read from `PLANS`/contracts into `INVARIANTS` so `assertInvariants()` at boot catches a bad edit.

- [ ] **Step 1: Failing tests**

`packages/core/test/billing.test.ts` — a table (`it.each`) over `billingStateOf`: trialing with null end → `trialing`; trialing ending tomorrow → `trialing`; trialing ended an hour ago → `trial_expired`; active/past_due/canceled pass through regardless of `trialEndsAt`. `allowanceOf`: trial with 3 domains → 50; standard 0 domains → 300; standard 2 → 600. `periodOf`: a row with Stripe dates returns them; a trial row on 2026-09-12T10:00Z → `[2026-09-01T00:00Z, 2026-10-01T00:00Z)`. `overageOf(601, 600) = 1`, `(599, 600) = 0`. `isAllowanceExhausted`: byok never; managed standard automatic used 10_000 → false; managed standard blocked used 600 allowance 600 → true; managed trial used 49 → false, 50 → true. **The worked example** (plan deviation 3, one recomputation walked with numbers): standard, 2 domains, allowance 600; day 1 used 601 → overage 1, reported 0 → delta 1; day 2 used 650 → overage 50, reported 1 → delta 49; day 3 used 650 → delta 0 (no event). `packages/core/test/invariants.test.ts` gains the two rules (a mutated copy fails).

`packages/contracts/test/billing.test.ts`: `SetOverageModeInput` accepts both modes and rejects `'packs'`; `BILLING_PRICING.perDomainCents === 4999`; `NOTIFICATION_KINDS` contains `billing` and `workspace`; `RequestDeletionInput` trims and bounds.

Run: `pnpm --filter @aesa/core test test/billing.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement contracts, core, plans, invariants** as specified above. `packages/core/src/index.ts` exports `./billing.ts`. Update `settings-catalog.test.ts`'s trial expectations only if they pin `includedConversationsPerDomain` (they pin the 8 mapped keys, which are unchanged — verify).

- [ ] **Step 3: Gate and commit**

```bash
pnpm --filter @aesa/contracts test && pnpm --filter @aesa/core test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(contracts,core): billing vocabulary and pricing, plans from one source, the pure billing maths, lifecycle inputs, two invariants

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 3: DB — `billing_subscriptions`, the lifecycle and purge columns, `resolve_stripe_customer`, `readBillingState`, `loadSettingSources`, the managed meter, `rewrapOrgDek`, `purgeWorkspace`

**Files:**
- Create: `packages/db/src/schema/billing.ts`, `packages/db/src/billing.ts`, `packages/db/src/settings.ts`, `packages/db/src/purge.ts`, `packages/db/migrations/0022_<generated>.sql`, `packages/db/migrations/0023_billing_hardening.sql`, `packages/db/test/billing.test.ts`, `packages/db/test/settings.test.ts`, `packages/db/test/purge.test.ts`
- Modify: `packages/db/package.json` (`"@aesa/core": "workspace:*"` in `dependencies`), `packages/db/src/schema/index.ts`, `packages/db/src/schema/tenancy.ts` (workspaces), `packages/db/src/schema/drafts.ts`, `packages/db/src/schema/memory.ts`, `packages/db/src/schema/knowledge.ts`, `packages/db/src/metering.ts`, `packages/db/src/keys.ts`, `packages/db/src/index.ts`, `packages/db/migrations/meta/_journal.json`, `packages/db/test/migrations.test.ts` (`EXPECTED_TABLES` + `billing_subscriptions`), `packages/db/test/rls.test.ts` (the superset list), `packages/db/test/mail-schema.test.ts:188` (the resolver list + `resolve_stripe_customer(text)`), `packages/db/test/keys.test.ts` (rewrap), `packages/db/test/metering.test.ts` (sumMeter)

**Interfaces:**
- Consumes: Task 2's `PlanId`, `BillingStatus`, `OverageMode`, `BILLING_PRICING`, `billingStateOf`, `allowanceOf`, `periodOf`, `isBillingActive`, `planSettingDefaults`, `SettingKey`; `rewrapDek`, `KekRing` from `@aesa/crypto`.
- Produces:

```ts
// schema/billing.ts — one row per workspace (deviation 1); org_id IS the primary key
export const billingSubscriptions = pgTable('billing_subscriptions', {
  orgId: uuid('org_id').primaryKey(),
  plan: text('plan').notNull().default('trial'),                       // CHECK IN ('trial','standard')
  status: text('status').notNull().default('trialing'),                // CHECK IN ('trialing','active','past_due','canceled')
  stripeCustomerId: text('stripe_customer_id'),                        // UNIQUE (partial, NOT NULL) — the webhook's lookup key
  stripeSubscriptionId: text('stripe_subscription_id'),                // UNIQUE (partial)
  stripeDomainItemId: text('stripe_domain_item_id'),                   // the licensed item whose quantity is the domain count
  stripeOverageItemId: text('stripe_overage_item_id'),
  domainQuantity: integer('domain_quantity').notNull().default(0),
  includedConversationsPerDomain: integer('included_conversations_per_domain').notNull().default(300),
  overageMode: text('overage_mode').notNull().default('automatic'),    // CHECK IN ('automatic','blocked')
  overageUnitCents: integer('overage_unit_cents').notNull().default(12),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  /** Overage units already reported to Stripe for `overage_reported_period_start` (deviation 3). */
  overageReported: integer('overage_reported').notNull().default(0),
  overageReportedPeriodStart: timestamp('overage_reported_period_start', { withTimezone: true }),
  /** Stripe `event.created` of the newest event applied — an older event arriving later is a no-op. */
  lastStripeEventCreated: bigint('last_stripe_event_created', { mode: 'number' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('billing_subscriptions_plan_check', sql`${t.plan} IN ('trial','standard')`),
  check('billing_subscriptions_status_check', sql`${t.status} IN ('trialing','active','past_due','canceled')`),
  check('billing_subscriptions_overage_mode_check', sql`${t.overageMode} IN ('automatic','blocked')`),
  ...tenantPolicies(t.orgId, 'billing_subscriptions'),
])
```

`workspaces` gains `deletionRequestedAt timestamptz`, `deletionRequestedBy uuid` (loose, no FK), `exportState text NOT NULL DEFAULT 'none'` (CHECK `none|queued|ready|failed`), `exportKey text`, `exportReadyAt timestamptz`, `exportRequestedAt timestamptz`. `drafts` gains `bodyPurgedAt timestamptz`. `resolved_answers` gains `sourceMessageId uuid` (loose). `knowledge_sources` gains `sweepAttempts integer NOT NULL DEFAULT 0`.

```ts
// billing.ts
export interface BillingStateRow extends BillingRowLike { orgId: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null; stripeDomainItemId: string | null; stripeOverageItemId: string | null; overageUnitCents: number; overageReported: number; overageReportedPeriodStart: Date | null; cancelAtPeriodEnd: boolean; lastStripeEventCreated: number | null }
export interface BillingStateView extends BillingStateRow { state: BillingState; active: boolean; allowance: number; period: { start: Date; end: Date }; missingRow: boolean }
/** The ONE reader. A workspace with no row reads as a fresh trial (`missingRow: true`) — never throws. */
export async function readBillingState(tx: OrgTx, now: Date): Promise<BillingStateView>
export async function ensureBillingRow(tx: OrgTx): Promise<void>            // insert … on conflict do nothing
/** `sum(usage_counters.value)` for SEND_METERS.aiHandledManaged over the period's UTC days. */
export async function countManagedConversations(tx: OrgTx, period: { start: Date; end: Date }): Promise<number>
/** `count(DISTINCT domain) FROM agents WHERE status = 'active'` — the same predicate mailboxes.addAddress caps on. */
export async function countActiveDomains(tx: OrgTx): Promise<number>
// settings.ts
export interface SettingSources { org: Partial<Record<SettingKey, unknown>>; plan: Partial<Record<SettingKey, number | boolean>>; planId: PlanId }
/** org_settings for `keys` + planSettingDefaults(readBillingState(tx, now).plan). One query each. */
export async function loadSettingSources(tx: OrgTx, keys: readonly SettingKey[], now?: Date): Promise<SettingSources>
// metering.ts additions
export const SEND_METERS = { …, aiHandledManaged: 'ai_handled_conversations_managed' } as const
export async function sumMeter(tx: OrgTx, meter: string, fromDay: string, toDayExclusive?: string): Promise<number>
// keys.ts addition
/** Re-wraps the CURRENT org DEK under ring.active, guarded on the exact bytes read. Returns what happened. */
export async function rewrapOrgDek(tx: OrgTx, ring: KekRing): Promise<{ outcome: 'rewrapped' | 'current' | 'lost_race'; fromVersion: number; toVersion: number }>
// purge.ts
export const PURGE_ORDER: readonly PgTable[]  // every tenant table except workspaces, children before parents
export async function purgeWorkspace(tx: PlatformTx, orgId: string): Promise<Record<string, number>>   // deletes in PURGE_ORDER, then workspaces; returns rows per table
export async function purgeAuthRows(tx: PlatformTx, orgId: string): Promise<void>  // session.active_organization_id → NULL where = orgId; DELETE FROM organization WHERE id = orgId (cascades member, invitation)
```

- [ ] **Step 1: Failing tests**

`packages/db/test/billing.test.ts` (real database via `createTestDatabase` + `createTestOrganization`): `readBillingState` on an org with no row → `{ plan: 'trial', state: 'trialing', active: true, missingRow: true, allowance: 50, period = this UTC month }`; after `ensureBillingRow` twice → one row; after setting `trial_ends_at` an hour ago → `state 'trial_expired', active false`; after `plan standard, status active, domainQuantity 2, period dates` → `allowance 600`, `period` = the Stripe dates; `countManagedConversations` sums only `ai_handled_conversations_managed` within `[start, end)` days (seed the managed meter on the period's first and last day and one outside it, plus an `ai_handled_conversations` row that must be ignored); `countActiveDomains` counts distinct domains of `active` agents only. **RLS**: as `aesa_app` under org A's `withOrg`, org B's row is invisible; `resolve_stripe_customer('cus_B')` as `aesa_app` (a raw pool query) returns org B's id and `NULL`-row for an unknown customer.

`packages/db/test/settings.test.ts`: `loadSettingSources` returns `org` with only the requested keys, `plan = planSettingDefaults('trial')` for a trial org and `('standard')` after the row flips; `resolveSetting('knowledge.max_sources', sources)` reads 10 on trial, 100 on standard, and an `org_settings` override of 7 wins on both.

`packages/db/test/purge.test.ts`: (1) **coverage** — `EXPECTED_TABLES` (import it from `migrations.test.ts` by moving the constant into `test/helpers/tables.ts`) minus `RLS_EXEMPT` minus `['workspaces']` equals the set of `PURGE_ORDER` table names (`getTableName`), so a future tenant table without a purge entry fails here; (2) **function** — seed org A and org B each with a workspace, a billing row, a connection + credential, an agent, a category + policy, a ticket + message, a draft + action token + outbound send, an agent run + event + llm call, a knowledge source + document + chunk, a resolved answer, a guidance suggestion, a notification, a device, an org setting, a usage counter, an org data key (`provisionOrgKeys`), a tenant audit row; run `purgeWorkspace(tx, A)` inside `withPlatform`; assert for every table in `PURGE_ORDER` + `workspaces`: `count(*) WHERE org_id = A` is 0 and `WHERE org_id = B` is unchanged; assert audit rows with `org_id = A` are GONE too (the trail dies with the tenant — spec §PII posture "an org-delete path that cascades"; the platform's own `platform.access` rows have no org). (3) `purgeAuthRows` — a session pointing at A gets `active_organization_id = NULL`; A's `organization`, `member` and `invitation` rows are gone; B's remain.

`packages/db/test/keys.test.ts` gains: with a ring `{ active: 2, keys: {1, 2} }` and a row wrapped under v1, `rewrapOrgDek` → `rewrapped`, the row now `kek_version 2`, and `loadOrgDek` under the two-key ring returns the SAME dek bytes as before; a second call → `current`; a concurrent re-key (mutate `wrapped_dek` between read and write in the test through a second connection) → `lost_race`, row untouched.

`packages/db/test/metering.test.ts` gains `sumMeter` (day-string bounds, exclusive end).

Run: `pnpm --filter @aesa/db test test/billing.test.ts` → FAIL.

- [ ] **Step 2: Schema, generate, hardening migration, commit the migrations**

Write the schema files, then:

```bash
pnpm --filter @aesa/db generate     # → 0022_<generated>.sql
```

Hand-write `0023_billing_hardening.sql` and append its journal entry (`when` = 0022's + 1):

```sql
ALTER TABLE "billing_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_customer_uidx" ON "billing_subscriptions" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_subscription_uidx" ON "billing_subscriptions" ("stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL;
--> statement-breakpoint
-- Every existing workspace gets its trial row (deviation 1); a workspace already switched on gets its
-- trial clock from the first enable, exactly as setAgentEnabled stamps it from Phase 7 on (deviation 2).
INSERT INTO "billing_subscriptions" ("org_id", "trial_ends_at")
  SELECT "org_id", "agent_enabled_at" + interval '14 days' FROM "workspaces"
  ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_export_state_check" CHECK ("export_state" IN ('none','queued','ready','failed'));
--> statement-breakpoint
-- Idempotency for "Remember this reply" (deviation 16): one answer per remembered message.
CREATE UNIQUE INDEX "resolved_answers_source_message_uidx" ON "resolved_answers" ("org_id", "source_message_id") WHERE "source_message_id" IS NOT NULL;
--> statement-breakpoint
-- The retention sweep's work lists (deviation 12): unpurged bodies by age, per org.
CREATE INDEX "messages_org_unpurged_idx" ON "messages" ("org_id", "created_at") WHERE "body_purged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "drafts_org_unpurged_idx" ON "drafts" ("org_id", "created_at") WHERE "body_purged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" ("created_at");
--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" ("created_at");
--> statement-breakpoint
-- The re-embed sweep's work list (Task 7): chunks embedded by a model that is no longer the configured one.
CREATE INDEX "knowledge_chunks_embedding_model_idx" ON "knowledge_chunks" ("embedding_model") WHERE "embedding" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" DROP CONSTRAINT IF EXISTS "knowledge_sources_failure_reason_check";
--> statement-breakpoint
-- (re-add the failure_reason CHECK with 'abandoned' and 'stuck' appended, copying the list from 0014 — verify the constraint name there)
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" IN ('escalation','mailbox_reauth','digest','draft_review','auto_send','graduation','demotion','memory_sample','provider_health','billing','workspace'));
--> statement-breakpoint
-- The api's cross-org read for the Stripe webhook (spec, tenancy net 1): customer id → org. Same shape and
-- the same ACL-then-owner order as resolve_mailbox_connection (0006) — see that migration's comments.
CREATE OR REPLACE FUNCTION resolve_stripe_customer(p_customer_id text)
RETURNS TABLE (org_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT org_id FROM billing_subscriptions WHERE stripe_customer_id = p_customer_id LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_stripe_customer(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_stripe_customer(text) TO "aesa_app";
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO "aesa_platform";
--> statement-breakpoint
ALTER FUNCTION resolve_stripe_customer(text) OWNER TO "aesa_platform";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM "aesa_platform";
```

```bash
git add packages/db/migrations && git commit -m "db: billing_subscriptions, lifecycle and purge columns, resolve_stripe_customer, retention indexes (migrations 0022–0023)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: Implement `billing.ts`, `settings.ts`, `metering.ts`, `keys.ts`, `purge.ts`**

`readBillingState`: `select().from(billingSubscriptions).where(eq(orgId, tx.orgId))`; when no row, build the defaults object (`plan 'trial'`, `status 'trialing'`, `trialEndsAt null`, `domainQuantity 0`, `includedConversationsPerDomain: BILLING_PRICING.includedPerDomain`, `overageMode 'automatic'`, `overageUnitCents: BILLING_PRICING.overageUnitCents`, `missingRow: true`); then `state = billingStateOf(row, now)`, `active = isBillingActive(state)`, `allowance = allowanceOf(row)`, `period = periodOf(row, now)`.

`rewrapOrgDek`: read the max-version row; `if (row.kekVersion === ring.active) return { outcome: 'current', … }`; `const next = rewrapDek(row.wrappedDek, row.kekVersion, ring, tx.orgId)`; `UPDATE … SET wrapped_dek = next.wrapped, kek_version = next.kekVersion WHERE org_id AND version AND wrapped_dek = <the bytes read> AND kek_version = <read> RETURNING`; zero rows → `lost_race`.

`purge.ts` — `PURGE_ORDER` in FK-dependency order (children first; the map from the survey): `draftActionTokens, outboundSends, agentRunEvents, llmCalls, drafts, agentRuns, messages, tickets, agentCategoryPolicies, categoryStatsDaily, guidanceSuggestions, resolvedAnswers, agentModelConfig, llmCredentialSecrets, llmCredentials, knowledgeChunks, knowledgeDocuments, knowledgeSources, agents, categories, mailboxCredentials, mailboxConnections, oauthFlows, gmailAccessRequests, notifications, notificationDevices, usageCounters, orgSettings, billingSubscriptions, orgDataKeys, auditLog` — each `tx.delete(table).where(eq(table.orgId, orgId))` as `aesa_platform` (RLS bypass; the explicit `org_id` predicate is the whole safety), then `workspaces`. The function header states that `PURGE_ORDER` is pinned by `purge.test.ts` against the migration table list, so adding a tenant table without a purge entry fails CI. `purgeAuthRows` runs two raw statements (`UPDATE session SET active_organization_id = NULL WHERE active_organization_id = $1`, `DELETE FROM organization WHERE id = $1`) with the deviation-9 comment; verify the session column name in `schema/auth.ts` (Better Auth's organization plugin adds `active_organization_id`).

`packages/db/src/index.ts` exports the new modules (`readBillingState`, `ensureBillingRow`, `countManagedConversations`, `countActiveDomains`, `loadSettingSources`, `SettingSources`, `sumMeter`, `rewrapOrgDek`, `purgeWorkspace`, `purgeAuthRows`, `PURGE_ORDER`).

- [ ] **Step 4: Run, gate, commit**

```bash
pnpm --filter @aesa/db test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(db): readBillingState (the one reader), loadSettingSources (org + plan), the managed conversations meter, rewrapOrgDek, purgeWorkspace pinned to the table list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: api — `ownerProcedure`; `src/billing/{stripe,service,webhook}.ts` (`@aesa/api/billing`) and the `billing` router; the raw-body Stripe webhook; config; the billing row at creation and the trial stamp; `mailboxes.max_connections`; every api `resolveSetting` on `loadSettingSources`

**Files:**
- Create: `apps/api/src/billing/stripe.ts`, `apps/api/src/billing/service.ts`, `apps/api/src/billing/webhook.ts`, `apps/api/src/trpc/routers/billing.ts`, `apps/api/test/billing-service.test.ts`, `apps/api/test/billing-router.test.ts`, `apps/api/test/billing-webhook.test.ts`, `apps/api/test/helpers/fake-stripe.ts`
- Modify: `apps/api/package.json` (`stripe@22.6.2` exact; `"./billing": "./src/billing/service.ts"`), `apps/api/src/config.ts`, `apps/api/src/trpc/init.ts` (`ownerProcedure`), `apps/api/src/deps.ts` (`resolveStripeCustomer`; `stripe: StripePort | null` on `ServerDeps`), `apps/api/src/index.ts` (builds the real port when configured), `apps/api/src/server.ts` (the webhook `register()`; `/meta` gains `billing: deps.stripe !== null`), `apps/api/src/trpc/router.ts` (`billing: billingRouter`), `apps/api/src/trpc/routers/workspace.ts` (`create` → `ensureBillingRow(tx)`; `setAgentEnabled` → stamps `billing_subscriptions.trial_ends_at = COALESCE(trial_ends_at, now() + 14 days)` on enable), `apps/api/src/trpc/routers/mailboxes.ts` (`startConnect` counts `mailbox_connections` with `status <> 'disabled'` against `resolveSetting('mailboxes.max_connections', sources)` → `FORBIDDEN` with `BILLING_ERROR_MESSAGES.connection_limit`), `apps/api/src/knowledge/service.ts` + `apps/api/src/trpc/routers/agents.ts` (`loadSettingSources` instead of `loadOrgSettings`), `apps/api/src/org-settings.ts` (DELETE), `apps/api/test/helpers/app.ts` (`stubDeps.api.resolveStripeCustomer`; `createTestApi` accepts `stripe`), `apps/api/test/error-surface.test.ts` (the facade mirror; `./src/billing/service.ts` joins the walked entry points; `stripe`'s graph must not bring `undici` from outside crypto — the SDK uses Node's `http`/`fetch` by default; assert it), `apps/api/test/config.test.ts`, `apps/api/test/workspace.test.ts` (create → a billing row; enable → `trial_ends_at`), `apps/api/test/mailboxes-router.test.ts` (the connection cap)

**Interfaces:**
- Consumes: Task 2's inputs/constants/messages; Task 3's `readBillingState`, `ensureBillingRow`, `countManagedConversations`, `countActiveDomains`, `loadSettingSources`; `recordWebhookEvent`; `escalationCopy`-style notification inserts; `JOB_NAMES.notifyDispatch`.
- Produces:

```ts
// stripe.ts — the port; the SDK is imported HERE and nowhere else in the api
export interface StripeEvent { id: string; type: string; created: number; data: { object: unknown } }
export interface StripePort {
  createCustomer(p: { email: string | null; name: string; orgId: string }): Promise<{ id: string }>
  createCheckoutSession(p: { customerId: string; orgId: string; domainQuantity: number; successUrl: string; cancelUrl: string }): Promise<{ url: string }>
  createPortalSession(p: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  cancelSubscription(subscriptionId: string): Promise<void>
  constructEvent(rawBody: string, signature: string): Promise<StripeEvent>   // throws on a bad signature
}
export interface StripeConfig { secretKey: Secret; webhookSecret: Secret; priceDomain: string; priceOverage: string }
export function createStripePort(config: StripeConfig): StripePort
// service.ts
export interface BillingServiceDeps { api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger; stripe: StripePort | null; appWebOrigin: string; now?: () => Date }
export interface BillingActor { userId: string; actor: AuditActor; email: string | null; ip?: string | null; userAgent?: string | null }
export async function getBilling(deps, orgId): Promise<BillingView>
export async function startCheckout(deps, orgId, actor): Promise<{ ok: true; url: string } | { ok: false; code: 'not_configured' | 'already_subscribed' | 'stripe_unavailable' }>
export async function openPortal(deps, orgId, actor): Promise<{ ok: true; url: string } | { ok: false; code: 'not_configured' | 'no_customer' | 'stripe_unavailable' }>
export async function setOverageMode(deps, orgId, input: SetOverageModeInput, actor): Promise<{ ok: true }>
// webhook.ts
export type StripeApplyOutcome = 'applied' | 'duplicate' | 'stale' | 'unknown_customer' | 'ignored'
/** Pure-ish: dedupe through recordWebhookEvent, resolve the org, then ONE withOrg transaction with guarded writes. The E2E drives this directly. */
export async function applyStripeEvent(deps: BillingServiceDeps, event: StripeEvent): Promise<StripeApplyOutcome>
export function registerStripeWebhook(app: FastifyInstance, deps: ServerDeps): void
```

- [ ] **Step 1: Failing service and webhook tests** (`createTestApi` with `stripe: createFakeStripe()` — `test/helpers/fake-stripe.ts` records every call and returns canned ids/urls, `constructEvent` parses the JSON body and checks `signature === 'valid'`)

`billing-service.test.ts`:
```ts
it('getBilling on a fresh workspace: trial, trialing, allowance 50, used 0, period = this UTC month, configured true, hasStripeCustomer false', …)
it('startCheckout: creates the customer with metadata.orgId and the owner email OUTSIDE the transaction, writes stripe_customer_id guarded on NULL, creates a subscription-mode session with the domain line (quantity max(1, active domains)) and the overage line, success/cancel URLs under appWebOrigin/settings/billing, audits billing.checkout_started; a second call reuses the customer (one createCustomer call total)', …)
it('startCheckout when status is active → already_subscribed; when deps.stripe is null → not_configured; when the fake throws → stripe_unavailable and NO row change', …)
it('openPortal without a customer → no_customer; with one → a url under return_url = appWebOrigin/settings/billing', …)
it('setOverageMode writes the row and audits', …)
```
`billing-webhook.test.ts` (over `applyStripeEvent` AND over HTTP):
```ts
it('checkout.session.completed: resolves the org by customer id, writes subscription id, item ids by price, quantity, period from items[0], plan standard, status active, last_stripe_event_created; audits billing.subscription_activated', …)
it('the SAME event id a second time → duplicate (webhook_events), no second audit row', …)
it('an event with created < last_stripe_event_created → stale, row untouched', …)
it('customer.subscription.updated with status past_due → status past_due + ONE billing notification (dedupe billing:past_due:<org>:<day>) + notify.dispatch enqueued post-commit; a second past_due event the same day adds no notification', …)
it('customer.subscription.deleted → status canceled, plan trial, cancel_at_period_end false', …)
it('invoice.payment_failed → past_due (+ the same day-deduped page); invoice.paid → active', …)
it('an unknown customer → unknown_customer, 200 over HTTP, an alert-level log line', …)
it('HTTP: a bad signature is 400 and records nothing; the route is 404 when stripe is null; the body reaches constructEvent as the RAW string (assert the fake saw the exact bytes, including whitespace)', …)
```
`billing-router.test.ts`: `billing.get` as a member works; `startCheckout`/`openPortal`/`setOverageMode` as an ADMIN → `FORBIDDEN` (`ownerProcedure`), as the owner → the fake url; the soft codes map to `PRECONDITION_FAILED` (`not_configured`, `already_subscribed`, `no_customer`) and `BAD_GATEWAY` (`stripe_unavailable`) with `BILLING_ERROR_MESSAGES`.

Run: `pnpm --filter @aesa/api test test/billing-service.test.ts` → FAIL.

- [ ] **Step 2: `ownerProcedure`, config, deps, the port**

`init.ts`: `export const ownerProcedure = orgProcedure.use(({ ctx, next }) => { if (ctx.member.role !== 'owner') throw new TRPCError({ code: 'FORBIDDEN', message: 'owner required' }); return next() })`.

`config.ts`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_DOMAIN`, `STRIPE_PRICE_OVERAGE` optional strings; a `stripeGroup()` all-or-none helper (the `oauthPair` shape, four names); `if (production && !stripe) throw new Error('STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_DOMAIN and STRIPE_PRICE_OVERAGE are required in production (billing)')`; `ApiConfig.stripe: StripeConfig | null`. Also `SENTRY_DSN` (optional, `Secret`) and `SENTRY_ENVIRONMENT` (default `NODE_ENV`) — read here, used in Task 11.

`deps.ts`: `resolveStripeCustomer(customerId: string): Promise<{ orgId: string } | null>` on `ApiFacade` (raw `handle.pool.query('SELECT * FROM resolve_stripe_customer($1)', [id])`); `ServerDeps.stripe: StripePort | null`. `index.ts`: `stripe: config.stripe ? createStripePort(config.stripe) : null` (warn once when null outside production).

`stripe.ts`: `createStripePort` wraps `new Stripe(config.secretKey.expose(), { typescript: true })` (verify the `Secret` accessor name in `@aesa/crypto`); `createCheckoutSession` passes `line_items: [{ price: config.priceDomain, quantity }, { price: config.priceOverage }]`, `client_reference_id: orgId`, `subscription_data: { metadata: { orgId } }`, `metadata: { orgId }`; `constructEvent` = `stripe.webhooks.constructEventAsync(rawBody, signature, config.webhookSecret.expose())` mapped to `StripeEvent`. Every SDK error is caught at the port boundary and rethrown as `new Error('stripe: ' + scrubbed message)` — never the SDK's error object (it carries request headers).

- [ ] **Step 3: The service and the webhook**

`service.ts` header (copy the `llm/service.ts` discipline): one `withOrg` per read or write, Stripe calls between them, soft codes as `{ ok: false; code }`. `startCheckout`: tx 1 reads `readBillingState` (+ `countActiveDomains`, the owner's email from the actor); `already_subscribed` when `stripeSubscriptionId` is set and state is `active`/`past_due`; if no customer → `stripe.createCustomer` → tx 2 `UPDATE … SET stripe_customer_id = $1 WHERE org_id AND stripe_customer_id IS NULL RETURNING` (zero rows → re-read the winner's id, log the orphaned Stripe customer at warn); → `stripe.createCheckoutSession` → tx 3 audits `billing.checkout_started { domainQuantity }` → `{ ok: true, url }`. `getBilling`: one tx — `readBillingState`, `countManagedConversations(period)`, `countActiveDomains` (the LIVE count, shown beside the billed `domainQuantity` when they differ) → `BillingView` with `configured: deps.stripe !== null`.

`webhook.ts`: `applyStripeEvent` — `if (!(await deps.api.recordWebhookEvent('stripe', event.id, { type: event.type, created: event.created }))) return 'duplicate'` (the envelope stores the type and timestamp only — never the object, which can carry the customer's email and card brand); narrow `event.data.object` with zod schemas per type (`customer: z.string()`, `subscription: z.string().optional()`, `status`, `items.data[].{id, price: {id}, quantity, current_period_start, current_period_end}`, `cancel_at_period_end`, `client_reference_id`, `metadata.orgId`, `parent.subscription_details.subscription` for invoices) — a payload that does not parse is `ignored` with a warn, never a throw; resolve `orgId` = `resolveStripeCustomer(customer)` ?? `metadata.orgId` ?? `client_reference_id` (only `checkout.session.completed` may fall back — and only when the resolved/claimed org's row has this customer id or none yet); unknown → `unknown_customer` + `alert('stripe_unknown_customer')`; then ONE `withOrg`: read the row; `if (row.lastStripeEventCreated !== null && event.created < row.lastStripeEventCreated) return 'stale'`; compute the patch per type (the status map from deviation 8: `active|trialing → active`, `past_due|unpaid|paused → past_due`, `canceled|incomplete_expired → canceled` (+ `plan 'trial'`), `incomplete → no status change`); `UPDATE … WHERE org_id AND (last_stripe_event_created IS NULL OR last_stripe_event_created <= $created)` (the guard, again, inside the write); audit `billing.<type>` with the ids; on a transition INTO `past_due` insert the `billing` notification (`title: 'Payment failed'`, `body: 'Autopilot is paused until the card is updated. Replies still come to you for review.'`, `dedupeKey: billing:past_due:${orgId}:${day}`, `payload: { state: 'past_due' }`) and collect its id; after commit, dispatch. `registerStripeWebhook(app, deps)`:

```ts
app.register(async (scoped) => {
  // Stripe verifies the RAW bytes; the app-wide parser (server.ts) hands us parsed JSON. This
  // encapsulated context swaps the parser for one that keeps the string — for these routes only,
  // the same trick server.ts plays for @fastify/formbody around the review pages.
  scoped.removeContentTypeParser('application/json')
  scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
  scoped.post('/webhooks/stripe', async (req, reply) => {
    if (!deps.stripe) return reply.code(404).send({ error: 'not configured' })
    const sig = req.headers['stripe-signature']
    if (typeof sig !== 'string' || typeof req.body !== 'string') return reply.code(400).send({ error: 'bad request' })
    let event: StripeEvent
    try { event = await deps.stripe.constructEvent(req.body, sig) } catch { alert(…'stripe_webhook_rejected'); return reply.code(400).send({ error: 'bad signature' }) }
    const outcome = await applyStripeEvent(serviceDeps(deps), event)
    return reply.code(200).send({ outcome })
  })
})
```

registered from `server.ts` inside the shared rate-limited `register()` block (so `onRoute` wraps it) — check that a nested `register` inside that block still gets the limiter; if not, register it beside the formbody block and note it. The CSRF hook matches `/trpc` only; the origin check does not apply.

`routers/billing.ts`: `get: orgProcedure.query`, `startCheckout: ownerProcedure.mutation`, `openPortal: ownerProcedure.mutation`, `setOverageMode: ownerProcedure.input(SetOverageModeInput).mutation`, the exhaustive `switch` on soft codes with no `default`.

- [ ] **Step 4: The two workspace edits, the connection cap, the settings sources**

`workspace.create`: after the `workspaces` insert, `await ensureBillingRow(tx)`. `setAgentEnabled`: when `input.enabled`, also `UPDATE billing_subscriptions SET trial_ends_at = COALESCE(trial_ends_at, now() + interval '14 days') WHERE org_id` (through drizzle `sql`, the same COALESCE idiom as `agent_enabled_at`; `ensureBillingRow` first so a pre-Phase-7 dev workspace has a row). `mailboxes.startConnect`: `const sources = await loadSettingSources(tx, ['mailboxes.max_connections'])` → count `mailbox_connections` `status <> 'disabled'` → `>= cap` → `TRPCError FORBIDDEN` with `BILLING_ERROR_MESSAGES.connection_limit`, BEFORE the `oauth_flows` insert. Replace `loadOrgSettings` in `knowledge/service.ts` and `agents.ts` with `loadSettingSources` (`resolveSetting(key, sources)`), delete `org-settings.ts`.

- [ ] **Step 5: Run, gate, commit**

```bash
pnpm --filter @aesa/api test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(api): ownerProcedure; the billing service and router (Checkout, Portal, overage mode); the raw-body Stripe webhook with dedupe and a monotonic event guard; the billing row at creation and the trial stamp; mailboxes.max_connections enforced; settings resolved from org + plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 5: Worker — billing everywhere: settings from org + plan, the two `decide()` facts, the `subscription_inactive` send lever, the managed conversations meter, the trial budget, the admission slot pool, and the `billing.report-usage` cron

**Files:**
- Create: `apps/worker/src/billing/stripe.ts`, `apps/worker/src/billing/report-usage.ts`, `apps/worker/src/drafting/admission.ts`, `apps/worker/test/billing-report-usage.test.ts`, `apps/worker/test/drafting-admission.test.ts`, `apps/worker/test/helpers/fake-stripe-usage.ts`
- Modify: `apps/worker/package.json` (`stripe@22.6.2` exact), `apps/worker/src/config.ts` (`STRIPE_SECRET_KEY`, `STRIPE_METER_EVENT_NAME` default `ai_conversation_overage`, `MANAGED_DRAFT_SLOTS` default 4, `SENTRY_DSN`/`SENTRY_ENVIRONMENT`), `apps/worker/src/index.ts` (the cron under `cron`; `pool` handed to the agent role), `apps/worker/src/agent-role.ts` (`admission`), `apps/worker/src/drafting/caps.ts`, `apps/worker/src/knowledge/sources.ts` (`loadOrgSettings` DELETED), `apps/worker/src/jobs/ticket-draft.ts`, `apps/worker/src/jobs/agent-sandbox.ts`, `apps/worker/src/jobs/send-execute.ts`, `apps/worker/src/jobs/ticket-triage.ts`, `apps/worker/src/jobs/guidance-suggest.ts`, `apps/worker/src/jobs/notify-digest.ts`, `apps/worker/src/digest-email.ts`, `apps/worker/src/jobs/knowledge-crawl.ts`, `apps/worker/src/jobs/knowledge-embed-batch.ts`, `apps/worker/src/jobs/memory-capture.ts`, `apps/worker/test/{config,drafting-caps,ticket-draft,agent-sandbox,send-execute}.test.ts`

**Interfaces:**
- Consumes: Task 3's `readBillingState`, `loadSettingSources`, `countManagedConversations`, `countActiveDomains`, `sumMeter`, `SEND_METERS.aiHandledManaged`; Task 2's `isAllowanceExhausted`, `overageOf`, `PLANS`; `resolveModelConfig`.
- Produces:

```ts
// billing/stripe.ts — the worker's port; the SDK imported here only
export interface StripeUsagePort {
  reportOverage(p: { customerId: string; value: number; identifier: string }): Promise<void>   // billing.meterEvents.create
  setDomainQuantity(p: { subscriptionId: string; itemId: string; quantity: number }): Promise<void>  // subscriptions.update, proration_behavior 'create_prorations'
}
export function createStripeUsagePort(p: { secretKey: Secret; meterEventName: string }): StripeUsagePort
// billing/report-usage.ts
export interface ReportUsageDeps { db: Db; logger: pino.Logger; stripe: StripeUsagePort | null; enqueueNotify: (orgId: string, notificationId: string) => Promise<void>; now?: () => Date }
export const REPORT_ORGS_PER_RUN = 500
export const TRIAL_ENDING_NOTICE_DAYS = 3
export async function runBillingReportUsage(deps: ReportUsageDeps): Promise<{ orgs: number; reported: number; quantitySynced: number; trialNotices: number; skipped: number }>
export async function registerBillingReportUsage(boss: PgBoss, deps: ReportUsageDeps): Promise<void>   // cron '20 0 * * *', singleton
// drafting/admission.ts
export interface AdmissionPool { acquire(signal: AbortSignal): Promise<{ release(): Promise<void> } | null> }   // null = timed out (60 s)
export function createAdmissionPool(pool: pg.Pool, slots: number, opts?: { waitMs?: number; pollMs?: number }): AdmissionPool
export const noAdmission: AdmissionPool   // slots = 0 → acquire resolves immediately with a no-op release
// caps.ts — GateParams.settings becomes SettingSources; GateOutcome gains { outcome: 'org_spend_capped'; scope: 'daily' | 'trial'; costMicros: number }
// send-execute.ts — LEVER_WORDS gains subscription_inactive: 'the workspace has no active subscription'; ClaimedSend gains billing: { active: boolean }
```

- [ ] **Step 1: Failing tests**

`drafting-caps.test.ts` gains: on a trial org with `llm_cost_micros` summed over ALL days ≥ `PLANS.trial.llmUsdBudget × 1e6` (seed $2.5 today and $8 spread across earlier days: the $3 daily cap passes, the trial total of $10.5 ≥ $10 trips) → `org_spend_capped` with `scope: 'trial'`; the same spend on a `standard` row → proceed; `readCapsUnlocked` mirrors (`orgTrialCostMicros`). And: a plan's `autonomy.daily_draft_cap` is what gates — a trial org with 50 draft runs today is `org_draft_capped` though the catalog default is 2000.

`ticket-draft.test.ts` gains: `subscriptionActive` false when the billing row is `past_due` → the draft lands `awaiting_review` with `decision_reason 'subscription_inactive'` (the ticket still gets a draft); a `trial_expired` row → the same; `allowanceExhausted`: a `standard` row with `overage_mode 'blocked'`, 2 domains, and the managed meter at 600 in this period → an otherwise auto-eligible draft (reuse the Phase 5 test's auto fixture) lands review `allowance_exhausted`; with `automatic` → `send`; a BYOK agent under `blocked` at 600 → `send` (never exhausted); `confidence_breakdown.blockers.allowance` records `{ used, allowance, mode }`.

`send-execute.test.ts` gains: a queued AUTO send (`decision_source 'auto'`) on a `past_due` row → `held` with lever `subscription_inactive` and the day-deduped page; a queued REVIEW send on the same row → sent; `completeSend` bumps `ai_handled_conversations_managed` when `resolveModelConfig(agent, 'draft').mode === 'managed'` and NOT when `byok` (both still bump `ai_handled_conversations`; both guarded by `ai_handled_month`).

`billing-report-usage.test.ts` (fake usage port recording calls): the worked example from Task 2 as three consecutive runs on a `standard` row with `stripe_customer_id`, 2 domains, `current_period_start` = the 1st: day 1 meter 601 → one `reportOverage({ value: 1, identifier: '<org>:<periodStartIso>:1' })`, row `overage_reported 1`, audit `billing.overage_reported { used: 601, allowance: 600, delta: 1 }`; day 2 meter 650 → `value 49`, `overage_reported 50`; day 3 unchanged → no call; a new period (`current_period_start` moved) → `overage_reported` resets to that period's overage; `blocked` mode → never reports; a `trial` row → never reports; `stripe: null` → `skipped` counts and a warn, NO row change; a port throw → `alert('stripe_report_failed')`, the row untouched (guarded write only after success). Quantity: 3 active domains vs `domain_quantity 2` → `setDomainQuantity({ quantity: 3 })` then the row updated guarded on `domain_quantity = 2`. Trial notices: a `trialing` row with `trial_ends_at` in 3 days → ONE `billing` notification `trial_ending` (`dedupe billing:trial_ending:<org>:<day>`), ended yesterday → `trial_ended` once; `blocked` with used ≥ allowance → `allowance_reached` once per period (`billing:allowance:<org>:<periodStartIso>`).

`drafting-admission.test.ts` (two real pool clients): `createAdmissionPool(pool, 1)` — the first `acquire` gets a slot; a second concurrent `acquire` with `waitMs: 200` resolves `null`; after `release()` it succeeds; `createAdmissionPool(pool, 0)` behaves as `noAdmission`; an aborted signal returns `null` at once; the held client is returned to the pool on release (pool `idleCount` restored).

`config.test.ts` gains: `STRIPE_SECRET_KEY` required in production with `cron`, not otherwise; `MANAGED_DRAFT_SLOTS` parses, defaults 4, rejects negatives.

Run: `pnpm --filter @aesa/worker test test/drafting-caps.test.ts` → FAIL.

- [ ] **Step 2: Settings sources everywhere**

Delete `knowledge/sources.ts`'s `loadOrgSettings`; every worker call site in the Repo facts list calls `loadSettingSources(tx, [keys], now)` (the pre-claim tx in `ticket-draft.ts` loads once and stores `pre.sources: SettingSources`; `ticket-triage.ts`, `guidance-suggest.ts`, `notify-digest.ts`, `digest-email.ts`, `knowledge-crawl.ts`, `knowledge-embed-batch.ts`, `memory-capture.ts` likewise — their hand-rolled single-row reads go). `GateParams.settings: SettingSources`. **Grep gate:** `grep -rn "resolveSetting(" apps packages --include=*.ts | grep "{ org" | grep -v test` must print nothing.

- [ ] **Step 3: The two facts, the lever, the meter, the budget**

`ticket-draft.ts`: `loadPreClaim` also reads `billing = await readBillingState(tx, now)` and `managedUsed = await countManagedConversations(tx, billing.period)`; the `decide()` literal becomes `subscriptionActive: pre.billing.active` and `allowanceExhausted: isAllowanceExhausted({ mode: resolved.config.mode, plan: pre.billing.plan, overageMode: pre.billing.overageMode, used: pre.managedUsed, allowance: pre.billing.allowance })`; `confidenceBreakdown.blockers.allowance = { used, allowance, mode, exhausted }` and `.subscription = billing.state`. `agent-sandbox.ts`: `subscriptionActive: billing.active` (read in its context tx), `allowanceExhausted` stays `false` with its comment.

`send-execute.ts`: `claimSend` reads `readBillingState(tx, now)` after `workspaces` (read-only, the fourth position) → `billing: { active }`; `firstKillLever`: after `category_off`, `if (!c.billing.active && c.draft.decisionSource === 'auto') return 'subscription_inactive'`; `LEVER_WORDS.subscription_inactive`. `completeSend`: after the existing `aiHandledConversations` bump (inside the same `stamped.length > 0` branch), `const cfg = await resolveModelConfig(tx, { agentId, role: 'draft' })` (verify the call shape in `packages/db/src/model-config.ts`) → `if (cfg.mode === 'managed') await bumpMeter(tx, orgId, day, SEND_METERS.aiHandledManaged, 1)`.

`caps.ts`: branch ④b after the daily cap — `if (p.settings.planId === 'trial') { const budget = PLANS.trial.llmUsdBudget; const total = await sumMeter(tx, LLM_METERS.costMicros, '1970-01-01'); if (total >= usdCapToMicros(budget)) return { outcome: 'org_spend_capped', scope: 'trial', costMicros: total } }` (the daily branch gains `scope: 'daily'`); `readCapsUnlocked` returns `orgTrialCostMicros`; `ticket-draft.ts`'s `orgCapReached` and `notifyOrgCapped` take the scope (the page's body says "for today" vs "for the trial"); `usdCapToMicros` exported and the inline copy in `ticket-draft.ts:322` removed. `alert('org_spend_capped', { orgId, scope })` from Task 11's module — until then a `logger.error({ alert: true })` line that Task 11 replaces.

- [ ] **Step 4: Admission**

`admission.ts`: `acquire` checks out `const client = await pool.connect()`, loops `for i in 0..slots-1`: `SELECT pg_try_advisory_lock(hashtext('managed-slot'), $1)` → true → return `{ release: async () => { await client.query('SELECT pg_advisory_unlock(hashtext(\'managed-slot\'), $1)', [i]); client.release() } }`; no slot → sleep `pollMs` (500) and retry until `waitMs` (60_000) or `signal.aborted` → `client.release(); return null`. `agent-role.ts` builds `admission = config.managedDraftSlots > 0 ? createAdmissionPool(pool, config.managedDraftSlots) : noAdmission` and hands it to `ticket.draft` and `agent.sandbox` deps; both wrap the MANAGED model call: `const slot = resolved.config.mode === 'managed' ? await deps.admission.acquire(signal) : null; if (resolved.config.mode === 'managed' && !slot) alert('admission_slot_timeout', { orgId })` then `try { …call… } finally { await slot?.release() }`. `index.ts` passes `pool` into `maybeRegisterAgentRole`.

- [ ] **Step 5: The cron**

`report-usage.ts`: `withPlatform(db, 'cron:billing.report-usage', …)`, orgs = `selectDistinct billing_subscriptions.org_id ORDER BY org_id LIMIT REPORT_ORGS_PER_RUN` (the `stats-rollup` idiom, per-org SAVEPOINT + `withOrgIdentity`, every query with an explicit `eq(orgId)`), and — because the Stripe calls are network — the per-org body is: (1) SAVEPOINT read (`readBillingState`, `countManagedConversations(period)`, `countActiveDomains`) and compute; commit the read; (2) Stripe calls OUTSIDE any transaction; (3) a second `withOrg` for the guarded writes and audit. Structure the pass as `collect → act → record` over the org list rather than one long platform transaction (write this in the header: "three phases, because a meter event is network I/O"). Trial notices and the `allowance_reached` page are inserted in phase 3 and dispatched through `deps.enqueueNotify` after each org commits. Register under the `cron` role in `index.ts` with `stripe: config.stripe ? createStripeUsagePort(config.stripe) : null`.

`config.ts`: `STRIPE_SECRET_KEY` + `STRIPE_METER_EVENT_NAME` (default) → `WorkerConfig.stripe: { secretKey: Secret; meterEventName: string } | null`; `if (production && roles.has('cron') && !stripe) throw new Error('STRIPE_SECRET_KEY is required in production when WORKER_ROLES includes `cron` (billing.report-usage)')`; `MANAGED_DRAFT_SLOTS` (`z.coerce.number().int().min(0).default(4)`).

- [ ] **Step 6: Run, gate, commit**

```bash
pnpm --filter @aesa/worker test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(worker): settings from org + plan at every site; subscription and allowance facts into decide(); the subscription_inactive send lever; the managed conversations meter; the trial budget; managed admission slots; the billing.report-usage cron (overage deltas as meter events, daily quantity sync, trial notices)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Worker — `retention.sweep`, `workspace.export`, `workspace.purge` + `workspace.purge-sweep`, `keys.rotate` + `pnpm --filter @aesa/worker keys:rotate`

**Files:**
- Create: `apps/worker/src/jobs/retention-sweep.ts`, `apps/worker/src/jobs/workspace-export.ts`, `apps/worker/src/jobs/workspace-purge.ts`, `apps/worker/src/jobs/keys-rotate.ts`, `apps/worker/scripts/keys-rotate.ts`, `apps/worker/test/retention-sweep.test.ts`, `apps/worker/test/workspace-export.test.ts`, `apps/worker/test/workspace-purge.test.ts`, `apps/worker/test/keys-rotate.test.ts`
- Modify: `packages/queue/src/names.ts` (`workspaceExport: 'workspace.export'`, `workspacePurge: 'workspace.purge'`, `keysRotate: 'keys.rotate'`), `packages/queue/src/queue-options.ts` (three rows: export `short`/1800 s/retry 1; purge `short`/600 s/retry 2 backoff; rotate `standard`/60 s/retry 3 backoff), `apps/worker/src/index.ts` (pre-create three; crons under `cron`; jobs under `knowledge` (export, purge) and `sync` (rotate, ring-gated)), `apps/api/src/boss.ts` (pre-create three), `apps/worker/test/queue-preflight.test.ts` (both `it.each` lists), `apps/worker/src/knowledge-role.ts` (registers export + purge with the store), `apps/worker/package.json` (`"keys:rotate": "tsx scripts/keys-rotate.ts"`), `packages/knowledge/src/storage/{types,s3,memory}.ts` (`put(key, bytes, contentType)` and `presignGet(key, { expiresSeconds })` added to the port and both adapters + their tests), `packages/knowledge/src/index.ts`

**Interfaces:**
- Consumes: Task 3's `purgeWorkspace`, `purgeAuthRows`, `rewrapOrgDek`; `KekRing`; `ObjectStore`; `withPlatform`/`withOrgIdentity`; `escalation`-style notification inserts.
- Produces:

```ts
// retention-sweep.ts
export const LLM_CALLS_RETENTION_DAYS = 400
export const NOTIFICATION_RETENTION_DAYS = 90
export const AUDIT_RETENTION_DAYS = 730
export const RETENTION_ORGS_PER_RUN = 500
export const RETENTION_BATCH = 5_000
export async function runRetentionSweep(deps: { db: Db; logger: pino.Logger; now?: () => Date }): Promise<{ orgs: number; messagesPurged: number; draftsPurged: number; llmCallsDeleted: number; notificationsDeleted: number; auditDeleted: number }>
export async function registerRetentionSweep(boss, deps): Promise<void>   // '45 3 * * *', singleton, expire 1800
// workspace-export.ts
export const WorkspaceExportPayload = z.object({ orgId: z.string(), exportId: z.string() })
export const EXPORT_MAX_BYTES = 200 * 1024 * 1024
export async function runWorkspaceExport(deps: { db: Db; store: ObjectStore; logger: pino.Logger; enqueueNotify; now? }, payload, signal): Promise<'ready' | 'failed' | 'skipped'>
// workspace-purge.ts
export const WorkspacePurgePayload = z.object({ orgId: z.string() })
export async function runWorkspacePurge(deps: { db: Db; store: ObjectStore; logger: pino.Logger; now? }, payload, signal): Promise<'purged' | 'skipped'>
export async function runWorkspacePurgeSweep(boss, deps: { db: Db; logger: pino.Logger; now? }): Promise<{ enqueued: number }>   // cron '15 4 * * *'
// keys-rotate.ts
export const KeysRotatePayload = z.object({ orgId: z.string() })
export async function runKeysRotate(deps: { db: Db; ring: KekRing; logger: pino.Logger }, payload): Promise<'rewrapped' | 'current' | 'lost_race'>
```

- [ ] **Step 1: Failing tests**

`retention-sweep.test.ts`: org A `retention_days 180`, org B `retention_days 30`; seed messages in each aged 200, 100 and 10 days with bodies, subjects and attachments metadata; seed drafts (`sent`, `rejected`, `pending`) aged 200 days; run → A: the 200-day message's `body_text IS NULL`, `body_purged_at` set, subject and attachments untouched; the 100-day one intact; B: the 200- and 100-day ones purged, the 10-day intact; the 200-day `sent`/`rejected` drafts have `body = ''`, `final_body NULL`, `rationale NULL`, `body_purged_at` set; the `pending` one untouched (only terminal statuses purge); ONE audit row per org per arm (`retention.purged { arm: 'messages', count }`); a second run purges nothing more (the partial index predicate). Platform arms: an `llm_calls` row 401 days old gone, 399 kept; a `notifications` row 91 days old gone; a tenant `audit_log` row 731 days old gone, 729 kept. Batching: seed 6_000 purgeable messages → all purged across batches of `RETENTION_BATCH` inside one run.

`workspace-export.test.ts` (in-memory store): seed an org with every table the bundle lists; run → the object at `orgs/<org>/exports/<exportId>.ndjson` exists; parse it: first line `{ "kind": "manifest", "orgId", "exportedAt", "tables": [...] }`, then one `{ "kind": "<table>", "row": {...} }` per row; assert `messages` rows carry `bodyText` and `resolved_answers` rows carry the scrubbed texts, and NO line carries `key_ciphertext`, `refresh_token_ciphertext`, `wrapped_dek`, `box_private_key_ciphertext`, `customer_hash_salt` or `pkce_ciphertext` (grep the whole bundle for those keys); `workspaces.export_state 'ready'`, `export_key`, `export_ready_at`; one `workspace` notification `export_ready`; a second run with the same `exportId` → `skipped` (guarded on `export_state = 'queued'`); a bundle over `EXPORT_MAX_BYTES` (seed a 3 MB body × 80) → `failed`, `export_state 'failed'`, the partial object deleted, a `workspace` notification `export_failed`.

`workspace-purge.test.ts`: org A `deletion_requested_at` 31 days ago, org B 29 days ago, org C never; `runWorkspacePurgeSweep` enqueues exactly one `workspace.purge` (A) — assert through `queryJobs`; `runWorkspacePurge(A)`: the org's knowledge objects (`storage_key`s) and export object are deleted from the store; every tenant table has zero rows for A (iterate `PURGE_ORDER`); A's `organization`/`member`/`invitation` rows gone; a session that pointed at A has `active_organization_id NULL`; B and C intact; a second `runWorkspacePurge(A)` → `skipped` (no workspace row); an org whose `deletion_requested_at` was cleared between enqueue and run → `skipped`, nothing deleted (the job re-reads the stamp under the platform tx before anything).

`keys-rotate.test.ts`: ring v1 only → provision; ring `{ active: 2, keys: {1,2} }` → `runKeysRotate` → `rewrapped`, and a mailbox credential + a BYOK secret written under the DEK BEFORE the rotate still open (`loadOrgDek` + `decrypt`) with the new ring; with a ring lacking v1 → the job throws (cannot unwrap) and the row is untouched; the script `scripts/keys-rotate.ts` — test its exported `selectOrgsNeedingRotate(db, ring)` returns the orgs whose current `kek_version ≠ ring.active`.

Run: `pnpm --filter @aesa/worker test test/retention-sweep.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`retention-sweep.ts`: platform-wide arms first (`llm_calls`, `notifications`, `audit_log` with `org_id IS NOT NULL` — the platform rows are `sweeps.daily`'s), each a batched `DELETE … WHERE id IN (SELECT id … LIMIT RETENTION_BATCH)` loop; then the per-org loop in the `stats-rollup` idiom over `workspaces` (`org_id, retention_days`), per org: `UPDATE messages SET body_text = NULL, body_purged_at = now WHERE org_id = $ AND body_purged_at IS NULL AND created_at < now − retention_days` in `RETENTION_BATCH` slices via `id IN (SELECT …)`, the same for drafts with `status IN ('sent','rejected','expired','superseded','failed')` (`body = ''`, `final_body = NULL`, `rationale = NULL`), one audit row per org per arm through a copy of `auditMemoryArm`. `escalation`s untouched.

`workspace-export.ts`: the api (Task 8) mints `exportId` and writes `export_state = 'queued'`, `export_key = orgs/<org>/exports/<exportId>.ndjson`, `export_requested_at` in one transaction; the job's first read proceeds only when the row says `queued` AND `export_key` ends with `<exportId>.ndjson` (anything else → `skipped`), and its landing write is guarded on `export_state = 'queued'`. Stream: build the NDJSON in memory per table in pages of 1_000 rows (`withOrg` per page — no network inside), append to a `Buffer[]`, abort at `EXPORT_MAX_BYTES`; `store.put(key, bytes, 'application/x-ndjson')` OUTSIDE any transaction; then `UPDATE … SET export_state = 'ready', export_ready_at WHERE export_state = 'queued'` + audit `workspace.exported { bytes, rows }` + the `workspace` notification (`title: 'Your export is ready'`, `body: 'Download it from Settings → Workspace within 7 days.'`, `dedupeKey: workspace:export:${exportId}`, `payload: { kind: 'export_ready' }`). Tables in the bundle, in this order: `workspaces` (profile columns only — never `box_public_key`/`customer_hash_salt`), `org_settings`, `billing_subscriptions` (no Stripe ids? — include them; they are the owner's), `agents` (no `consent_required_from_user_id`), `categories`, `agent_category_policies`, `agent_model_config`, `llm_credentials` (metadata only, never the secret table), `mailbox_connections` (`provider`, `email_address`, `status` only), `tickets`, `messages`, `drafts` (decided ones: `decided_at IS NOT NULL`), `resolved_answers`, `guidance_suggestions`, `knowledge_sources` (metadata + `pasted_text` + `url`; uploads listed by `title`/`mime`/`byte_size`), `category_stats_daily`, `usage_counters`, `audit_log` (`org_id = $`). Column allowlists per table are explicit arrays in the file, and the test greps the bundle for the forbidden keys.

`workspace-purge.ts`: `runWorkspacePurge`: `withPlatform` tx 1 — re-read `workspaces.deletion_requested_at`; missing row → `skipped`; NULL or `+ 30 days > now` → `skipped` with a warn; collect `knowledge_sources.storage_key`s and `export_key`; commit. Store deletes OUTSIDE a transaction (best-effort; a failing delete logs and continues — objects are re-swept by no one, so log the keys at error level for the runbook). tx 2 (`withPlatform(db, 'job:workspace.purge')`): `purgeWorkspace(tx, orgId)` then `purgeAuthRows(tx, orgId)`, and one platform audit row (`org_id NULL`, `action 'workspace.purged'`, `entity_id orgId`, `detail: { rows }`) — the tenant trail is gone by design, the platform keeps the fact. `runWorkspacePurgeSweep`: `withPlatform` select `org_id FROM workspaces WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at + interval '30 days' <= now` → `enqueue(boss, workspacePurgeJob, { orgId }, { entityId: orgId })`.

`keys-rotate.ts`: `withOrg(db, orgId, tx => rewrapOrgDek(tx, deps.ring))` + audit `keys.rotated { from, to }` on `rewrapped`; `lost_race` logs and returns (the sweep script re-selects it). `scripts/keys-rotate.ts`: `loadDotEnv`, `loadConfig` (throws without a ring), `createDb`, a send-only boss (`startBoss`), `selectOrgsNeedingRotate` (`withPlatform`: `SELECT DISTINCT ON (org_id) org_id, kek_version FROM org_data_keys ORDER BY org_id, version DESC` filtered `kek_version <> ring.active`), enqueue one job per org, print the count, exit.

Register: `index.ts` pre-creates the three queues; under `cron`: `registerRetentionSweep`, `registerWorkspacePurgeSweep`; under `sync` (inside the ring gate): `registerKeysRotate`; `knowledge-role.ts` registers `workspace.export` and `workspace.purge` with `createKnowledgeStore(config, logger)`. `boss.ts` pre-creates the three; `queue-preflight.test.ts` lists them (export and purge in the `short` list too).

- [ ] **Step 3: Run, gate, commit**

```bash
pnpm --filter @aesa/knowledge test && pnpm --filter @aesa/worker test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(worker): retention.sweep (bodies by retention_days, drafts, llm_calls, notifications, audit); workspace.export (NDJSON bundle to the store); workspace.purge + purge-sweep (every tenant table, then the auth rows); keys.rotate and its enqueue script; the three queues in four places

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Worker — the knowledge carries (`knowledge.stuck-sweep`, `knowledge.reembed-sweep`) and `memory.capture`'s `messageId` source

**Files:**
- Create: `apps/worker/src/jobs/knowledge-stuck-sweep.ts`, `apps/worker/src/jobs/knowledge-reembed-sweep.ts`, `apps/worker/test/knowledge-stuck-sweep.test.ts`, `apps/worker/test/knowledge-reembed-sweep.test.ts`
- Modify: `apps/worker/src/jobs/memory-capture.ts`, `apps/worker/src/knowledge-role.ts` (registers both crons — they need the embedder and the store, which live on this role), `apps/worker/test/memory-capture.test.ts`, `packages/knowledge/src/retrieval/*` only if the answers leg needs a column it lacks (it does not — `source_message_id` is provenance)

**Interfaces:**
- Consumes: `guardedSourceWrite`, `failSource`, `CRAWL_LEASE_SECONDS`, `enqueueKnowledgeIngest`/`enqueueKnowledgeCrawl`/`enqueueKnowledgeEmbedBatch` (verify the exported enqueue names in each job file), `KnowledgeDeps` (embedder with `.model`/`.version`), `scrubForMemory`, `customerHash`/`ensureCustomerHashSalt`, `KNOWLEDGE_METERS.embedTokens` + its cap.
- Produces:

```ts
// knowledge-stuck-sweep.ts — cron '*/5 * * * *', knowledge role, singleton
export const STUCK_LEASE_SECONDS = 600              // 2 × CRAWL_LEASE_SECONDS; ingest has no lease of its own, this is it
export const STUCK_MAX_ATTEMPTS = 3
export const QUEUED_STALE_MINUTES = 10
export const UPLOAD_ABANDON_HOURS = 24
export async function runKnowledgeStuckSweep(boss, deps: { db: Db; store: ObjectStore; logger; now? }): Promise<{ requeued: number; failed: number; abandoned: number }>
// knowledge-reembed-sweep.ts — cron '*/10 * * * *', knowledge role, singleton
export const REEMBED_DOCS_PER_RUN = 20
export const REEMBED_ANSWERS_PER_RUN = 128
export async function runKnowledgeReembedSweep(boss, deps: KnowledgeDeps & { logger; now? }): Promise<{ documentsQueued: number; answersReembedded: number; skippedCap: number }>
// memory-capture.ts
export const MemoryCapturePayload = z.object({ orgId: z.string(), draftId: z.string().optional(), messageId: z.string().optional() }).refine((p) => (p.draftId ? 1 : 0) + (p.messageId ? 1 : 0) === 1, 'exactly one of draftId or messageId')
export async function enqueueMemoryCapture(boss, orgId, draftId): Promise<void>         // unchanged
export async function enqueueMemoryRemember(boss, orgId, messageId): Promise<void>      // entityId = messageId
```

- [ ] **Step 1: Failing tests**

`knowledge-stuck-sweep.test.ts`: (a) a `processing` crawl source with `updated_at` 11 minutes ago and `sweep_attempts 0` → status `queued`, `claim_token NULL`, `sweep_attempts 1`, a `knowledge.crawl` job enqueued (assert via `queryJobs`); (b) a `processing` upload source 11 minutes old → `queued` + `knowledge.ingest` enqueued; (c) `sweep_attempts 3` and stale again → `failed` with reason `stuck` (through `failSource`, audit `knowledge.source.failed`); (d) a `processing` source updated 4 minutes ago → untouched; (e) a `queued` paste source created 11 minutes ago with no job → re-enqueued (the claim token dedupes a duplicate — assert one `processing` after the ingest runs once); (f) a `queued` upload created 25 hours ago whose object is missing (`store.head` → null) → `failed` reason `abandoned`; one created 2 hours ago → untouched; (g) audit: one `knowledge.source.requeued` per requeue.

`knowledge-reembed-sweep.test.ts` (hash embedder with `model = 'hash-v2'` while chunks were written as `'hash-v1'`): three documents with 2 chunks each embedded under v1, one document under v2 → run → the v1 chunks have `embedding NULL` and `embedding_model NULL` (one guarded `UPDATE … WHERE document_id AND embedding_model = 'hash-v1'` per document), `knowledge_documents.embedded_count` reset to the count of remaining v2 chunks, three `knowledge.embed-batch` jobs enqueued, the v2 document untouched; `knowledge_version` NOT bumped (the retrievable set is unchanged — the lexical leg still serves those chunks); after `runKnowledgeEmbedBatch` runs on one, its chunks read `hash-v2`. Answers: two `resolved_answers` under v1, one under v2 → the v1 pair re-embedded in place (`question_embedding`, `embedding_model 'hash-v2'`), `embed_tokens` metered, and with the org at its embed cap → `skippedCap` and nothing written. `REEMBED_DOCS_PER_RUN` bounds one run.

`memory-capture.test.ts` gains: `{ messageId }` on an outbound message whose ticket has an earlier inbound → an `active` answer with `approvals 1`, `was_edited false`, `source_message_id`, `source_ticket_id`, `source_draft_id NULL`, scrubbed texts, the customer hash; a second run with the same message → `skipped` (the partial unique index; the job checks first and audits `memory.skipped { reason: 'already_remembered' }`); an outbound message with no inbound before it → `skipped` (`no_question`); the payload refine rejects both-or-neither ids.

Run → FAIL.

- [ ] **Step 2: Implement** the two sweeps in the `stats-rollup` per-org idiom over `knowledge_sources` grouped by org (`selectDistinct org_id … LIMIT 500`), each source in its own SAVEPOINT; the stuck arm's requeue is `guardedSourceWrite(tx, id, ['processing'], { status: 'queued', claimToken: null, sweepAttempts: sql\`sweep_attempts + 1\` }, undefined, sql\`updated_at < now() - make_interval(secs => ${STUCK_LEASE_SECONDS})\`)` + audit + the enqueue AFTER the commit (through `boss` — `enqueue` collapses nothing here because the earlier job is `active`/`retry`/gone, and the claim token makes a duplicate harmless). The reembed sweep: per document `withOrg` → the guarded NULLing UPDATE → `enqueueKnowledgeEmbedBatch`; answers: read ≤128 v1 rows, `embedder.embed` OUTSIDE the tx, then a per-row guarded UPDATE (`WHERE id AND embedding_model = <old>`) + `bumpMeter(embedTokens)`, cap-checked first exactly as `memory-capture.ts:66-68` does. `memory-capture.ts`: a second `load` path for `messageId` (the outbound message → its ticket → the latest inbound with `sent_at < message.sent_at`), the same scrub/embed/insert path with `status 'active'`, `approvals 1`, `sourceMessageId`; register `enqueueMemoryRemember`.

- [ ] **Step 3: Run, gate, commit**

```bash
pnpm --filter @aesa/worker test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(worker): knowledge.stuck-sweep (requeue, then fail at three; abandoned uploads), knowledge.reembed-sweep (chunks and answers onto the configured model), memory.capture's messageId source for Remember this reply

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 8: api — the workspace lifecycle (`setKillSwitch`, `setRetentionDays`, `requestDeletion`, `cancelDeletion`, `requestExport`, `exportStatus`) and `memory.rememberReply`

**Files:**
- Create: `apps/api/src/workspace/lifecycle.ts` (exported as `@aesa/api/workspace`), `apps/api/test/workspace-lifecycle.test.ts`
- Modify: `apps/api/package.json` (`"./workspace": "./src/workspace/lifecycle.ts"`), `apps/api/src/trpc/routers/workspace.ts` (six procedures; `WorkspaceView` gains `killSwitch`, `retentionDays`, `deletionRequestedAt`, `purgeAfter`, `exportState`, `exportReadyAt`), `apps/api/src/memory/service.ts` (`rememberReply`), `apps/api/src/trpc/routers/memory.ts` (`rememberReply: managerProcedure.input(RememberReplyInput)`), `apps/api/src/review/pages.ts` (no change — the `kill_switch` result page already exists), `apps/api/test/workspace.test.ts`, `apps/api/test/memory-router.test.ts`, `apps/api/test/error-surface.test.ts` (`./src/workspace/lifecycle.ts` joins the entry points)

**Interfaces:**
- Consumes: Task 4's `StripePort.cancelSubscription`, `BillingServiceDeps`; Task 3's `workspaces` columns; `ObjectStore.presignGet` (Task 6); `JOB_NAMES.workspaceExport`, `enqueueMemoryRemember`'s payload shape (`{ orgId, messageId }` on `JOB_NAMES.memoryCapture`).
- Produces:

```ts
export interface LifecycleDeps { api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger; stripe: StripePort | null; store: ObjectStore; now?: () => Date }
export async function setKillSwitch(deps, orgId, on: boolean, actor): Promise<{ killSwitch: boolean }>
export async function setRetentionDays(deps, orgId, days: number, actor): Promise<{ retentionDays: number }>
export async function requestDeletion(deps, orgId, confirm: string, actor): Promise<{ ok: true; purgeAfter: Date } | { ok: false; code: 'confirm_mismatch' | 'deletion_pending' | 'billing_cancel_failed' }>
export async function cancelDeletion(deps, orgId, actor): Promise<{ ok: true } | { ok: false; code: 'not_pending' }>
export async function requestExport(deps, orgId, actor): Promise<{ ok: true; exportId: string } | { ok: false; code: 'export_in_progress' }>
export async function exportStatus(deps, orgId): Promise<{ state: ExportState; readyAt: Date | null; url: string | null }>   // presignGet 7 days when ready
// memory/service.ts
export async function rememberReply(deps: MemoryServiceDeps, orgId, messageId, actor): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'not_outbound' | 'empty' | 'already_remembered' }>
```

- [ ] **Step 1: Failing tests**

`workspace-lifecycle.test.ts`: `setKillSwitch(true)` writes the column + audits `workspace.kill_switch_on`; `workspace.get` now returns `killSwitch true`; a member (not owner) over tRPC → `FORBIDDEN` (`ownerProcedure`); `setRetentionDays(29)` → `BAD_REQUEST` at the input; `(90)` writes and audits. `requestDeletion('wrong name')` → `confirm_mismatch`, nothing written; the right name on a workspace with an active Stripe subscription → the fake's `cancelSubscription` called ONCE, BEFORE the write, then `deletion_requested_at`, `deletion_requested_by`, `kill_switch true`, `agent_enabled false`, audit `workspace.deletion_requested`, a `workspace` notification `deletion_scheduled` (`dedupe workspace:deletion:${orgId}`), `purgeAfter = now + 30 days`; the fake throwing → `billing_cancel_failed`, nothing written; a second request → `deletion_pending`. `cancelDeletion` clears the stamps, audits, leaves `agent_enabled false` and `kill_switch true` (the owner flips them back deliberately); on a workspace not pending → `not_pending`. `requestExport` → `export_state 'queued'`, `export_key = orgs/<org>/exports/<exportId>.ndjson`, `export_requested_at`, `workspace.export` enqueued with `{ orgId, exportId }` (`entityId: exportId`); while `queued` → `export_in_progress`; `exportStatus` → `{ state: 'queued', url: null }`; after the row reads `ready` (set by the test) → a presigned URL from the store for `export_key`.

`memory-router.test.ts` gains `rememberReply`: an outbound message → `{ ok: true }` and `memory.capture` enqueued with `{ orgId, messageId }`; an inbound message → `not_outbound` → the router's `PRECONDITION_FAILED`; a message of another org → `not_found`; a message already carrying a `resolved_answers.source_message_id` → `already_remembered`; an empty body → `empty`; audit `memory.remember_requested`.

- [ ] **Step 2: Implement** with the service discipline (Stripe cancel BEFORE `withOrg`; `presignGet` is an SDK signature computation, no network — verify in the S3 adapter; if it performs a request, do it after the read). `WorkspaceView` widened in `toWorkspaceView` (the header comment loses "never the kill switch internals" — the switch is now the owner's to see). Router: `setKillSwitch: ownerProcedure.input(SetKillSwitchInput)`, `setRetentionDays: ownerProcedure.input(SetRetentionDaysInput)`, `requestDeletion: ownerProcedure.input(RequestDeletionInput)` (codes → `BAD_REQUEST` for `confirm_mismatch`, `PRECONDITION_FAILED` for `deletion_pending`, `BAD_GATEWAY` for `billing_cancel_failed`, messages from `WORKSPACE_ERROR_MESSAGES`), `cancelDeletion: ownerProcedure`, `requestExport: ownerProcedure`, `exportStatus: orgProcedure.query`.

- [ ] **Step 3: Run, gate, commit**

```bash
pnpm --filter @aesa/api test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(api): workspace lifecycle — kill switch, retention, delete with a 30-day grace (Stripe cancelled first), export; memory.rememberReply

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: app — Settings → Billing (route 26), the billing banner, the Workspace danger zone, "Remember this reply", push routing

**Files:**
- Create: `apps/app/src/app/(app)/settings/billing.tsx` (`export { BillingSettingsScreen as default } from '@/screens/settings/billing'`), `apps/app/src/screens/settings/billing.tsx`, `apps/app/src/screens/settings/billing.test.tsx`, `apps/app/src/screens/inbox/billing-banner.tsx`, `apps/app/src/screens/inbox/billing-banner.test.tsx`, `apps/app/src/screens/settings/danger-zone.tsx`, `apps/app/src/screens/settings/danger-zone.test.tsx`, `apps/app/src/screens/inbox/message-bubble.tsx`, `apps/app/src/lib/open-external.ts` (the popup-before-await helper lifted from `connect-card.tsx`)
- Modify: `apps/app/src/app/(app)/settings/_layout.tsx` (`<Stack.Screen name="billing" options={{ title: 'Billing' }} />`), `apps/app/src/screens/settings/index.tsx` (the Billing row goes live; `<BillingBanner />` at the top), `apps/app/src/screens/settings/workspace.tsx` (`<DangerZone />` below the profile form; members see the readonly note like `ai.tsx`), `apps/app/src/screens/inbox/inbox.tsx` (`<BillingBanner />` beside `<AgentOffBanner />`), `apps/app/src/screens/inbox/ticket.tsx` (messages render through `MessageBubble`; the `memory.rememberReply` mutation into the shared `note`), `apps/app/src/screens/settings/connect-card.tsx` (uses `openExternal`), `apps/app/src/lib/push-routing.ts` (`billing` → `/settings/billing`, `workspace` → `/settings/workspace`), `apps/app/src/lib/push-routing.test.ts`, `apps/app/src/screens/settings/index.test.tsx`, `apps/app/src/screens/inbox/ticket.test.tsx`

**Interfaces:**
- Consumes: `trpc.billing.get/startCheckout/openPortal/setOverageMode`, `trpc.workspace.get/setKillSwitch/setRetentionDays/requestDeletion/cancelDeletion/requestExport/exportStatus`, `trpc.memory.rememberReply`; `BILLING_PRICING`, `BILLING_ERROR_MESSAGES`, `WORKSPACE_ERROR_MESSAGES`, `canManageWorkspace`; the primitives: `Screen { children; testID? }`, `Card { children; testID? }`, `Banner { tone?: 'info'|'error'|'success'|'warning'; children: string; testID? }`, `Button { label; onPress; variant?: 'primary'|'secondary'|'danger'; loading?; disabled?; testID? }`, `ListRow { title; subtitle?; badge?; onPress?; testID? }`, `SwitchRow { label; value; onValueChange; disabled?; hint?; testID? }`, `Chip { tone?; children: string; testID? }`, `TextField extends TextInputProps { label; error?; hint? }`, `StatTile { label; value; subtitle?; testID? }`, `Loading`.
- Produces: `openExternal(start: () => Promise<{ url: string }>, opts: { onBlocked: (msg: string) => void }): Promise<void>` — on web opens the popup SYNCHRONOUSLY before awaiting `start()` then points it at the url (the `connect-card.tsx:105-117,145` shape); native `WebBrowser.openBrowserAsync(url)`. `BillingBanner` (renders null unless the state warrants one). `DangerZone` (owner-only controls; readonly lines otherwise). `MessageBubble { message; outbound; onRemember?: () => void; remembering?: boolean }`.

- [ ] **Step 1: Failing tests** (the `ai.test.tsx` harness: `notifyManager.setScheduler`, a fresh `QueryClient`, `jest.mock('@/lib/trpc', …)` with `mock`-prefixed closures, `jest.mock('expo-router', …)`)

`billing.test.tsx`: trial state → chip "Trial" + "ends in 9 days", the usage tile "12 of 50 conversations this month", a "Subscribe" button for the owner that calls `startCheckout` and hands the url to `openExternal` (mock `@/lib/open-external`), no button for a member (`billing-readonly` note); `configured: false` → the Subscribe button replaced by "Billing is not set up on this server yet."; active state → "Standard · 2 domains", "$99.98 / month", "301 of 600 · 1 extra at $0.12", a "Manage billing" button → `openPortal`; the overage-mode radio (`automatic`/`blocked`) calls `setOverageMode` for the owner, is disabled while pending, and hidden for a member; `past_due` → the error banner and Manage billing; the api's `PRECONDITION_FAILED` message renders via `BILLING_ERROR_MESSAGES` (never raw); `checkout=success` in the route params → `invalidateQueries(billing.get)` and a success banner "Thanks — your subscription is active." (or "Stripe is confirming your payment…" while the state is still trialing).

`billing-banner.test.tsx`: null on `trialing` with 10 days left; `warning` "Your trial ends in 3 days — subscribe to keep Autopilot." at ≤ 3 days with a Subscribe button for the owner; `error` "Your trial has ended — replies wait for your review until you subscribe." on `trial_expired`; `error` "Payment failed — Autopilot is paused until the card is updated." on `past_due` with Manage billing; `error` "This workspace will be deleted on <date>. Turn this off in Settings → Workspace." when `deletionRequestedAt` is set (from `workspace.get`) — deletion outranks billing when both apply; `canceled` → the trial-ended copy with "Subscribe". Copy lives in `BILLING_BANNER_COPY` in the component file (owner-facing prose, not a contract) — one string per state.

`danger-zone.test.tsx`: the kill-switch `SwitchRow` (hint "Stops every send instantly, including replies you already approved. Drafts keep coming.") calls `setKillSwitch({ on })` and is disabled while pending; retention `TextField` (numeric, 30–730) + Save calls `setRetentionDays`; Export → `requestExport`, then the status line ("Preparing…" / "Ready — Download" → `exportStatus.url` through `openExternal` / "Failed — try again"); Delete: pressing "Delete workspace" reveals a `TextField` "Type the workspace name" + a `danger` Confirm that stays disabled until the text equals `businessName`, calls `requestDeletion({ confirm })`, then the zone shows "Deletion scheduled for <date>" with "Cancel deletion" → `cancelDeletion`; a member sees only a `Muted` line "Only the workspace owner can change these."; `WORKSPACE_ERROR_MESSAGES.billing_cancel_failed` renders on that code.

`ticket.test.tsx` gains: an outbound bubble shows "Remember this reply"; pressing calls `memory.rememberReply({ messageId })` once (pending guard), the note reads "Saved — the agent can reuse this answer." (`info`); `PRECONDITION_FAILED` ("already remembered") → the note in `error` tone with the server message; inbound bubbles show no button.

`push-routing.test.ts` gains the two kinds. `settings/index.test.tsx`: the Billing row pushes `/settings/billing`.

Run: `pnpm --filter @aesa/app test` → FAIL.

- [ ] **Step 2: Implement.** `billing.tsx` mirrors `ai.tsx` (`useQuery(trpc.billing.get.queryOptions())` + `trpc.workspace.get` for the role; `formatUsd`-style money from cents — add `formatCents(cents)` beside `formatUsd` in `activity.tsx` and import it; a `useLocalSearchParams()` read of `checkout`). `BillingBanner` copies `agent-off-banner.tsx` and reads BOTH `workspace.get` (for `deletionRequestedAt`, `role`) and `billing.get`. `DangerZone` follows `ai.tsx`'s two-press confirm + Cancel and its `gcTime: 0` on the mutation that carries the typed name. `MessageBubble` extracts `ticket.tsx:323-341` unchanged plus the button under the text for `outbound && message.bodyText`. No `fontWeight`, no literal colours; every string through `@aesa/contracts` where the api produced it.

- [ ] **Step 3: Export, gate, commit**

```bash
EXPO_PUBLIC_API_URL=http://localhost:3001 pnpm --filter @aesa/app export:web 2>&1 | tail -30   # expect 26 routes
pnpm --filter @aesa/app test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(app): Settings → Billing (route 26), the billing banner, the Workspace danger zone (kill switch, retention, export, delete), Remember this reply, push routing for billing and workspace

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: app — native share-sheet intake (`expo-share-intent`, route 27)

**Files:**
- Create: `apps/app/src/app/share.tsx` (`export { ShareScreen as default } from '@/screens/share'`), `apps/app/src/screens/share.tsx`, `apps/app/src/screens/share.test.tsx`, `apps/app/src/lib/share-routing.ts`, `apps/app/src/lib/share-routing.test.ts`, `apps/app/src/lib/share-intent.ts` (a thin wrapper: `useShareIntentSafe()` returns the context on native and `{ hasShareIntent: false, shareIntent: null, resetShareIntent() {} }` on web — so no test or web bundle touches the native module)
- Modify: `apps/app/package.json` (`expo-share-intent@8.0.1` exact), `apps/app/app.json` (the plugin with `iosActivationRules { NSExtensionActivationSupportsWebURLWithMaxCount: 1, NSExtensionActivationSupportsWebPageWithMaxCount: 1, NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsFileWithMaxCount: 1 }` and `androidIntentFilters ["text/*", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/markdown", "text/plain"]`), `apps/app/src/app-config.test.ts` (asserts the plugin and its options), `apps/app/src/app/_layout.tsx` (`<ShareIntentProvider>` outermost on native), `apps/app/src/app/(app)/_layout.tsx` (`useShareIntentRouting()` beside `usePushRouting()` in `Shell`), `apps/app/src/screens/knowledge/source-cards.tsx` (exports `defaultMaxPages` if not already; the share screen reuses `useUpload`, `StartCrawlInput`, `PasteInput`), `apps/app/jest.config.*` (`transformIgnorePatterns` for the new module if jest-expo does not already cover `expo-*`; `moduleNameMapper` to `src/test-utils/share-intent-mock.ts`)

**Interfaces:**
- Produces: `pathForShareIntent(intent: ShareIntentLike | null): '/share' | null` (pure: any intent with a `webUrl`, non-empty `text` or ≥ 1 file → `/share`); `useShareIntentRouting()` — on `hasShareIntent`, cold start → `setNextPath('/share')` + the existing bump, warm → `router.push('/share')` (the `usePushRouting` split at `push-routing.ts:83-113`); `ShareScreen`: reads the intent, renders one of three cards — **Link** (URL prefilled, page-cap radios via `defaultMaxPages`, "Crawl this site" → `knowledge.startCrawl`), **Text** (a required Title field, the text in a bounded preview, "Add as a note" → `knowledge.paste`), **File** (name/size, "Upload" → `useUpload().start([{ name: fileName, mime: mimeType, size, uri: path }])`) — then `resetShareIntent()` and `router.replace('/settings/knowledge')` with a success banner; "Not now" resets and goes to `/inbox`. Signed-out or no workspace → the gate redirects as it does for every `(app)` route (the route sits OUTSIDE `(app)`, like `create-workspace.tsx`, so it must run `useGate()` itself and redirect on anything but `app`); on web → a `Screen` with one `Banner`: "Sharing into aesa works from the iOS and Android apps."

- [ ] **Step 1: Failing tests** — `share-routing.test.ts` (the pure mapper: null, empty, url, text, files); `share.test.tsx` with `@/lib/share-intent` mocked: a URL intent renders the Link card and `startCrawl({ url, maxPages })` on press, then `resetShareIntent` and `replace('/settings/knowledge')`; a text intent needs a title (button disabled until typed) then `paste({ title, text })`; a file intent calls the mocked `useUpload().start` with the `PickedFile` shape; the `FORBIDDEN` cap error renders the shared cap banner (copy from `source-cards.tsx`); "Not now" resets and goes to `/inbox`; `Platform.OS === 'web'` renders the one-line banner and touches no hook. `app-config.test.ts` asserts the plugin entry.

- [ ] **Step 2: Implement.** `useShareIntentSafe` guards `Platform.OS === 'web'` and wraps `useShareIntentContext()`; `ShareIntentProvider` wraps the root layout's providers on native only (a `Platform.select`). Run `npx expo prebuild --platform ios --no-install` ONCE in a scratch copy to confirm the plugin generates the share extension without error (do not commit the native folders — the repo has none), and record in the task's commit message that the intake needs an EAS/dev build.

- [ ] **Step 3: Export, gate, commit**

```bash
EXPO_PUBLIC_API_URL=http://localhost:3001 pnpm --filter @aesa/app export:web 2>&1 | tail -30   # expect 27 routes
pnpm --filter @aesa/app test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(app): native share-sheet intake — expo-share-intent, the /share route (27): a link crawls, text pastes, a file uploads

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 11: Observability — Sentry with org attribution in both apps, the job observer, the named alerts; `scripts/smoke-tenant.ts`

**Files:**
- Create: `apps/api/src/observability.ts`, `apps/worker/src/observability.ts`, `packages/queue/src/observe.ts`, `scripts/smoke-tenant.ts`, `apps/api/test/observability.test.ts`, `apps/worker/test/observability.test.ts`, `packages/queue/test/observe.test.ts`
- Modify: `apps/api/package.json` + `apps/worker/package.json` (`@sentry/node@10.74.0` exact), `package.json` (root devDependencies `@trpc/client`, `superjson`, `@aesa/api: workspace:*` for the type; script `"smoke:tenant": "tsx scripts/smoke-tenant.ts"`), `packages/queue/src/define-job.ts` (the catch calls the observer before rethrowing), `packages/queue/src/index.ts`, `apps/api/src/index.ts` (`initObservability(config)` FIRST, after `loadConfig`), `apps/api/src/server.ts` (`setupFastifyErrorHandler(app)` when initialised; the tRPC `onError` captures 500s with `orgId`/`path` tags), `apps/worker/src/index.ts` (`initObservability(config)`; `setJobObserver(…)`), every `logger.error({ alert: true })` placeholder from Tasks 4–7 → `alert(...)`, `apps/api/test/error-surface.test.ts` (the `undici` rule gains: a parent under `node_modules/@sentry/` or `node_modules/@opentelemetry/` is allowed — Sentry instruments the global fetch and never fetches a customer URL; state the rationale in the test)

**Interfaces:**
- Produces:

```ts
// packages/queue/src/observe.ts — no Sentry here; the worker wires it
export interface JobObserver { onFailure(err: unknown, ctx: { name: string; jobId: string; orgId: string | null }): void }
export function setJobObserver(observer: JobObserver | null): void
export function notifyJobFailure(err: unknown, ctx): void   // called from registerJob's catch, never throws
// apps/{api,worker}/src/observability.ts (the same shape in both)
export function initObservability(config: { sentry: { dsn: Secret; environment: string } | null; release?: string }): boolean   // false = no-op mode
export const ALERT_KINDS = ['platform_killswitch_on', 'admission_slot_timeout', 'stripe_webhook_rejected', 'stripe_unknown_customer', 'stripe_report_failed', 'org_spend_capped', 'keys_rotate_failed', 'purge_failed', 'export_failed'] as const
export function alert(logger: pino.Logger, kind: AlertKind, ctx: { orgId?: string | null } & Record<string, string | number | boolean | null>): void   // pino error line { alert: true, kind, ...ctx } + Sentry.captureMessage(kind, { level: 'error', tags: { org_id, kind } }) when initialised
export function captureWithOrg(err: unknown, ctx: { orgId?: string | null; job?: string; path?: string }): void   // withIsolationScope + setTag('org_id') + captureException; a no-op when not initialised
```

`beforeSend` in `initObservability` deletes `event.request?.data`, every `extra`/`contexts` key named `body`, `bodyText`, `detail`, `payload`, `apiKey`, `key`, `token`, `cookie`, `authorization`, and truncates breadcrumb messages to 200 chars — the PII posture (spec) holds in the error tracker too.

- [ ] **Step 1: Failing tests** — `observe.test.ts`: `registerJob` with a throwing handler calls the observer with `{ name, jobId, orgId }` then still fails the job (the scrubbed error rethrown); no observer → no throw. `apps/*/test/observability.test.ts`: `initObservability({ sentry: null })` returns false and `alert`/`captureWithOrg` are no-ops that still log the pino line (`{ alert: true, kind, orgId }`); with a DSN (`Sentry.init` with `transport` stubbed via `Sentry.init({ transport: () => fakeTransport })` — check the 10.x `NodeOptions.transport` signature) the captured event carries `tags.org_id` and `tags.kind` and NO `request.data`/`extra.body` after `beforeSend`. `error-surface.test.ts` keeps passing (Sentry's graph is walked from `./src/index.ts`? — it walks `router.ts`/`config.ts`/services; `observability.ts` is imported by `index.ts` and `server.ts`; add `['./src/observability.ts', 'initObservability']` to the entry points so the `undici` allowance is exercised).

- [ ] **Step 2: Implement** as specified. The api's tRPC `onError` (`server.ts:179-183`) adds `captureWithOrg(error.cause ?? error, { orgId: (ctx as { orgId?: string })?.orgId ?? null, path })` for `INTERNAL_SERVER_ERROR` only; the Fastify handler through `setupFastifyErrorHandler(app)`. The worker's `setJobObserver({ onFailure: (err, ctx) => captureWithOrg(err, { orgId: ctx.orgId, job: ctx.name }) })`. `SENTRY_DSN`/`SENTRY_ENVIRONMENT` in both configs (Task 4 and Task 5 already read them); `SENTRY_RELEASE` optional (the runbook sets it from the deploy's git SHA).

- [ ] **Step 3: `scripts/smoke-tenant.ts`** — a post-deploy walk, run by hand: env `SMOKE_API_URL`, `SMOKE_WEB_ORIGIN` (sent as the `origin` header — the CSRF hook), `SMOKE_COOKIE` (the full `cookie` header value copied from a signed-in browser session of a throwaway workspace), optional `SMOKE_SANDBOX=1`. Steps, each printed as a row (`ok`/`FAIL` + ms): `GET /healthz` is 200 with `db: 'ok'`; `GET /meta` lists `billing`, `mail`, `providers`; `workspace.get` returns the workspace; `billing.get` returns a state; `agents.list` ≥ 1 agent; `knowledge.list` responds; `memory.summary` responds; with `SMOKE_SANDBOX=1`: `agents.sandboxStart({ agentId: <first>, question: 'What are your opening hours?' })` then poll `agents.sandboxStatus` (verify the procedure names in `routers/agents.ts`) up to 120 s for a terminal state. Exit 1 on any FAIL; never prints the cookie. Built with `createTRPCClient<AppRouter>` + `httpBatchLink` + superjson (the app's `lib/trpc.ts` shape). Not part of CI (it needs a deployed stack); `pnpm smoke:tenant` at the root.

- [ ] **Step 4: Gate and commit**

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(observability): Sentry with org attribution in api and worker, a job observer in @aesa/queue, nine named alerts; scripts/smoke-tenant.ts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The Phase 7 E2E — billing, caps, retention, delete, rotate, remember, the knowledge sweeps

**Files:**
- Create: `apps/worker/test/e2e-phase7.test.ts`, `apps/worker/test/helpers/fake-stripe.ts` (implements BOTH ports — `StripePort` from `@aesa/api/billing` and `StripeUsagePort` from the worker — with a recorded call log and a canned event factory `stripeEvent(type, object, created)`)
- Modify: nothing in `src/` (an E2E that needs a production change stops and reports it, per the Phase 5/6 lesson)

**Harness** (the `e2e-phase6.test.ts` shape, header included): one `createTestDatabase`, one pg-boss on `pgboss_e2e7_<hex>`, `createMockMailbox` through the `clientFactory` seams, a `createFakeProvider` managed provider wrapped in the real metering, the REAL api services (`@aesa/api/billing`'s `startCheckout`/`applyStripeEvent`, `@aesa/api/workspace`'s `requestDeletion`, `@aesa/api/memory`'s `rememberReply`, `@aesa/api/drafts`' `approveDraft`) over `createApiFacade`/`createEnqueue`, the REAL jobs (`ticket.triage`, `ticket.draft`, `send.execute`, `billing.report-usage`, `retention.sweep`, `workspace.purge`, `keys.rotate`, `memory.capture`, `knowledge.stuck-sweep`, `knowledge.reembed-sweep`), a fake clock (`now` injected everywhere; the harness advances it), and `waitFor` polling — no wall-clock sleeps.

- [ ] **Step 1: The scenarios**

1. **Trial clock.** Create a workspace (billing row `trialing`, `trial_ends_at NULL`); enable the agent → `trial_ends_at = now + 14 d`; an inbound → a draft `awaiting_review` (cold start); advance the clock 15 days; an inbound → the draft's `decision_reason 'subscription_inactive'`, the ticket still `awaiting_review` with a draft; `billing.get` reads `trial_expired`.
2. **Checkout → caps rise the same day.** `startCheckout` (fake) → `applyStripeEvent(checkout.session.completed …)` with 2 domains → `plan standard`, `active`; `loadSettingSources` now resolves `knowledge.max_sources` 100 (was 10) — assert through the REAL `@aesa/api/knowledge` paste path: the 11th paste on the trial row was `forbidden_cap`; after the event it is accepted.
3. **Conversation 301.** Two active domains (allowance 600). Drive 600 managed conversations cheaply: seed 600 tickets with `ai_handled_month` unset and bump the managed meter through the REAL `completeSend` path for a handful, then seed the rest of the meter directly (state the shortcut in the test); `runBillingReportUsage` → no call; one more REAL send → 601 → the fake records `reportOverage({ value: 1, identifier: '<org>:<period>:1' })`; `overage_reported 1`; a re-run → no call.
4. **Blocked vs automatic.** Under `blocked` at 600, an auto-eligible draft (the Phase 5 fixture: category `auto`, three learned approvals, evidence ≥ threshold) lands `review/allowance_exhausted`; flip to `automatic` → the next lands `send`, an `outbound_sends` row `queued`, the ticket `auto_sending`.
5. **Unpaid suspends auto-send, not approvals.** `invoice.payment_failed` → `past_due` + the page; a queued auto send → `send.execute` holds it with `subscription_inactive`; the owner approves a review draft → it SENDS (the mock mailbox has the message).
6. **Downgrade.** `customer.subscription.deleted` → `canceled`, `plan trial`; `knowledge.max_sources` back to 10 the same instant; a BYOK agent (a credential seeded through the Phase 6 path) still drafts, still never counts toward the allowance.
7. **Retention.** Messages and drafts older than `retention_days` lose their bodies after `runRetentionSweep`; a direct select of those `messages` rows still returns their subjects and attachment metadata (the ticket list keeps reading).
8. **Delete with grace.** `requestDeletion` → the fake's `cancelSubscription` called, `kill_switch` on, a queued auto send holds with `workspace_kill_switch`; advance 31 days → `runWorkspacePurgeSweep` → the job → zero rows for the org in every `PURGE_ORDER` table, the `organization` row gone, the knowledge object gone from the memory store; the SECOND org in the run is untouched (assert its counts before/after).
9. **Rotate.** Ring v1 → provision, a mailbox credential and a BYOK key stored; ring `{ active: 2 }` → `runKeysRotate` → `send.execute` (which opens the mailbox credential) and `ticket.draft` (which opens the BYOK key) both still succeed.
10. **Remember this reply.** An owner-sent outbound message ingested by the mock → `rememberReply` → `memory.capture` → an `active` answer; the next similar inbound's draft carries the answer id in `used_answer_ids` (the answers leg retrieved it) and `confidence_breakdown.memory > 0`.
11. **Stuck and re-embed.** A crawl left `processing` 11 minutes → requeued once, three times → `failed 'stuck'`; the embedder's model flips → `runKnowledgeReembedSweep` → `runKnowledgeEmbedBatch` → the chunks read the new model and the vector leg retrieves them again.

- [ ] **Step 2: Run, gate, commit**

```bash
pnpm --filter @aesa/worker test test/e2e-phase7.test.ts
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "test(worker): the Phase 7 E2E — trial clock, checkout and caps, conversation 301, blocked vs automatic, past_due, downgrade, retention, delete with grace, rotate, remember, the knowledge sweeps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: The external-setup runbook, the CASA evidence package, store submission, the docs, the whole-branch review record, and the close-out

**Files:**
- Create: `docs/runbooks/2026-09-phase-7-external-setup.md`, `docs/security/2026-09-casa-evidence.md`, `docs/superpowers/reviews/2026-09-1x-phase-7-final-review.md` (dated the day the review runs)
- Modify: `docs/STATUS.md` (the Phase 7 record: what landed, the 20 deviations, rulings, carries closed, carries still open, the baseline; the intro's "Only Phase 7 remains" becomes "all seven phases built"; every "25 routes" → 27; a `Next: after Phase 7` section listing what the spec leaves open — the bridge for on-prem models, Gemini, PgBouncer, load tests, the stubbed-provider Playwright walk, the three-pane review), `CLAUDE.md` (Layout: `packages/db` gains `billing_subscriptions`, `readBillingState`, `loadSettingSources`, `purgeWorkspace`, `rewrapOrgDek`; `packages/core` `billing.ts`; `apps/api` the `billing`/`workspace` services and routers, `ownerProcedure`, the Stripe webhook; `apps/worker` the eight new jobs/crons, `admission.ts`, `billing/`, `observability.ts`; `apps/app` routes 26 and 27. Rules: the queue count — TWELVE short queues (the ten plus `workspace.export`/`workspace.purge`), and `keys.rotate` standard; a **Billing** rule (one reader, the managed meter, the cap rule's third sentence); a **Plans** rule (no `{ org }`-only `resolveSetting`); a **Lifecycle** rule (`purgeWorkspace` pinned to the table list; the Better Auth raw-SQL exception); the env: `STRIPE_*` in both apps, `MANAGED_DRAFT_SLOTS`, `SENTRY_*`, and "Phase 7 added SIX environment variables" — say which are required where; the three new runtime deps; Commands: `pnpm smoke:tenant`, `pnpm --filter @aesa/worker keys:rotate`), `apps/api/.env.example` + `apps/worker/.env.example` (the Stripe block, Sentry, `MANAGED_DRAFT_SLOTS`, a "Phase 7" trailer), `apps/app/eas.json` (`submit.production` with `ios: { appleId, ascAppId, appleTeamId }` and `android: { serviceAccountKeyPath, track: 'internal' }` placeholders; a `preview` submit profile), `docs/superpowers/plans/2026-09-12-phase-7-billing-caps-launch-hardening.md` (the Deviations list amended with anything ruled during execution)

- [ ] **Step 1: The runbook** — what CI cannot do: (a) **Stripe**: create the product and two prices (licensed monthly $49.99 per unit; metered on a Billing Meter with `event_name = ai_conversation_overage`, `customer_mapping stripe_customer_id`, `value_settings value`, sum aggregation, $0.12 per unit), the Customer Portal configuration (cancel at period end allowed, quantity edits DISABLED — the platform owns the domain count), the webhook endpoint `<APP_BASE_URL>/webhooks/stripe` subscribed to the six event types, the four api env values and the worker's two, and the live walk: subscribe with a test card, watch `checkout.session.completed` land, force a `past_due` with Stripe's test clock or a failing card, cancel through the Portal, and read the meter's event summary after `billing.report-usage` runs; (b) **Sentry**: the project, the DSN in both apps, `SENTRY_RELEASE` from the deploy SHA, alert rules on the nine `kind` tags with org attribution in the message, and the **log drain** (Railway → Better Stack or Axiom, JSON, with `org_id` as an indexed field); (c) **the KEK rotation procedure**: add `AESA_KEK_V2` to EVERY `sync`/`send`/`agent` replica while `AESA_KEK_ACTIVE` stays 1 → set `AESA_KEK_ACTIVE=2` everywhere → `pnpm --filter @aesa/worker keys:rotate` → confirm zero orgs on v1 → remove `AESA_KEK_V1` from every replica — and the failure mode of skipping a step (`provider_unavailable`, a mailbox that cannot refresh); (d) **the chaos walk** from the spec's Verify list: kill a `send` worker mid-send (`SIGKILL` between `createReply` and `send` on Graph, and after `messages.send` on Gmail) → exactly one email, the marker scan recovers; stop Postgres for 2 minutes with mail arriving → cursors intact, jobs resume, no duplicate ticket; (e) **the design-partner run**: ≤ 100 Google test users, two weeks, the daily checks (`smoke:tenant`, Sentry, the audit trail for `platform.access`, zero cross-org rows — a query the runbook gives), and the Microsoft-first public launch order; (f) **retention and deletion in the privacy policy**: 180 days default (30–730 owner-set), the 30-day deletion grace, what the export contains, the "delete everything learned from one customer" route; (g) **store submission**: EAS Build production profiles, the App Store / Play listings (the brand assets under `brand/`), privacy nutrition labels (mail content, contacts none, identifiers), the share extension's review notes, TestFlight/internal track first; (h) `MANAGED_DRAFT_SLOTS` sized to the Anthropic tier (replicas × 1 ≤ slots ≤ the tier's concurrent-request ceiling).

- [ ] **Step 2: The CASA evidence package** — `docs/security/2026-09-casa-evidence.md`: a table of the CASA Tier 2 / OWASP ASVS control areas the assessor asks about (authentication and session, access control/tenancy, input validation, cryptography and key management, error handling and logging, data protection and retention, communication security, malicious code/supply chain, business logic, files and resources, API and web service security, configuration) — one row per control with the repo's evidence: the file, the test that enforces it, and the runbook step (e.g. tenancy → `rls.test.ts` + `withOrg`; key management → `packages/crypto` + the rotation runbook; retention → `retention.sweep` + `retention-sweep.test.ts`; logging → `redact.ts`, `logging.ts`, the `Secret` type; SSRF → `createPinnedFetch` and its tests; deletion → `purgeWorkspace` + `purge.test.ts`). Written from the code — every claim cites a path.

- [ ] **Step 3: STATUS and CLAUDE.md** — the Phase 6 record's shape (headings, "Carries CLOSED", "Carries still open", the baseline from the FINAL gate's raw output: tests, skips, routes = 27).

- [ ] **Step 4: The whole-branch review record** — run `superpowers:requesting-code-review` over `main..phase-7` split by area (db+core+contracts / api / worker / app, plus one seams reviewer — billing state read at every gate, the meter split, the purge order, the Stripe calls outside transactions); fix Critical and Important findings in a wave; write `docs/superpowers/reviews/<date>-phase-7-final-review.md`; point STATUS at it. **This step is part of THIS task.**

- [ ] **Step 5: Final gate, paste the raw output into the review record, commit**

```bash
export S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 S3_BUCKET=aesa-dev S3_ACCESS_KEY_ID=aesa S3_SECRET_ACCESS_KEY=aesaaesa S3_FORCE_PATH_STYLE=true
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check && pnpm --filter @aesa/app export:web && pnpm e2e
git add -A && git commit -m "docs: Phase 7 runbook, the CASA evidence package, STATUS record, CLAUDE.md, env examples, EAS submit profiles, the whole-branch final review record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then `superpowers:finishing-a-development-branch` — present the menu; never push, merge or open a PR without Robert.

## Self-review against the spec

- **Spec coverage (Phase 7 paragraph):** `billing_subscriptions` + Stripe Checkout/Portal/webhooks → Tasks 3–4; `billing.report-usage` (domain quantity, automatic overage, blocked mode) → Task 5 (deviations 3–4, 7); the trial policy (14 days from `agent_enabled_at`, no card; trial end or `past_due` → review with a banner, drafts continue, nothing sends automatically) → Tasks 2 (`billingStateOf`), 4 (the stamp), 5 (`decide()` and the lever), 9 (the banner); per-org caps from `usage_counters` everywhere incl. the daily LLM USD cap and trial budgets → Tasks 3 (`loadSettingSources`), 4–5 (every site), 5 (the trial budget, the slot pool); the retention sweep → Tasks 1 and 6; workspace export/delete with 30-day grace → Tasks 3, 6, 8, 9; `keys.rotate` runbook → Tasks 3, 6, 13; Sentry + log drain + alerts with org attribution → Task 11 + the runbook; the CASA evidence package → Task 13; store submissions → Task 13 (`eas.json`, runbook); `scripts/smoke-tenant.ts` → Task 11; native share-sheet intake → Task 10; "Remember this reply" (backfill here, not at connect) → Tasks 7–9. **Verify list:** overage at conversation 301 → E2E 3; downgrade lowers caps the same day → E2E 6; unpaid suspends auto-send → E2E 5; kill a worker mid-send / kill Postgres 2 min → the runbook's chaos walk (d) (the mock-tier crash cases already live in `e2e-phase3.test.ts`); design partners two weeks with zero cross-org rows and zero double sends → runbook (e); Gmail behind CASA, Microsoft first → runbook (e) and the evidence package. **Spec §Decision**: both reasons wired, order untouched. **§PII posture**: 180-day default retention, per-plan-configurable → `retention_days` (owner-set) + `retention.sweep`; an org-delete path that cascades → `purgeWorkspace`. **§Budgets**: the admission slot pool → Task 5 (deviation 13). **§Queue and job model**: `keys.rotate` and `billing.report-usage` exist by those names. **Load test deferred** — recorded, not built.
- **Placeholder scan:** no "TBD"/"similar to Task N"; every test block names its assertions; the migration's re-added `failure_reason` CHECK says to copy the list from 0014 and verify the constraint name (an instruction, not a placeholder); Task 11's Sentry transport stub says to check the 10.x option name — the implementer verifies against `node_modules` exactly as Phase 6 did for `openai`.
- **Type consistency:** `BillingRowLike` (Task 2) ⊂ `BillingStateRow` ⊂ `BillingStateView` (Task 3), the latter what `readBillingState` returns and what Tasks 4, 5, 8 consume; `BillingView` (Task 2) is what `getBilling` (Task 4) returns and `billing.tsx` (Task 9) renders; `SettingSources` (Task 3) is what every `resolveSetting` site takes after Tasks 4–5 and what `GateParams.settings` becomes; `StripePort` (Task 4) vs `StripeUsagePort` (Task 5) are two ports, both implemented by `fake-stripe.ts` (Task 12); `StripeEvent` (Task 4) is what `applyStripeEvent` takes in the webhook test and the E2E; `AdmissionPool` (Task 5) is a dep of `ticket.draft`/`agent.sandbox`; `MemoryCapturePayload`'s refine (Task 7) is what `rememberReply` (Task 8) enqueues; `ExportState` (Task 2's `EXPORT_STATES`) is what `exportStatus` (Task 8) returns and `DangerZone` (Task 9) renders; `PURGE_ORDER` (Task 3) is what `workspace.purge` (Task 6) and E2E 8 iterate; `ALERT_KINDS` (Task 11) names every `alert(...)` placeholder Tasks 4–7 left.
- **Recipe walk (the Phase 5/6 lesson):** the overage delta example (600 allowance; 601 → 1; 650 → 49; 650 → 0) is worked in Task 2's test and re-run against the real cron in Task 5's test and E2E 3; the trial budget example (daily $3 not tripped, total $10.5 ≥ $10 trips) in Task 5; the invariant `10 ≤ 3 × 14` in Task 2; retention's two orgs (180 vs 30 days against 200/100/10-day messages) in Task 6.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-12-phase-7-billing-caps-launch-hardening.md`. Execute with **superpowers:subagent-driven-development** (a fresh implementer per task, a reviewer between tasks, the whole-branch review in Task 13), on branch `phase-7`.
