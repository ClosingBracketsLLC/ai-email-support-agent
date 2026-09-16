# CASA Tier 2 evidence package (OWASP ASVS control areas)

Written 2026-09-16 at the close of Phase 7, from the code on branch `phase-7`. This is the document
handed to the CASA assessor (Google's Cloud Application Security Assessment for the Gmail
restricted-scope OAuth client — the `gmail.readonly`/`gmail.send`-class scopes the mailbox connect
flow requests). It is organised by the ASVS control areas an assessor asks about, one row per
control: **what the control is here, the file that implements it, the test that enforces it, and the
runbook step that operates it.** Every path cited exists in the repository at the commit this
document was written on; nothing here describes an intention.

Two conventions the whole codebase follows, which most rows lean on:

- **Tenancy is enforced in the database, not in application code.** Every tenant table has row-level
  security ENABLED and FORCED with exactly two policies (`<table>_org_isolation` for the app role,
  keyed on the `app.org_id` setting; `<table>_platform_all` for the platform role), and the app
  role's transaction sets that setting from the authenticated session's active organization — never
  from request input (`packages/db/src/tenant.ts`, `apps/api/src/trpc/init.ts`).
- **Secrets are typed.** Anything that must never be logged or returned is a `Secret`
  (`packages/crypto/src/secret.ts`), which serialises as `[redacted]` under `JSON.stringify`,
  `String()` and `util.inspect`; provider keys and OAuth tokens are encrypted at rest under a
  per-organization data key wrapped by a key-encryption-key ring the api process never holds.

The context for the assessor: the platform is a multi-tenant SaaS (`apps/api` Fastify + tRPC +
Better Auth; `apps/worker` pg-boss jobs; `apps/app` Expo; Postgres 17) whose worker reads a
business's support mailbox over Gmail or Microsoft Graph, drafts replies with a model, and — only
after a human approval or a graduated category's automatic decision — sends them from that mailbox.
Customer email content is processed by the worker, stored under the workspace's retention window,
and never leaves the platform except to the model provider the workspace chose (Anthropic by
default; a provider the customer's own key names under BYOK).

---

## V2 — Authentication

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Sign-in is by email one-time code (6 digits, 10-minute expiry, 3 attempts, stored hashed) or by Google/Microsoft OIDC SSO; no passwords exist | `apps/api/src/auth.ts` (`emailOTP({ otpLength: 6, expiresIn: 600, allowedAttempts: 3, storeOTP: 'hashed' })`), Better Auth 1.7.3 | `apps/api/test/auth.test.ts`, `auth-errors.test.ts` | Phase 1 runbook (the Better Auth secret, the SSO clients) |
| Sign-in codes are sent by the platform's own transport and never logged; the devsink exists only outside production | `packages/platform-mail/src/` (`MailTransport`, Resend in production), `apps/api/src/config.ts` (`parseMailConfig` refuses `devsink` in production) | `apps/api/test/config.test.ts`, `packages/platform-mail/test/` | Phase 1 runbook (the Resend sending domain) |
| Authentication endpoints are rate-limited per client IP; the limiter is refused in production without a trusted proxy header | `apps/api/src/auth.ts` (`rateLimit`), `apps/api/src/config.ts` (`AUTH_RATE_LIMIT=on requires TRUST_PROXY in production`), `apps/api/src/server.ts` (`@fastify/rate-limit`, `global: true`) | `apps/api/test/rate-limit.test.ts`, `config.test.ts` | Phase 7 runbook §2.3 (sizing against Stripe's delivery burst) |
| Mailbox access is OAuth 2.0 with PKCE; the refresh token is sealed to the organization's public key in the api and re-wrapped by the worker — the api never stores a usable token | `apps/api/src/connect/{flows,routes}.ts`, `apps/worker/src/jobs/mailbox-credentials.ts`, `packages/crypto/src/sealed-box.ts` | `apps/api/test/connect-flow.test.ts`, `apps/worker/test/mailbox-credentials.test.ts`, `packages/crypto/test/sealed-box.test.ts` | Phase 2 runbook (the OAuth clients, publisher verification) |
| The one-click review pages (`/a/:draftId?t=`) authenticate by a single-use, domain-separated, hashed action token with its own retention | `packages/crypto/src/tokens.ts` (`hashToken('action', …)`), `apps/api/src/review/routes.ts`, `apps/worker/src/jobs/sweeps-daily.ts` (token retention) | `packages/crypto/test/tokens.test.ts`, `apps/api/test/review-pages.test.ts`, `apps/worker/test/sweeps-daily.test.ts` | Phase 3 runbook (the digest email's links) |

## V3 — Session management

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Sessions are Better Auth cookie sessions; the signed cookie cache is 60 s so a revoked session is refused within a minute; cookies are `secure`/`SameSite=None` only when cross-site is explicitly configured | `apps/api/src/auth.ts` (`session.cookieCache.maxAge: 60`, `defaultCookieAttributes`) | `apps/api/test/auth.test.ts` | — |
| Every tRPC mutation is protected against cross-site request forgery by an `Origin` check against the configured web origins | `apps/api/src/server.ts` (the `/trpc` CSRF hook), `apps/api/src/config.ts` (`APP_WEB_ORIGIN`, `trustedOrigins`) | `apps/api/test/trpc-origin.test.ts` | Phase 1 runbook (`APP_WEB_ORIGIN`) |
| The organization a request acts on comes from the session's active organization plus a membership lookup, never from the request body | `apps/api/src/trpc/init.ts` (`orgProcedure`: `getActiveMember`) | `apps/api/test/team.test.ts`, `workspace.test.ts` | — |
| A purged workspace's sessions are detached first (`session.active_organization_id` nulled) before the organization row is deleted | `packages/db/src/purge.ts` (`purgeAuthRows`) | `packages/db/test/purge.test.ts`, `apps/worker/test/workspace-purge.test.ts` | Phase 7 runbook §7 |

## V4 — Access control

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| **Tenant isolation is row-level security, enabled AND forced, on every ordinary table; exactly two policies per table; the exempt list is explicit** | `packages/db/src/schema/helpers.ts` (`tenantPolicies`), every hardening migration's `FORCE ROW LEVEL SECURITY`, `packages/db/src/tenant.ts` (`withOrg` sets `app.org_id`) | `packages/db/test/rls.test.ts` (asserts the policy pair on every non-exempt table), `test/helpers/tables.ts` (`RLS_EXEMPT`, `EXPECTED_TABLES` exact) | Phase 7 runbook §6 step 4 (the daily zero-cross-org-rows query) |
| Cross-tenant access exists only through `withPlatform(db, reason, fn)`, which writes an audit row per call; raw database handles are import-banned outside the db package | `packages/db/src/tenant.ts`, `eslint.config.js` (`@typescript-eslint/no-restricted-imports` on `@aesa/db/raw`, `pg`, `drizzle-orm/node-postgres`) | `packages/db/test/tenant.test.ts`, `audit.test.ts`; `pnpm lint` | Phase 7 runbook §6 step 3 (the daily `platform.access` read) |
| Retrieval into a prompt re-checks tenancy in application code as well: every leg filters `org_id` in SQL and `assertSameOrg` THROWS on a foreign row before anything reaches a model | `packages/knowledge/src/retrieval/` (`sql.ts`, `assertSameOrg`) | `packages/knowledge/test/retrieval.test.ts` ("never returns another org's chunk (100 orgs loaded)", "assertSameOrg throws on a foreign row"), `retrieval-answers.test.ts` | — |
| Role-based procedures: `orgProcedure` (any member) → `managerProcedure` (owner or admin) → `ownerProcedure` (owner only: buying, cancelling, deleting, exporting a workspace, its kill switch and retention) | `apps/api/src/trpc/init.ts`, `apps/api/src/trpc/routers/{billing,workspace}.ts`, `apps/api/src/workspace/lifecycle.ts` (`exportStatus` mints the download URL for the owner only — ruling R21) | `apps/api/test/billing-router.test.ts`, `workspace-lifecycle.test.ts`, `team.test.ts` | Phase 7 runbook §11 |
| Platform-only tables: `mailbox_credentials` and `llm_credential_secrets` are `REVOKE`d from the api's database role outright | `packages/db/migrations/0006_mail_hardening.sql`, `0020_provider_hardening.sql` | `packages/db/test/mail-schema.test.ts` ("aesa_app has NO privilege on the credentials table"), `llm-tables.test.ts` ("aesa_app has NO privilege on llm_credential_secrets") | Phase 6 runbook §2 |
| The api's one cross-tenant read for a webhook (Stripe customer → org) is a SECURITY DEFINER function owned by the platform role with `EXECUTE` granted to the app role alone; the same shape as the mail webhooks' resolver | `packages/db/migrations/0023_billing_hardening.sql` (`resolve_stripe_customer`), `0006_mail_hardening.sql` (`resolve_mailbox_connection`) | `packages/db/test/billing.test.ts`, `mail-schema.test.ts` (pins the resolver list) | Phase 7 runbook §1 |

## V5 — Validation, sanitisation and encoding

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Every API input is a zod schema shared by api and app; the contracts package is zod-only with no Node imports | `packages/contracts/src/*.ts` | `packages/contracts/test/`, `apps/api/test/*-router.test.ts` | — |
| Webhook payloads are DATA: every Stripe/Gmail/Graph object is narrowed by a zod schema; a shape that does not parse is `ignored` with a warn, never a throw or a write | `apps/api/src/billing/webhook.ts`, `apps/api/src/webhooks/{gmail,microsoft}.ts` | `apps/api/test/billing-webhook.test.ts`, `webhooks.test.ts` | Phase 7 runbook §2.3 |
| Inbound email is parsed by a fixed pipeline (RFC 2822, address, body, threading) with fixtures recorded and scrubbed; HTML is never rendered server-side | `packages/mail/src/` (`rfc2822.ts`, `body.ts`, `address.ts`, `threading.ts`), `packages/test-kit` (the scrubbed recorder) | `packages/mail/test/` (12 files), `packages/test-kit`'s provider conformance suite | Phase 2 runbook (recording real fixtures) |
| **Prompt injection**: every knowledge chunk is screened before storage and a flagged chunk is stored but never retrieved until an owner clears it; retrieval excludes it in SQL and again on the re-read | `packages/knowledge/src/injection.ts` (`screenChunk`), `retrieval/sql.ts` | `packages/knowledge/test/injection.test.ts`, `retrieval.test.ts` | Phase 4 runbook |
| **Outbound reply guardrails**: the model's body, the owner's edited body and the final body about to be sent are all screened by ONE validator against ONE per-tenant policy (platform hard rules, persona, operating guidance, agent guidance; allowed link hosts; unbacked numbers) | `packages/core/src/guardrails/{validator,screens,policy,shingles}.ts`, `packages/agent/src/policy.ts` (`buildReplyPolicy`), the three gates in `apps/worker/src/jobs/{ticket-draft,send-execute}.ts` and `apps/api/src/drafts/service.ts` | `packages/core/test/guardrails.test.ts`, `packages/agent/test/policy.test.ts`, `apps/api/test/drafts-service.test.ts`, `apps/worker/test/send-execute.test.ts` | Phase 3 runbook |
| The tripwire (a customer's message that must not be answered by a machine) is evaluated before any model call | `packages/core/src/tripwire.ts`, `apps/worker/src/jobs/ticket-triage.ts` | `packages/core/test/tripwire.test.ts`, `apps/worker/test/ticket-triage.test.ts` | — |

## V6 — Stored cryptography and key management

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Envelope encryption: each organization has a data-encryption key (DEK) wrapped under a key-encryption-key ring (`AESA_KEK_V<n>` / `AESA_KEK_ACTIVE`); row secrets are AES-256-GCM under the DEK with additional authenticated data naming the org, table and row | `packages/crypto/src/envelope.ts`, `packages/db/src/keys.ts` (`org_data_keys`, `rewrapOrgDek`), `apps/worker/src/provider-resolver.ts` (`secretAad`) | `packages/crypto/test/envelope.test.ts`, `packages/db/test/keys.test.ts` | Phase 3/6 runbooks (the ring on every `sync`/`send`/`agent` replica) |
| The api never holds the KEK; its config refuses to boot with key material present | `apps/api/src/config.ts` ("api must not be configured with key material") | `apps/api/test/config.test.ts` | Phase 6 runbook §2 |
| Secrets in flight from api to worker (a pasted provider key, an OAuth token) are sealed to the org's libsodium box public key and travel only on a job payload | `packages/crypto/src/sealed-box.ts`, `apps/api/src/llm/service.ts`, `apps/api/src/connect/routes.ts` | `packages/crypto/test/sealed-box.test.ts`, `apps/worker/test/llm-probe.test.ts` (the re-wrap byte guard), `mailbox-credentials.test.ts` | Phase 6 runbook §2 |
| **Key rotation is a runbook'd job**: `keys.rotate` re-wraps one org's DEK under the active KEK, guarded on the exact bytes it read; the operator script enqueues every org behind the active version and is safe to re-run; a ring that cannot unwrap a row throws and leaves the row untouched | `apps/worker/src/jobs/keys-rotate.ts`, `apps/worker/scripts/keys-rotate.ts`, `packages/db/src/keys.ts` (`rewrapOrgDek`) | `apps/worker/test/keys-rotate.test.ts` (decrypts a real mailbox token and a real BYOK key after the re-wrap), `apps/worker/test/e2e-phase7.test.ts` scenario 9 | **Phase 7 runbook §4 (the four-step rotation and the cost of skipping a step)** |
| Tokens that are compared, never decrypted (action tokens, webhook client state, OTP) are hashed with domain separation and compared in constant time | `packages/crypto/src/tokens.ts` (`hashToken`, `hashesEqual`) | `packages/crypto/test/tokens.test.ts` | — |
| Customer identity in learned answers is a salted hash with a per-workspace salt, so a learned answer never stores an address | `packages/db/src/memory.ts` (`customerHash`, `ensureCustomerHashSalt`) | `packages/db/test/memory.test.ts` | Phase 5 runbook |

## V7 — Error handling and logging

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Secrets never reach a log or a client: `Secret` serialises as `[redacted]`; the api error handler strips SQL parameters and redacts URLs; the api's pino `err` serializer collapses a query error's SQL and bound values; the worker's pino config redacts token paths and its job failures are scrubbed before they are logged | `packages/crypto/src/secret.ts`, `apps/api/src/pg-error.ts`, `apps/api/src/logging.ts`, `apps/worker/src/logging.ts`, `packages/queue/src/define-job.ts` | `packages/crypto/test/secret.test.ts`, `apps/api/test/error-handler.test.ts`, `logging.test.ts`, `apps/worker/test/logging.test.ts` | — |
| **One redaction implementation** for both processes (`redactText`, `redactUrl`, `scrubKeys`, `redactHeaders`, `redactQueryParams`, `redactBreadcrumbMessage`) — ruling R25 | `packages/core/src/redact.ts` (the api's `src/redact.ts` is a re-export) | `packages/core/test/redact.test.ts`, `apps/api/test/redact.test.ts` | — |
| **Error reporting to a third party (Sentry) has an EVENT-level PII boundary**: `beforeSend` runs on every event however captured and redacts exception messages, breadcrumb messages, strips request bodies, sensitive headers, and the one-click token from URLs, query strings and header values. The Phase 7 review found two Critical leaks on this path (a session cookie in `request.headers`, and customer text in a `DrizzleQueryError` message reaching Sentry through Fastify's own handler) and both are closed by the boundary rather than at the call site | `apps/api/src/observability.ts`, `apps/worker/src/observability.ts` (`beforeSend`, `captureWithOrg`, `alert`) | **`apps/api/test/observability.test.ts`, `apps/worker/test/observability.test.ts`** (a fake transport reads back the event `beforeSend` produced; the cookie, the token and the query text are asserted absent) | Phase 7 runbook §3.1 (`--inspect` is the one thing the boundary cannot reach) |
| Job errors are scrubbed before pg-boss persists them, for every job at once | `packages/queue/src/define-job.ts` (`scrubJobError` in `registerJob`'s catch) | `packages/queue/test/define-job.test.ts` | — |
| Every tenant-visible mutation and every platform-role access writes an audit row with a typed actor (`user:<id>` / `agent:<run_id>` / `system:<job>`); the tenant trail is retained 730 days and the platform trail 30 | `packages/db/src/audit.ts`, `tenant.ts` (`withPlatform`), `apps/worker/src/jobs/{retention-sweep,sweeps-daily}.ts` | `packages/db/test/audit.test.ts`, `apps/worker/test/retention-sweep.test.ts`, `sweeps-daily.test.ts` | Phase 7 runbook §6 step 3, §7 |
| Operator alerts are named and enumerated (`ALERT_KINDS`, eleven kinds) and tagged with the organization, so an alert can be traced to a tenant without a body | `apps/{api,worker}/src/observability.ts` | `apps/{api,worker}/test/observability.test.ts` (asserts the kind list and that `platform_killswitch_on` is absent) | Phase 7 runbook §3.1 |

## V8 — Data protection and retention

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| **Retention is a per-workspace setting (180 days default, 30–730) enforced nightly**: message bodies and terminal draft texts older than the window are nulled and stamped; three append-only tables have platform-wide windows (`llm_calls` 400 d, `notifications` 90 d, tenant `audit_log` 730 d); every workspace is visited every night in its own short transaction (ruling R15) | `apps/worker/src/jobs/retention-sweep.ts`, `packages/db/src/schema/tenancy.ts` (`retention_days` CHECK 30–730), `apps/api/src/workspace/lifecycle.ts` (`setRetentionDays`, owner) | **`apps/worker/test/retention-sweep.test.ts`** (two orgs at 180 vs 30 days against 200/100/10-day rows), `apps/worker/test/e2e-phase7.test.ts` scenario 7 | **Phase 7 runbook §7** |
| `agent_runs` (90 d) and the `platform.access` trail (30 d) have their own arms | `apps/worker/src/jobs/sweeps-daily.ts` arms (g), (h) | `apps/worker/test/sweeps-daily.test.ts` | Phase 7 runbook §7 |
| **Workspace deletion**: a 30-day grace after an owner's typed confirmation, then a job deletes the org's objects and every tenant table in FK order from a list PINNED against the migration table list (a new table cannot escape the purge), then the workspace and the auth rows | `apps/api/src/workspace/lifecycle.ts` (`requestDeletion`, `cancelDeletion`), `apps/worker/src/jobs/workspace-purge.ts`, `packages/db/src/purge.ts` (`PURGE_ORDER`, `purgeWorkspace`, `purgeAuthRows`) | **`packages/db/test/purge.test.ts`** (`PURGE_ORDER` = `EXPECTED_TABLES − RLS_EXEMPT − workspaces`; the reverse order is proven to fail), `apps/worker/test/workspace-purge.test.ts` (a foreign object key is refused), `e2e-phase7.test.ts` scenario 8 (orgs A and B keep every row) | Phase 7 runbook §7 |
| **Workspace export** is an allow-listed NDJSON bundle (every column named; the secrets tables not present at all), capped at 200 MB, served by a 7-day presigned GET to the owner only; the URL is never in a notification | `apps/worker/src/jobs/workspace-export.ts`, `apps/api/src/workspace/lifecycle.ts` (`requestExport`, `exportStatus`), `packages/contracts/src/workspace.ts` (`exportObjectKey`) | `apps/worker/test/workspace-export.test.ts` (greps the produced bytes for every secret column name and seeded secret value), `apps/api/test/workspace-lifecycle.test.ts` | Phase 7 runbook §7 |
| Learned answers are scrubbed of structural PII before storage, expire at a fixed 365 days from the human decision, and can be erased per customer | `packages/knowledge/src/memory/scrub.ts` (`scrubForMemory`), `apps/worker/src/jobs/memory-capture.ts`, `apps/api/src/memory/service.ts` (`deleteByCustomer`) | `packages/knowledge/test/scrub.test.ts`, `apps/worker/test/memory-capture.test.ts`, `apps/api/test/memory-router.test.ts` | Phase 5 runbook |
| Uploaded documents live in one bucket under `orgs/<orgId>/…`; the purge refuses to delete a key outside that prefix | `packages/knowledge/src/storage/`, `apps/worker/src/jobs/workspace-purge.ts` | `packages/knowledge/test/storage.test.ts`, `apps/worker/test/workspace-purge.test.ts` | Phase 4 runbook (the bucket, CORS) |
| Sentry receives no message bodies, no request bodies, no cookies; the log drain receives pino lines with ids, never bodies | `apps/{api,worker}/src/observability.ts`, `logging.ts` | `apps/{api,worker}/test/observability.test.ts`, `logging.test.ts` | Phase 7 runbook §3 |

## V9 — Communication security

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Every outbound request to a customer-supplied address (a BYOK base URL, a crawl target, a redirect) is validated (https, a hostname, no credentials, a public address after DNS resolution) and **pinned at every call** — re-resolved on each request, redirects refused rather than followed | `packages/crypto/src/ssrf/{resolve-public,pinned-fetch,ranges}.ts` (`validateOutboundUrl`, `resolvePublic`, `createPinnedFetch`), `packages/llm/src/core/registry.ts` (`createByokProvider` DEFAULTS to the pinned fetch), `packages/knowledge/src/crawler/` | `packages/crypto/test/ssrf.test.ts`, **`pinned-fetch-fn.test.ts`** (a rebinding hostname refused on the second request; a 3xx throws), `packages/knowledge/test/pinned-crawl-fetch.test.ts`, `crawler.test.ts`, `apps/worker/test/e2e-phase6.test.ts` scenario 7 (hostile base URLs refused at write time) | Phase 6 runbook §3.4 |
| Inbound webhooks each have one cryptographic anchor: Gmail Pub/Sub — a Google-signed OIDC token checked for audience and service account; Microsoft Graph — a hashed `clientState`; Stripe — the signature over the raw bytes | `apps/api/src/webhooks/gmail.ts` (`verifyGoogleJwt`), `webhooks/microsoft.ts`, `billing/webhook.ts` (`constructEvent`) | `apps/api/test/webhooks.test.ts`, `billing-webhook.test.ts` | Phase 2 runbook (`GMAIL_PUBSUB_AUDIENCE`/`_SA_EMAIL`), Phase 7 runbook §2.3 |
| Mail provider calls use the provider SDK/REST over TLS with short-lived access tokens refreshed from the sealed refresh token by the worker alone | `packages/mail/src/` (`credentials.ts`, the Gmail and Graph adapters) | `packages/mail/test/credentials.test.ts`, `gmail-adapter.test.ts`, `graph-adapter.test.ts` | Phase 2 runbook |
| CORS is restricted to the configured web origins with credentials; the bucket's CORS rule is a single origin written by `s3:init` | `apps/api/src/server.ts` (`@fastify/cors`), `scripts/s3-init.ts` | `apps/api/test/trpc-origin.test.ts` | Phase 4 runbook (`S3_CORS_ORIGIN`) |

## V10 — Malicious code and supply chain

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Dependencies are installed from a committed lockfile with `--frozen-lockfile` in CI; the four vendor SDKs that handle secrets or money are pinned exactly (`stripe@22.6.2`, `@sentry/node@10.74.0`, `openai@7.15.0`, `expo-share-intent@8.0.1`) | `pnpm-lock.yaml`, `.github/workflows/ci.yml`, `apps/{api,worker,app}/package.json`, `packages/llm/package.json` | CI | Phase 7 runbook §1 |
| The api's module graph is walked by a test that bans the model SDKs, the document parsers and `undici` from entering it — the api never calls a model and never parses a customer document | `apps/api/test/error-surface.test.ts` | itself | — |
| The app bundle never value-imports a server package or `node:*`; share-sheet code is split so the web bundle contains none of it | `eslint.config.js` (the `apps/app/**` block), `apps/app/src/lib/share-intent{,.web}.tsx` | `pnpm lint`; the Task 10 review read the emitted web bundle | — |
| PDF and DOCX are parsed in a forked child under a memory cap and a 60 s clock, never in the worker process | `packages/knowledge/src/parsers/{child-runner,child-main}.ts`, `bounds.ts` | `packages/knowledge/test/child-runner.test.ts`, `parsers.test.ts` | Phase 4 runbook |
| The brand assets are generated from four sources and a test fails on any byte of drift, so no hand-edited binary reaches the stores | `brand/scripts/build.ts` | `brand/test/build.test.ts` | Phase 7 runbook §9 |

## V11 — Business logic

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| No reply is sent without either a human approval or a decision the workspace's own policy graduated, and the decision order is the spec's; a lapsed or unpaid subscription parks every decision on review while drafts continue | `packages/core/src/autonomy.ts` (`decide()`), `apps/worker/src/jobs/ticket-draft.ts`, `send-execute.ts` (the eight kill levers incl. `subscription_inactive`) | `packages/core/test/autonomy.test.ts` (the precedence table), `apps/worker/test/send-execute.test.ts`, `e2e-phase7.test.ts` scenarios 1, 4, 5 | Phase 7 runbook §2.5 |
| A reply is sent exactly once: the send job scans the thread for its own marker before acting, every status write is guarded on the status it was read at, and the staleness anchor refuses a send whose thread has a newer inbound | `apps/worker/src/jobs/send-execute.ts`, `packages/mail/src/` (`MARKER_HEADER`) | `apps/worker/test/send-execute.test.ts`, `e2e-phase3.test.ts` (the crash cases) | Phase 7 runbook §5.1 (the live kill-mid-send walk) |
| Per-tenant caps (drafts/day, Managed-AI USD/day, a trial's total budget, sources, crawl pages, embed tokens, connections, sandbox runs) resolve from the workspace's plan and are enforced at the write site under an advisory lock; a tenant's own provider spend never trips the platform's cap | `packages/db/src/settings.ts` (`loadSettingSources`), `packages/core/src/plans.ts`, `apps/worker/src/drafting/caps.ts`, `packages/db/src/metering.ts` | `apps/worker/test/drafting-caps.test.ts`, `packages/db/test/settings.test.ts`, `e2e-phase7.test.ts` scenarios 2, 6 | Phase 7 runbook §1 (the trial tier's caps) |
| Billing state has one reader and the meter that bills is the managed-only one; a Checkout is fulfilled on its payment status, a foreign invoice is refused, a double subscription is alerted | `packages/db/src/billing.ts` (`readBillingState`), `packages/core/src/billing.ts`, `apps/api/src/billing/webhook.ts`, `apps/worker/src/billing/report-usage.ts` | `packages/core/test/billing.test.ts` (the worked overage example), `apps/api/test/billing-webhook.test.ts`, `apps/worker/test/billing-report-usage.test.ts`, `e2e-phase7.test.ts` scenario 3 | Phase 7 runbook §2 |
| A platform-wide kill switch and a per-workspace kill switch both stop sending before any provider is resolved; a platform concurrency ceiling on managed model calls never drops a draft | `platform_state['killswitch.global']`, `workspaces.kill_switch` (`setKillSwitch`, owner), `apps/worker/src/drafting/admission.ts` | `apps/worker/test/send-execute.test.ts`, `drafting-admission.test.ts`, `ticket-draft.test.ts` | Phase 7 runbook §8 |

## V12 — Files and resources

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Uploads are browser-direct to the bucket by presigned PUT (the api never proxies bytes), capped at 20 MiB declared to the api AND re-checked by the ingest job's HEAD, which deletes an oversize object | `apps/api/src/knowledge/service.ts`, `apps/worker/src/jobs/knowledge-ingest.ts`, `packages/knowledge/src/storage/` | `apps/api/test/knowledge-router.test.ts`, `apps/worker/test/knowledge-ingest.test.ts` | Phase 4 runbook |
| A paste is capped in characters, a chunk in characters, a crawl in pages, hops and concurrency, an export in bytes | `packages/knowledge/src/bounds.ts`, `crawler/`, `apps/worker/src/jobs/workspace-export.ts` (`EXPORT_MAX_BYTES`) | `packages/knowledge/test/crawler.test.ts`, `chunker.test.ts`, `apps/worker/test/workspace-export.test.ts` | Phase 7 runbook §7 |
| The share sheet accepts one URL, one page, text or one file, and a file of an unsupported type is refused with a visible failure rather than silently dropped | `apps/app/app.json` (`expo-share-intent` activation rules), `apps/app/src/screens/share.tsx`, `screens/knowledge/use-upload.ts` | `apps/app/src/screens/share.test.tsx`, `lib/share-routing.test.ts` | Phase 7 runbook §9 step 5 |

## V13 — API and web services

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| The API is tRPC over HTTP with typed procedures, zod inputs and a scrubbed error surface; every route is inside a `register()` so the global rate limiter wraps it | `apps/api/src/trpc/`, `apps/api/src/server.ts` | `apps/api/test/*-router.test.ts`, `rate-limit.test.ts` | — |
| Webhooks answer 2xx for every non-signature outcome (a retry storm cannot be induced), deduplicate on the provider's event id, and store an envelope without the payload | `apps/api/src/billing/webhook.ts`, `webhooks/{gmail,microsoft}.ts`, `apps/api/src/deps.ts` (`recordWebhookEvent`) | `apps/api/test/billing-webhook.test.ts`, `webhooks.test.ts` | Phase 7 runbook §2.3 |
| A queue that does not exist is a silently dropped job in pg-boss; every queue is therefore pre-created by both processes from one options table, and a test pins the list | `packages/queue/src/queue-options.ts`, `apps/worker/src/index.ts`, `apps/api/src/boss.ts` | `apps/worker/test/queue-preflight.test.ts` | — |
| `/healthz` reports database and migration state; `/meta` reports which integrations are configured and nothing else | `apps/api/src/server.ts` | `apps/api/test/healthz.test.ts` | Phase 7 runbook §6 (`smoke:tenant`) |

## V14 — Configuration

| Control | Implementation | Enforcing test | Runbook |
|---|---|---|---|
| Configuration is one zod schema per process; production refuses to boot without the secrets a role needs (the KEK ring for `sync`/`send`/`agent`, the model key for `agent`, Voyage for `knowledge`/`agent`, the bucket for the api and `knowledge`, Stripe for the api and a `cron` worker, a mail transport for the api and a `cron` worker); all-or-none groups throw on a partial set | `apps/api/src/config.ts`, `apps/worker/src/config.ts` | `apps/api/test/config.test.ts`, `apps/worker/test/config.test.ts` | Every runbook's §1; Phase 7 runbook §1, §2.4 |
| `.env` files are read per app, never from the repository root, and never override the process environment; `.env.example` documents every variable and which are required where | `packages/core/src/load-env.ts`, `apps/{api,worker}/.env.example` | `packages/core/test/load-env.test.ts` | — |
| The database roles are least-privilege: `aesa_app` (forced RLS, 5 s idle-in-transaction and 30 s statement timeouts), `aesa_platform` (RLS bypass, audited), `aesa_owner` (migrations); no process connects as a superuser in production | `scripts/db-init/001-roles.sql`, `packages/db/src/client.ts` (`createDb`) | `packages/db/test/rls.test.ts`, `migrations.test.ts` | Phase 0/4 runbooks (the `vector` extension is the one superuser step) |
| Startup invariants are asserted before any job runs (the watchdog fits inside the job expiry, the signal margin, the trial budget's relation to the daily cap) | `packages/core/src/invariants.ts` (`assertInvariants`) | `packages/core/test/invariants.test.ts` | — |
| Post-deploy verification is a script, not a memory: `pnpm smoke:tenant` walks the authenticated surface of a throwaway workspace and never prints its credential | `scripts/smoke-tenant.ts` | (manual; §6 of the runbook) | Phase 7 runbook §6 |

---

## What an assessor may ask that is NOT in a row above

- **Penetration testing** — none commissioned yet; the design-partner run (Phase 7 runbook §6) is the
  first live exposure, and the Gmail client stays in Testing until the CASA letter arrives.
- **Load testing** — deferred until the first paying customers (spec). The admission pool (§V11) and
  the per-tenant caps are the controls that bound a burst in the meantime.
- **A reconciliation of billing state against Stripe** — none; the webhook is the only writer and a
  missed delivery is repaired by hand from the Dashboard (Phase 7 runbook §2.3).
- **Backups and restore** — the database platform's own (Railway Postgres); the retention sweep and
  the purge are irreversible by design, and a restored backup would resurrect bodies the sweep
  removed — the retention promise in the privacy policy should say backups are retained for N days
  beyond the window, where N is the platform's backup retention.
- **The on-prem model bridge** (a customer's local Ollama/vLLM) — not built; in v1 a BYOK endpoint
  must be a public https hostname, which is what keeps every model call inside the SSRF guard.
