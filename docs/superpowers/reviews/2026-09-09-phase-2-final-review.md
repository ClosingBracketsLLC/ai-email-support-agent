# Phase 2 — whole-branch final review record

Reviewed 2026-09-09 on branch `phase-2`, range `1b0fc34..e00a339` (50 commits after the fix wave).
Plan: `docs/superpowers/plans/2026-09-08-phase-2-mailboxes-ingest-triage.md` (23 tasks, 13 recorded
deviations). Execution: subagent-driven development — fresh implementer per task, a spec+quality review
per task (every task got one; 20 of 23 required at least one fix round, all converged within two), then
this whole-branch review and one final fix wave.

## Verdict

**"With fixes" — and the fixes landed.** The review found one Critical and four Important issues that the
23 task-scoped gates structurally could not see (each spans files owned by different tasks); a single
coordinated fix wave (`0015a74` code+tests, `e00a339` docs) resolved all of them, and a scoped re-review
verified every fix against the drizzle/pg-boss/better-auth sources rather than the comments. Gate after
the wave: **816 tests** across 12 packages/apps, typecheck, lint (zero `eslint-disable` repo-wide),
`db:check` no drift, 21-route Expo web export, Playwright smoke — all green.

## What the branch-level review found (all fixed in the wave)

- **C1 (Critical, a plan defect):** the same-org mailbox *reconnect* flips an existing connection to
  `pending_claim` without resetting `created_at`, while poll-sweep (b) deleted `pending_claim` rows keyed
  on `created_at` — so a routine reconnect (the designed response to Gmail's Testing-mode 7-day expiry)
  was deletable immediately: with tickets present the FK violation aborted the entire single-transaction
  poll-sweep platform-wide (retryLimit 0, every 2 min); without tickets it silently cascaded away the
  connection's agents and credentials. Both halves were written into the plan (sweep spec and reconnect
  spec) and never reconciled. Fix: sweep (b) keys on `updated_at`, never deletes a ticketed connection
  (reverts it to `reauth_required`, audited), and wraps each row in a SAVEPOINT so no single row can
  abort the other six sub-sweeps. Three regression tests pin the matrix.
- **I2:** the settings Mailboxes screen only offered a connect action when zero connections existed —
  the reauth banner, badge and `mailbox_reauth` push all dead-ended. The connect card now renders below
  the list always.
- **I3:** the spec's "draft churn zero rows" Verify item had no sync-level test (the reference's test was
  deliberately not ported and nothing replaced it). A DRAFT-labelled message through `runSync` now pins
  zero rows.
- **I4:** `mailbox.sync` declared a pg-boss retry policy its catch-everything handler made dead; removed
  with a comment pointing at the real retry layer (`consecutive_failures`/`backoff_until` + poll-sweep).
- **I5 (promoted from a parked Task 17 minor):** a `null` return from the `storeCredentials` enqueue
  (singleton dedupe) silently produced a *connected* connection with no credentials row and no recovery
  path. The flow now fails with `enqueue_failed`; a fresh connect deletes its just-created row, a
  reconnect reverts to `reauth_required`, both audited and tested.
- **Promoted minor:** `mailboxes.addAddress` now maps the unique-violation to `CONFLICT` instead of a
  masked 500.

## What the review verified holds

- **The three tenancy nets, end to end.** All 11 new tables carry `org_id` + `tenantPolicies()` + forced
  RLS; `withPlatform` appears at exactly 14 production call sites, none in the api; no tRPC procedure
  accepts an org id; `AESA_KEK*` reaches only the worker. The api's only credential contact is the
  one-way `sealTokens`.
- **Migration discipline.** 0005–0009 orderly; 0006/0009's SECURITY DEFINER ACL ordering (REVOKE/GRANT
  before `ALTER OWNER`, with the reproduced Postgres warning-not-error evidence) called out as the best
  SQL in the repo.
- **All 13 plan-header deviations are real, recorded, and in several cases better than the spec's literal
  text; no unrecorded spec deviation was found.**
- **The spec's Phase 2 mock-tier Verify list** is covered by tests (the one gap, draft churn, was I3);
  the live items (< 60 s push walk, Graph marker round-trip, watch renewal observation, fixture
  recording) are deliberately runbook-deferred (`docs/runbooks/2026-09-phase-2-external-setup.md`).

## Residuals and rulings the next phase inherits

The execution ledger's ~60 deferred minors were triaged: none blocks the merge; the full list with
verdicts lives in this record's source review. Named Phase 3 carries (also in STATUS.md): re-examine
DMARC's last-match clause selection before `autonomy.ts` makes it a decision lever; a claim-time
notification email to the connected mailbox (collapses most of the residual reverse-phish window — whose
lock-out amplification now has an operator break-glass procedure in the runbook §6); an index on
`push_subscription_id` (the Graph webhook hot path currently seq-scans); a `use-gate` regression test for
the setActive/cookieCache interaction (triaged as *not* the create-workspace bug — the client call
refreshes the cookie — but one render-loop assumption deserves a pin); marking a connection degraded on a
malformed pre-captured resync cursor. Accepted trade-offs, recorded with reasoning in the ledger and
STATUS.md: the platform-sender drop has no DMARC gate (a forger suppresses only their own message; the
runbook documents the `mailbox.platform_mail_skipped` grep); the DMARC parser inherits the reference's
last-match trust assumption; the fixture conformance tier cannot discriminate cursor-value threading (the
mock tier and the live walk do).

## Process note

C1 and I2 were invisible to per-task review because each spans two tasks' file sets, and the pre-flight
conflict scan paired producers with consumers but never asked "which task *deletes* rows another task
*creates*?" — that lens joins the next phase's scan. The Playwright smoke (again) and the final review
(again) earned their keep: the smoke surfaced a real ESM crash in the api's production entrypoint and a
cookie-cache stranding bug that no unit suite could see; the final review caught a reconnect-vs-sweep
interaction that 46 green task-gate verdicts had sailed past.
