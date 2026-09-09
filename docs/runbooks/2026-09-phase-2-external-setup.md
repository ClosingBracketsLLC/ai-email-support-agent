# Phase 2 external setup — Robert's checklist

Everything in this file happens OUTSIDE the codebase: console clicks, an external submission, and
one live run against real Gmail/Microsoft accounts. Phase 2's code is complete and gated (mock-tier
E2E in `apps/worker/test/e2e-phase2.test.ts`, unit/conformance suites elsewhere) without any of
this — nothing here blocks `main pnpm test`. It blocks shipping a mailbox connection to a real
customer.

**One rule that spans every section below: `MAIL_FROM` in `apps/api/.env` and `apps/worker/.env`
must be the IDENTICAL address.** The worker's sync walk drops any inbound mail claiming to be
FROM that address (so our own sign-in codes/invitations never become a customer ticket), and the
api's address-verification flow only honors a code mailed FROM that address. Configure both env
files from the same value; there is no runtime check that catches drift — a mismatch fails
silently in both directions (platform mail starts landing as noise tickets, or verification codes
stop being recognized) with no error at boot in either app. See `CLAUDE.md`'s Commands section for
the full Phase 2 env var list.

## 1. Google Cloud (mail)

One GCP project serves every tenant's Gmail connections (the spec's rate-limit design assumes a
single project-wide bucket).

1. **OAuth client** (APIs & Services → Credentials → Create OAuth client ID → Web application):
   - Authorized redirect URI: `<APP_BASE_URL>/connect/gmail/callback`.
   - Scopes requested at connect time (least privilege, `packages/mail/src/adapters/gmail/oauth.ts`):
     `gmail.readonly`, `gmail.send`, `openid`, `email`. `gmail.readonly` is a *restricted* scope —
     that's what Section 2 (CASA) exists for.
   - Record the client id/secret into **both** `apps/api/.env` (`GMAIL_OAUTH_CLIENT_ID/_SECRET` —
     the connect flow starts the OAuth dance) and `apps/worker/.env` (same names — the worker
     exchanges the code and later refreshes the token). They are the SAME OAuth client in both
     files, unlike `MAIL_FROM` which is the same *value* by convention, not the same *credential*.
2. **Pub/Sub topic + push subscription** (Pub/Sub → Topics → Create topic, e.g.
   `projects/<project>/topics/gmail-push`):
   - Grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on the topic
     (IAM tab on the topic, not the project) — this is the fixed Google-owned service account that
     Gmail's `users.watch` API publishes through; without this grant every `watch()` call the
     worker makes (`mailbox.renew-watch`) fails at the provider with a permission error and the
     mailbox silently falls back to poll-only cadence.
   - Create a **push** subscription on that topic delivering to `<APP_BASE_URL>/webhooks/gmail`,
     with an **OIDC token** authentication: a service account (create one, e.g.
     `gmail-pubsub-invoker@<project>.iam.gserviceaccount.com`) and an audience string (any stable
     value — the webhook verifies the token's `aud` claim against exactly this string).
   - Record: `GMAIL_PUBSUB_TOPIC` (worker `.env`, the full `projects/<p>/topics/<t>` path — this is
     what `mailbox.renew-watch`'s `subscribe()` call passes as Gmail's `topicName`), and
     `GMAIL_PUBSUB_AUDIENCE` + `GMAIL_PUBSUB_SA_EMAIL` (api `.env` — the service account's email
     and the audience string from the push subscription's OIDC config; `apps/api/src/webhooks/
     gmail.ts` verifies the bearer JWT's issuer (`https://accounts.google.com`), audience, and that
     `email`/`email_verified` match this service account before trusting a push).
3. **Test-user management (early access).** While the OAuth consent screen is in Testing mode
   (true until CASA clears, Section 2), only the ≤100 emails added as test users can complete the
   Gmail OAuth flow at all, and **their refresh tokens expire after 7 days** — the app's health
   surfacing treats credential age as a scheduled reconnect (a banner at day 5). `gmail_access_
   requests` (`packages/db/src/schema/mail.ts`) is the queue the "Request Gmail early access"
   onboarding button writes to (`mailboxes.requestGmailAccess`, api). Operator loop: query that
   table (`SELECT email, org_id, requested_at FROM gmail_access_requests WHERE granted_at IS
   NULL`), add each email as a test user in the OAuth consent screen within a day, then stamp
   `granted_at` by hand (no automated sync back from Google's console).

## 2. CASA Tier 2 — start the submission NOW

This is a 4–12 week, self-serve-lab clock (spec §Launch risks) that runs independently of any
code in this repo, and Google's restricted-scope verification requires it before the Gmail
consent screen can leave Testing mode (100-test-user cap) for a public launch. Microsoft 365
carries no equivalent third-party audit — it is already launchable on admin consent alone, which
is why the spec's launch order puts Microsoft first and lets Gmail trail behind this clock.

1. Start the **OAuth app verification** request in the Google Cloud console (APIs & Services →
   OAuth consent screen → "Prepare for verification"), declaring the `gmail.readonly` (restricted)
   and `gmail.send` (sensitive) scopes.
2. Google routes restricted-scope apps to a **CASA Tier 2** self-assessment: a self-serve
   third-party security lab, roughly **$540–1,000**, renewed **annually**. Pick a lab from Google's
   approved list once the verification team requests it.
3. **Evidence this design already produces** (hand these to the lab/verification team as-is, no
   extra work):
   - The RLS + tenant-isolation suite (`packages/db/test/rls.test.ts`) — FORCED row-level security
     on every tenant table, exactly two policies each.
   - Envelope encryption + the KEK ring (`packages/crypto`) — `mailbox_credentials`' refresh/access
     tokens are AES-256-GCM sealed per-org, platform-role-only (never touched by the api).
   - The SSRF guard (`pinnedFetch`/`validateOutboundUrl`/`resolvePublic`, `packages/crypto`).
   - Audited platform access — every `withPlatform()` call writes an `audit_log` row.
   - Scrubbed fixtures — `packages/test-kit`'s recorder runs `assertScrubbed` before anything
     recorded from a real mailbox is allowed to be committed (Section 5).
   - Secret redaction — `Secret` serializes as `[redacted]`; the api's error handler strips SQL
     parameters and redacts URLs before anything reaches a log.
4. **Deliverable: record the submission ticket id and date here once started** —
   `<ticket id — fill in when the verification request is submitted>`.

## 3. Microsoft Entra (mail)

1. **App registration** (Entra admin center → App registrations → New registration):
   - Supported account types: accounts in any organizational directory AND personal Microsoft
     accounts (tenant `common` — the same value the app authorizes against for BOTH personal and
     work/school accounts; `packages/mail/src/adapters/graph/oauth.ts`).
   - Redirect URI (Web platform): `<APP_BASE_URL>/connect/microsoft/callback`.
   - API permissions (Delegated, Microsoft Graph): `offline_access`, `User.Read`, `Mail.ReadWrite`,
     `Mail.Send`. `Mail.ReadWrite` (not the narrower `Mail.Read`) is required because Graph's
     `createReply` — the only mechanism that sets the reply's threading headers correctly — needs
     write access; the connect-flow consent copy already states this plainly and that every Graph
     write this app makes is audited.
   - A work/school tenant's admin may need to grant admin consent up front (`AADSTS65001` is the
     recovery path the connect flow classifies automatically — `mailboxes.adminConsentInfo`
     produces the `https://login.microsoftonline.com/common/adminconsent` link the owner mails to
     their admin). Microsoft publisher verification (MPN) is a Phase 1+ item per the spec, not a
     gate on connecting a mailbox.
   - Record the client id/secret into `apps/api/.env` and `apps/worker/.env` as `MS_OAUTH_CLIENT_
     ID`/`_SECRET` (same client in both files, same reasoning as the Gmail pair above).
2. **`WEBHOOK_PUBLIC_URL`** (worker `.env`) must be a PUBLICLY reachable https origin — Graph's
   subscription validation handshake (`POST /webhooks/microsoft?validationToken=…`, echoed back as
   `text/plain` within 10 s) and every change notification land on `${WEBHOOK_PUBLIC_URL}/webhooks/
   microsoft`. In dev, that means a tunnel (`ngrok http $PORT` or equivalent) pointed at the api,
   with `WEBHOOK_PUBLIC_URL` set to the tunnel's https URL and `APP_BASE_URL` matching it too (the
   redirect URI above is derived from `APP_BASE_URL`). No Gmail equivalent — Pub/Sub push delivers
   to whatever endpoint the subscription in Section 1 already names.

## 4. Live verification walk

Do this once both providers above are configured end-to-end (real OAuth clients, real push
delivery) — it's the one check nothing in the automated suites can stand in for.

1. **Gmail**: add a real Gmail address as a consent-screen test user (Section 1.3), connect it
   through the app, tick it as the primary address, send it a test mail from a second account.
   Expect a triaged ticket visible in **under 60 seconds** with push armed. Then disable push (or
   revoke the subscription) and repeat: expect a triaged ticket within **under 3 minutes**
   (`mailbox.poll-sweep`'s cadence, push-optional by design).
2. **Microsoft 365**: same walk against an M365 sandbox tenant (a Microsoft 365 developer tenant
   works and needs no admin-consent step for its own admin). Same two timings.
3. **Observe, don't just infer**, in the worker's log during this walk:
   - The Graph subscription validation handshake succeeding at `POST /me/subscriptions` time
     (`mailbox.renew-watch`), and one **Gmail watch renewal** actually firing before the 7-day
     `users.watch` expiry (renew fires at < 36 h remaining — either wait for it naturally on a
     long-lived sandbox connection or temporarily shorten the renew threshold to force one; revert
     before shipping).
4. **Graph `PS_INTERNET_HEADERS` marker — the 4-point live-evidence checklist** (flagged by the
   Task 10 review as a mechanism that is internally coherent in the mock but has never round-tripped
   against real Graph; confirm all four on this same live M365 walk, using a real reply sent through
   the app):
   - The `X-Aesa-Draft` marker, stamped via Graph's `singleValueLegacyExtendedProperty` mechanism
     (namespace GUID `{00020386-0000-0000-C000-000000000046}`, `packages/mail/src/adapters/graph/
     client.ts`), **survives the full send pipeline** — `createReply` → `PATCH` (marker attached) →
     `/send` — and is still readable on the message once it lands in **Sent Items**, not just on the
     draft before sending.
   - This holds for **both account types under tenant `common`**: a personal Microsoft account and
     a work/school (Microsoft 365) account.
   - `findSentByMarker`'s **exact query shape** returns the marker on a real thread: `GET
     /me/messages?$filter=conversationId eq '<threadId>'&$select=id,internetMessageHeaders&
     $orderby=receivedDateTime desc`, scanning each returned message's `internetMessageHeaders` for
     the `X-Aesa-Draft` header — confirm the header is actually present in that array for a message
     fetched this way (not only via a direct single-message GET).
   - A **re-PATCH replaces, not duplicates**: send a reply, then (simulating the crash-recovery
     re-entry path) PATCH the SAME draft id's extended property a second time before sending —
     confirm the message ends up with exactly one `X-Aesa-Draft` header, not two.

## 5. Fixture recording

`packages/test-kit`'s recorder (`MAIL_RECORD=1`) captures real Gmail/Graph responses and scrubs
them before they can be committed — this is what turns the live walk above into fixtures the
conformance suite (`packages/test-kit`) runs on every `pnpm test`, forever, with no live
credentials needed again.

1. Use the SAME sandbox credentials as Section 4 (a test-user Gmail account, the M365 sandbox).
2. Run the recorder (`MAIL_RECORD=1` against the conformance/fixture scripts in `packages/test-
   kit`) through the same scenarios the mock-tier E2E suite covers: inbound → ticket, re-poll,
   reopen, cursor-expired resync, thread walk.
3. The recorder's own `assertScrubbed` gate runs before anything is written to disk — a fixture
   that still contains a real token, address, or body fragment the scrubber should have masked
   fails the recording outright rather than landing in the repo. Do not bypass it.
4. Commit the resulting fixtures. **They replace the hand-authored ones where they overlap** (Task
   12 shipped 6 hand-authored fixtures as a placeholder, flagged in the ledger for exactly this
   swap) — diff the new fixture set against `packages/mail`'s existing hand-authored fixtures and
   delete the ones a recorded fixture now supersedes, rather than keeping both.
