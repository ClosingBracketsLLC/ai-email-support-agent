# Working in this repo

A multi-tenant SaaS: an AI agent that answers a business's customer-support email. Working codename
`aesa` (package scope `@aesa/*`, database roles, header names) until Robert picks a product name.

## Read first

- `docs/STATUS.md` — what is built, what comes next, and the carry-overs for the next phase.
- `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md` — the normative design
  (product, architecture, data model, seven build phases). The spec wins over any plan.
- `docs/superpowers/plans/` — one implementation plan per phase, named
  `YYYY-MM-DD-phase-N-<slug>.md` and committed on the phase branch before the first implementation
  task; each plan lists its deviations from the spec. `docs/superpowers/reviews/` holds the
  whole-branch review of each finished phase.
- Reference implementation: `~/Desktop/code/ClosingBrackets/doge-buddy`, a live business. It is
  read-only: port code from it, never modify it, never share packages with it.
- `brand/brand.md` — the brand guide (identity, the mark's derivation, colour, type, icons, where
  things live, licences) for anything visual: a new screen, a review page, an asset.

## How a phase is built

brainstorm → spec → `superpowers:writing-plans` → `superpowers:subagent-driven-development` (fresh
implementer per task, task review, fix loop, whole-branch review) →
`superpowers:finishing-a-development-branch`. The spec already fixes the scope of Phases 1–7, so a
phase starts at `writing-plans`; brainstorm only when Robert changes the scope. Work on a branch
off `main`. Integration (standing flow, Robert 2026-09-09): a finished phase lands on `main`
through a GitHub PR merged with a merge commit (never squash/rebase — STATUS.md and the review
records cite branch SHAs), and the branch is deleted after merge. Opening and merging the PR still
happens on Robert's go-ahead — never push, merge, or open a PR without him or a standing
instruction from him in the session.

## Commands

    corepack enable && pnpm install
    pnpm db:up                                    # Postgres 17 + pgvector on :5434 (aesa/aesa/aesa_dev) (pgvector is installed by db-init; a volume from before Phase 4 needs `pnpm db:down && pnpm db:up`); also brings up minio on :9000/:9001, CORS via MINIO_API_CORS_ALLOW_ORIGIN (server-wide, not per-bucket — minio has no PutBucketCors)
    pnpm s3:init                                  # creates the dev bucket in minio (idempotent; safe to re-run)
    DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev pnpm --filter @aesa/db migrate
    pnpm typecheck && pnpm lint && pnpm test && pnpm db:check    # the CI gate; run before every commit
    pnpm --filter @aesa/db test test/rls.test.ts  # one package, one file
    pnpm --filter @aesa/db generate               # after a schema change; commit the migration BEFORE running db:check
    pnpm --filter @aesa/api dev                   # copy apps/api/.env.example to apps/api/.env first
    pnpm --filter @aesa/worker dev                # copy apps/worker/.env.example to apps/worker/.env first
    pnpm --filter @aesa/app dev                   # copy apps/app/.env.example to .env first; EXPO_PUBLIC_API_URL must be the LAN address for a physical phone
    pnpm --filter @aesa/app export:web            # Expo web export (server output)
    pnpm --filter @aesa/app test                  # jest, no database
    pnpm e2e                                      # Playwright signup smoke against the api and the served web export
    pnpm brand:build   # after changing brand/tokens.json, mark.svg, wordmark.svg or icons/*.svg; commit the outputs

- The database must be running for every suite except `@aesa/core` and `@aesa/crypto`. Tests read
  `DATABASE_URL` from the real environment (default `postgres://aesa:aesa@localhost:5434/aesa_dev`)
  and never read a `.env` file. Most suites create a throwaway database per test file through
  `createTestDatabase()`; the `@aesa/queue` suites run against `DATABASE_URL` itself in the
  `pgboss_test` schema.
- `pnpm db:check` re-runs `generate` and, if anything under `packages/db/migrations` changes, fails
  and then restores that directory with `git checkout --` and `git clean -fd`. An uncommitted
  migration, generated or hand-written, is deleted by that step, so commit migrations first.
- `loadDotEnv` reads only the app's own `apps/<app>/.env` (never the repo root) and never
  overrides a variable already set in the environment. `migrate` loads no `.env` at all, hence the
  inline `DATABASE_URL` above.
- Local database roles come from `scripts/db-init/001-roles.sql`, run once by the compose
  container (CI runs the same file with `psql`). `pnpm db:down` drops the volume, so the roles are
  recreated on the next `pnpm db:up`.
- Ports: the api listens on 3001 (`PORT`, `HOST` defaults to `0.0.0.0`); the worker binds no port;
  Postgres is on 5434 because doge-buddy already uses 5433. `APP_BASE_URL` is the api's public
  origin (Better Auth's `baseURL`; OAuth redirect URIs are `<APP_BASE_URL>/api/auth/callback/<provider>`);
  `APP_WEB_ORIGIN` is the Expo web origin (CORS, trusted origin, invitation links).
- Env (see each app's `.env.example` for the full list). `apps/worker`: `WORKER_ROLES`
  (`sync,agent,send,knowledge,cron`), `AESA_KEK_V1`/`AESA_KEK_ACTIVE` (the KEK ring; required in
  production when `WORKER_ROLES` includes `sync`, `send` **or — since Phase 6 — `agent`**, which
  opens a tenant's BYOK provider key under that org's DEK on every model call and re-wraps a freshly
  sealed one in `llm.probe`; `loadConfig` refuses that boot. It must be the **SAME ring on every
  replica**: a key sealed under one ring cannot be opened by a replica holding another, and the only
  symptom is `provider_unavailable`), `ANTHROPIC_API_KEY` (the MANAGED key; required in production
  when `WORKER_ROLES` includes `agent` — the four jobs that CHAT are `ticket.triage`, `ticket.draft`,
  `agent.sandbox` and `guidance.suggest`; the role's other two, `memory.capture` and `llm.probe`, only
  embed and only call the tenant's own endpoint respectively. Outside production a missing key no
  longer skips the role: every job registers with `managed = null`, BYOK agents work normally and an agent
  configured for Managed AI lands `provider_unavailable`. `llm.probe` is gated by the **ring alone**,
  so a ringed dev box with no Anthropic key can still add, probe and re-wrap BYOK credentials),
  `GMAIL_OAUTH_CLIENT_ID`/`_SECRET` and `MS_OAUTH_CLIENT_ID`/`_SECRET`
  (all-or-none pairs, one per provider; **at least one is required in production only for the
  `send` role**, refused at boot by `maybeRegisterSendRole` in `apps/worker/src/send-role.ts`
  together with the ring — `loadConfig` gates `sync` on the ring and `MAIL_FROM` and never on a
  pair, so a `sync` replica with no pair boots and throws at the first token refresh instead),
  `MAIL_FROM`, and — because the worker now sends the daily digest email
  through the same `@aesa/platform-mail` transport the api uses — `EMAIL_TRANSPORT` +
  `RESEND_API_KEY` (required in production on a `cron` replica) plus `APP_BASE_URL` and
  `APP_WEB_ORIGIN` (the digest links' two bases; **either one unset disables the digest email
  pass entirely** — the gate is `!mail || !appBaseUrl || !appWebOrigin` — while the push digest
  still runs), `VOYAGE_API_KEY` (**required in production when `WORKER_ROLES` includes `knowledge`
  OR `agent`** — the first writes every chunk's vector, the second embeds every retrieval query;
  outside production a missing key falls back to the deterministic hash embedder with one warning,
  and its vectors are NOT comparable with Voyage's), `KNOWLEDGE_EMBED_MODEL` (`voyage-4` default;
  stored on every chunk as `embedding_model` and part of the vector leg's `WHERE`, so changing it
  on a live workspace hides every existing chunk from that leg until the re-embed job that is still a
  carry-over, now → Phase 7) and
  `KNOWLEDGE_RERANK` (`off` default; `on` adds Voyage's cross-encoder pass, inert without a key).
  `apps/api`: the same `GMAIL_OAUTH_CLIENT_ID`/`_SECRET`
  and `MS_OAUTH_CLIENT_ID`/`_SECRET` pairs (the connect flow's own OAuth, distinct from Better
  Auth's `GOOGLE_CLIENT_ID`/`MICROSOFT_CLIENT_ID` SSO login), `GMAIL_PUBSUB_AUDIENCE`/`_SA_EMAIL`
  (the webhook's OIDC verification), and `MAIL_FROM`. **Both apps** read the same six
  `S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_FORCE_PATH_STYLE`
  (`parseS3Env`, all-or-none — a half-configured set throws at boot) and must point at ONE bucket:
  the api issues the presigned PUT, a `knowledge`-role worker reads the bytes back. Required in
  production for the api, and for a worker whose `WORKER_ROLES` includes `knowledge`; in dev/test a
  missing set falls back to an in-memory store (paste and crawl still work; an upload's presign
  hands the browser a `memory://` URL, the PUT fails in the browser and the row simply sits
  `queued` — `knowledge.ingest`'s "object missing" only fires if `completeUpload` is somehow
  reached). `S3_CORS_ORIGIN` is read by `pnpm s3:init` ALONE, never by either app: it is the single
  origin written into the bucket's CORS rule, so the browser's cross-origin PUT is allowed. It
  defaults to `http://localhost:8081` and **must be set to `APP_WEB_ORIGIN` whenever `s3:init` is
  run against a real bucket** — otherwise every upload dies in a CORS preflight. **`MAIL_FROM`,
  `APP_BASE_URL` and
  `APP_WEB_ORIGIN` must be identical in both `.env` files** — the worker's sync walk
  (platform-sender skip), the api's verification-code interception and the digest email's
  `/a/:draftId` + `/ticket/:id` links all key off them, and drift breaks each silently, with no
  error at boot in either app. **`KNOWLEDGE_EMBED_MODEL` must likewise be identical on every
  `knowledge` AND `agent` replica** — the first writes it onto each chunk as `embedding_model`, the
  second embeds the query and filters the vector leg by it, so a drifted replica retrieves nothing
  from the vector leg at all and silently degrades every draft to the lexical one. Nothing refuses
  it at boot; the retriever warns once per process per org when the vector leg comes back empty and
  a different `embedding_model` is stored. **Phase 5 added NO environment variable to either app.**
  Its two new knobs are per-workspace `org_settings` rows, resolved through `resolveSetting`:
  `notifications.push_auto_sends` (boolean, **default false** — the Hold-button push on every
  auto-send) and `guidance.daily_suggest_cap` (number, default 50 — the per-org daily ceiling on
  `guidance.suggest`'s Haiku call). Learned answers are embedded with the SAME
  `KNOWLEDGE_EMBED_MODEL` as chunks and filtered by it on the answers leg too, so the paragraph
  above now also governs whether a workspace can retrieve anything it has learned.
  **Phase 6 added NO environment variable to either app either** — the KEK ring was already one; what
  changed is that `agent` now needs it (above). A workspace's own provider key is pasted in
  Settings → AI, sealed by the api and re-wrapped by the worker; it is never env, on either side, and
  the api's BYOK connect flow needs no platform credential at all. Phase 6's ONE new runtime
  dependency is `openai@7.15.0` (pinned exactly, `packages/llm` only), so a deploy needs
  `pnpm install`.

## Layout

- `packages/contracts` — zod inputs and enums shared by api, db and app; zod only, no Node imports.
  Phase 6 added `llm.ts`: `LLM_PROVIDERS` + `PROVIDER_PRESETS` (the provider catalog the app renders
  — base URL, consent name, key hint, suggested models), `MANAGED_MODELS` (the ONE source
  `DRAFT_MODEL_ID` now aliases), `QUALITY_TIERS` / `qualityTierFor` / `presetModel`,
  `AddCredentialInput` / `SetAgentModelInput` / `CredentialIdInput`, `ProbeResult` /
  `ProbeResultView`, `LLM_MAX_CREDENTIALS` (5), and `LLM_ERROR_MESSAGES` — the ONE source of the
  owner-facing sentence for every soft refusal Settings → AI can produce, thrown by the router and
  keyed on by both screens (plain string constants; this file stays zod-only otherwise).
- `packages/db` — drizzle schema (`src/schema/`), SQL migrations, `createDb` (session role set through
  libpq startup options), `withOrg` / `withPlatform` / `withOrgIdentity` (lending a platform sweep's
  per-row SAVEPOINT tx one org's identity), per-org data keys, `escalateTicket` (the single entry
  into `needs_owner` — see the Escalation rule below), the meter sink (`createMeterSink`,
  `bumpMeter`, `LLM_METERS` / `SEND_METERS` (incl. Phase 5's `autoSends`) / `SANDBOX_METERS` /
  `KNOWLEDGE_METERS` / `GUIDANCE_METERS`), `bumpKnowledgeVersion`, Phase 5's `resolved_answers` /
  `category_stats_daily` / `guidance_suggestions` tables, `customerHash` /
  `ensureCustomerHashSalt` (`memory.ts`) and the autonomy helpers (`autonomy.ts`:
  `countHumanDecisions`, `readDemotionSignals`, `demoteCategory`, `graduateCategory` — the single
  entries into a mode change, see the Autonomy rule below), `createTestDatabase`, and Phase 6's four
  tables — `llm_credentials` (api-visible metadata: health, `key_fingerprint`, `last_probe`),
  `llm_credential_secrets` (platform-role-only, see the Provider credentials rule below),
  `agent_model_config` (per agent × role, `NULLS NOT DISTINCT` unique) and the platform table
  `model_pricing` — plus `resolveModelConfig` / `managedConfig` / `ResolvedModelConfig`
  (`model-config.ts`, the ONE reader of an agent's model choice, used by the api AND the worker),
  `loadModelPricing` (`pricing.ts`), `LLM_METERS.costMicrosByok`, `llm_calls`'s new
  `mode` / `credential_id` / `cost_unknown`, `DEMOTION_COPY.model_changed` and
  `escalationCopy.provider_unavailable`.
- `packages/crypto` — `Secret`, domain-separated token hashing, AES-256-GCM envelope with a KEK ring,
  libsodium sealed boxes, the SSRF guard (`validateOutboundUrl`, `resolvePublic`, `pinnedFetch`) and
  Phase 6's `createPinnedFetch` — a `fetch`-shaped transport an SDK accepts for its `fetch` option
  that re-validates and re-resolves on EVERY call and refuses a redirect rather than following it.
- `packages/core` — tripwire, state-transition matrices, settings catalog, plans, startup
  invariants, `loadDotEnv`, and Phase 3's pure decision logic: the guardrails validator and its
  screens (`guardrails/{validator,screens,policy,shingles}.ts` — one implementation run at all three
  gates, over a per-tenant `WorkspacePolicy` built in one place, `@aesa/agent/policy`, so the draft,
  approve and send gates screen against the SAME four trusted texts and the same allowed hosts),
  `decide()` (`autonomy.ts` — Phase 5 added its `memory_conflict` / `unresolved_questions` /
  `thread_too_long` blockers), the redraft policy
  (`redraft.ts`: `resolveRejectAction`, `clearRedraftCycle`, `REDRAFT_MAX`), `appendSignature`, and
  Phase 5's `evidence.ts` — the evidence maths (`memoryBand`, `memoryScore`,
  `evidenceScore = max(memory, grounding) × model`) plus the graduation and demotion rules
  (`DEMOTION_RULES`, `evaluateDemotion`, `GRADUATION_RULES`, `evaluateGraduation`) and the memory
  constants (`MEMORY_RETRIEVE_MIN_COSINE`, `MEMORY_EXPIRY_DAYS`, `MEMORY_STRIKES_TO_RETIRE`,
  `THREAD_MAX_MESSAGES_FOR_AUTO`), and Phase 6's `quality.ts` — `QUALITY_CAPS` (1.0 / 0.9 / 0.6),
  `cappedModelConfidence` and `graduationRulesFor` (20 / 40 / never); `evaluateGraduation` now takes
  an optional rules override.
- `packages/queue` — pg-boss wrappers (`startBoss`, `registerCron`), `defineJob` / `registerJob`,
  `enqueue`, `fairSelectSql`, and Phase 6's `QUEUE_OPTIONS` / `queueOptionsFor`
  (`queue-options.ts`) — the ONE source of every queue's options, read by `defineJob` AND both
  pre-create lists (see the Jobs rule) — plus `RegisteredJobDefinition` (what `registerJob` demands,
  so a hand-built definition without queue options is a compile error; `enqueue` stays on the looser
  `JobDefinition`) and `scrubJobError`, which keeps a `DrizzleQueryError`'s `query`/`params` out of
  `pgboss.job.output` for every job at once. `drizzle-orm` is a runtime dependency here for that.
- `packages/mail` — the provider-agnostic mailbox port: Gmail + Microsoft Graph adapters, credential
  lease/refresh, rfc2822/address/body/threading helpers, the sync walk (`sync.ts`), `MockMailbox`,
  the send limiter. No database dependency beyond what `sync.ts` itself needs via `@aesa/db`.
- `packages/llm` — the provider-agnostic chat port (`LlmProvider`, with Phase 6's optional
  `listModels` and `ChatMeta.mode`/`.credentialId`), **two** adapters — the Anthropic one and
  Phase 6's `adapters/openai-compatible/` (one dialect, six presets, a per-model capability seed) —
  the structured-output ladder now complete with its `'plain'` rung (the `'none'` capability: a
  plain call with a JSON instruction, then repair/extract), the per-model limiter, the metering
  wrapper, the code-seeded price table, `core/shared.ts` as the ONE scrub/envelope implementation,
  `createManagedProvider`, Phase 6's `probeProvider` (`core/probe.ts` — models list, one tiny chat,
  a structured probe driving the RAW adapter's rungs itself) and `createByokProvider` + `withMeta`
  (`core/registry.ts`), and `createFakeProvider` for tests. `runProviderContract` lives on the
  `@aesa/llm/testing` sub-path alone, so vitest never enters a production graph. No database
  dependency (the `MeterSink` it consumes is implemented in `packages/db`). `openai@7.15.0` is
  pinned exactly and lives only here.
- `packages/agent` — the triage prompt and one-model-call (`runTriageCall`), the six-layer draft
  prompt with its stability hints and `runDraftCall`, the `Retriever` seam (`emptyRetriever` here;
  `@aesa/knowledge`'s `createRetriever` is what implements it), the usage accumulator and the run
  watchdog; no database dependency — `apps/worker`'s
  `ticket.triage` / `ticket.draft` jobs own every read and write around it. Its second entry point
  `@aesa/agent/policy` (`src/policy.ts`) is the ONE builder of a tenant's `WorkspacePolicy` —
  `buildReplyPolicy` / `personaFor`, the four trusted texts in a fixed order (platform hard rules,
  persona block, workspace operating guidance, agent guidance extra) — used by all three guardrail
  gates including the api's approve gate. It is deliberately pure: `@aesa/core` plus this package's
  own prompt-text modules and nothing else, so the api can build the identical policy without the
  Anthropic SDK entering its module graph (held by `packages/agent/test/policy.test.ts` and
  `apps/api/test/error-surface.test.ts`, which both walk the real module graph). Phase 5 added
  `guidance/suggest.ts` — the small Haiku call that turns ONE edited approval into ONE suggested
  operating rule, or `null`. Phase 6 moved the MODEL out of this package: `DraftPromptInput.model`
  (and its widened `effort`, now including `'low'`) and `runGuidanceSuggestCall`'s `model` parameter
  are the caller's, and `runTriageCallDetailed` (+ `TriageCallResult`) exposes what the worker needs
  to record which provider actually answered.
- `packages/knowledge` — Phase 4's knowledge pipeline, with no job and no queue of its own:
  the HTML/Markdown/text/PDF/DOCX block parsers and the bounded parser child
  (`parsers/`, `bounds.ts`), the heading-aware chunker, the prompt-injection screen,
  `prepareDocument` (chunk + screen + hash), the `Embedder`/`Reranker` ports with the Voyage and
  deterministic-hash adapters, the `ObjectStore` port with its S3 and in-memory adapters
  (`storage/`), the SSRF-safe crawler (robots, sitemap-first, re-validated redirects, first-20
  batches) and hybrid per-org retrieval (`createRetriever`, `assertSameOrg`, the relaxed tsquery,
  RRF fusion) — plus Phase 5's `memory/scrub.ts` (`scrubForMemory`, the structural PII scrub every
  stored answer passes through) and the retriever's **answers leg** (`answerSearchSql`: vector-only,
  `status = 'active'`, cosine ≥ `MEMORY_RETRIEVE_MIN_COSINE`, top 3, never fused with the chunk
  ranking). Two PURE sub-paths the api imports and nothing else — `@aesa/knowledge/storage` and
  `@aesa/knowledge/url` — keep the parsers and the LLM client out of the api's module graph
  (`apps/api/test/error-surface.test.ts` walks it); `./testing` exports `fakeSite`. `@aesa/agent` is
  a type-only devDependency (`RetrievedChunk`/`Retriever` erase at runtime).
- `packages/platform-mail` — the platform's own outbound mail (sign-in codes, invitations,
  address-verification codes, the daily digest): the `MailTransport` port with a Resend transport
  and a devsink, plus the templates. Shared by `apps/api` and `apps/worker`; no database dependency.
- `packages/test-kit` — `MockMailbox` re-export, the scrubbed fixture recorder (`MAIL_RECORD=1`),
  and the provider conformance suite run against both the mock and recorded fixtures.
- `brand/` — the `@aesa/brand` workspace package, root-level (listed in `pnpm-workspace.yaml`, not
  under `packages/`): the four sources (`tokens.json`, `mark.svg`, `wordmark.svg`, `icons/*.svg`),
  the Python derivation (`scripts/derive/`, not part of the CI gate), `scripts/build.ts`
  (`pnpm brand:build`), and `test/` (sources, compose, build-drift, tokens, contrast,
  app-typography). Generates the other mark colourways/lockups/OG SVG under `brand/`,
  `apps/app/assets/{icon,adaptive-icon,splash-icon,notification-icon,favicon}.png`,
  `apps/api/public/{favicon.svg,favicon-16.png,favicon-32.png,favicon.ico,apple-touch-icon.png,og.png}`,
  and `packages/contracts/src/brand.ts` (`BRAND`). See `brand/brand.md` for the guide.
- `apps/api` — Fastify + Better Auth + tRPC: `/healthz`, config, scrubbed error handler, log
  redaction; the mailbox connect flow and provider webhooks; the `inbox`/`agents`/`workspace`/`team`
  routers, and Phase 3's `drafts` router (approve with the 15-second undo, hold, resume, reject with
  redraft, mark viewed) — which shares ONE service module (`src/drafts/service.ts`, exported as
  `@aesa/api/drafts`) with the session-less `/a/:draftId?t=` one-click review pages and with
  `inbox`'s draft view and resolve — plus a separate `activity` router (counts, cost, recent sends)
  that reads its own aggregates and touches no draft service, and Phase 4's `knowledge` router
  (presigned uploads, paste, crawl, list, delete, flagged chunks, gaps), which is likewise a thin
  code-to-`TRPCError` wrapper over ONE service module (`src/knowledge/service.ts`, exported as
  `@aesa/api/knowledge`). Phase 5 adds the same shape again: a `memory` router over
  `src/memory/service.ts` (`@aesa/api/memory` — the sampling verdicts, keep/retire, and
  delete-by-customer), `drafts.flagAutoSent` plus the Hold that cancels an auto-send in the SAME
  `src/drafts/service.ts`, `agents.setCategoryPolicy` with the cold-start lock, and the guidance
  suggestions. Every owner correction (reject, flag, an edited approve of a held auto-send) runs the
  demotion check INLINE in its own transaction — a category that has earned a demotion never waits
  for the nightly rollup. Phase 6 adds the shape once more: an `llm` router over `src/llm/service.ts`
  (`@aesa/api/llm`) — add a provider connection (seal the pasted key, enqueue `llm.probe`), probe,
  remove, per-agent model get/set with the `model_changed` demotion, and the per-credential 30-day
  usage read from `llm_calls` — plus a `model` line on `agents.list` and a `sandboxStart` that stamps
  the agent's RESOLVED provider/model instead of the managed constants. The approve gate screens the owner's
  body through the SAME policy the draft and send gates use — the api depends on `@aesa/agent`, but
  only through the pure `@aesa/agent/policy` sub-path, never the package root. The api never holds
  the KEK, never calls a model, never
  touches customer mail (it sends platform email — sign-in codes, invitations, address-verification
  codes — through `@aesa/platform-mail`'s `MailTransport`; Resend in production, the devsink
  elsewhere). It never touches `mailbox_credentials` either (platform-role only) — a connect flow's
  sealed OAuth tokens ride a job payload to the worker, which is the only process that ever opens
  them. The same holds for `llm_credential_secrets` (see the Provider credentials rule below).
- `apps/worker` — `WORKER_ROLES` partition, KEK ring, `jobs/`: `platform.heartbeat` (cron),
  `mailbox.sync` / `mailbox.poll-sweep` / `mailbox.renew-watch` / `mailbox.store-credentials` /
  `mailbox.revoke` (mailbox lifecycle, `sync` role), `ticket.triage` / `ticket.draft` /
  `agent.sandbox` (`agent` role; `drafting/` holds the claim protocol, the caps gate, the run
  context, the outcome table, the reply policy and Phase 6's `evidence.ts` — the ONE home of the
  evidence maths, shared by draft and sandbox, which is where the quality-tier cap bites;
  `ticket.triage` now writes its own `agent_runs.kind = 'triage'` rows), `knowledge.ingest` / `knowledge.crawl` /
  `knowledge.embed-batch` (`knowledge` role — one upload or paste becomes one document and its
  chunks; both ingest and crawl claim their source under a 300 s lease, so a replica that died
  mid-parse is re-claimed rather than stranded `processing`; one crawl becomes one document per
  page, streamed in batches under that lease;
  one document's missing vectors are filled in ≤ 128-text embed calls — `knowledge/sources.ts`
  holds `guardedSourceWrite`/`failSource` and `knowledge-deps.ts` is the ONE place the store,
  embedder and reranker are chosen from `WorkerConfig`, shared with the `agent` role's retriever so
  a worker can never write vectors with one model and query with another),
  `memory.capture` / `guidance.suggest` (Phase 5, `agent` role — the first turns one DELIVERED reply
  into a new resolved answer or a reinforcement of the one it reused, the second turns one edited
  approval into a suggested guidance rule; both are enqueued from elsewhere, `memory.capture` by
  `send.execute`'s post-commit `onSent` seam and `guidance.suggest` by the api's approve;
  `memory.capture`'s embed is now metered on `KNOWLEDGE_METERS.embedTokens` and gated by
  `knowledge.daily_embed_tokens_cap` like every other embed),
  `llm.probe` (Phase 6, `agent` role, gated by the KEK ring alone — store the sealed key, probe the
  endpoint, land the verdict, re-wrap under the org DEK), `send.execute` (`send`
  role — the only process that ever sends a customer reply; it now delivers from `auto_sending` as
  well as `awaiting_review` and meters `auto_sends` vs `review_sends` off `drafts.decision_source`),
  `notify.dispatch` / `notify.digest` (escalation and
  collapsed-overflow push, plus the daily digest EMAIL via `digest-email.ts`), and the crons
  `ticket.backstop-sweep` (every minute, five arms: (a) missed/stuck draft runs, (a2) tickets
  stranded at the agent failure ceiling, (b) stuck run rows, (c) orphaned tickets — `auto_sending`
  included, so a levered auto-send whose held draft expired still pages, (d) due sends —
  the pass reads `platform_state['killswitch.global']` once and skips (a), and only (a), while it
  is set), `sweeps.daily` (draft expiry, run-event/action-token retention, and Phase 5's three
  memory arms: expired answers, unsampled candidates past 30 days, and answers whose source chunks
  changed → `needs_review`; each writes one audit row per org per arm) and `stats.rollup`
  (02:15 UTC — the SOLE writer of `category_stats_daily`, recomputed for the trailing 30 days from
  `drafts`, plus the Autopilot suggestion / `auto_graduate` graduation, the demotion backstop and
  the Monday `memory_sample` nudge) and Phase 6's `llm.reprobe-sweep` (`15 */6 * * *`, `cron` role —
  it enqueues `llm.probe` for every credential not `dead` and not probed in the last 6 hours).
  Phase 6 also added `provider-resolver.ts` — the ONE way a worker gets a model provider
  (`createProviderResolver`, `staticResolver`/`staticRefusal` for tests, `openCredentialKey`,
  `secretAad`, `markCredentialDead`, `FALLBACK_CODES`, `cacheTtlFor`) — and
  `provider-health-notify.ts`.
- `apps/app` — the Expo universal app (`@aesa/app`, SDK 57, Expo Router, `web.output` server):
  `src/app` routes only, `src/screens` bodies, `src/lib` clients and the session gate, `src/components`
  primitives; jest-expo + RNTL for units, Playwright for the signup smoke. Phase 6 added **route 25**,
  `(app)/settings/ai` (Managed AI vs provider connections: add, probe, remove, per-credential 30-day
  usage, the consent sentence), the agent edit screen's **Model** card, and the model each agent runs
  on in the agent list row.

## Rules that hold here (most are test-enforced; do not work around them)

- **Tenancy.** Every tenant table carries `org_id uuid` (NOT NULL except `audit_log`, where NULL
  marks a platform event) and leads its tenant indexes with it; that ordering is a convention, not
  something a test checks. What `packages/db/test/rls.test.ts` enforces: row-level security ENABLED
  and FORCED on every ordinary table in `public`, with exactly two policies, `<table>_org_isolation`
  for `aesa_app` using the `NULLIF(current_setting('app.org_id', true), '')::uuid` predicate and
  `<table>_platform_all` for `aesa_platform`. Declare them with `tenantPolicies()` from
  `packages/db/src/schema/helpers.ts`. A table that is not tenant data (`platform_state`,
  `webhook_events`, Phase 6's `model_pricing` — platform price-table data; Better Auth's tables in
  Phase 1) goes in that test's `RLS_EXEMPT` list instead. drizzle never
  emits `FORCE`, so a custom migration adds it, and migration 0002's default privileges give
  `aesa_app` full DML on new tables, so a worker-only table needs an explicit `REVOKE`.
- **Data access.** Tenant reads and writes go through `withOrg(db, orgId, fn)` (branded `OrgTx`) or
  `withPlatform(db, reason, fn)`, which writes an `audit_log` row per call. Raw handles come only
  from `@aesa/db/raw`, and the ESLint gate also blocks value imports of `pg` and
  `drizzle-orm/node-postgres` outside `packages/db`, `apps/*/src/index.ts`, tests and scripts.
- **Transactions.** A `withOrg` transaction never spans network I/O. The app role gets a 5 s
  idle-in-transaction timeout and a 30 s statement timeout from `createDb` (configured there, not
  asserted by a test), so a violation fails loudly at runtime.
- **Jobs.** Payload schemas include `orgId`; `enqueue` sets `singletonKey` to `${orgId}:${entityId}`;
  `registerJob` hands the handler an `AbortSignal` that fires at `expireInSeconds` minus
  `JOB_SIGNAL_MARGIN_SECONDS` (owned by `@aesa/core`). **`singletonKey` only does something on a
  queue whose `policy` says so.** pg-boss 10 gates its singleton indexes on the queue's policy, and
  `defineJob` defaults to `standard`, on which no index applies and the key is inert. The TEN
  `short` queues — Phase 3's `ticket.draft`, `send.execute`, `agent.sandbox`, `notify.dispatch`,
  Phase 4's `knowledge.ingest`, `knowledge.crawl`, `knowledge.embed-batch`, Phase 5's
  `memory.capture` (produced by the WORKER alone, from `send.execute`'s post-commit `onSent` seam)
  and `guidance.suggest` (produced by the API alone, from `approveDraft` after an edited
  approval), and Phase 6's `llm.probe` (the FIRST queue with a producer on BOTH sides — the api's
  `addCredential`/`probeCredential` and the worker's own `llm.reprobe-sweep` cron) — declare
  `policy: 'short'` in `defineJob`'s `queue` options, which collapses a duplicate only while the
  first job is still `created` (a job that has gone `active`, or that is sitting in `retry`, never
  swallows a newer event; `enqueue` returns `null` when a duplicate was collapsed).
  `ticket.triage` and `mailbox.sync` stay `standard` on purpose: their burst source is a push
  webhook, and those enqueues pass `enqueue`'s `debounceSeconds` (pg-boss `singletonSeconds`),
  which is policy-independent — and `mailbox.sync`'s own per-connection lease serializes whatever
  still gets through. `short`'s
  index keys on `COALESCE(singleton_key,'')`, so two KEYLESS `boss.send` calls on one of those
  queues collapse into one — **`enqueue` is the only send path, and ESLint bans a bare `boss.send`
  outside `packages/queue` and tests.** **A new queue is added in FOUR
  places** —
  `JOB_NAMES` (`packages/queue/src/names.ts`), the worker's `apps/worker/src/index.ts` pre-create
  list (any queue another role or a cron enqueues), the api's `apps/api/src/boss.ts` pre-create list
  (any queue the api sends), and `apps/worker/test/queue-preflight.test.ts`'s `it.each`. pg-boss 10
  silently returns `null` from `send` on a queue that does not exist yet, so a missed pre-create is
  a job that never runs and never errors; the preflight test is what catches it. **Both pre-create
  lists carry the queue's `policy`** — `createQueue` ignores a second call, so whichever process
  boots first decides, and a `short` queue first created by an api-only boot with no options would
  stay `standard` until a worker replica ran `updateQueue`. The rule is LITERAL about "both
  pre-create lists": `memory.capture` is in the api's list though the api never sends it, and
  `guidance.suggest` is in the worker's though the worker never sends it. **Since Phase 6 the
  OPTIONS for all three code places come from ONE table** — `QUEUE_OPTIONS` in
  `packages/queue/src/queue-options.ts` — so a queue's policy, retry, backoff and expiry are edited
  in one file and cannot drift between `defineJob` and the two pre-creates; `defineJob`'s `queue` is
  optional for a `JOB_NAMES` name (it resolves from the table, and throws for a name the table does
  not carry) while `registerJob` demands a `RegisteredJobDefinition`, making "forgot the queue
  options" a compile error. A cron is NOT a queue in
  this sense — `stats.rollup`, like `sweeps.daily`, `ticket.backstop-sweep` and Phase 6's
  `llm.reprobe-sweep` (`15 */6 * * *`, `cron` role), is registered with `registerCron` and belongs in
  none of the four places.
- **Escalation.** Every entry into `needs_owner` from the drafting, send and api paths goes through
  `escalateTicket` (`@aesa/db`) — it owns the guarded transition, the `escalation_notified_at` reset,
  the audit row and the deduped notification, and its `dedupeKey` is reason-scoped where a second
  same-day escalation for a DIFFERENT reason must still page. Never write
  `tickets.status = 'needs_owner'` by hand outside `ticket.triage`'s own three landings
  (`triage_cap`, `triage_failed`, and the verdict's `triage_flags`/`sentiment_angry`), which predate
  `escalateTicket` and pair their own guarded write with `insertEscalationNotification` inside the
  verdict transaction. It is still exactly **three** after Phase 6: `ticket.triage`'s two new
  `provider_unavailable` landings (the resolver produced no provider; the tenant's key was rejected
  mid-call) write no verdict columns, so they go through `escalateTicket` — with the SAME
  reason-scoped `provider_unavailable:${ticketId}:${day}` key `ticket.draft` uses, so which job met
  the dead key first cannot change whether the owner is paged.
- **Guarded writes and the staleness anchor.** Every status write is guarded on the status it was
  read at (`WHERE ... AND status = <read value>`), and zero rows is a soft outcome the caller
  reports, never an error — that is what makes a concurrent owner, sweep or job simply win.
  `drafts.thread_snapshot_at` (the claiming run's `tickets.last_inbound_at`, never a wall-clock read)
  is the ONE staleness anchor: `send.execute` refuses any send whose thread has an inbound strictly
  newer than it, and nothing else is allowed to stand in for that comparison.
- **Guardrail gates.** All three gates — `ticket.draft`/`agent.sandbox` on the model's body,
  `drafts.approve` (tRPC and the `/a/:draftId` review pages) on the owner's, and `send.execute` on
  the `final_body` about to go out — run `validateReplyBody` from `@aesa/core` against a
  `WorkspacePolicy` built by `buildReplyPolicy` from `@aesa/agent/policy`. Never hand a gate a
  hand-rolled policy: a gate screening against fewer trusted texts than the one after it either
  waves through the edit the later gate exists to catch, or destroys a reply an earlier gate already
  cleared. The approve gate differs from the send gate in exactly one deliberate way — it passes no
  `groundedNumbers` (the owner is the grounding for their own edit, and `unbacked_number` is a
  `warn` that flips no outcome). A BYOK draft is screened exactly like a managed one — **the provider
  never enters the `WorkspacePolicy`.**
- **Autonomy.** `decide()`'s evaluation order IS the spec's — do not reorder a branch without
  changing the spec and `packages/core/test/autonomy.test.ts`'s table. The auto branch compares
  `confidence_breakdown.evidence` (`max(memory, grounding) × model`) against the category policy's
  `auto_send_min_confidence / 100`, **never `drafts.confidence`**, which still means the model's own
  self-assessment (plan deviation 1). Since Phase 6 that `model` term is
  `min(model, QUALITY_CAPS[tier])` — 1.0 `calibrated` / 0.9 `standard` / 0.6 `limited`, computed in
  ONE place (`apps/worker/src/drafting/evidence.ts`) and explained on the breakdown by `.modelCap`
  and `.tier`, so a weaker model cannot talk its way onto Autopilot; `drafts.confidence` still stores
  the UNCAPPED self-assessment. A `send` verdict lands exactly one shape — an `approved` draft
  with `decision_source = 'auto'` and no `decided_by`, a `queued` `outbound_sends` row due the
  agent's `auto_send_delay_min` out, and the ticket on `auto_sending` — and **nothing else in the
  codebase may write `decision_source = 'auto'`**; `auto_decided_at` is stamped once there and never
  cleared, so a Hold + re-approve still reads as "the agent proposed it, the human sent it". Every
  demotion goes through `demoteCategory` and every graduation through `graduateCategory`
  (`@aesa/db`), both guarded on the mode they were read at; the cold-start count is
  `countHumanDecisions` (`decided_by IS NOT NULL`), never a draft count. Phase 6 added three things
  around that: `DEMOTION_REASONS` gains `model_changed`, written by the api's
  `setAgentModel`/`removeCredential` in the SAME transaction as the `model_generation` bump;
  graduation is gated by `graduationRulesFor(tier)` (`standard` doubles `minDecisions` to 40,
  `limited` can never self-graduate); and `stats.rollup` windows a category's graduation sample to
  decisions at or after the agent's `model_generation_at` — a different model is a different writer,
  so its streak starts over.
- **Retrieval.** Every retrieval leg filters `org_id` in SQL (`retrieval/sql.ts`) AND runs inside
  `withOrg`, and `assertSameOrg` re-checks every row again before any of it can reach a prompt — it
  throws rather than filtering, because a foreign row in that set is evidence the filter is broken.
  Scoring is an **exact cosine scan inside one org's rows** over the `(org_id, document_id)` btree:
  **never a global vector index** (no HNSW/IVFFlat — an EXPLAIN test pins the access path), and the
  vector leg additionally matches `embedding_model` so a workspace embedded by another model scores
  nothing rather than nonsense. An `injection_flagged` chunk is excluded by both legs and again by
  the re-read. An embedder failure **degrades to the lexical (`tsvector`) leg alone**
  (`mode: 'lexical'`, `degraded: true`, one warn) and never fails a draft — a Voyage outage costs
  grounding quality, not replies. `apps/worker`'s `ticket.draft` records the provenance
  (`score`, `mode`, `knowledgeVersion`, `retrieved`, `cited`) in `confidence_breakdown.grounding`
  and re-filters every id the model cites against what retrieval actually returned.
- **Memory.** A resolved answer reaches a prompt ONLY through the retriever's answers leg —
  `status = 'active'`, `org_id` in the SQL, `assertSameOrg` on the re-read, cosine ≥
  `MEMORY_RETRIEVE_MIN_COSINE`, vector-only (the degraded/lexical path returns no answers at all).
  A `candidate` (every auto-send produces one) is therefore invisible until a human samples it.
  `memory.capture` is the ONLY writer of a new `resolved_answers` row, and it is idempotent on
  `drafts.memory_captured_at`; `scrubForMemory` runs on every stored question and answer, and an
  empty result is a skip (`memory.skipped`, `empty_after_scrub`), never a stored empty string.
  `expires_at` is a FIXED 365 days from the human decision that set it — capture, a reinforcing
  approval, or `confirmCandidate` — and **nothing else moves it**: being retrieved into a prompt,
  or cited by a draft nobody approved, buys an answer no extra life. The api's
  memory service and `flagAutoSent`/`rejectDraft` are the strike/retire paths; two strikes retire.
- **Knowledge bounds.** PDF and DOCX are parsed in a **forked child** (`runParserInChild`) under
  `--max-old-space-size=512` and a 60 s clock, never in the worker process; uploads are capped at
  `KNOWLEDGE_MAX_UPLOAD_BYTES` (20 MiB) declared to the api AND re-checked by `knowledge.ingest`'s
  HEAD, which deletes the object and clears `storage_key` when it refuses. A paste is capped at
  `KNOWLEDGE_MAX_PASTE_CHARS`, a chunk at `KNOWLEDGE_CHUNK_MAX_CHARS`; a crawl is https-only,
  same-site, with starts spaced >= 250 ms apart per host and at most two requests in flight, at most 3 redirect hops each
  re-validated through the SSRF guard, and bounded by `knowledge.max_crawl_pages`. Sources are
  bounded by `knowledge.max_sources` and embedding by `knowledge.daily_embed_tokens_cap`, all three
  resolved per org through `resolveSetting`. Every chunk is screened by `screenChunk` before it is
  stored, and a flagged chunk is stored but never retrieved until an owner clears the flag.
  `workspaces.knowledge_version` is bumped **in the same transaction as the chunk-set change that
  caused it** (ingest, each crawl batch that actually changed something, delete, unflag) — it is
  provenance, not a cache key. It tracks the set of RETRIEVABLE chunks, and a chunk is retrievable
  (lexically) from the moment ingest stores it, so `knowledge.embed-batch` filling in vectors never
  bumps it; "fully embedded" is `embedded_count = chunk_count` on the source, a different question.
- **Lock order.** Any transaction touching more than one of the FOUR row kinds takes them in ONE
  global order, in the api AND the worker:
  **`outbound_sends` → `drafts` → `tickets` → `resolved_answers` / `workspaces`**. The first three
  are the order every `send.execute` path already takes; `approveDraft`, `holdDraft` and
  `resolveTicket` follow it, and the worker's draft landings lock the ticket's live drafts before the
  ticket flip. The FOURTH position is Phase 5's (task 9 review): a transaction that touches
  `resolved_answers` or `workspaces` beside a ticket takes them **LAST**, never before it — the
  worker's `applyDraftOutcome` locks the ticket and THEN flags a conflicting answer `needs_review` in
  the same transaction, and the api's `rejectDraft` does its ticket work first and only then strikes
  the used answers, appends the guidance line and runs `maybeDemote` (whose
  `agent_category_policies` / `notifications` writes ride in that same fourth position). Taking them
  first is a real `40P01` cycle, which is why `rejectDraft` is wrapped in `withDeadlockRetry` like its
  siblings. `apps/api/src/drafts/service.ts`'s header spells the same order out call by call.
- **Secrets.** Never logged, never returned by an API. `Secret` serializes as `[redacted]`; the api
  error handler strips SQL parameters and redacts URLs before anything reaches a log or a client.
- **App bundle.** `apps/app` never value-imports a server package — `@aesa/db`, `@aesa/core`,
  `@aesa/crypto`, `@aesa/queue`, `@aesa/mail`, `@aesa/platform-mail`, `@aesa/llm`, `@aesa/agent`,
  `@aesa/knowledge`, `@aesa/test-kit`, `@aesa/api`, `drizzle-orm`, `fastify`, `better-auth/node` or
  `node:*` — nor any of their sub-paths (`@aesa/db/*`, `@aesa/api/*`, `@aesa/agent/*`,
  `@aesa/knowledge/*`, `drizzle-orm/*`); `import type` is allowed
  throughout (ESLint block for `apps/app/**`). Share types through `@aesa/contracts`. The two PURE
  `@aesa/knowledge` sub-paths are pure for the API's sake, not the app's: they still reach `node:*`
  and the AWS SDK. The Expo web export is **25 static routes** since Phase 6's
  `(app)/settings/ai`.
- **Brand files are generated.** `brand/mark-{ink,paper,lifted}.svg`, `brand/lockup-{horizontal,
  stacked}.svg`, `brand/og-image.svg`,
  `apps/app/assets/{icon,adaptive-icon,splash-icon,notification-icon,favicon}.png`,
  `apps/api/public/{favicon.svg,favicon-16.png,favicon-32.png,favicon.ico,apple-touch-icon.png,og.png}`
  and `packages/contracts/src/brand.ts` (`BRAND`) are all written by `pnpm brand:build` from
  `brand/tokens.json` + `mark.svg` + `wordmark.svg` + `icons/*.svg` — never hand-edit one;
  `brand/test/build.test.ts` rebuilds into memory and fails on any byte of drift.
- **App typography and colour.** `apps/app` never sets `fontWeight` — one registered family per
  weight, named by `theme.ts`'s `font` — and never writes a literal colour outside `theme.ts`,
  whose palettes are token-only (`BRAND.light`/`BRAND.dark`); `brand/test/app-typography.test.ts`
  and `apps/app/src/theme.test.ts` enforce both. Icons come from `components/icon.tsx`'s `<Icon>`,
  never an icon font.
- **Auth tables.** Better Auth's `user`/`session`/`account`/`verification`/`organization`/`member`/
  `invitation` are `RLS_EXEMPT` with uuid ids minted by Postgres (`generateId: false`); the api
  reaches them only through Better Auth; tRPC's `orgProcedure` derives `orgId` from the session's
  active organization plus `getActiveMember`, never from input.
- **Audit.** Tenant-side audit rows go through `audit(tx, entry)` with actor `user:<id>` |
  `agent:<run_id>` | `system:<job>`; every tRPC mutation writes one.
- **Mailbox credentials.** `mailbox_credentials` is platform-role-only (migration 0006 `REVOKE`s
  `aesa_app`'s default DML entirely) — the api never reads or writes that table, not even through
  `withPlatform()`. A connect flow's sealed OAuth tokens reach it only via the
  `mailbox.store-credentials` job payload; the worker is the only process that ever opens them
  (`getAccessToken`, the KEK ring).
- **Provider credentials.** The same rule, one table over: `llm_credential_secrets` is
  platform-role-only (migration 0020 `REVOKE`s `aesa_app` outright, and a test asserts the grant list
  is empty) — the api never reads or writes it, not even through `withPlatform()`. A pasted BYOK key
  is sealed to the org's box public key in the api, rides the `llm.probe` payload and nowhere else,
  and is re-wrapped under the org DEK by the worker, which is the only process that ever opens one
  (`openCredentialKey`; `secretAad` is `${orgId}:llm_credential_secrets:${credentialId}`; the
  re-wrap is guarded on the exact ciphertext bytes it opened, so a mid-probe re-key cannot be
  reverted). `key_fingerprint` (sha256 hex prefix 8 + the key's last 4) is the ONLY thing any API
  ever returns, and `last_error` is the scrubbed `LlmError.message` cut to 200 chars.
- **Provider choice.** `resolveModelConfig` (`@aesa/db`) is the ONE reader of an agent's model
  choice — the worker's resolver, `agents.list`, `getAgentModel`, `sandboxStart` and
  `stats.rollup`'s graduation window all go through it, so no two surfaces can disagree about which
  model an agent runs on. The probe's stored verdict overrides a preset's `structuredOutput` in
  **both** directions for OpenAI-compatible endpoints (a preset is a guess about someone else's
  endpoint) and **never** for the Anthropic adapter (whose table is a fact); a `native` rung the
  endpoint then rejects with `permanent` falls through to `json_mode` rather than failing the draft.
  A BYOK call is SSRF-pinned at EVERY call — `createByokProvider` defaults `fetchFn` to
  `createPinnedFetch`, so it does not depend on a caller remembering — and the base URL is validated
  again at write time (https, a hostname, no credentials, `resolvePublic`; non-standard ports
  allowed). The limiter key is `byok:${orgId}:${credentialId}`. The worker's per-credential provider
  cache is keyed on FRESHNESS (`${credentialId}:${lastProbedAt}`) with a 15-minute ceiling, so a
  probe on any replica retires every replica's entry.
- **Metering.** Every BYOK call writes an `llm_calls` row with `mode = 'byok'` and its
  `credential_id`, and its cost bumps `LLM_METERS.costMicrosByok` (`llm_cost_micros_byok`) and
  **NEVER `llm_cost_micros`** — the managed daily USD cap (`autonomy.daily_llm_usd_cap`, read by
  `drafting/caps.ts`) is the platform's money and a tenant's own spend must never trip it. A model
  with no `model_pricing` row records `cost_unknown = true` and cost 0 rather than a wrong number,
  which is why the BYOK stop-loss is token-based (30k output tokens) beside the managed one ($0.40).
  Read sides that answer "what is this costing me" — Activity's headline tile — sum BOTH meters and
  label the BYOK half; the SEPARATION is a cap rule, not a display rule.
- **Toolchain.** TypeScript strict NodeNext ESM with explicit `.ts` imports, `tsx` at runtime (no
  build step), runtime dependencies in `dependencies`, vitest, zod 4. This covers the server
  packages and `apps/api` / `apps/worker`; `apps/app` extends `expo/tsconfig.base` instead
  (bundler resolution, JSX, extensionless imports) with `allowImportingTsExtensions`, `noEmit` and
  `types: ["node", "jest"]`, and is built by EAS; the root ESLint TypeScript block covers `**/*.tsx`.
- **Commits** end with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  (a convention, not a check).
