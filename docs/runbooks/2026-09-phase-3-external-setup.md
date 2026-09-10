# Phase 3 external setup — Robert's checklist

Everything in this file happens OUTSIDE the codebase: environment values on the deployed replicas,
one live send/reply walk against real Gmail and Microsoft 365 accounts, one recorded fixture, and
two device checks. Phase 3's code is complete and gated without any of it — the mock-tier E2E
(`apps/worker/test/e2e-phase3.test.ts`) drives all twenty verification scenarios through real
pg-boss jobs and the real api draft service in **21 cases** (scenario 6 is split into 6a and 6b),
and nothing here blocks `pnpm test`. What it blocks is letting a real reply leave the building.

Read `docs/runbooks/2026-09-phase-2-external-setup.md` first if the mailbox side is not already
live: the Google Cloud OAuth client + Pub/Sub topic, the CASA Tier 2 submission, the Entra app
registration and the Resend sending domain are all Phase 2 steps this phase assumes are done.

**The rule that spans every section, carried from Phase 2 and now with a second and third member:
`MAIL_FROM`, `APP_BASE_URL` and `APP_WEB_ORIGIN` must be IDENTICAL in `apps/api/.env` and
`apps/worker/.env`.** Each app reads only its own `.env` (`loadDotEnv` never reads the repo root),
there is no runtime check on any of the three, and every mismatch fails silently:

| variable | what breaks on drift | how it looks |
| --- | --- | --- |
| `MAIL_FROM` | the worker's sync walk stops recognizing platform mail; the api stops recognizing verification codes | sign-in codes become customer tickets, alias verification never completes |
| `APP_BASE_URL` | the digest email's `Approve:` links point at an origin the api does not serve | one-click review 404s, or the token resolves on a host with no session cookie |
| `APP_WEB_ORIGIN` | the digest email's "open the ticket" links point at the wrong app origin | the owner lands on a blank page instead of the ticket |

## 1. Environment

Both `.env.example` files are the reference for the complete list; this is what is NEW or newly
load-bearing in Phase 3.

**`apps/worker/.env`**

- `WORKER_ROLES` — must include **`send`** on the replica that holds the KEK ring and the OAuth
  pairs. `maybeRegisterSendRole` refuses to boot in production when `send` is listed without
  `AESA_KEK_V<n>`/`AESA_KEK_ACTIVE` or without at least one of the
  `GMAIL_OAUTH_CLIENT_ID`/`_SECRET` / `MS_OAUTH_CLIENT_ID`/`_SECRET` pairs — deliberately loud,
  because a `send` replica missing either would look healthy while every approved reply silently
  never went out. In dev/test the same gate logs a warning and skips registration.
  A replica list that works: one `sync,send,agent,cron` box to start; split `cron` off first when
  you scale out, since the crons are singleton-keyed and the digest email is a `cron`-role job.
- `ANTHROPIC_API_KEY` — required in production when `WORKER_ROLES` includes `agent`; it now serves
  `ticket.triage`, `ticket.draft` AND `agent.sandbox` (one `createManagedProvider` per role, so
  every call is metered into `llm_calls`). **Set an Anthropic Console workspace spend limit as the
  backstop.** The in-product caps (`autonomy.daily_llm_usd_cap`, default $60/org/day; the $0.40
  per-run stop-loss) are per-org and per-run; the Console limit is what stops a platform-wide
  runaway.
- `EMAIL_TRANSPORT=resend` + `RESEND_API_KEY` + `MAIL_FROM` — the worker now SENDS platform mail
  (the daily digest email) through the same `@aesa/platform-mail` transport the api uses. Required
  in production on any replica whose `WORKER_ROLES` includes `cron`; a replica without `cron` sends
  no platform mail and needs none of it. `MAIL_FROM` must equal the api's (table above).
- `APP_BASE_URL` + `APP_WEB_ORIGIN` — the digest email's two link bases
  (`<APP_BASE_URL>/a/<draftId>?t=<token>` to approve, `<APP_WEB_ORIGIN>/ticket/<id>` to open).
  **Both must be set or the digest email pass stays off entirely** (the 5-minute push digest still
  runs). Must equal the api's (table above).

**`apps/api/.env`** — nothing new in Phase 3. The review pages (`/a/:draftId?t=`) are served by the
api on `APP_BASE_URL` and need no new variable; the drafts/activity/agents routers need none either.

## 2. Live verification walk (both providers)

Do the whole walk twice — once with a Gmail test user's mailbox connected, once with the Microsoft
365 sandbox tenant's — and drive it from a real phone with a dev build (Section 4).

1. **Connect** a Gmail test user (still inside the ≤100 test-user list until CASA clears) and the
   M365 sandbox mailbox, per the Phase 2 runbook.
2. **Ask a question from outside.** From a personal **Gmail** address AND from an **outlook.com**
   address, send an ordinary support question to each connected agent address. Four inbound
   messages total (2 senders × 2 mailboxes) — the cross-product is the point: it is the only way to
   exercise both DMARC stamps against both providers' header shapes.
3. **The draft appears** in **To review** in the app, and on the phone as a push carrying the
   Review and Hold actions.
4. **Approve from the phone.** Then check, in the customer's own client:
   - the reply lands **in the same conversation** — in Gmail's threaded view AND in Outlook's — not
     as a new message;
   - it is **from the agent's address**, not the platform sender;
   - it ends with the agent's **signature** (appended by code after validation, never by the model).
5. **The business's Sent folder has the copy.** Look in the connected mailbox itself: the reply is
   a real sent message, not something that exists only in our database.
6. **A follow-up threads onto the same ticket.** Reply again from the customer address; it must
   reopen the SAME ticket (not open a second one) and produce a fresh draft.
7. **Redeploy the worker mid-thread**, then send one more follow-up: it must still thread onto the
   same ticket. (This is what proves nothing thread-critical lives in process memory.)
8. **Check the metering.** In the database, for the org you just used:
   - `select role, count(*) from llm_calls where org_id = '<org>' group by role;` — **two rows per
     draft when the structured-output ladder fell through** to a repair/extract rung, **one
     otherwise**; one triage row per ticket.
   - **The SECOND draft within the same hour shows `cache_read_tokens > 0`.** That is the 1-hour
     static-prefix cache breakpoint actually paying off. If it is 0 on the second draft, the static
     prefix is not clearing the model's cache minimum — capture the request and raise it before
     Section 3.

## 3. Record the cache-hit fixture

`packages/llm/test/anthropic.test.ts`'s "(g) reports cache_read tokens per response" is the only
test that proves prompt caching is wired, and no test can produce its input: only a live call
reports a cache hit. Record it by hand, from the same machine/account as Section 2:

    LLM_RECORD=1 ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @aesa/llm exec tsx scripts/record-cache-hit.ts

It sends the same ~1,500-token static-block request twice, one second apart, captures each response
BODY only (never a request, never a header — the bearer token is excluded structurally), re-checks
the captured body for `sk-`/`Bearer `/PEM material, and rewrites
`packages/llm/test/fixtures/anthropic/draft-cache-hit.json` from the SECOND response. **It exits 1
and writes nothing unless that response reports `cache_read_input_tokens > 0`.**

Then `git add packages/llm/test/fixtures/anthropic/draft-cache-hit.json` and commit it. The script
never runs in CI: it is inert unless it is the process entry point AND `LLM_RECORD=1`, and it makes
a real, billed API call. Override the model with `RECORD_MODEL=<id>` if the recording account cannot
call `claude-sonnet-5`.

## 4. Push categories need a dev build

The Review / Hold action buttons on the `draft_review` push are a **notification category**, and
**Expo Go does not render custom categories** — it has no way to register them. Build a dev client
(EAS) and install it on a real device:

    eas build --profile development --platform ios
    eas build --profile development --platform android

Then, on **both** iOS and Android, with the app backgrounded:

- a draft-ready push arrives carrying **Review** and **Hold** on the notification itself
  (long-press on iOS, expand on Android);
- **Review** opens the ticket with the draft on screen;
- **Hold** holds an approved-not-yet-sent draft (the undo window). On a still-`pending` draft there
  is nothing to hold — the server answers `not_holdable` and the tap just opens the ticket. That is
  the designed behaviour, not a bug.

## 5. Digest email

- The sending domain is the Resend domain from the Phase 1 runbook — no new domain setup.
- **Confirm one email per org per local day at 08:00**, in the workspace's own timezone, to every
  owner and admin, with working links: `Approve:` (`<APP_BASE_URL>/a/<draftId>?t=…`, a single-use
  token minted per RECIPIENT so a forwarded email can never act as someone else) and the
  "open the ticket" link (`<APP_WEB_ORIGIN>/ticket/<id>`). Tokens are valid 7 days.
- A partner who wants a different hour: set `notifications.digest_email_hour` (0-23, local) for
  that org in `org_settings`. `notifications.digest_email` (default true) turns the channel off per
  org. The once-per-day lock is a `notifications` row keyed `digest_email:<orgId>:<localDay>`; if
  you need to re-send a day's digest for a support reason, delete that row.

## 6. Operator notes

- **`platform_state` `killswitch.global` stops drafting AND sending.** `ticket.draft` treats it as
  a policy no-op (no stamp, no run row, no model call, nothing written); `send.execute` holds the
  ledger row and the draft together and pages the owner with "Reply on hold". Set it with
  `insert into platform_state (key, value) values ('killswitch.global', 'true') on conflict (key)
  do update set value = 'true';` and clear it by deleting the row. Per-workspace equivalents:
  `workspaces.kill_switch` (read but not yet exposed in Settings — Phase 7) and
  `workspaces.agent_enabled` (the master switch the owner controls in-app). While the lever is set,
  `ticket.backstop-sweep` also stops selecting tickets for new draft runs (it logs
  `ticket.backstop_sweep_draft_selection_skipped_killswitch` once per pass); its recovery arms —
  stuck runs, orphaned tickets, tickets stranded at the failure ceiling, and due sends — keep
  running, so the lever pauses the agent without blinding the owner to what is stuck.
- **The daily-budget notification.** When an org's `llm_cost_micros` for the UTC day reaches
  `autonomy.daily_llm_usd_cap` (default $60), drafting stops for that org and the owner is paged
  ONCE per day, "Daily AI budget reached". Tickets are left `triaged` and untouched, so they are
  selectable again after UTC midnight with no manual intervention.
- **A held send re-queues on re-approve.** `drafts.resume` puts a `held` draft back to `pending`
  ("Back to review" in the app); the ledger row stays `held` and the next approve revives that SAME
  row through the upsert, so the delivery keeps its history (attempts, provider ids) instead of
  starting a second one. Fix the cause first (the kill lever, the reauth) or the next attempt holds
  again.
- **A dead-lettered send lands the ticket in `needs_owner/send_failed`.** That is the last pg-boss
  attempt giving up; `outbound_sends.last_error` carries the real reason and the owner is paged.
  The way back: **fix the cause, open the ticket, tap Back to review, then Approve — the same send
  row re-queues.** "Back to review" is `drafts.resume`, which now accepts a `failed` draft as well
  as a `held` one (`failed → pending`), and — when the ticket is sitting on
  `needs_owner/send_failed` — walks the ticket back to `awaiting_review` at the same time. The
  ticket screen surfaces the failed draft with a "Not sent — …" banner and that button (the send
  row's `last_error` chooses the sentence). Never insert a second `outbound_sends` row for a draft:
  the unique on `draft_id` is what makes a double send impossible, and the re-approve revives the
  same row (`attempts` back to 0, `last_error` cleared) instead of starting a second one.
  Refusals to know about: a resume is refused (`resumed: false`, an in-app note) while another live
  draft already exists on that ticket — a re-draft that landed in the meantime is the reply to work
  with instead — and it is refused unless the ticket is still `needs_owner/send_failed` or `triaged`
  (the stale hand-back). A ticket the owner has since resolved, or that a customer reply reopened,
  keeps its `failed` draft as history: the ticket screen shows no banner and no button there, and the
  recovery is an ordinary fresh reply on the reopened thread.
- **Nothing sends twice.** Every reply carries `X-Aesa-Draft: <draftId>`, and any re-entered run
  scans the thread for its own marker BEFORE anything else. If you ever have to reason about
  "did it actually go out?", search the connected mailbox for that header value — that, not our
  database, is the ground truth.
