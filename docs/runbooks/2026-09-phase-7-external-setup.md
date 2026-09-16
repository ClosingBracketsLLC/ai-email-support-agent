# Phase 7 external setup — Robert's checklist

Phase 7 is the last phase in the spec, and the first since Phase 4 that adds **vendors**: Stripe (the
money), Sentry (the errors) and a log drain (the JSON lines with `org_id` on them), plus the two app
stores. It also adds the first **destructive** operations in the product — a nightly body purge, a
30-day-grace workspace delete, and a KEK rotation — and each of those has a step CI cannot take: a
production Stripe account, a real Apple/Google submission, a real KEK rollout across live replicas, a
worker killed mid-send, a Postgres stopped for two minutes with mail arriving.

Read `docs/runbooks/2026-09-phase-6-external-setup.md` first if the KEK ring is not yet on every
`agent` replica — §4 below rotates that ring, and a rotation on a drifted ring is the one operation
here that can make a tenant's data unreadable.

---

## 1. What has to be provisioned

| | |
|---|---|
| New third-party accounts | **Stripe** (live mode, one product, two prices, one Billing Meter, the Customer Portal, one webhook endpoint); **Sentry** (one project per app, or one with two environments); a **log drain** (Better Stack or Axiom, fed from Railway); **Apple Developer** + **Google Play Console** for the store submissions |
| New environment variables | **Nine names across the two apps.** `apps/api`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_DOMAIN`, `STRIPE_PRICE_OVERAGE` (all four or none — `stripeGroup` in `src/config.ts` throws on a partial set — and **required in production**), `SENTRY_DSN`, `SENTRY_ENVIRONMENT` (optional everywhere). `apps/worker`: `STRIPE_SECRET_KEY` (**required in production when `WORKER_ROLES` includes `cron`**), `STRIPE_METER_EVENT_NAME` (default `ai_conversation_overage` — must name the SAME meter the api's `STRIPE_PRICE_OVERAGE` price is attached to), `MANAGED_DRAFT_SLOTS` (default 4, `0` disables; §8), `SENTRY_DSN`, `SENTRY_ENVIRONMENT`. **Both** apps read `SENTRY_RELEASE` straight from `process.env` at their composition root (`src/index.ts`) — it is deliberately not in either config schema; set it from the deploy's git SHA (§3) |
| New runtime dependencies | `stripe@22.6.2` (api and worker), `@sentry/node@10.74.0` (api and worker), `expo-share-intent@8.0.1` (app) — all pinned exactly; a deploy needs `pnpm install` |
| New queues | `workspace.export` (`short`, `knowledge` role), `workspace.purge` (`short`, `knowledge` role), `keys.rotate` (`standard`, `sync` role) — pre-created at boot by BOTH `apps/worker/src/index.ts` and `apps/api/src/boss.ts`, in `QUEUE_OPTIONS` and in the preflight test, per the four-places rule |
| New crons | `billing.report-usage` `20 0 * * *` (`cron`), `retention.sweep` `45 3 * * *` (`cron`), `workspace.purge-sweep` `15 4 * * *` (`cron`), `knowledge.stuck-sweep` `*/5 * * * *` (`knowledge`), `knowledge.reembed-sweep` `*/10 * * * *` (`knowledge`) |
| New migrations | `0021_retention_indexes.sql` (`agent_runs (started_at)`), `0022_lonely_zemo.sql` (generated: `billing_subscriptions`, the lifecycle/export columns on `workspaces`, `drafts.body_purged_at`, `knowledge_sources.sweep_attempts`, `resolved_answers.source_message_id`), `0023_billing_hardening.sql` (FORCE RLS, the two partial unique indexes on the Stripe ids, a trial-row backfill that **silently did nothing** — see below, the retention work-list indexes, `notifications_kind_check` re-added with `billing`/`workspace`, `resolve_stripe_customer`), `0024_audit_retention_index.sql` (`audit_log (created_at)`), **`0025_billing_backfill.sql`** (the fix wave, ruling R33: 0023's backfill re-run under `SET ROLE aesa_platform … RESET ROLE` — the one that actually inserts) |
| New commands | `pnpm smoke:tenant` (root; §6) and `pnpm --filter @aesa/worker keys:rotate` (§4) |

**Deploy migrations before code, as always.** Three notes on this set:

- **`0023`'s trial-row backfill was a silent no-op, and `0025` is the one that lands.** Migrations
  run as `aesa_owner`; every tenant table is FORCE RLS with no policy for that role, so 0023's
  `INSERT … SELECT FROM workspaces` saw zero workspaces and inserted nothing — on the dev database,
  7 workspaces and 1 billing row. `0025_billing_backfill.sql` re-runs it under
  `SET ROLE aesa_platform … RESET ROLE` (ruling R33; `migrations.test.ts` now refuses any later
  data write against a tenant table without that pair), with `ON CONFLICT DO UPDATE … COALESCE` so a
  row `ensureBillingRow` minted meanwhile with a NULL clock gets its clock too. **The moment 0025
  runs, every existing workspace has a `billing_subscriptions` row** (`plan = 'trial'`,
  `status = 'trialing'`, `trial_ends_at = agent_enabled_at + 14 days` when the agent was ever on,
  NULL — no expiry — when it never was). Two consequences, and they are immediate:
  - **A workspace whose `agent_enabled_at + 14 d` is already in the past reads `trial_expired` the
    instant 0025 lands** — Autopilot OFF (every auto-eligible draft lands in review as
    `subscription_inactive`), not "tighter caps", and no `org_settings` override can lift it: the
    derived billing STATE is not a setting. `billing.report-usage` pages "Your trial has ended"
    that night.
  - Every workspace lands on the TRIAL tier's caps — much tighter than the catalog defaults
    everything ran on through Phase 6: sources 100 → 10, crawl pages 200 → 20, sandbox runs/day
    100 → 10, mailbox connections 5 → 1, drafts/day 2000 → 50, Managed-AI USD/day 60 → 3, plus a
    TOTAL trial budget of $10 (a genuine, unexpired trial only, summed from `agent_enabled_at` —
    ruling R27) and a flat allowance of 50 Managed conversations per period. A workspace already
    over a cap is not broken: the 11th source is refused, the existing ten stay.

  So the order is **migrate → deploy → IMMEDIATELY act on every design-partner workspace**.
  "Subscribe before the migration" is impossible (Checkout needs the table). Either subscribe them
  through the app the same hour (§2.5 — `checkout.session.completed` lands `standard/active` and the
  paid caps the same instant), or extend the trial by hand:

      UPDATE billing_subscriptions SET trial_ends_at = now() + interval '14 days'
       WHERE org_id IN ('<org>', …) AND status = 'trialing';

  (as `aesa_platform` or a superuser — `aesa_app` under RLS with no `app.org_id` sees nothing).
  `trialEndsAtFor` is the one formula for a FRESH clock (`setAgentEnabled`, 0025); an extension is an
  operator's write and the trial budget still counts from `agent_enabled_at`. For a cap alone, a
  per-workspace `org_settings` override (`knowledge.max_sources`, `mailboxes.max_connections`,
  `autonomy.daily_draft_cap`, `autonomy.daily_llm_usd_cap`) still works — `resolveSetting` reads
  org > plan > default — but it cannot un-expire a trial.
- **`0023` drops and re-adds `notifications_kind_check`** (one constraint validation's
  `ACCESS EXCLUSIVE` on a small table, the Phase 5/6 shape) and creates `resolve_stripe_customer`,
  a SECURITY DEFINER function owned by `aesa_platform` and `GRANT EXECUTE`d to `aesa_app` alone —
  the fifth fixed-signature resolver of its kind (after `resolve_mailbox_connection` and
  `resolve_mailbox_subscription` in 0006, `resolve_oauth_flow` in 0009 and
  `resolve_draft_action_token` in 0011; see CLAUDE.md), mapping a Stripe customer id to an org. It returns **zero rows** for an unknown customer, and the webhook
  treats that as `unknown_customer` + an alert.
- **The fix wave's `0025` is the LAST migration on this branch and carries no snapshot** (hand-written,
  like 0021 and 0024). `pnpm db:check` is green against it; `pnpm --filter @aesa/db generate` emits
  nothing.

---

## 2. Stripe

### 2.1 The product, the two prices, the meter

In the live-mode Dashboard (or with the CLI), create:

1. **One product** — the subscription.
2. **The licensed price** (`STRIPE_PRICE_DOMAIN`): recurring, monthly, **$49.99 per unit**, usage
   type *licensed*. Its line item's **quantity is the billed domain count**, set at Checkout and
   synced DAILY by `billing.report-usage` with `proration_behavior: 'create_prorations'` (plan
   deviation 4 — not on every agent add/remove).
3. **The Billing Meter**: `event_name = ai_conversation_overage` (or whatever `STRIPE_METER_EVENT_NAME`
   says on the worker — they must match), customer mapping `stripe_customer_id`, value settings
   `value`, aggregation **sum**.
4. **The metered price** (`STRIPE_PRICE_OVERAGE`): recurring, monthly, usage type *metered*, attached
   to that meter, **$0.12 per unit**.

The numbers the APP renders come from `BILLING_PRICING` in `packages/contracts/src/billing.ts`
(`perDomainCents: 4999`, `includedPerDomain: 300`, `overageUnitCents: 12`, `trialDays: 14`,
`trialIncludedConversations: 50`, `trialLlmUsdBudget: 10`). **Stripe's prices and those constants are
two copies of the same numbers with nothing checking they agree** — a price change is both a Dashboard
edit and a contracts commit, in that order.

What the worker reports (plan deviation 3): `billing.meterEvents.create({ event_name, identifier,
payload: { stripe_customer_id, value } })` where `value` is the **DELTA** of `max(0, used − allowance)`
since the last report for the current period and `identifier = ${orgId}:${periodStartIso}:${overageTotal}`
— idempotent on Stripe's side by the identifier and on ours by the guarded `overage_reported`
watermark. Only overage units are ever reported; the allowance (300 × active domains, or the flat 50
on a trial) is computed locally. A workspace whose agents all run on their own keys (BYOK) never counts
toward the allowance and is never billed overage — the meter reads `ai_handled_conversations_managed`,
not the total.

### 2.2 The Customer Portal

Configure the Portal (Settings → Billing → Customer portal) so that:

- **cancelling is allowed** (immediately or at period end — either way the platform learns of it
  through `customer.subscription.deleted`, and a `cancel_at_period_end` flag is recorded and shown);
- **quantity edits are DISABLED** — the platform owns the domain count (`billing.report-usage` will
  overwrite an edited quantity on its next pass anyway, with a proration);
- switching to another price is disabled (there is one plan);
- updating the payment method and downloading invoices are allowed.

`billing.openPortal` returns a Portal session URL with `return_url` = the app's Billing screen; the
owner is the only role that can open it (`ownerProcedure`).

### 2.3 The webhook endpoint

Add an endpoint at **`<APP_BASE_URL>/webhooks/stripe`** and subscribe it to the **five** event types
the api acts on: `checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. (The plan listed a sixth,
`customer.subscription.created`; the api does not handle it — subscribing to it is harmless, the
route acks and ignores it with `outcome: 'ignored'`.) Copy the endpoint's **signing secret** into
`STRIPE_WEBHOOK_SECRET`.

What the route does (`apps/api/src/billing/webhook.ts`): verifies `stripe-signature` over the RAW
bytes (its own content-type parser, in its own encapsulated `register()`), answers **404** when
`STRIPE_*` is unconfigured, **400** on a signature failure (the only 4xx, and the only branch that
records nothing — it fires the `stripe_webhook_rejected` alert, because a sustained run of them is a
rotated secret or someone probing), and **200** for every other outcome (`applied`, `duplicate`,
`stale`, `unknown_customer`, `ignored`) — Stripe retries a non-2xx for three days, so "nothing to do"
must ack. Deliveries are deduplicated on `event.id` through `webhook_events` (the envelope stores the
type and timestamp only, never the object — it carries the customer's email and card brand) and
ordered by `last_stripe_event_created` (checked on the read and repeated in the UPDATE's WHERE).

What the route will NOT apply (the fix wave, rulings R30–R32 — each is `outcome: 'ignored'`, 200,
and the row is untouched):

- **A `customer.subscription.updated|deleted` for a subscription the row does not hold** is ignored
  and alerts `stripe_foreign_subscription_event` (the twelfth alert kind). Only
  `checkout.session.completed` may introduce a different subscription id — the platform creates every
  subscription through Checkout. This is what makes the `stripe_double_subscription` remedy safe:
  cancelling the orphan the alert names delivers a `deleted` for THAT id, which is now ignored
  (and alerts, so you see it land) rather than displacing the live subscription. **Cancel the orphan
  it names, never the survivor.**
- **Any `invoice.*` on a `canceled` row** — the "cancel immediately + prorate" Portal flow delivers
  `deleted` then `invoice.paid` in the same second, and a canceled Stripe subscription can never
  become active again. Re-subscribing goes through Checkout.
- **`incomplete_expired`** moves nothing; **`past_due`/`canceled` land only on a `standard`-plan
  row.** A Checkout that completed unpaid (a card that failed at completion, an SCA never finished —
  ruling R10's deferred state) leaves the row on the trial plan holding the subscription id, and
  `startCheckout` reads that as a Checkout still pending (`checkout_pending`: "Stripe is still
  confirming your payment") rather than starting a second one. When Stripe gives up on it
  (`incomplete_expired`, or a `deleted`) the ids are forgotten and Checkout is open again; an
  `invoice.payment_failed` on it pages nobody. **Until a reconciliation arm exists (a carry), keep
  the Checkout's payment methods to cards** — a delayed-notification method (SEPA, ACH) is exactly
  the state these guards were written for, and the only recovery for a row that drifts from Stripe
  is the Dashboard plus a hand fix.

Three operator notes on that route, from the review:

- **`recordWebhookEvent` runs BEFORE the event is applied.** A throw after it (a database error
  mid-apply) loses that event to the dedupe when Stripe retries — the retry is answered `duplicate`.
  This is the shape both mail webhooks use and it was mandated; the consequence is that a lost
  `checkout.session.completed` is recovered by the `invoice.paid` that follows it (which establishes
  `plan = 'standard'` for the row's own subscription), and a lost `subscription.updated` by the next
  one. If a workspace's Stripe state and its `billing_subscriptions` row ever disagree, the Dashboard
  is the truth and the row is fixed by hand — there is no reconciliation sweep (a carry).
- **The global rate limiter covers this route** (`@fastify/rate-limit`, `global: true`, whose
  `onRoute` hook wraps every route declared inside a `register()` — the same propagation the mail
  webhooks rely on), at `API_RATE_LIMIT_PER_MINUTE` (default 300) **per IP**. No test asserts the
  Stripe route specifically. Stripe delivers from a small, published set of IPs, so a burst of
  deliveries — a Portal cancel fans out to several events, a dunning cycle more — could 429 real
  events. Stripe retries a 429 and nothing is lost, but a retry is minutes of latency on a
  `past_due` the owner is waiting to see. Size the limiter with that in mind, or raise it for
  Stripe's ranges at the proxy.
- **`stripe_webhook_rejected` reaches Sentry as a message with the scrubbed error text**, not as an
  exception with a stack: the alert helper takes scalars only. If you are debugging a signature
  failure, the pino line beside it (`alert: true, kind: stripe_webhook_rejected`) is where the
  detail is.

Locally: `stripe listen --forward-to localhost:3001/webhooks/stripe` prints a `whsec_…` to put in
`apps/api/.env`, and `stripe trigger checkout.session.completed` exercises the route (the org
resolution will land `unknown_customer` unless the customer exists — that is the alert working).

### 2.4 The environment

api: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_DOMAIN`, `STRIPE_PRICE_OVERAGE`.
worker (`cron` replica): `STRIPE_SECRET_KEY`, `STRIPE_METER_EVENT_NAME`. The two apps hold the same
secret for different calls (deviation 18): the api for Checkout, Portal, cancel and webhook
verification; the worker for meter events and the quantity sync. Neither app calls Stripe inside a
transaction — every Stripe call is before or after a `withOrg`, and the write that records its
result is guarded on what was read.

`GET /meta` reports `billing: true|false`; the Billing screen hides **Subscribe** when it is false
rather than offering a button that can only answer `not_configured`.

### 2.5 The live walk

Do this once in **test mode** end to end, then once more in live mode with a real card you refund.

1. **Subscribe.** Settings → Billing → *Subscribe* (owner). Checkout opens in a new tab on web
   (`window.open` before the await, the connect-card pattern) or an auth session on native. Pay with
   `4242 4242 4242 4242`. Expect `checkout.session.completed` to land within seconds:

   ```sql
   select plan, status, stripe_customer_id, stripe_subscription_id, domain_quantity,
          current_period_start, current_period_end, overage_mode, last_stripe_event_created
   from billing_subscriptions where org_id = '<org>';
   ```

   `plan = 'standard'`, `status = 'active'`, both Stripe ids set, `domain_quantity` = the number of
   connected domains at Checkout (the `subscription.updated` that follows within the same second fills
   the item ids and the period). A Checkout whose payment is asynchronous (`payment_status = 'unpaid'`)
   records the ids only and waits for `invoice.paid` to promote the plan (ruling R10) — the
   conservative direction. The Billing screen now shows the plan, the domain count, the allowance and
   the period; the api's `billing.get` reads it all through `readBillingState`, the ONE reader.

2. **Watch the caps rise the same day.** `knowledge.max_sources` resolves 100 where the trial refused
   an 11th paste; `mailboxes.max_connections` 5. No restart is involved — `loadSettingSources` reads
   the row on every call.

3. **Force a failed payment.** Either attach `4000 0000 0000 0341` in the Portal and advance a
   **test clock** past the renewal, or use *Send a test webhook* for `invoice.payment_failed` against
   the subscription. Expect `status = 'past_due'`, **one** `billing` push *"Payment failed"* /
   *"Autopilot is paused until the card is updated. Replies still come to you for review."*
   (day-deduped), the **BillingBanner** across the inbox for every member, and — the whole point —
   drafts still arriving on Review with `decision_reason = subscription_inactive` while any queued
   auto-send **holds** on the `subscription_inactive` lever. **A reply the owner approves by hand
   still goes out** (deviation 6: "nothing sends automatically" is the spec's wording, and an owner
   who approved while past due must not be silently ignored).

4. **Bring it back.** Fix the card; `invoice.paid` for the row's own subscription returns
   `status = 'active'`. A foreign `invoice.paid` (another subscription's) is ignored — the E2E pins it.

5. **Cancel through the Portal.** `customer.subscription.deleted` → `status = 'canceled'`,
   `plan = 'trial'`, and — because `trial_ends_at` is in the past — the workspace behaves like an
   expired trial: Review with a *"subscribe to resume Autopilot"* banner and trial caps the same
   instant (deviation 8). The Billing screen for this state reads *"trial · 0 domains · $0.00 /
   month"* beside a Subscribe button — correct data, undignified presentation, a deferred minor
   worth judging by eye here.

6. **Read the meter.** Get a workspace past its allowance (on a trial that is 50 Managed
   conversations — a test workspace with `4242` subscribed and two domains needs 601), then wait for
   `billing.report-usage` at **00:20 UTC** — there is deliberately no manual trigger; if you need it
   sooner, call `runBillingReportUsage` from a one-off `tsx` script with the worker's deps, exactly as
   `apps/worker/test/billing-report-usage.test.ts` does. Then:

   ```sql
   select overage_reported, overage_reported_period_start, domain_quantity
   from billing_subscriptions where org_id = '<org>';
   select created_at, action, detail from audit_log
   where org_id = '<org>' and action like 'billing.%' order by created_at desc limit 10;
   ```

   and in the Dashboard: Billing → Meters → `ai_conversation_overage` → the customer's event summary.
   Exactly one unit at 601, 49 more at 650, nothing on a re-run at 650 (the worked example the E2E
   walks). Under `overage_mode = 'blocked'` (Settings → Billing, owner) nothing is reported; the 601st
   auto-eligible draft lands `review/allowance_exhausted` and the nightly pass pages *"Included
   conversations used up"* once — as it also does for a TRIAL at its flat 50 under `automatic`
   (ruling R11: a trial is exhausted regardless of mode, and every stop in this product explains
   itself).

7. **Refund the live-mode charge** and cancel the live subscription in the Dashboard when done; the
   `deleted` event puts the workspace back on trial.

---

## 3. Sentry and the log drain

### 3.1 Sentry

- Create the project(s) and put the DSN in **both** `apps/api/.env` and `apps/worker/.env` as
  `SENTRY_DSN`. `SENTRY_ENVIRONMENT` defaults to `NODE_ENV`; set it to `production`/`staging` by
  hand if the two are not the same word. Unset DSN = not configured: the process logs one warn at
  boot and every alert still lands as a pino `error` line with `alert: true` — an operator on logs
  alone loses nothing.
- **`SENTRY_RELEASE` from the deploy SHA.** Both `src/index.ts` files read it from `process.env`
  directly and pass it to `Sentry.init({ release })`. On Railway that is
  `SENTRY_RELEASE=${{RAILWAY_GIT_COMMIT_SHA}}` in the service variables; anywhere else, export the
  SHA the build was made from. Without it every event lands on one unversioned stream and a
  regression cannot be tied to a deploy.
- **Alert rules on the `kind` tag.** Every `alert(kind, ctx)` is a `captureMessage` at level
  `error` tagged `kind` and `org_id`; every uncaught error goes through `captureWithOrg` tagged
  `org_id` (and `job` on the worker, `path` on the api). The **twelve** kinds in `ALERT_KINDS`
  (`apps/{api,worker}/src/observability.ts`) are: `admission_slot_timeout`,
  `deletion_billing_unconfigured`, `export_failed`, `keys_rotate_failed`,
  `knowledge_reembed_stranded`, `org_spend_capped`, `purge_failed`, `stripe_double_subscription`,
  `stripe_foreign_subscription_event` (the fix wave's, ruling R31 — routine after you cancel the
  orphan a `stripe_double_subscription` named, otherwise a subscription this platform did not
  create), `stripe_report_failed`, `stripe_unknown_customer`, `stripe_webhook_rejected`. Make one
  rule per kind (or one rule on `kind:*` with the kind and `org_id` in the notification message) and
  page on all of them but `org_spend_capped`, which is a daily notice (`scope: daily`) or, for a
  trial that has spent its whole $10 (`scope: trial`), a once-per-workspace one. The plan's other kind,
  `platform_killswitch_on`, is wired nowhere — flipping `platform_state['killswitch.global']` is a
  manual operation and the operator doing it knows; a carry, not a gap.
- **What Sentry may NOT receive, and what stops it.** `beforeSend` in each app's `observability.ts`
  is the PII boundary, and it is EVENT-level: it runs on every event however it was captured —
  Fastify's own error handler, pg-boss's job failure, the process-level uncaught-exception
  integrations — not only on the two helpers. It redacts every exception message (a
  `DrizzleQueryError`'s `Failed query: <sql>\nparams: <bound values>` can carry a draft's
  `final_body`), every breadcrumb message (the console integration renders a logged error into
  `message` via `util.format`), strips `request.data`, the sensitive headers (`cookie`,
  `authorization`, `x-api-key`) and scans every other header value and the URL/query string for the
  `/a/:draftId?t=` one-click token, and drops every `detail`/`payload`-shaped key. The scrubbers are
  ONE implementation in `packages/core/src/redact.ts` (ruling R25). Two things it cannot reach, so
  never do them: run either process with **`--inspect`** (Sentry's default `localVariablesIntegration`
  would attach stack-frame locals outside `beforeSend`'s reach — inert today because nothing sets
  `includeLocalVariables`, and it must stay that way), and add a Sentry integration that reads
  request bodies.

### 3.2 The log drain

Both apps log JSON through pino with `org_id` on every line that has one (the api's request logger
and tRPC `onError`, the worker's per-job child logger). Wire the drain at the platform, not in code:

- **Railway → Better Stack (Logtail) or Axiom**, JSON mode. Both parse pino's line format directly.
- Mark `org_id` as an **indexed field** on arrival — it is the pivot for every "what happened to
  this tenant" question, and the field the `platform.access` audit trail (§6) joins on.
- `alert: true` and `kind` are the fields the alert rules in §3.1 are mirrored on; a drain-side
  alert on `alert:true` catches the case where Sentry itself is down.
- Retention at the drain is your choice, but keep it **≤ 30 days**: pino lines carry no bodies (the
  api's `err` serializer redacts a `DrizzleQueryError` the same way `beforeSend` does, the worker's
  job failures are scrubbed by `scrubJobError` before they are stored or logged, and `Secret`
  serializes as `[redacted]`), but they do carry ticket and message ids, and the product's own
  retention promise (§7) should not be undercut by a log store nobody prunes.

---

## 4. The KEK rotation procedure

The ring is `AESA_KEK_V<n>` + `AESA_KEK_ACTIVE=<n>` on every `sync`, `send` and `agent` replica
(Phase 6 §2). A rotation re-wraps each org's **DEK** under the new active KEK — the DEK itself never
changes, so nothing encrypted under it (mailbox refresh tokens, BYOK provider keys, the org's sealed
box private key) is touched (deviation 11). `keys.rotate` runs on the **`sync`** role, one org per job,
guarded on the exact `wrapped_dek` bytes and `kek_version` it read.

**The four steps, in this order and no other:**

1. **Add `AESA_KEK_V2` to EVERY replica whose `WORKER_ROLES` includes `sync`, `send` or `agent`**,
   while `AESA_KEK_ACTIVE` stays `1`. Roll them all. Nothing changes yet: every row is still on v1
   and every replica can still open v1.
2. **Set `AESA_KEK_ACTIVE=2` everywhere** and roll again. Still nothing is re-wrapped — new orgs
   provision under v2, existing ones stay on v1, and every replica holds both.
3. **`pnpm --filter @aesa/worker keys:rotate`** from a shell that has the same ring in its
   environment (the script refuses without one). It enqueues one `keys.rotate` per org whose NEWEST
   `org_data_keys` row is not on the active version, and prints
   `keys:rotate — active KEK v2; N workspace(s) behind, N job(s) enqueued`. Safe to re-run: the work
   list is re-derived from the database every time, so a job that failed, was collapsed or lost the
   guarded write is simply selected again.
4. **Confirm zero orgs on v1**, then remove `AESA_KEK_V1` from every replica and roll one last time:

   ```sql
   select kek_version, count(*) from (
     select distinct on (org_id) org_id, kek_version from org_data_keys order by org_id, version desc
   ) current group by kek_version;
   select created_at, org_id, action, detail from audit_log
   where action = 'keys.rotated' order by created_at desc limit 20;
   ```

**What skipping a step costs.** A replica that does not hold the KEK a row is wrapped under cannot
open that org's DEK, and nothing says "wrong KEK": for the `agent` role every BYOK draft lands
`needs_owner` / `provider_unavailable`; for `sync` the mailbox cannot refresh its token and flips to
`reauth_required`; for `send` the reply holds. Running step 3 before step 1 has reached every replica
produces exactly that on every replica still missing v2. Removing v1 before step 3 has finished
leaves the un-rotated orgs unreadable on every replica at once — `rewrapOrgDek` THROWS (does not
return) when the ring lacks the row's version, the row is untouched, and the failed job alerts
`keys_rotate_failed` with the org id; the fix is to put v1 back and re-run step 3. **Never replace
`AESA_KEK_V1`'s value in place** — add a version and move `ACTIVE`.

The worker's per-credential provider cache is freshness-keyed (`${credentialId}:${lastProbedAt}`,
15-minute ceiling), so a rotation needs no cache flush; `keys.rotate` re-wraps the DEK, and the next
`resolve` opens it under the new wrap.

---

## 5. The chaos walk (spec §Verify)

Two failures the mock-tier E2Es (`apps/worker/test/e2e-phase3.test.ts`'s crash cases) approximate
and only a real deployment proves. Do both on a staging stack against real Gmail and M365 test
mailboxes, with the send limiter and the real providers in the loop.

### 5.1 Kill a `send` worker mid-send

- **Graph:** put a breakpoint or a `kill -9` between `createReply` and `send` (the two Graph calls
  `send.execute` makes) and approve a draft. **Gmail:** kill the process right after
  `messages.send` returns, before the `outbound_sends` row is marked. Then let pg-boss retry.
- Expect **exactly one email** in the customer's mailbox. The retry reads the thread back for its
  own marker header (`MARKER_HEADER`, `packages/mail`) BEFORE doing anything else and recovers the
  already-sent message rather than sending again; the row lands `sent`, the ticket moves,
  `SEND_METERS` bump once. Check:

  ```sql
  select status, attempts, provider_message_id, sent_at, last_error from outbound_sends
  where org_id = '<org>' order by created_at desc limit 5;
  ```

- If a second email ever arrives, stop: that is the property the whole send path exists to hold, and
  it is a bug report, not a runbook step.

### 5.2 Stop Postgres for two minutes with mail arriving

- Send three or four customer emails to both test mailboxes, `docker stop` (or the platform
  equivalent) the database for two minutes, then start it. Both apps keep running: the api's
  `/healthz` reports `degraded`, the worker's pg-boss loop retries its poll.
- Expect the mailbox cursors intact (`mailbox_connections.cursor` — Gmail's `historyId`, Graph's
  `deltaTokens` — unchanged by the outage), the sync jobs resuming on the next `mailbox.poll-sweep`
  tick, every email arriving as **one** ticket each (`messages_connection_provider_uidx` on
  `(connection_id, provider_message_id)` is the guard), and no job lost: a job that was `active` when the database went away is re-queued by pg-boss's
  expiry, and `ticket.backstop-sweep`'s arms catch a draft run that died mid-flight.
- Check for duplicates afterwards:

  ```sql
  select connection_id, provider_message_id, count(*) from messages
  where org_id = '<org>' group by connection_id, provider_message_id having count(*) > 1;
  ```

---

## 6. The design-partner run

**Order: Microsoft 365 first, Gmail behind the test-user gate until CASA clears** (spec, Open items
for Robert). The Gmail OAuth client stays in *Testing* with **≤ 100 test users** (Phase 2 runbook);
Microsoft needs no CASA and is the public launch path.

Run **two weeks** with design partners before the public launch, and do these **daily**:

1. **`pnpm smoke:tenant`** against a throwaway workspace on the deployed stack — `SMOKE_API_URL`,
   `SMOKE_WEB_ORIGIN`, `SMOKE_COOKIE` (the full cookie header from a signed-in browser session of
   that workspace; the script never prints it), optionally `SMOKE_SANDBOX=1` for one real sandbox
   run. It walks `/healthz`, `/meta`, `workspace.get`, `billing.get`, `agents.list`,
   `knowledge.list` and `memory.summary`, prints one `ok`/`FAIL` row per step with its latency, and
   exits non-zero on any failure.
2. **Sentry**: zero unresolved issues tagged with a partner's `org_id`; every alert kind in §3.1
   either silent or explained.
3. **The `platform.access` audit trail** — every `withPlatform` call writes one row with
   `org_id IS NULL`, `action = 'platform.access'`, actor `system:<reason>` and the reason as
   `entity_id`; read it daily and make sure every reason is one you recognise (a cron's name, a
   webhook's, the export/purge jobs, `script:keys.rotate`). An unfamiliar reason is a new code path
   bypassing RLS:

   ```sql
   select entity_id as reason, count(*) from audit_log
   where org_id is null and action = 'platform.access' and created_at > now() - interval '1 day'
   group by 1 order by 2 desc;
   ```

   `sweeps.daily`'s arm (h) prunes these at 30 days, and `retention.sweep` now writes one per
   workspace per night (§7), so the count scales with the org count — that is expected.
4. **Zero cross-org rows.** Every tenant table carries `org_id`; the query below joins each
   child to its parent through the FK and reports any row whose `org_id` disagrees with its
   parent's. It must return nothing, every day:

   ```sql
   select 'messages' as t, count(*) from messages m join tickets t on t.id = m.ticket_id where t.org_id <> m.org_id
   union all select 'drafts', count(*) from drafts d join tickets t on t.id = d.ticket_id where t.org_id <> d.org_id
   union all select 'outbound_sends', count(*) from outbound_sends s join drafts d on d.id = s.draft_id where d.org_id <> s.org_id
   union all select 'agent_runs', count(*) from agent_runs r join agents a on a.id = r.agent_id where a.org_id <> r.org_id
   union all select 'llm_calls', count(*) from llm_calls c join agent_runs r on r.id = c.run_id where r.org_id <> c.org_id
   union all select 'knowledge_chunks', count(*) from knowledge_chunks k join knowledge_documents d on d.id = k.document_id where d.org_id <> k.org_id
   union all select 'knowledge_documents', count(*) from knowledge_documents d join knowledge_sources s on s.id = d.source_id where s.org_id <> d.org_id
   union all select 'resolved_answers', count(*) from resolved_answers a join tickets t on t.id = a.source_ticket_id where t.org_id <> a.org_id
   union all select 'llm_credential_secrets', count(*) from llm_credential_secrets s join llm_credentials c on c.id = s.credential_id where c.org_id <> s.org_id
   union all select 'mailbox_credentials', count(*) from mailbox_credentials mc join mailbox_connections c on c.id = mc.connection_id where c.org_id <> mc.org_id;
   ```

   Run it as a superuser or `aesa_platform` (RLS would otherwise hide the very rows it looks for).
   Column names are the schema's at the time of writing; if one has moved, `packages/db/src/schema/`
   is the source.
5. **Zero double sends**: §5.1's `outbound_sends` query, plus a partner asking their customers — one
   reply per approval is the promise the design partners are there to confirm.

At the end of the two weeks: zero cross-org rows, zero double sends, every alert explained → public
Microsoft launch; Gmail stays gated until the CASA letter arrives
(`docs/security/2026-09-casa-evidence.md` is the evidence package).

---

## 7. Retention and deletion — the privacy policy

Phase 7 makes four promises true in code; the privacy policy has to state them in the same numbers.

- **Retention: 180 days by default, owner-set between 30 and 730** (`workspaces.retention_days`,
  Settings → Workspace, owner only). `retention.sweep` runs nightly at 03:45 UTC and, per
  workspace, NULLs `messages.body_text` and the three text columns of every TERMINAL draft
  (`body`, `final_body`, `rationale`) older than that window, stamping `body_purged_at`. Subjects,
  attachment metadata, timestamps and every counter stay — the ticket list still reads, the words are
  gone. Platform-wide it also deletes `llm_calls` past 400 days, `notifications` past 90 and tenant
  `audit_log` rows past 730; `sweeps.daily` deletes `agent_runs` past 90 days and platform
  `platform.access` rows past 30. **Learned answers keep their own 365-day expiry** (Phase 5) and
  are not retention-swept.
  Two operator facts about the sweep: it takes **one short transaction per workspace and visits
  every workspace** (ruling R15 — a `LIMIT` with no rotation was a workspace whose retention promise
  was never kept), so the nightly pass **scales with the org count** — N sequential transactions and
  one `platform.access` audit row per workspace per night; watch its duration in the logs as the
  tenant count grows, and if a single workspace's first purge (a decade of mail) is long, it runs in
  `RETENTION_BATCH` slices so no statement meets the 30 s `statement_timeout`. And it is
  **irreversible** by design — a body it nulled is not in any backup the sweep knows about.
- **Deletion: a 30-day grace, then everything.** `workspace.requestDeletion` (owner, typed
  confirmation of the business name) cancels the Stripe subscription **immediately** (not at period
  end — ruling R22: the deletion copy says so, and cancelling the deletion does NOT bring the plan
  back; the owner re-subscribes), then flips the kill switch, disables the agent and stamps
  `deletion_requested_at`, paging once per day (ruling R19). `workspace.purge-sweep` (04:15 UTC)
  hands every workspace past the grace to `workspace.purge`, which deletes the org's objects from the
  bucket (best effort, and it **refuses** any key not under `orgs/<orgId>/`, alerting instead), then
  in one platform transaction deletes every tenant table in FK order (`PURGE_ORDER`, pinned by a
  test against the migration table list so a new table cannot escape), the `workspaces` row, and
  finally the Better Auth `organization` row (cascading members and invitations) — the ONE place the
  worker writes Better Auth's tables directly. One platform audit row records that the purge
  happened, and nothing else. `cancelDeletion` inside the window clears the stamps; the agent stays
  off until switched on (and since the fix wave `setAgentEnabled(true)` is refused while the
  deletion is pending — the switch comes back with `cancelDeletion`). The purge re-checks the
  cancel a second time INSIDE its row transaction, under `FOR UPDATE` (fix wave B4): a
  `cancelDeletion` that lands between the job's read and its row purge wins, the rows are kept, and
  the job alerts `purge_failed` with `phase: cancelled_mid_purge` — **the objects are already gone
  by then** (every upload and the export bundle), so that alert means telling the owner what was
  lost. A workspace holding a subscription — a live one, or a deferred Checkout's that could still
  settle — on a replica that has no Stripe configured is **refused** (`deletion_billing_unconfigured`)
  rather than purged while the card keeps being charged; a `canceled` row is the one status the
  cancel is skipped for.
- **Export: what the bundle contains.** `workspace.requestExport` (owner) → `workspace.export`
  writes ONE NDJSON object per workspace to `orgs/<orgId>/exports/<exportId>.ndjson`: a manifest
  line, then one line per row across the workspace profile, settings, agents, categories and
  policies, tickets, messages, decided drafts, learned answers, knowledge sources (metadata and
  pasted text; uploaded files are listed by name, not bundled — the owner has them), billing
  metadata, notifications and the org's own audit trail. **Every column is allow-listed by name**;
  the secrets tables are not in the bundle at all and a test greps the produced bytes for every
  secret column name and value. The bundle is capped at **200 MB** — past it the export fails
  loudly (`export_failed`) rather than filling the bucket; note the builder holds the lines in
  memory and `Buffer.concat`s them at the end, so the worker's peak memory for one export is about
  **twice** the bundle size — size the `knowledge` replica's memory for ~400 MB headroom, or expect
  a large tenant's export to fail there first. `exportStatus` presigns a **7-day** GET on demand, for
  the **owner only** (ruling R21 — the bundle carries the whole audit log); the URL is never in a
  push payload. One export at a time per workspace (`export_in_progress`).
- **"Delete everything learned from one customer."** Settings → Memory → *Delete by customer*
  (`memory.deleteByCustomer`, Phase 5) removes every learned answer keyed to that customer's salted
  hash. It is the erasure route for ONE customer of a business; the retention sweep and the workspace
  purge are the routes for the business itself. Say all three in the policy, in those words.

Say also that Stripe (billing), Sentry (error reports, with no message bodies) and the log drain are
new sub-processors, and that under BYOK the customer's chosen provider is their own (Phase 6 §6).

---

## 8. `MANAGED_DRAFT_SLOTS` — size it to the Anthropic tier

`MANAGED_DRAFT_SLOTS` (worker env, default **4**, `0` disables) is the number of MANAGED model calls
this **deployment** may have in flight at once, across every replica — a session-level
`pg_try_advisory_lock(hashtext('managed-slot'), i)` held on a dedicated pool client for the length of
one model call (`apps/worker/src/drafting/admission.ts`). It is prevention with a reactive floor: a
run that finds no slot within **60 s** proceeds anyway with an `admission_slot_timeout` alert — a
draft is never lost to admission control. BYOK calls bypass it entirely (their limiter is per
credential).

The sizing rule: **`agent` replicas × 1 ≤ `MANAGED_DRAFT_SLOTS` ≤ the Anthropic tier's
concurrent-request ceiling** (Console → Limits). Below the replica count, replicas queue on each
other for nothing; above the tier's ceiling, the pool no longer prevents the 429s it exists to
prevent. Set the SAME value on every `agent` replica — it is one lock namespace, and a replica with a
larger number would claim slots the others never see.

Two things to know when it is contended:

- **A waiting `acquire` holds one pooled client for the whole 60 s.** The pool is `pg`'s default of
  **10** connections per process and the draft queue's `batchSize` is 1, so one replica can have at
  most one waiter — but that waiter is a connection the replica's other jobs cannot use for a minute.
  If `admission_slot_timeout` fires regularly, the tier is undersized for the load, not the pool.
- **The wait is spent from the draft's 240 s watchdog** (`DRAFT_WATCHDOG_SECONDS`) — a run that
  waited the full minute has three left for retrieval, the model and the landing. That is enough,
  but a slow model on a busy hour is where the two meet.

---

## 9. Store submission

`apps/app/eas.json` now carries `submit.production` and `submit.preview` with **placeholders**
(`REPLACE_ME_*`) for the Apple and Play credentials — fill them from the two consoles; nothing in the
file is secret except the path to the Play service-account JSON, which stays out of git.

1. **EAS Build**, production profile: `eas build --profile production --platform all`. The
   `production` build profile sets `EXPO_PUBLIC_API_URL` — replace `https://api.example.com` with the
   real api origin BEFORE the first build; the value is baked into the binary. `preview` builds are
   internal distribution against staging.
2. **TestFlight and the Play internal track first**: `eas submit --profile preview` (the profile
   submits to TestFlight / the `internal` track). Run §6's daily checks on that build for at least a
   week before `--profile production`.
3. **The listings.** Name: the codename `aesa` until the product name is picked (spec, Open items —
   the bundle id `com.closingbrackets.aesa` and the scheme `aesa` are already baked into `app.json`
   and change with a new build). Assets: the icons under `apps/app/assets/` and the marks/lockups
   under `brand/` are generated from `brand/tokens.json` + `mark.svg` + `wordmark.svg` by
   `pnpm brand:build` — export the store screenshots from the web build at phone width and the
   feature graphic from `brand/og-image.svg`; never hand-edit a generated file.
4. **Privacy nutrition labels (Apple) / Data safety (Play).** Declare, honestly:
   - **Email content** (customer messages and the business's replies) — collected, linked to the
     account, used for app functionality; retained per the workspace's setting (§7).
   - **Contact info** — the account email; no address book access, **no contacts** collected.
   - **Identifiers** — the user id and the Expo push token (`notification_devices`).
   - **Diagnostics** — crash and error data via Sentry, with no message bodies (§3.1).
   - **Purchases** — none in-app: subscriptions are bought through Stripe Checkout on the web, and
     the native app's Billing screen opens that page in the browser. Say so in the review notes, or
     the iOS reviewer will look for an in-app purchase.
   - Not collected: location, health, financial info (Stripe holds the card), browsing history.
5. **The share extension's review notes.** The app registers a share extension (`expo-share-intent`,
   `app.json`): iOS activation rules accept one web URL, one web page, text, or one file; Android
   intent filters accept `text/*`, PDF, DOCX, Markdown and plain text. Tell the reviewer: *"Share a
   web page, a paragraph of text, or a PDF/DOCX from any app into aesa; it lands on the Share screen
   inside the app, where the user confirms it as a knowledge source (a link is crawled, text is
   pasted, a file is uploaded). Nothing is sent anywhere until the user confirms."* Give them a test
   account with a workspace already created — the share screen sits behind sign-in.
6. **Sign-in**: email one-time code (Better Auth `emailOTP`), with optional Google/Microsoft SSO
   when those client ids are set; provide the reviewer a test email they can read, or a workspace
   invitation link.
7. **Push**: `expo-notifications`; the reviewer will want to see one — an escalation on a test
   ticket (send an angry email to the test mailbox) is the quickest.

---

## 10. Operator notes

- **`billing.report-usage` (00:20 UTC, `cron` role, singleton, 500 orgs per pass)** has three phases
  per org — collect (one platform transaction), act (the Stripe calls, outside every transaction),
  record (one `withOrg` per org, guarded on what phase 1 read). A failed meter event is
  `stripe_report_failed` + a dropped action for that org; tomorrow recomputes the same delta from the
  same watermark. A `cron` replica with no `STRIPE_SECRET_KEY` still runs the local half (the trial
  and allowance pages) and counts every Stripe call it could not make as `skipped` — in production
  `loadConfig` refuses that boot.

  ```sql
  select created_on, state, output from pgboss.job where name = 'billing.report-usage'
  order by created_on desc limit 5;
  ```

- **The trial pages.** *"Your trial ends in N days"* from three days out (*"…ends tomorrow"* on the
  last), *"Your trial has ended"* once, and *"Included conversations used up"* — all `billing`
  pushes, day-deduped, routed to `/settings/billing`. The trial **spend** page (`org_spend_capped`, scope `trial`, when the $10
  total is reached) uses a DAILY dedupe key on a budget that never resets, so it re-pages every day
  until the workspace subscribes — a deferred minor, and a support answer ("subscribe, or it pages
  again tomorrow").
- **`workspace.purge-sweep`'s select has no `LIMIT`** — a mass-deletion event (many workspaces past
  their grace on the same night) enqueues them all in one tick. Fine at launch scale; a bound is a
  carry.
- **`knowledge.stuck-sweep` (every 5 min)** requeues a source stuck `processing` past its lease three
  times, then fails it `stuck`; an upload `queued` past a day with no object is failed `abandoned`.
  **`knowledge.reembed-sweep` (every 10 min)** is what finally makes `KNOWLEDGE_EMBED_MODEL`
  changeable on a live workspace: chunks embedded under another model have their vectors NULLed
  (without bumping `knowledge_version`) and `knowledge.embed-batch` refills them under the current
  one; learned answers are re-embedded in place. Both run on the `knowledge` role. A document whose
  re-embed enqueue fails is `knowledge_reembed_stranded` — the vectors are NULL and the sweep's own
  discovery cannot find it again (it looks for `embedding IS NOT NULL`), so the alert IS the
  recovery path: re-enqueue `knowledge.embed-batch` for that document by hand. Since the fix wave
  the chunk arm checks the org's daily embed cap BEFORE nulling anything (a refill the cap refused
  stranded the document the same way, silently). **Do not change `KNOWLEDGE_EMBED_MODEL` in
  production until the rediscovery arm lands** (a Phase 8 carry: a `ready` source with
  `embedded_count < chunk_count` and no live job is found by nothing today), and never run two
  `knowledge` replicas on different models — they re-embed each other's work up to each cap, daily.
- **The mailbox connection cap counts LIVE SYNC SLOTS** — `connected` and `pending_claim`, not
  `reauth_required` (ruling R7) — so an owner can always repair a broken mailbox on a trial capped at
  1. The residual: a workspace can end one over the cap by adding a mailbox while an old one is
  broken and then repairing it; visible on the Mailboxes screen, fixed by disconnecting.
- **`decide()`'s order is the spec's** (ruling R12): `subscription_inactive` sits before the
  tripwire/guardrail branches, so on a lapsed workspace a guardrail-failed body reports
  `review/subscription_inactive` rather than `escalate/guardrail_failed`. Containment is identical
  (neither auto-sends; the approve gate re-screens), only the reason's precision differs. **A spec
  question for Robert, after Phase 7:** should `subscription_inactive` move after the guardrail
  branch so a lapsed workspace still gets the precise reason?
- **Nothing about the guardrails, the lock order or the escalation entry changed.** `escalateTicket`
  is still the one entry into `needs_owner` (three grandfathered landings in `ticket.triage`), the
  four-position lock order holds, and `memory.capture` is still the only writer of a new learned
  answer — "Remember this reply" enqueues it with a `messageId` and audits every skip (ruling R20).

---

## 11. What only a real device proves

Six screens and one extension have never rendered outside jest — the Playwright smoke still ends at
the gated mailbox step. Open them signed in, at wide and phone widths and on a real phone:

- **Settings → Billing** (route 26): trialing, active, past_due AND the lapsed
  (`trial_expired`/`canceled`) presentation flagged in §2.5 step 5; the Subscribe/Manage billing
  popup on web (a blocked popup shows `POPUP_BLOCKED_MESSAGE`); the overage-mode toggle for the owner
  and its absence for a member.
- **The BillingBanner** across the inbox on a past-due workspace, for a member as well as the owner.
- **Settings → Workspace → the danger zone** (owner only; a member sees the one Muted line, ruling
  R24): the kill switch, the retention field at 30 and 730, Export (queued → ready → the download
  actually downloads a `.ndjson`), Request deletion's typed confirmation and the "your subscription
  was cancelled" / "needs re-subscribing" sentences (rulings R22/R23), Cancel deletion.
- **"Remember this reply"** on an owner-sent outbound message in a ticket, and its second tap
  reading *already remembered*.
- **The `/share` route** (27) from the real iOS share sheet and the real Android intent chooser — a
  link, a paragraph, a PDF, and a file of an unsupported type (which must NOT report success — the
  Task 10 fix). **On iOS the share must land on `/share` directly, never on "Page not found"**: the
  library reopens the app with `aesa://dataUrl=aesaShareKey`, which Expo Router routed to
  `+not-found` until the fix wave's `src/app/+native-intent.ts` (`redirectSystemPath`, ruling R34)
  sent it to `/`. Reasoned from both libraries' sources, provable only on the dev build — confirm
  it there, cold start and warm.
- **Push routing** for the `billing` and `workspace` kinds landing on the right settings screen from
  the notification shade.
- **Dark mode** on all of the above.
