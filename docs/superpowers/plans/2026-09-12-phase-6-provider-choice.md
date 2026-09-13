# Phase 6 — Provider Choice (BYOK) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace can bring its own model provider — Anthropic, OpenAI, DeepSeek, Groq, Together, OpenRouter, or any OpenAI-compatible https endpoint — paste one API key in Settings → AI, watch the platform probe it (models list, one tiny chat, a structured-output probe), and point any agent's drafting and triage at that provider and model; every call still runs through the same structured-output ladder, limiter, metering and guardrails as Managed AI, the key never leaves the worker's envelope, every customer-supplied endpoint is SSRF-pinned at every call, a weaker model's self-confidence is capped by its quality tier so it cannot talk its way past Autopilot, a dead key parks tickets with "AI provider unavailable" instead of failing silently, and the owner sees what each key spent from `llm_calls`.

**Architecture:** `packages/llm` grows a second adapter (`adapters/openai-compatible`, the `openai` SDK with `baseURL` + presets), an optional `listModels` on the port, the missing `'none'` rung of the ladder, a `probeProvider` function and a `createByokProvider` composer beside `createManagedProvider`; `@aesa/crypto` gains `createPinnedFetch`, a `fetch`-shaped function the SDKs accept that validates, resolves and pins every request. `packages/db` gains `llm_credentials` (api-visible metadata), `llm_credential_secrets` (worker-only, `REVOKE`d from `aesa_app` like `mailbox_credentials`), `agent_model_config` (per agent × role) and the platform table `model_pricing`, plus `resolveModelConfig` — the ONE reader of an agent's model choice, shared by the api and the worker. The api's new `llm` router seals a pasted key to the org's box public key and hands it to the worker through the new `llm.probe` job (the same sealed-payload path mailbox credentials take); the worker's `provider-resolver.ts` opens the key under the org DEK, builds a cached per-credential provider and hands it to `ticket.draft`, `ticket.triage`, `agent.sandbox` and `guidance.suggest`. Quality tiers hook the ONE `model` term of `evidenceScore` and the graduation bar in `stats.rollup`.

**Tech Stack:** unchanged repo toolchain (Node 22, TypeScript 5.9, pnpm 10, Postgres 17 + pgvector, drizzle 0.44, Fastify 5, pg-boss 10, zod 4, vitest 3, Expo SDK 57 + jest-expo + Playwright). **ONE new runtime dependency:** `openai@7.15.0` (pinned exactly, `packages/llm` only). `undici` is already a dependency of `@aesa/crypto`.

**Spec:** `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md` — *Build phases → Phase 6* (scope and the Verify list), *LLM provider adapter* (the interface, capabilities probed not assumed, the provider table, the fallback ladder, config + metering tables, security, default models, risks), *AI cost model* (BYOK), *Data model → AI providers & metering*, *Launch risks → Quality variance across providers* and *→ Custom endpoints are an SSRF surface*, *Onboarding* ("95% of owners should never see the words provider or key in minute 8" — Settings → AI is a Settings screen, never an onboarding step).

## Global Constraints

- Node `>=22`; strict NodeNext ESM with explicit `.ts` imports, `tsx` at runtime, runtime deps in `dependencies`, zod 4, vitest 3; `apps/app` extends `expo/tsconfig.base` (extensionless imports, jest-expo). The CI gate stays `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check`; run it before every commit with the six `S3_*` exported (`S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 S3_BUCKET=aesa-dev S3_ACCESS_KEY_ID=aesa S3_SECRET_ACCESS_KEY=aesaaesa S3_FORCE_PATH_STYLE=true`); the database and minio must be running (`pnpm db:up && pnpm s3:init`). **Commit migrations before running `pnpm db:check`** (it `git clean`s the migrations directory).
- **Tenancy.** Every new tenant table carries `org_id uuid NOT NULL` first in its indexes, declares `...tenantPolicies(t.orgId, '<table>')`, and gets `ALTER TABLE "<t>" FORCE ROW LEVEL SECURITY;` in the hand-written hardening migration; `packages/db/test/rls.test.ts` demands exactly the two policies, and `model_pricing` (platform data, no `org_id`) joins its `RLS_EXEMPT` list beside `platform_state`; `packages/db/test/migrations.test.ts`'s `EXPECTED_TABLES` is an exact sorted list. **`llm_credential_secrets` is platform-role-only**: the hardening migration `REVOKE ALL ON "llm_credential_secrets" FROM "aesa_app"` (migration 0006's `mailbox_credentials` pattern), the api never reads or writes it, a pasted key reaches it only as a sealed job payload.
- **Data access.** Tenant reads/writes through `withOrg(db, orgId, fn)` (branded `OrgTx`) or `withPlatform(db, reason, fn)`; raw handles only from `@aesa/db/raw`. **A `withOrg` transaction never spans network I/O**: the api's `addCredential` resolves the base URL's hostname BEFORE its transaction opens; the worker's resolver opens a key in one transaction and calls the model outside every transaction; the probe job's three network steps sit between its read and its write transactions.
- **Jobs.** `defineJob(name, z.object-with-orgId, …)`, `enqueue` sets `singletonKey = ${orgId}:${entityId}`, handlers get an `AbortSignal`. **A new queue is added in FOUR places:** `JOB_NAMES`, the worker's `apps/worker/src/index.ts` pre-create list, the api's `apps/api/src/boss.ts` pre-create list, and `apps/worker/test/queue-preflight.test.ts`'s `it.each`. The ONE new queue, `llm.probe`, is `policy: 'short'` in `defineJob` AND in both pre-create calls, and — after Task 1 — its full options come from `QUEUE_OPTIONS` in `@aesa/queue`, the single table both pre-create lists and `defineJob` read. `llm.reprobe-sweep` is a cron (`registerCron`), not a queue.
- **Escalation and guarded writes.** Every entry into `needs_owner` goes through `escalateTicket`; the new reason `provider_unavailable` is no exception. Every status write is guarded on the status it was read at (`llm_credentials.health_status` included), and zero rows is a soft outcome. Lock order `outbound_sends → drafts → tickets → resolved_answers / workspaces` is unchanged; the new tables are never touched in a transaction that holds a draft or a ticket, EXCEPT `agent_category_policies` (the fourth position's neighbour) in the api's `setAgentModel`/`removeCredential`, which hold no draft and no ticket.
- **Guardrail gates.** Unchanged: three gates, one `validateReplyBody`, one `buildReplyPolicy`. A BYOK draft is screened exactly like a managed one — the provider never enters the policy.
- **Decision order is the spec's.** `decide()` does not change. A quality tier changes exactly ONE of its inputs: the `model` term of `evidenceScore({ memory, grounding, model })` is `min(model, QUALITY_CAPS[tier])`, computed in ONE shared helper (`apps/worker/src/drafting/evidence.ts`) used by `ticket.draft` and `agent.sandbox`. `drafts.confidence` still stores the model's own uncapped number; `confidence_breakdown.model` is the CAPPED term and `.modelCap`/`.tier` say why.
- **Quality tiers (spec §Risks, numbers fixed here — deviation 6).** `calibrated` cap 1.0 (Managed AI, and Anthropic BYOK opus/sonnet), `standard` cap 0.9 (frontier BYOK: OpenAI `gpt-5*`, DeepSeek `deepseek-chat`/`-reasoner`, OpenRouter's `anthropic/*`, Groq/Together 70B-class), `limited` cap 0.6 (every other model, every custom endpoint, and ANY model whose probe found no structured output). Graduation `minDecisions`: 20 / 40 / never suggested or auto-graduated. `qualityTierFor(provider, model)` is the catalog lookup in `@aesa/contracts`; the probe downgrades only.
- **SSRF (spec §Security, verbatim).** A BYOK base URL is https only, a hostname (never an IP literal), no credentials in the URL, resolved to a public address (`resolvePublic`) at write time AND at every call (`createPinnedFetch`: lookup override pinning the vetted IP, `redirect: 'manual'` → a 3xx throws), non-standard ports allowed. `validateOutboundUrl` + `resolvePublic` are the only validators; nothing hand-rolls a hostname check.
- **Secrets / PII.** A pasted key is never logged, never audited, never returned by an API, never stored outside `llm_credential_secrets`; the api stores `key_fingerprint` (`sha256` hex prefix 8 + the key's last 4 characters) for display. Every adapter scrubs `sk-…`/`Bearer …` out of every error message (the Anthropic adapter's `scrubSecrets`, reused). `last_error` on a credential is the scrubbed `LlmError.message` cut to 200 chars.
- **Metering.** Every BYOK call writes an `llm_calls` row with `mode = 'byok'` and `credential_id`; its cost bumps `llm_cost_micros_byok`, NEVER `llm_cost_micros` — the managed daily USD cap (`autonomy.daily_llm_usd_cap`, read by `drafting/caps.ts`) is the platform's money and a tenant's own spend must never trip it. A model with no pricing row writes `cost_unknown = true` and cost 0.
- **App.** `apps/app` never value-imports a server package or `node:*`; enums and the provider catalog the app renders live in `@aesa/contracts`; no `fontWeight`, no literal colour outside `theme.ts`; **ONE new route file** (`src/app/(app)/settings/ai.tsx`) — the web export goes from 24 to **25** routes and every doc that pins 24 is updated. App tests: `await render()`, self-contained `jest.mock` factories, no fake timers.
- **Audit.** Every tRPC mutation writes `audit(tx, entry)` with actor `user:<id>`; the jobs write `system:<job>` rows for every transition an owner can see (a probe verdict, a credential going dead, a model change, a `model_changed` demotion).
- Commits end with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; work on branch `phase-6` (off `main` at `99a852d`, first commit `0449596` = the Phase 5 hand-off cherry-pick); never push, merge or open a PR without Robert.

## Deviations from the spec's Phase 6 list (flagged; the spec wins on everything else)

1. **`org_data_keys` already exists** (Phase 0) and is reused unchanged: a BYOK key is sealed by the api to the org's box public key, rides the `llm.probe` payload, and is re-wrapped under the org DEK by the worker — the exact `mailbox.store-credentials` shape. The spec's `key_ciphertext`/`key_nonce`/`data_key_version` collapse to `key_ciphertext` (the envelope carries its own nonce) + `encryption` (`sealed`|`dek`) + `data_key_version`.
2. **`agent_model_config` is per agent × role (`draft`, `triage`) in v1.** `guidance_suggest` follows the agent's `triage` row (the cheap model); `probe` has no config row (a probe is the credential's own). The `agent_id IS NULL` workspace-default row the spec admits is allowed by the schema (`NULLS NOT DISTINCT` unique) but written by no v1 surface; `resolveModelConfig` falls straight from the agent row to the managed default.
3. **`model_generation` semantics.** Changing an agent's draft provider, model or mode bumps `model_generation`, stamps `model_generation_at`, and in the same transaction demotes every `auto` category of that agent to `review` with the new reason `model_changed` (through `demoteCategory`) and clears pending graduation suggestions; `stats.rollup` evaluates graduation only over decisions made at or after `model_generation_at`. The spec says only "bumping it resets graduation streaks".
4. **No `echo` tool probe.** Tools are off in v1 for every provider (spec §Fallback ladder: "off in v1"), so the probe is: models list (when the adapter has `listModels`), one tiny chat, and a 2-field structured-output probe tried at `native` then `json_mode`. Its result overrides the preset's `structuredOutput` capability DOWNWARD only.
5. **`egress_allowlist[]` is cut** (YAGNI skeptic): a credential's `base_url` host IS its allowlist — validated at write and pinned at every call. `transport` lands as a `text` column (`direct` only, CHECK) as the spec's on-prem seam; no bridge, no `extra_headers`.
6. **Tier numbers and rules are fixed here** (the spec gives "capped at 0.6" for local/small and "graduation streak requirements scale with a model-quality tier" without numbers): three tiers, caps 1.0 / 0.9 / 0.6, graduation `minDecisions` 20 / 40 / never. All in `QUALITY_CAPS` and `graduationRulesFor` (`@aesa/core`) so they can be tuned in one place.
7. **Error policy, narrowed to what lands.** `auth` on a BYOK credential → the credential goes `dead`, ONE `provider_health` notification (day-deduped per credential), and the ticket goes to `needs_owner` with the new reason `provider_unavailable` (there is no draft to review; the owner's copy is "AI provider unavailable — check Settings → AI") with no retry. `rate_limit`/`transient` keep the existing job retry (pg-boss backoff, ceiling 2 → `agent_failed`); `retryAfterMs` is logged, not scheduled. **`context_too_long`'s "halve retrieval, retry once" is NOT implemented** (carried); it lands `llm_context_too_long` like any failure today. `fallback_to_managed` = one managed retry on `auth`/`rate_limit`/`transient` when the flag is on AND the replica has `ANTHROPIC_API_KEY`, metered as `mode = 'managed'` (billable to the platform allowance — the spec's "opt-in billable").
8. **Re-probe cadence is a `cron`-role cron** `llm.reprobe-sweep` every 6 hours that enqueues `llm.probe` (`reason: 'scheduled'`) for every credential not `dead` and not probed in the last 6 hours; `degraded` after 2 consecutive failures, `dead` only on `auth`; a `dead` credential is re-probed only by the owner's "Test connection". The spec's "dead → UI badge + owner notification" is the `provider_health` notification + the health chip.
9. **`model_pricing` is a platform table seeded by migration** (RLS_EXEMPT, like `platform_state`) from `PRICING_SEED` plus the BYOK families; the worker loads it once at boot (`loadModelPricing`) into `withMetering`'s `pricing` option and falls back to `PRICING_SEED` when the table is empty. No admin UI; a price change is a migration. BYOK cost lands in the separate meter `llm_cost_micros_byok` (see Global Constraints → Metering).
10. **Settings → AI is ONE new route** (`settings/ai.tsx`, 24 → 25); the per-agent override is a "Model" card on the existing agent edit screen, not a route. The onboarding flow is untouched.
11. **Local endpoints need https and a public address in v1** (non-standard ports allowed): `http://localhost:11434` Ollama is unreachable until the spec's bridge lands. The runbook and the screen say so plainly. Ollama/vLLM/LM Studio are therefore ONE catalog entry, `custom` (OpenAI-compatible), not three presets.
12. **OpenAI `json_schema` is sent non-strict.** Strict mode demands `additionalProperties: false` and every property required, which would rewrite the draft schema's optional fields; the ladder's `json_mode` → repair → extract rungs already cover a non-strict miss. Recorded as the preset quirk `strictJsonSchema: false`.
13. **Carries folded in.** Task 1: `QUEUE_OPTIONS`, the `registerJob`-level drizzle-error scrub, the crawl partial unique index. Task 7: `agent_runs.kind = 'triage'` rows, `memory.capture`'s embed metered AND capped, the shared evidence helper. Task 11: the `flags` demotion E2E scenario. **Carried again** (record at close): the `src/drafts/learning.ts` split, `context_too_long` retrieval halving, and the rest of Phase 5's list.

### Rulings during execution (appended at close-out, 2026-09-12)

The controller's decisions on Robert's behalf while this plan was executed, in order. Where one amends a Deviation above, it says so — the ruling wins. STATUS.md's Phase 6 record carries the same list.

1. Task 4's probe test drives the RAW fake, not `withStructuredLadder` — the probe's contract is "drive the raw adapter's rungs itself"; through the ladder it would test the ladder.
2. `push-routing.ts`'s `provider_health` entry is Task 5's edit and Task 9 asserts it — one task owns each file edit.
3. The brief's "label map" IS `REASON_CHIP` (1–2 word labels), so `'AI provider unavailable'` stays there; `REASON_SENTENCE` gets a sentence in its siblings' voice.
4. Keep the `deepseek-chat`/`deepseek-reasoner` catalog ids and pricing rows: an unverified web claim should not drive a mid-phase catalog churn, and a probe on a real key shows the truth. **Conditioned by ruling 23.**
5. Task 4's shape ratified: `runProviderContract` on the `@aesa/llm/testing` sub-path (the root would drag vitest into production graphs), `withCauseMessage` lifted to `core/shared.ts`, the brief's non-existent "none makes zero calls" case replaced by `structured-none.test.ts`.
6. **`createByokProvider` must DEFAULT `fetchFn` to `createPinnedFetch`** — "SSRF at every call" must not depend on every caller remembering to pass it.
7. Task 5's four-deps shape, `runLlmProbe`'s `'unknown'` fifth return and the `fetchFn?` seam stand.
8. Task 5's fix round promoted two minors to correctness: a re-wrap guarded on `encryption = 'sealed'` alone would silently revert a key after a double rotation, and `JSON.parse` on decrypted plaintext can echo the key into an unscrubbed error.
9. `managed = anthropicApiKey ? createManagedProvider(...) : null`; when null (dev/test only — production still throws) `llm.probe` is still registered, while the five model-calling jobs keep their transitional warn-and-skip until Task 6 puts them all on the resolver.
10. Task 6's fix round carried the fallback call's own idempotency key (it collided with the primary's error row, leaving the fallback call unmetered) plus per-attempt provenance, the triage fallback's trace, the sandbox's effort, `cacheTtlFor`, `FALLBACK_CODES`' home and the run clock.
11. `confidence_breakdown.modelGeneration` identifies the **agent's** configured generation — a fallback is an event inside it, recorded by `mode`/`provider`/`modelId`; the rollup's window keys on `resolveModelConfig(...).modelGenerationAt`, which is authoritative. (Amplifies Deviation 3.)
12. The in-transaction `llm.probe` enqueue stands: pg-boss `send` is one INSERT on the boss pool, not external network I/O, and it is the transaction's last statement.
13. `agentsUsing` = `countDistinct(agent_id)` — Task 8's brief said "config rows", which would double-count every BYOK agent.
14. Task 9's fix round took six UX/secrets items: the save that reverted itself, a 2-minute cap on the probe wait, an error state for the card, `gcTime: 0` on the add mutation, a required-field hint for a custom connection, a Cancel beside Confirm remove.
15. `probeTimedOut`'s banner may greet an owner whose connection sat `unknown` since before the screen opened — kept: accurate and actionable.
16. **AMENDS DEVIATION 4 — the spec wins.** `probeProvider` tries `native` first for every non-Anthropic provider regardless of the preset, and `createByokProvider`'s override applies the stored verdict to the OpenAI-compatible adapter in BOTH directions (`native` raises an unknown model, `json_mode`/`none` narrow); the Anthropic adapter is never overridden and the quality tier is untouched. The spec says `json_schema` is "treated as `json_mode` unless probe passes" and that "presets are overridden by the stored probe result". Deviation 4's downward-only narrowing would have fossilized a guess about someone else's endpoint.
17. The whole-branch fix wave carries all twelve Important findings (deduplicated to ten changes) plus two ledger minors, in one wave of three commits grouped by package.
18. Activity's headline cost = managed + BYOK with a "$X of this on your own provider keys" subtitle; the METER separation stays, because the managed daily cap must never charge a tenant's own spend.
19. The ladder catches a `permanent` `LlmError` on the NATIVE rung only and falls through to `json_mode`, so a wrong probe verdict for one model on a credential costs one call, never a draft.
20. An `auth` failure on a BYOK primary ALWAYS marks the credential dead and pages once, whether or not the fallback then lands the draft; only the ticket escalation is skipped when the fallback succeeded. (Resolves the tension inside Deviation 7.)
21. `credential_dead` is refused only when a save SELECTS a *different* credential than the agent's current one — re-saving the current (dead) credential to flip fallback or effort is the one remedy the product offers.
22. No second fix wave: of the re-review's four Low residuals, `keyByCredential`'s LRU trim and `ticket.triage`'s docblock folded into Task 11's own commit; the other two are carried in STATUS.
23. **Deviation 4's DeepSeek carry gets a named runbook line item** (D's condition on ruling 4): `docs/runbooks/2026-09-phase-6-external-setup.md` §4 tells Robert to re-verify DeepSeek's live model ids and prices against a real key before DeepSeek is offered.

**One spec item this phase activated and closed late:** the BYOK stop-loss (spec §Budgets, "30k output tokens BYOK") was missing from Deviations 1–13 and from the code; the whole-branch review caught it and the fix wave implemented it (`STOP_LOSS_BYOK_OUTPUT_TOKENS`). **One structural carry this plan named and did NOT deliver:** Deviation 13's "carried again" list still stands in full — the `src/drafts/learning.ts` split was not done, and `ticket-draft.ts` grew to ~1,021 lines beside it.

## File structure

```
packages/queue/src/queue-options.ts     NEW (QUEUE_OPTIONS: name → { policy, retryLimit, retryDelay, retryBackoff, expireInSeconds })   Task 1
packages/queue/src/define-job.ts        MODIFY (defineJob reads QUEUE_OPTIONS when `queue` omitted; registerJob scrubs DrizzleQueryError)  Task 1
packages/db/migrations/0018_crawl_url_uidx.sql (hand-written partial unique index)                                                     Task 1
packages/contracts/src/llm.ts           NEW (LLM_PROVIDERS, PROVIDER_PRESETS, MANAGED_MODELS, QUALITY_TIERS, qualityTierFor, inputs, views) Task 2
packages/contracts/src/{drafts,triage,notify,autonomy}.ts  MODIFY (DRAFT_MODEL_ID alias; provider_unavailable; provider_health; model_changed) Task 2
packages/core/src/quality.ts            NEW (QUALITY_CAPS, cappedModelConfidence, graduationRulesFor)                                     Task 2
packages/db/src/schema/llm.ts           NEW (llm_credentials, llm_credential_secrets, agent_model_config, model_pricing)                  Task 3
packages/db/src/schema/runs.ts          MODIFY (llm_calls + credential_id, mode, cost_unknown) · metering.ts (+costMicrosByok, sink writes) Task 3
packages/db/src/model-config.ts         NEW (resolveModelConfig, ResolvedModelConfig) · pricing.ts NEW (loadModelPricing) · index.ts    Task 3
packages/db/migrations/0019_<generated>.sql, 0020_provider_hardening.sql + meta/_journal.json                                            Task 3
packages/crypto/src/ssrf/pinned-fetch.ts MODIFY (signal on PinnedTransportInit; createPinnedFetch) · index.ts                            Task 4
packages/llm/src/core/types.ts          MODIFY (listModels?, ChatMeta.mode/credentialId, ParseStrategy 'plain')                           Task 4
packages/llm/src/core/structured.ts     MODIFY (the 'none' rung) · metering/{types,with-metering}.ts (mode, credentialId)                 Task 4
packages/llm/src/adapters/openai-compatible/{index,models,map-errors}.ts  NEW · adapters/anthropic/index.ts (+listModels)               Task 4
packages/llm/src/core/probe.ts          NEW (probeProvider) · core/registry.ts (createByokProvider, withMeta) · pricing/seed.ts (+rows)  Task 4
packages/llm/src/index.ts               MODIFY (exports) · package.json (+openai)                                                        Task 4
packages/llm/test/{openai-compatible,structured-none,probe,contract}.test.ts  NEW                                                       Task 4
apps/worker/src/provider-resolver.ts    NEW (createProviderResolver, staticResolver, ProviderResolver, ResolvedProvider)                  Task 5
apps/worker/src/jobs/llm-probe.ts       NEW · jobs/llm-reprobe-sweep.ts NEW · provider-health-notify.ts NEW                              Task 5
apps/worker/src/{config,index,agent-role}.ts  MODIFY (KEK gate for agent; the queue in its places; resolver wired) · boss.ts (api)       Task 5
apps/worker/src/drafting/evidence.ts    NEW (computeEvidence) · jobs/{ticket-draft,agent-sandbox,ticket-triage,guidance-suggest,memory-capture}.ts MODIFY  Task 6
packages/agent/src/{draft/prompt,draft/run,triage,guidance/suggest}.ts  MODIFY (model in the input; runTriageCallDetailed)              Task 6
apps/worker/src/jobs/stats-rollup.ts    MODIFY (graduationRulesFor(tier); model_generation_at window)                                   Task 7
apps/api/src/llm/service.ts             NEW (@aesa/api/llm) · trpc/routers/llm.ts NEW · trpc/router.ts · routers/agents.ts (sandboxStart) Task 8
apps/app/src/app/(app)/settings/ai.tsx  NEW (route) · screens/settings/ai.tsx NEW · screens/settings/agent-edit.tsx (Model card)         Task 9
apps/app/src/screens/settings/index.tsx MODIFY (AI row live) · lib/push-routing.ts (provider_health)                                     Task 9
apps/worker/test/e2e-phase6.test.ts     NEW · test/helpers/mock-openai.ts NEW · test/e2e-phase5.test.ts (+flags scenario)                Task 10
docs/runbooks/2026-09-phase-6-external-setup.md NEW · docs/STATUS.md · CLAUDE.md · apps/{api,worker}/.env.example · docs/superpowers/reviews/  Task 11
```

## Repo facts the tasks rely on (surveyed 2026-09-12; do not re-derive)

- `LlmProvider` (`packages/llm/src/core/types.ts`) is `{ kind; capabilities(model); chat(req) }`; `createManagedProvider` composes `withMetering` (innermost) → `withLimiter` → `withStructuredLadder` around `createAnthropicProvider`. `withLimiter(inner, limiter, keyFor?)` already accepts a key function (the `byok:${orgId}:${credentialId}` key is documented in `limiter.ts`'s header). `MeterRecord` mirrors `llm_calls` field for field; `createMeterSink` (`packages/db/src/metering.ts`) writes it and bumps `LLM_METERS`.
- `withStructuredLadder` returns `parsed: null, parseStrategy: 'none', usage 0, apiCalls 0` for a `structuredOutput: 'none'` model WITHOUT calling the model (the unreachable branch; ruling ledger 74).
- The Anthropic adapter's `scrubSecrets`, `parseRetryAfterMs`, `withCauseMessage`, `envelopeSchema`, `toJsonObjectSchema` are module-private; Task 4 lifts `scrubSecrets`/`parseRetryAfterMs`/`envelopeSchema`/`toJsonObjectSchema` into `packages/llm/src/core/shared.ts` and imports them from both adapters.
- `packages/crypto`'s `pinnedFetch(input, init)` takes `PinnedFetchInit` (`method/headers/body/timeoutMs/maxBodyBytes/redirect/resolver/allowNonstandardPort`) — NO `signal`; `fetchThroughPinnedDispatcher` builds its own `AbortSignal.timeout`. `validateOutboundUrl(input, { allowNonstandardPort })`, `resolvePublic(hostname, { resolver })`, `buildPinnedDispatcher(address, family)` are exported.
- `agent-role.ts` builds ONE provider and hands it to the five agent-role jobs as `deps.provider`; `TicketDraftDeps`/`AgentSandboxDeps`/`TicketTriageDeps`/`GuidanceSuggestDeps` each carry `provider: LlmProvider`. `ticket.draft`'s `gateAndRecordRun` writes `agent_runs.provider/model` from `deps.provider.kind`/`DRAFT_MODEL`; `agents.sandboxStart` (api) writes `provider: 'anthropic', model: DRAFT_MODEL_ID`. `runDraftCall(provider, input, meta, signal)`, `runTriageCall(provider, input, meta, signal)` (throws on `parsed === null`), `runGuidanceSuggestCall(provider, input, meta, signal)` all hard-code their model constants (`DRAFT_MODEL` = contracts' `DRAFT_MODEL_ID` = `claude-opus-5`; `TRIAGE_MODEL` = `GUIDANCE_SUGGEST_MODEL` = `claude-haiku-4-5`).
- `tickets.agent_id` is nullable; `ticket.triage` never reads the agent today. `drafts.agent_id` is set on every draft. `agent_runs.kind` CHECK already admits `triage` (0011); only draft and sandbox runs create rows.
- The evidence block is duplicated: `ticket-draft.ts` ~lines 680–705 and `agent-sandbox.ts` ~lines 400–416 compute `citedChunkIds`/`usedAnswerIds`/`memoryConflictIds`/`groundingScore`/memory/evidence the same way.
- `stats.rollup` (`apps/worker/src/jobs/stats-rollup.ts`) loads each org's drafts in step (b) into per-(agent, category) signals and calls `evaluateGraduation` + `graduateCategory(org, { …, auto: policy.autoGraduate })` in step (d); `GRADUATION_RULES` is `{ minDecisions: 20, minUnchangedRate: 0.9, rejectionFreeDays: 14, sampleSize: 20 }`.
- `demoteCategory(tx, { orgId, agentId, categoryId, categoryLabel, reason, now, day, actor })` is guarded on `mode = 'auto'` and inserts the `demotion` notification itself, returning `{ demoted, notificationId? }`; `DEMOTION_REASONS` is a contracts enum with no DB CHECK.
- `escalateTicket(tx, { orgId, ticketId, fromStatus, reason, day, dedupeKey?, now, actor, auditAction, … })` returns `{ notificationId }`; `NEEDS_OWNER_REASONS` has no DB CHECK; `escalationCopy(reason)` maps every reason to `{ title, body }` and must gain the new one.
- `notifications.kind` HAS a CHECK (`notifications_kind_check`, last rewritten in 0017) — a new kind means DROP + ADD in the hardening migration. Push routing lives in `apps/app/src/lib/push-routing.ts`.
- The api seals to the org box with `sealTo(publicKey, plaintext)` (`@aesa/crypto`) after `getOrgBoxPublicKeyOrNull(tx)`; the worker opens with `openSealedForOrg(tx, ring, sealed)` and re-wraps with `encrypt(dek, plaintext, aad)` after `loadOrgDek(tx, ring)` (`apps/worker/src/jobs/mailbox-credentials.ts`). `mailbox_credentials`' AAD is `${orgId}:mailbox_credentials:${connectionId}`.
- The api's tests build a server with `createTestApi()` (`apps/api/test/helpers/app.ts`) and call routers through `createTRPCClient` with a cookie from `signInWithOtp`; `insertConnectedMailbox` + `mailboxes.addAddress` mint an agent. The worker's job tests run `run<Job>(deps, payload, signal)` directly against `createTestDatabase()` with `createFakeProvider`.
- `apps/api/test/error-surface.test.ts` walks the api's REAL module graph and fails if the Anthropic SDK (or any `packages/llm` root import) enters it — the api may import `@aesa/contracts`' catalog and `@aesa/crypto`'s SSRF helpers, never `@aesa/llm`.
- `apps/app/src/screens/settings/index.tsx` already renders the `AI` row with `badge="Phase 6"` and no `onPress`; `agent-edit.tsx` saves dirty keys through `agents.update`.
- `pnpm view openai version` → `7.15.0` (2026-09-12). Verify the installed SDK's `chat.completions.create` parameter and error-class names against `node_modules/openai/*.d.ts` before writing the adapter, exactly as the Anthropic adapter's header records for 0.124.0.

---

### Task 1: Branch, plan commit, and the three folded carries (`QUEUE_OPTIONS`; the `registerJob` drizzle-error scrub; the crawl partial unique index)

**Files:**
- Create: `packages/queue/src/queue-options.ts`, `packages/queue/test/queue-options.test.ts`, `packages/db/migrations/0018_crawl_url_uidx.sql`, `packages/db/test/knowledge-sources-uidx.test.ts`
- Modify: `packages/queue/src/define-job.ts`, `packages/queue/src/index.ts`, `packages/queue/test/define-job.test.ts`, `apps/worker/src/index.ts` (pre-create list), `apps/api/src/boss.ts` (pre-create list), `packages/db/migrations/meta/_journal.json`, `packages/knowledge/src/index.ts` (no code change — the index's name is documented in `apps/api/src/knowledge/service.ts`'s `startCrawl` catch)
- Test: the two new tests above; `apps/worker/test/queue-preflight.test.ts` (unchanged — it keeps proving the policy sticks)

**Interfaces:**
- Produces: `QUEUE_OPTIONS: Record<JobName, JobQueueOptions>` (every queue's `policy`, `retryLimit`, `retryDelay`, `retryBackoff`, `expireInSeconds` — the SAME values each `defineJob` call passes today, moved into one table) and `queueOptionsFor(name: JobName): PgBoss.Queue` (the `{ name, policy, retryLimit, retryDelay, retryBackoff, expireInSeconds }` shape `createQueueRetrying` takes). Task 5 adds `llm.probe` to this table.
- Produces: `scrubJobError(err: unknown): unknown` — a `DrizzleQueryError` is replaced by a plain `Error` whose message is `Failed query: [redacted]` + the pg code; everything else passes through. `registerJob` applies it to whatever a handler throws.

- [ ] **Step 1: Branch state check and the plan commit**

The branch already exists with the hand-off as its first commit (created by the planning session):

```bash
git status --short            # must be clean apart from this plan file
git log --oneline -2          # 0449596 docs(status): Phase 5 hand-off …  /  99a852d Merge pull request #6 …
git add docs/superpowers/plans/2026-09-12-phase-6-provider-choice.md
git commit -m "docs(plan): Phase 6 — provider choice (BYOK) implementation plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing test for `QUEUE_OPTIONS`**

`packages/queue/test/queue-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { JOB_NAMES } from '../src/names.ts'
import { QUEUE_OPTIONS, queueOptionsFor } from '../src/queue-options.ts'

describe('QUEUE_OPTIONS', () => {
  it('has a row for EVERY JOB_NAMES entry (a queue with no row cannot be pre-created with its options)', () => {
    for (const name of Object.values(JOB_NAMES)) expect(QUEUE_OPTIONS[name], name).toBeDefined()
  })

  it('the nine short queues declare policy short and the two push-fed ones stay standard', () => {
    const short = [
      JOB_NAMES.ticketDraft, JOB_NAMES.sendExecute, JOB_NAMES.agentSandbox, JOB_NAMES.notifyDispatch,
      JOB_NAMES.knowledgeIngest, JOB_NAMES.knowledgeCrawl, JOB_NAMES.knowledgeEmbedBatch, JOB_NAMES.memoryCapture, JOB_NAMES.guidanceSuggest,
    ]
    for (const name of short) expect(QUEUE_OPTIONS[name].policy, name).toBe('short')
    expect(QUEUE_OPTIONS[JOB_NAMES.ticketTriage].policy ?? 'standard').toBe('standard')
    expect(QUEUE_OPTIONS[JOB_NAMES.mailboxSync].policy ?? 'standard').toBe('standard')
  })

  it('queueOptionsFor returns the PgBoss.Queue shape with name and policy always present', () => {
    expect(queueOptionsFor(JOB_NAMES.ticketDraft)).toEqual({ name: 'ticket.draft', policy: 'short', expireInSeconds: 600, retryLimit: 2, retryDelay: 30, retryBackoff: true })
    expect(queueOptionsFor(JOB_NAMES.ticketTriage)).toMatchObject({ name: 'ticket.triage', policy: 'standard' })
  })
})
```

Before writing the table, read every `defineJob({ … queue: { … } })` call in `apps/worker/src/jobs/*.ts` and copy its values EXACTLY — this task moves numbers, it does not change them. Run `grep -n "queue: {" apps/worker/src/jobs/*.ts` and record each queue's current options in the table; where the test above guesses a number (`ticket.draft`'s 600/2/30/true), correct the TEST to the real value, never the job.

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter @aesa/queue test test/queue-options.test.ts`
Expected: FAIL — `Cannot find module '../src/queue-options.ts'`.

- [ ] **Step 4: Write `queue-options.ts` and wire `defineJob`**

`packages/queue/src/queue-options.ts`:

```ts
import type PgBoss from 'pg-boss'
import type { JobQueueOptions } from './define-job.ts'
import { JOB_NAMES, type JobName } from './names.ts'

/**
 * The ONE table of per-queue pg-boss options (Phase 4 residual, folded into Phase 6): `defineJob`
 * reads a queue's options from here, and BOTH pre-create lists (`apps/worker/src/index.ts`,
 * `apps/api/src/boss.ts`) pass `queueOptionsFor(name)` to `createQueueRetrying` — so the options
 * reach `pgboss.queue` at the queue's FIRST-EVER creation, whichever process creates it. Before this
 * table an api-only cold boot created a queue with NULL options, and a job sent before the worker's
 * `registerJob` ran `updateQueue` carried pg-boss's defaults (retry_limit 2, delay 0, 15-min expiry).
 *
 * Values are the ones each job's `defineJob` call carried before this table existed — copied, not
 * changed. `policy` absent means `standard` (ticket.triage, mailbox.sync: push-fed, debounced
 * through `enqueue`'s `debounceSeconds` instead — CLAUDE.md, Jobs).
 */
export const QUEUE_OPTIONS: Record<JobName, JobQueueOptions> = {
  [JOB_NAMES.keysProvision]: { expireInSeconds: 60, retryLimit: 5, retryBackoff: true },
  [JOB_NAMES.storeCredentials]: { expireInSeconds: 60, retryLimit: 5, retryBackoff: true },
  [JOB_NAMES.revokeMailbox]: { expireInSeconds: 120, retryLimit: 3, retryBackoff: true },
  [JOB_NAMES.mailboxSync]: { /* copy from jobs/mailbox-sync.ts */ expireInSeconds: 600 },
  [JOB_NAMES.ticketTriage]: { /* copy from jobs/ticket-triage.ts */ expireInSeconds: 120, retryLimit: 2, retryBackoff: true },
  [JOB_NAMES.ticketDraft]: { policy: 'short', /* copy */ expireInSeconds: 600, retryLimit: 2, retryDelay: 30, retryBackoff: true },
  [JOB_NAMES.agentSandbox]: { policy: 'short', /* copy */ expireInSeconds: 600 },
  [JOB_NAMES.sendExecute]: { policy: 'short', /* copy */ expireInSeconds: 600, retryLimit: 3, retryDelay: 30, retryBackoff: true },
  [JOB_NAMES.notifyDispatch]: { policy: 'short', /* copy */ expireInSeconds: 60, retryLimit: 3, retryBackoff: true },
  [JOB_NAMES.knowledgeIngest]: { policy: 'short', /* copy */ expireInSeconds: 600 },
  [JOB_NAMES.knowledgeCrawl]: { policy: 'short', /* copy */ expireInSeconds: 600 },
  [JOB_NAMES.knowledgeEmbedBatch]: { policy: 'short', /* copy */ expireInSeconds: 300 },
  [JOB_NAMES.memoryCapture]: { policy: 'short', /* copy */ expireInSeconds: 120 },
  [JOB_NAMES.guidanceSuggest]: { policy: 'short', /* copy */ expireInSeconds: 120 },
}

/** The `PgBoss.Queue` shape both pre-create lists hand to `createQueueRetrying`. */
export function queueOptionsFor(name: JobName): PgBoss.Queue {
  const { policy = 'standard', ...rest } = QUEUE_OPTIONS[name]
  return { name, policy, ...rest }
}
```

(The `/* copy */` markers are instructions to the implementer, not content to keep: replace each with the job's real values and delete the marker.)

In `packages/queue/src/define-job.ts`:
- `JobDefinition.queue` becomes OPTIONAL (`queue?: JobQueueOptions`); `defineJob` resolves `def.queue ?? QUEUE_OPTIONS[def.name as JobName]` and throws `job ${def.name}: no queue options — add a row to QUEUE_OPTIONS or pass queue` when neither exists; it stores the resolved options back on the returned definition (`{ ...def, queue: resolved }`) so `registerJob`/`enqueue` keep reading `def.queue`. Every existing `defineJob` call in `apps/worker/src/jobs/*.ts` then DROPS its `queue: { … }` literal (the api's `createEnqueue` and the tests that build throwaway definitions keep passing `queue` explicitly — they use names outside `JOB_NAMES`).
- `registerJob`'s per-job `try { await def.handler(...) }` gains `catch (err) { throw scrubJobError(err) }` before the `finally`. Add:

```ts
import { DrizzleQueryError } from 'drizzle-orm/errors'

/** A thrown `DrizzleQueryError` carries the failed SQL and its PARAMETERS on `.query`/`.params`,
 * and pg-boss writes a failed job's error into `pgboss.job.output` — which for a knowledge or memory
 * job can mean customer text. Replace it with a bare Error (message + pg code) before pg-boss sees
 * it; the original still went to the worker's pino logger through the job's own catch/log, where
 * `logging.ts`'s redaction applies. */
export function scrubJobError(err: unknown): unknown {
  if (!(err instanceof DrizzleQueryError)) return err
  const code = (err.cause as { code?: string } | undefined)?.code
  return new Error(`Failed query: [redacted]${code ? ` (pg ${code})` : ''}`)
}
```

`drizzle-orm` is already a dependency of `@aesa/queue`? Check `packages/queue/package.json`; if it is not, add `"drizzle-orm": "^0.44.0"` to `dependencies` (the ESLint raw-db rule bans `drizzle-orm/node-postgres`, not `drizzle-orm/errors`).

Add to `packages/queue/test/define-job.test.ts`:

```ts
it('registerJob scrubs a DrizzleQueryError before pg-boss records it', () => {
  const err = new DrizzleQueryError('insert into "t" ("secret") values ($1)', ['customer text'], Object.assign(new Error('dup'), { code: '23505' }))
  const scrubbed = scrubJobError(err) as Error
  expect(scrubbed.message).toBe('Failed query: [redacted] (pg 23505)')
  expect(scrubbed.message).not.toContain('customer text')
  expect(scrubJobError(new Error('plain'))).toEqual(new Error('plain'))
})
```

Then both pre-create lists: replace every `createQueueRetrying(boss, JOB_NAMES.x, { name: …, policy: 'short' })` and every bare `createQueueRetrying(boss, JOB_NAMES.x)` with `createQueueRetrying(boss, JOB_NAMES.x, queueOptionsFor(JOB_NAMES.x))`, and export `QUEUE_OPTIONS`/`queueOptionsFor` from `packages/queue/src/index.ts`.

- [ ] **Step 5: Run the queue and worker suites**

Run: `pnpm --filter @aesa/queue test && pnpm --filter @aesa/worker test test/queue-preflight.test.ts`
Expected: PASS (the preflight's policy test still reads `short` on every short queue).

- [ ] **Step 6: The crawl partial unique index (hand-written migration + test)**

`packages/db/migrations/0018_crawl_url_uidx.sql`:

```sql
-- Phase 4 residual: the source cap's read-then-insert and `refreshCrawl`'s resurrect race — one live crawl per URL per org.
CREATE UNIQUE INDEX "knowledge_sources_org_crawl_url_uidx" ON "knowledge_sources" ("org_id", "url") WHERE "kind" = 'crawl' AND "status" <> 'failed';
```

Append the journal entry (idx 18, tag `0018_crawl_url_uidx`, `when` = now in ms, `breakpoints: true`) to `packages/db/migrations/meta/_journal.json`. Drizzle's generated snapshot does not describe partial indexes written by hand (0011/0017 pattern) so `pnpm db:check` stays clean.

`packages/db/test/knowledge-sources-uidx.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { knowledgeSources, withOrg } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from '../src/testing.ts'

describe('knowledge_sources_org_crawl_url_uidx', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  let orgId: string
  beforeAll(async () => { t = await createTestDatabase(); handle = createDb(t.url, { role: 'app' }); orgId = await createTestOrganization(handle) })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  const insert = (status: string) => withOrg(handle.db, orgId, (tx) =>
    tx.insert(knowledgeSources).values({ orgId, kind: 'crawl', status, url: 'https://example.test/', title: 'x' }).returning({ id: knowledgeSources.id }))

  it('refuses a second live crawl of the same URL but allows one beside a failed one', async () => {
    await insert('queued')
    await expect(insert('ready')).rejects.toMatchObject({ cause: { code: '23505' } })
    await insert('failed')          // a failed row never blocks
  })
})
```

Adjust the `values({…})` to `knowledgeSources`' real NOT NULL columns (read `packages/db/src/schema/knowledge.ts`). In `apps/api/src/knowledge/service.ts`'s `startCrawl`, catch pg `23505` on that index name and return the existing soft code for "already crawling" (read the function; it has one for the read-then-check path — reuse it).

Run: `pnpm --filter @aesa/db test test/knowledge-sources-uidx.test.ts test/migrations.test.ts`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(queue,db): QUEUE_OPTIONS as the one source of queue options; registerJob scrubs DrizzleQueryError; one live crawl per URL (0018)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `@aesa/contracts` — the LLM vocabulary, the provider catalog and the inputs; `@aesa/core` — quality tiers

**Files:**
- Create: `packages/contracts/src/llm.ts`, `packages/contracts/test/llm.test.ts`, `packages/core/src/quality.ts`, `packages/core/test/quality.test.ts`
- Modify: `packages/contracts/src/index.ts` (+`export * from './llm.ts'`), `packages/contracts/src/drafts.ts` (`DRAFT_MODEL_ID` aliases `MANAGED_MODELS.draft`), `packages/contracts/src/triage.ts` (`NEEDS_OWNER_REASONS` + `'provider_unavailable'`), `packages/contracts/src/notify.ts` (`NOTIFICATION_KINDS` + `'provider_health'`), `packages/contracts/src/autonomy.ts` (`DEMOTION_REASONS` + `'model_changed'`), `packages/core/src/index.ts` (+`export * from './quality.ts'`), `packages/db/src/escalations.ts` (`escalationCopy` gains `provider_unavailable`), `apps/app/src/screens/settings/autopilot.tsx` (`DEMOTION_SENTENCE.model_changed`), `apps/app/src/screens/inbox/*` (the reason-label map that renders `needsOwnerReason` — grep `owner_handling` to find it)

**Interfaces:**
- Produces (`@aesa/contracts`): `LLM_PROVIDERS`, `LlmProviderId`; `MANAGED_MODELS = { draft: 'claude-opus-5', triage: 'claude-haiku-4-5', guidanceSuggest: 'claude-haiku-4-5' }`; `QUALITY_TIERS`, `QualityTier`; `MODEL_CONFIG_ROLES = ['draft','triage']`, `ModelConfigRole`; `MODEL_CONFIG_MODES = ['managed','byok']`; `CREDENTIAL_HEALTH = ['unknown','healthy','degraded','dead']`, `CredentialHealth`; `LLM_EFFORTS = ['low','medium','high']`; `PROVIDER_PRESETS: Record<LlmProviderId, ProviderPreset>`; `qualityTierFor(provider, model): QualityTier`; `presetModel(provider, role): string | null`; `LLM_MAX_CREDENTIALS = 5`; inputs `AddCredentialInput`, `CredentialIdInput`, `SetAgentModelInput`, `AgentIdInput` (existing); views `ProbeResult` (zod), `ProbeResultView = z.infer`.
- Produces (`@aesa/core`): `QUALITY_CAPS: Record<QualityTier, number>`, `cappedModelConfidence(model: number, tier: QualityTier): number`, `graduationRulesFor(tier): GraduationRules & { canGraduate: boolean }`.

- [ ] **Step 1: Write the failing contracts test**

`packages/contracts/test/llm.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  AddCredentialInput, DEMOTION_REASONS, DRAFT_MODEL_ID, LLM_PROVIDERS, MANAGED_MODELS, NEEDS_OWNER_REASONS, NOTIFICATION_KINDS,
  PROVIDER_PRESETS, presetModel, qualityTierFor, SetAgentModelInput,
} from '../src/index.ts'

describe('llm contracts', () => {
  it('every provider has a preset with a label, a consent name and a draft + triage suggestion (custom has no base URL)', () => {
    for (const id of LLM_PROVIDERS) {
      const p = PROVIDER_PRESETS[id]
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.consentName.length).toBeGreaterThan(0)
      if (id === 'custom') expect(p.baseUrl).toBeNull()
      else expect(p.baseUrl).toMatch(/^https:\/\//)
      if (id !== 'custom') { expect(presetModel(id, 'draft')).not.toBeNull(); expect(presetModel(id, 'triage')).not.toBeNull() }
    }
    expect(presetModel('custom', 'draft')).toBeNull()
  })

  it('DRAFT_MODEL_ID still names the managed draft model', () => {
    expect(DRAFT_MODEL_ID).toBe(MANAGED_MODELS.draft)
    expect(MANAGED_MODELS.draft).toBe('claude-opus-5')
    expect(MANAGED_MODELS.triage).toBe('claude-haiku-4-5')
  })

  it('quality tiers: managed Anthropic is calibrated, frontier BYOK is standard, everything unknown is limited', () => {
    expect(qualityTierFor('anthropic', 'claude-opus-5')).toBe('calibrated')
    expect(qualityTierFor('anthropic', 'claude-haiku-4-5')).toBe('standard')
    expect(qualityTierFor('openai', 'gpt-5')).toBe('standard')
    expect(qualityTierFor('openai', 'gpt-5-mini')).toBe('standard')
    expect(qualityTierFor('deepseek', 'deepseek-chat')).toBe('standard')
    expect(qualityTierFor('openrouter', 'anthropic/claude-opus-5')).toBe('standard')
    expect(qualityTierFor('groq', 'llama-3.3-70b-versatile')).toBe('standard')
    expect(qualityTierFor('groq', 'llama-3.1-8b-instant')).toBe('limited')
    expect(qualityTierFor('custom', 'qwen3:32b')).toBe('limited')
    expect(qualityTierFor('openai', 'something-new')).toBe('limited')
  })

  it('AddCredentialInput: a preset ignores baseUrl; custom requires an https URL; the key is bounded', () => {
    expect(AddCredentialInput.safeParse({ provider: 'openai', label: 'Prod', apiKey: 'sk-abcdefghij' }).success).toBe(true)
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij' }).success).toBe(false)
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij', baseUrl: 'http://10.0.0.1/v1' }).success).toBe(false)
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij', baseUrl: 'https://llm.example.com:8443/v1' }).success).toBe(false)   // custom also needs probeModel
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij', baseUrl: 'https://llm.example.com:8443/v1', probeModel: 'qwen3:32b' }).success).toBe(true)
    expect(AddCredentialInput.safeParse({ provider: 'openai', label: 'Prod', apiKey: 'short' }).success).toBe(false)
  })

  it('SetAgentModelInput: byok needs a credential; managed carries none', () => {
    expect(SetAgentModelInput.safeParse({ agentId: crypto.randomUUID(), mode: 'byok', credentialId: null, draftModel: 'gpt-5', triageModel: 'gpt-5-mini', effort: null, fallbackToManaged: false }).success).toBe(false)
    expect(SetAgentModelInput.safeParse({ agentId: crypto.randomUUID(), mode: 'managed', credentialId: null, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false }).success).toBe(true)
  })

  it('the three vocabularies gained their Phase 6 words', () => {
    expect(NEEDS_OWNER_REASONS).toContain('provider_unavailable')
    expect(NOTIFICATION_KINDS).toContain('provider_health')
    expect(DEMOTION_REASONS).toContain('model_changed')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @aesa/contracts test test/llm.test.ts`
Expected: FAIL — the imports do not exist.

- [ ] **Step 3: Write `packages/contracts/src/llm.ts`**

```ts
import { z } from 'zod'
import { HttpsUrl } from './workspace.ts'

/** The providers Settings → AI offers. `custom` is any OpenAI-compatible https endpoint (vLLM, LM
 * Studio, a hosted Ollama, Gemini's OpenAI-compatible route) — the spec's Ollama/vLLM/LM Studio
 * presets collapse into it because v1 reaches only public https hosts (plan deviation 11). */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'groq', 'together', 'openrouter', 'custom'] as const
export type LlmProviderId = (typeof LLM_PROVIDERS)[number]

/** Managed AI's models (spec §Decisions: drafting opus-5, triage haiku-4-5). The ONE source — the
 * worker's prompt builders and the api's run rows read these; `DRAFT_MODEL_ID` aliases `draft`. */
export const MANAGED_MODELS = { draft: 'claude-opus-5', triage: 'claude-haiku-4-5', guidanceSuggest: 'claude-haiku-4-5' } as const

export const QUALITY_TIERS = ['calibrated', 'standard', 'limited'] as const
export type QualityTier = (typeof QUALITY_TIERS)[number]

export const MODEL_CONFIG_ROLES = ['draft', 'triage'] as const
export type ModelConfigRole = (typeof MODEL_CONFIG_ROLES)[number]
export const MODEL_CONFIG_MODES = ['managed', 'byok'] as const
export type ModelConfigMode = (typeof MODEL_CONFIG_MODES)[number]
export const CREDENTIAL_HEALTH = ['unknown', 'healthy', 'degraded', 'dead'] as const
export type CredentialHealth = (typeof CREDENTIAL_HEALTH)[number]
export const LLM_EFFORTS = ['low', 'medium', 'high'] as const
export type LlmEffort = (typeof LLM_EFFORTS)[number]
export const LLM_MAX_CREDENTIALS = 5

export interface SuggestedModel { id: string; role: ModelConfigRole | 'both'; tier: QualityTier }

export interface ProviderPreset {
  id: LlmProviderId
  label: string
  /** The name the consent sentence uses ("Email content will be sent to OpenAI under its terms"). */
  consentName: string
  /** Null for `custom` (the owner supplies it); for a preset the owner never sees or edits it. */
  baseUrl: string | null
  /** What a key from this provider looks like, for the placeholder only — never validated. */
  keyHint: string
  suggestedModels: SuggestedModel[]
}

/** Spec §Default models (seed; ids re-verified against each provider's `/models` by the probe). */
export const PROVIDER_PRESETS: Record<LlmProviderId, ProviderPreset> = {
  anthropic: { id: 'anthropic', label: 'Anthropic', consentName: 'Anthropic', baseUrl: 'https://api.anthropic.com', keyHint: 'sk-ant-…',
    suggestedModels: [{ id: 'claude-opus-5', role: 'draft', tier: 'calibrated' }, { id: 'claude-sonnet-5', role: 'draft', tier: 'calibrated' }, { id: 'claude-haiku-4-5', role: 'triage', tier: 'standard' }] },
  openai: { id: 'openai', label: 'OpenAI', consentName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyHint: 'sk-…',
    suggestedModels: [{ id: 'gpt-5', role: 'draft', tier: 'standard' }, { id: 'gpt-5-mini', role: 'triage', tier: 'standard' }] },
  deepseek: { id: 'deepseek', label: 'DeepSeek', consentName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyHint: 'sk-…',
    suggestedModels: [{ id: 'deepseek-chat', role: 'both', tier: 'standard' }, { id: 'deepseek-reasoner', role: 'draft', tier: 'standard' }] },
  groq: { id: 'groq', label: 'Groq', consentName: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…',
    suggestedModels: [{ id: 'llama-3.3-70b-versatile', role: 'draft', tier: 'standard' }, { id: 'llama-3.1-8b-instant', role: 'triage', tier: 'limited' }] },
  together: { id: 'together', label: 'Together', consentName: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyHint: '…',
    suggestedModels: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', role: 'draft', tier: 'standard' }, { id: 'meta-llama/Llama-3.1-8B-Instruct-Turbo', role: 'triage', tier: 'limited' }] },
  openrouter: { id: 'openrouter', label: 'OpenRouter', consentName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…',
    suggestedModels: [{ id: 'anthropic/claude-opus-5', role: 'draft', tier: 'standard' }, { id: 'anthropic/claude-haiku-4.5', role: 'triage', tier: 'standard' }] },
  custom: { id: 'custom', label: 'Custom (OpenAI-compatible)', consentName: 'the endpoint you configured', baseUrl: null, keyHint: '…', suggestedModels: [] },
}

/** The catalog lookup behind every tier decision: a listed model's tier, else `limited` (spec
 * §Risks: an unknown or local/small model is capped until proven). The probe may downgrade this,
 * never upgrade it (`@aesa/db`'s `resolveModelConfig`). */
export function qualityTierFor(provider: LlmProviderId, model: string): QualityTier {
  const hit = PROVIDER_PRESETS[provider].suggestedModels.find((m) => m.id === model)
  return hit?.tier ?? 'limited'
}

/** The preset's first suggestion for a role (a `both` model serves either), or null (custom). */
export function presetModel(provider: LlmProviderId, role: ModelConfigRole): string | null {
  const models = PROVIDER_PRESETS[provider].suggestedModels
  return (models.find((m) => m.role === role) ?? models.find((m) => m.role === 'both'))?.id ?? null
}

export const AddCredentialInput = z.object({
  provider: z.enum(LLM_PROVIDERS),
  label: z.string().trim().min(1).max(60),
  apiKey: z.string().min(8).max(512),
  /** Required for `custom`, ignored for a preset (the api substitutes the preset's own). */
  baseUrl: HttpsUrl.optional(),
  /** The model the probe exercises. Required for `custom` (no catalog suggestion exists); a preset defaults to `presetModel(provider, 'draft')`. */
  probeModel: z.string().trim().min(1).max(120).optional(),
}).refine((v) => v.provider !== 'custom' || v.baseUrl !== undefined, { message: 'a custom endpoint needs its base URL', path: ['baseUrl'] })
  .refine((v) => v.provider !== 'custom' || v.probeModel !== undefined, { message: 'a custom endpoint needs the model to probe', path: ['probeModel'] })
export type AddCredentialInput = z.infer<typeof AddCredentialInput>

export const CredentialIdInput = z.object({ credentialId: z.uuid() })
export type CredentialIdInput = z.infer<typeof CredentialIdInput>

export const SetAgentModelInput = z.object({
  agentId: z.uuid(),
  mode: z.enum(MODEL_CONFIG_MODES),
  credentialId: z.uuid().nullable(),
  draftModel: z.string().trim().min(1).max(120).nullable(),
  triageModel: z.string().trim().min(1).max(120).nullable(),
  effort: z.enum(LLM_EFFORTS).nullable(),
  fallbackToManaged: z.boolean(),
}).refine((v) => v.mode === 'managed' || v.credentialId !== null, { message: 'a BYOK agent needs a provider connection', path: ['credentialId'] })
export type SetAgentModelInput = z.infer<typeof SetAgentModelInput>

/** What `llm.probe` stores on `llm_credentials.last_probe` and the screen renders. */
export const ProbeResult = z.object({
  ok: z.boolean(),
  probedAt: z.string(),
  /** Null when the adapter cannot list models (or the endpoint refused the call). */
  models: z.array(z.string()).nullable(),
  chat: z.enum(['ok', 'failed']),
  /** Which structured-output rung actually worked; null when the chat step already failed. */
  structured: z.enum(['native', 'json_mode', 'none']).nullable(),
  latencyMs: z.number().int().nonnegative(),
  error: z.object({ code: z.string(), message: z.string().max(200) }).nullable(),
})
export type ProbeResultView = z.infer<typeof ProbeResult>
```

Then: `drafts.ts` → `export const DRAFT_MODEL_ID = MANAGED_MODELS.draft` (import from `./llm.ts`; keep the JSDoc); `triage.ts` → append `'provider_unavailable'` to `NEEDS_OWNER_REASONS`; `notify.ts` → append `'provider_health'`; `autonomy.ts` → append `'model_changed'`; `index.ts` → `export * from './llm.ts'`. `packages/db/src/escalations.ts` `escalationCopy`: `provider_unavailable: { title: 'AI provider unavailable', body: 'The provider this agent uses rejected its key. Check Settings → AI; replies wait for you until then.' }`. The app's two reason maps (Autopilot's `DEMOTION_SENTENCE`: `model_changed: 'the agent\'s model was changed'`; the inbox/ticket needs-owner label map: `provider_unavailable: 'AI provider unavailable'`) — the contracts test for those maps (`apps/app/src/screens/**/*.test.tsx` pins "every reason has a label" somewhere; run `pnpm --filter @aesa/app test` to find which fails and add the entries).

- [ ] **Step 4: Write the failing core test, then `quality.ts`**

`packages/core/test/quality.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cappedModelConfidence, evidenceScore, graduationRulesFor, GRADUATION_RULES, QUALITY_CAPS } from '../src/index.ts'

describe('quality tiers', () => {
  it('caps are 1.0 / 0.9 / 0.6 and cap only the model term', () => {
    expect(QUALITY_CAPS).toEqual({ calibrated: 1, standard: 0.9, limited: 0.6 })
    expect(cappedModelConfidence(0.95, 'calibrated')).toBe(0.95)
    expect(cappedModelConfidence(0.95, 'standard')).toBe(0.9)
    expect(cappedModelConfidence(0.95, 'limited')).toBe(0.6)
    expect(cappedModelConfidence(0.4, 'limited')).toBe(0.4)
    expect(cappedModelConfidence(Number.NaN, 'limited')).toBe(0)
    // Worked example: grounding 0.9, memory 0, model 0.95 on a limited model → 0.9 × 0.6 = 0.54 < Eager's 0.70.
    expect(evidenceScore({ memory: 0, grounding: 0.9, model: cappedModelConfidence(0.95, 'limited') })).toBeCloseTo(0.54, 5)
  })

  it('graduation bars: calibrated keeps the spec numbers, standard doubles minDecisions, limited never graduates', () => {
    expect(graduationRulesFor('calibrated')).toEqual({ ...GRADUATION_RULES, canGraduate: true })
    expect(graduationRulesFor('standard')).toEqual({ ...GRADUATION_RULES, minDecisions: 40, canGraduate: true })
    expect(graduationRulesFor('limited')).toEqual({ ...GRADUATION_RULES, canGraduate: false })
  })
})
```

`packages/core/src/quality.ts`:

```ts
import type { QualityTier } from '@aesa/contracts'
import { GRADUATION_RULES } from './evidence.ts'

/** Spec §Risks ("local/small models capped at 0.6"), the other two fixed by plan deviation 6. The
 * cap clamps ONE input of `evidenceScore` — the model's self-assessment — so a weaker model's
 * confidence can never outrun its grounding. */
export const QUALITY_CAPS: Record<QualityTier, number> = { calibrated: 1, standard: 0.9, limited: 0.6 }

export function cappedModelConfidence(model: number, tier: QualityTier): number {
  if (!Number.isFinite(model)) return 0
  return Math.min(Math.max(model, 0), QUALITY_CAPS[tier])
}

export type GraduationRules = typeof GRADUATION_RULES & { minDecisions: number; canGraduate: boolean }

/** "Graduation streak requirements scale with a model-quality tier" (spec §Risks): the same rules,
 * a higher bar for `standard`, and no self-graduation at all for `limited` (the owner can still flip
 * Auto by hand; the 0.6 cap keeps every preset threshold unreachable there). */
export function graduationRulesFor(tier: QualityTier): GraduationRules {
  if (tier === 'standard') return { ...GRADUATION_RULES, minDecisions: 40, canGraduate: true }
  if (tier === 'limited') return { ...GRADUATION_RULES, canGraduate: false }
  return { ...GRADUATION_RULES, canGraduate: true }
}
```

`packages/core/package.json` already depends on `@aesa/contracts` (evidence.ts imports `DemotionReason` from it). Add `export * from './quality.ts'` to `packages/core/src/index.ts`.

- [ ] **Step 5: Run both suites and the app's tests**

Run: `pnpm --filter @aesa/contracts test && pnpm --filter @aesa/core test && pnpm --filter @aesa/app test`
Expected: PASS (after the two label maps gain their entries).

- [ ] **Step 6: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(contracts,core): the LLM vocabulary and provider catalog, quality tiers and their caps, provider_unavailable / provider_health / model_changed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: DB — `llm_credentials`, `llm_credential_secrets`, `agent_model_config`, `model_pricing`; `llm_calls`' three columns; `resolveModelConfig`; `loadModelPricing`; the meters

**Files:**
- Create: `packages/db/src/schema/llm.ts`, `packages/db/src/model-config.ts`, `packages/db/src/pricing.ts`, `packages/db/migrations/0019_<generated>.sql` (from `pnpm --filter @aesa/db generate`), `packages/db/migrations/0020_provider_hardening.sql`, `packages/db/test/model-config.test.ts`, `packages/db/test/llm-tables.test.ts`
- Modify: `packages/db/src/schema/index.ts` (+`export * from './llm.ts'`), `packages/db/src/schema/runs.ts` (`llm_calls` + 3 columns), `packages/db/src/metering.ts` (`LLM_METERS.costMicrosByok`; the sink writes `mode`/`credentialId`/`costUnknown` and routes cost by mode), `packages/db/src/index.ts` (exports), `packages/db/test/migrations.test.ts` (`EXPECTED_TABLES` + the four names), `packages/db/test/rls.test.ts` (`RLS_EXEMPT` + `'model_pricing'`), `packages/db/test/metering.test.ts` (the BYOK routing case), `packages/db/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `@aesa/contracts` `MANAGED_MODELS`, `qualityTierFor`, `ProbeResult`, `LlmProviderId`, `ModelConfigRole`, `QualityTier`, `LlmEffort`; `@aesa/llm`'s `MeterRecord` (type-only, gains `mode` + `credentialId` in Task 4 — this task adds the fields to the record type FIRST, in `packages/llm/src/metering/types.ts`, as its one edit outside `packages/db`, so both packages typecheck at every commit).
- Produces: tables `llmCredentials`, `llmCredentialSecrets`, `agentModelConfig`, `modelPricing`; `resolveModelConfig(tx: OrgTx, agentId: string | null, role: ModelConfigRole): Promise<ResolvedModelConfig>`; `ResolvedModelConfig = { mode: 'managed' | 'byok'; credentialId: string | null; provider: LlmProviderId; model: string; effort: LlmEffort | null; fallbackToManaged: boolean; tier: QualityTier; modelGeneration: number; modelGenerationAt: Date | null; credential: { label: string; baseUrl: string | null; healthStatus: CredentialHealth; lastProbe: ProbeResultView | null } | null }`; `MANAGED_CONFIG(role)`; `loadModelPricing(db: Db): Promise<ModelPricing[]>` (rows → `{ id, pattern: new RegExp(source), … }`, newest `effective_from <= now()` per `id`); `LLM_METERS.costMicrosByok = 'llm_cost_micros_byok'`.

- [ ] **Step 1: Write the failing table + resolver tests**

`packages/db/test/model-config.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MANAGED_MODELS } from '@aesa/contracts'
import { agentModelConfig, agents, llmCredentials, mailboxConnections, resolveModelConfig, withOrg } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from '../src/testing.ts'

describe('resolveModelConfig', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  let orgId: string
  let agentId: string
  let credentialId: string
  beforeAll(async () => {
    t = await createTestDatabase(); handle = createDb(t.url, { role: 'app' }); orgId = await createTestOrganization(handle)
    await withOrg(handle.db, orgId, async (tx) => {
      const [conn] = await tx.insert(mailboxConnections).values({ orgId, provider: 'gmail', providerAccountId: 'acct', emailAddress: 'support@acme.test', status: 'connected' }).returning({ id: mailboxConnections.id })
      const [agent] = await tx.insert(agents).values({ orgId, connectionId: conn!.id, address: 'support@acme.test', domain: 'acme.test', displayName: 'Support', status: 'active' }).returning({ id: agents.id })
      agentId = agent!.id
      const [cred] = await tx.insert(llmCredentials).values({ orgId, provider: 'openai', label: 'Prod', keyFingerprint: 'abcdef12…9xyz', createdBy: 'user:x' }).returning({ id: llmCredentials.id })
      credentialId = cred!.id
    })
  })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  it('no row → the managed default for the role, tier calibrated, generation 1', async () => {
    const draft = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(draft).toMatchObject({ mode: 'managed', credentialId: null, provider: 'anthropic', model: MANAGED_MODELS.draft, tier: 'calibrated', modelGeneration: 1, fallbackToManaged: false, credential: null })
    const triage = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'triage'))
    expect(triage.model).toBe(MANAGED_MODELS.triage)
    expect(await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, null, 'draft'))).toMatchObject({ mode: 'managed' })
  })

  it('a byok row resolves its credential, the catalog tier, and the probe can only lower it', async () => {
    await withOrg(handle.db, orgId, (tx) => tx.insert(agentModelConfig).values({ orgId, agentId, role: 'draft', mode: 'byok', credentialId, model: 'gpt-5', effort: 'high', fallbackToManaged: true, modelGeneration: 3 }))
    let r = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(r).toMatchObject({ mode: 'byok', credentialId, provider: 'openai', model: 'gpt-5', effort: 'high', fallbackToManaged: true, tier: 'standard', modelGeneration: 3 })
    expect(r.credential).toMatchObject({ label: 'Prod', healthStatus: 'unknown', lastProbe: null })

    await withOrg(handle.db, orgId, (tx) => tx.update(llmCredentials).set({ lastProbe: { ok: true, probedAt: new Date().toISOString(), models: null, chat: 'ok', structured: 'none', latencyMs: 5, error: null } }).where(eq(llmCredentials.id, credentialId)))
    r = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(r.tier).toBe('limited')   // probe found no structured output → downgraded
  })

  it('a byok row whose credential was deleted falls back to managed (ON DELETE SET NULL, then mode managed)', async () => {
    await withOrg(handle.db, orgId, (tx) => tx.delete(llmCredentials).where(eq(llmCredentials.id, credentialId)))
    const r = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(r).toMatchObject({ mode: 'managed', credentialId: null, provider: 'anthropic', model: MANAGED_MODELS.draft })
  })
})
```

`packages/db/test/llm-tables.test.ts` — three facts a migration can silently lose:

```ts
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from './helpers/test-db.ts'

describe('Phase 6 tables', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>; let c: pg.Client
  beforeAll(async () => { t = await createTestDatabase(); c = new pg.Client({ connectionString: t.url }); await c.connect() })
  afterAll(async () => { await c.end(); await t.drop() })

  it('aesa_app has NO privilege on llm_credential_secrets (the key never reaches the api)', async () => {
    const res = await c.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'llm_credential_secrets' AND grantee = 'aesa_app'`)
    expect(res.rows).toEqual([])
  })
  it('agent_model_config is unique per (org, agent, role) with NULL agent rows NOT distinct', async () => {
    const res = await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'agent_model_config_org_agent_role_uidx'`)
    expect(res.rows[0]?.indexdef).toMatch(/UNIQUE/); expect(res.rows[0]?.indexdef).toMatch(/NULLS NOT DISTINCT/)
  })
  it('model_pricing is seeded with the managed rows and at least the OpenAI/DeepSeek families', async () => {
    const res = await c.query<{ id: string }>(`SELECT id FROM model_pricing ORDER BY id`)
    const ids = res.rows.map((r) => r.id)
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5', 'gpt-5-mini', 'deepseek-chat']) expect(ids).toContain(id)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @aesa/db test test/model-config.test.ts test/llm-tables.test.ts`
Expected: FAIL — no such tables / exports.

- [ ] **Step 3: The schema**

`packages/db/src/schema/llm.ts`:

```ts
import { sql } from 'drizzle-orm'
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './support.ts'
import { bytea, createdAt, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'

/** A BYOK provider connection's api-visible half: label, provider, endpoint, fingerprint, health. The key itself is in `llm_credential_secrets`. */
export const llmCredentials = pgTable('llm_credentials', {
  id: id(), orgId: orgId(),
  provider: text('provider').notNull(),                       // LLM_PROVIDERS (CHECK, 0020)
  label: text('label').notNull(),
  /** Null for a preset provider (the adapter uses the preset's base URL); the validated https URL for `custom`. */
  baseUrl: text('base_url'),
  /** sha256 hex prefix 8 + '…' + the key's last 4 chars — display only, never enough to reconstruct. */
  keyFingerprint: text('key_fingerprint').notNull(),
  /** The model `llm.probe` exercises: the owner's choice for `custom`, the preset's draft suggestion otherwise. */
  probeModel: text('probe_model'),
  transport: text('transport').notNull().default('direct'),   // 'direct' only in v1 (CHECK) — the spec's bridge seam
  healthStatus: text('health_status').notNull().default('unknown'),   // CREDENTIAL_HEALTH (CHECK)
  lastProbe: jsonb('last_probe'),                              // ProbeResultView
  lastProbedAt: timestamp('last_probed_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastError: text('last_error'),                               // scrubbed, ≤ 200 chars
  createdBy: text('created_by').notNull(),                     // user:<id>
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('llm_credentials_provider_check', sql`${t.provider} IN ('anthropic','openai','deepseek','groq','together','openrouter','custom')`),
  check('llm_credentials_health_check', sql`${t.healthStatus} IN ('unknown','healthy','degraded','dead')`),
  check('llm_credentials_transport_check', sql`${t.transport} IN ('direct')`),
  index('llm_credentials_org_idx').on(t.orgId, t.createdAt),
  ...tenantPolicies(t.orgId, 'llm_credentials'),
])

/** Platform-role-only (0020 REVOKEs aesa_app): the api writes a SEALED blob into the `llm.probe` payload, the worker stores it here and re-wraps it under the org DEK. */
export const llmCredentialSecrets = pgTable('llm_credential_secrets', {
  credentialId: uuid('credential_id').primaryKey().references(() => llmCredentials.id, { onDelete: 'cascade' }),
  orgId: orgId(),
  keyCiphertext: bytea('key_ciphertext').notNull(),
  encryption: text('encryption').notNull(),                    // 'sealed' | 'dek' (CHECK)
  dataKeyVersion: integer('data_key_version'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('llm_credential_secrets_encryption_check', sql`${t.encryption} IN ('sealed','dek')`),
  index('llm_credential_secrets_org_idx').on(t.orgId),
  ...tenantPolicies(t.orgId, 'llm_credential_secrets'),
])

/** Per agent × role model choice. `agent_id IS NULL` = the workspace default (admitted, unwritten in v1). */
export const agentModelConfig = pgTable('agent_model_config', {
  id: id(), orgId: orgId(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),                                // 'draft' | 'triage' (CHECK)
  mode: text('mode').notNull().default('managed'),             // 'managed' | 'byok' (CHECK)
  credentialId: uuid('credential_id').references(() => llmCredentials.id, { onDelete: 'set null' }),
  model: text('model'),                                        // null → the managed default for the role
  effort: text('effort'),                                      // 'low' | 'medium' | 'high' | null (CHECK)
  fallbackToManaged: boolean('fallback_to_managed').notNull().default(false),
  modelGeneration: integer('model_generation').notNull().default(1),
  modelGenerationAt: timestamp('model_generation_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('agent_model_config_role_check', sql`${t.role} IN ('draft','triage')`),
  check('agent_model_config_mode_check', sql`${t.mode} IN ('managed','byok')`),
  check('agent_model_config_effort_check', sql`${t.effort} IS NULL OR ${t.effort} IN ('low','medium','high')`),
  uniqueIndex('agent_model_config_org_agent_role_uidx').on(t.orgId, t.agentId, t.role).nullsNotDistinct(),
  ...tenantPolicies(t.orgId, 'agent_model_config'),
])

/** Platform data (RLS_EXEMPT, like platform_state): USD per MTok, versioned by effective_from. Seeded by 0020. */
export const modelPricing = pgTable('model_pricing', {
  id: text('id').notNull(),                                    // the pricing family, e.g. 'gpt-5'
  provider: text('provider').notNull(),
  pattern: text('pattern').notNull(),                          // RegExp source, prefix-anchored
  inputPerMtok: doublePrecision('input_per_mtok').notNull(),
  outputPerMtok: doublePrecision('output_per_mtok').notNull(),
  cacheReadPerMtok: doublePrecision('cache_read_per_mtok').notNull(),
  cacheWrite5mPerMtok: doublePrecision('cache_write_5m_per_mtok').notNull(),
  cacheWrite1hPerMtok: doublePrecision('cache_write_1h_per_mtok').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('model_pricing_id_effective_uidx').on(t.id, t.effectiveFrom)])
```

If drizzle 0.44's `uniqueIndex().nullsNotDistinct()` is unavailable, declare the index in `0020_provider_hardening.sql` by hand (`CREATE UNIQUE INDEX … NULLS NOT DISTINCT`) and omit it from the schema — the `llm-tables.test.ts` case reads `pg_indexes` either way.

`packages/db/src/schema/runs.ts` `llmCalls` gains: `credentialId: uuid('credential_id')` (loose, no FK — metering must never fail on a deleted credential), `mode: text('mode').notNull().default('managed')`, `costUnknown: boolean('cost_unknown').notNull().default(false)`, plus `index('llm_calls_org_credential_idx').on(t.orgId, t.credentialId, t.createdAt)`.

- [ ] **Step 4: Generate, then hand-write the hardening migration**

```bash
pnpm --filter @aesa/db generate        # → 0019_<name>.sql (four CREATE TABLEs, the ALTERs, the policies)
```

`packages/db/migrations/0020_provider_hardening.sql`:

```sql
ALTER TABLE "llm_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_credential_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_model_config" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The key never reaches the api: same rule as mailbox_credentials (0006). Platform role only.
REVOKE ALL ON "llm_credential_secrets" FROM "aesa_app";
--> statement-breakpoint
-- Platform data: every role reads it, only migrations write it.
GRANT SELECT ON "model_pricing" TO "aesa_app";
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_mode_check" CHECK ("mode" IN ('managed','byok'));
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" IN ('escalation','mailbox_reauth','digest','draft_review','auto_send','graduation','demotion','memory_sample','provider_health'));
--> statement-breakpoint
-- Seed (USD per MTok, 2026-09-12). Anthropic rows mirror packages/llm/src/pricing/seed.ts; the BYOK
-- families are the published list prices at seed time — a BYOK row prices the OWNER's spend for the
-- dashboard only, never a platform bill. Cache-write rates for providers with automatic caching are 0.
INSERT INTO "model_pricing" ("id","provider","pattern","input_per_mtok","output_per_mtok","cache_read_per_mtok","cache_write_5m_per_mtok","cache_write_1h_per_mtok","effective_from") VALUES
  ('claude-opus-5','anthropic','^claude-opus-5(-|$)',5,25,0.5,6.25,10,'2026-09-09T00:00:00Z'),
  ('claude-sonnet-5','anthropic','^claude-sonnet-5(-|$)',2,10,0.2,2.5,4,'2026-09-09T00:00:00Z'),
  ('claude-haiku-4-5','anthropic','^claude-haiku-4-5(-|$)',1,5,0.1,1.25,2,'2026-09-09T00:00:00Z'),
  ('gpt-5','openai','^gpt-5(-|$)',1.25,10,0.125,0,0,'2026-09-12T00:00:00Z'),
  ('gpt-5-mini','openai','^gpt-5-mini(-|$)',0.25,2,0.025,0,0,'2026-09-12T00:00:00Z'),
  ('deepseek-chat','deepseek','^deepseek-chat(-|$)',0.27,1.1,0.07,0,0,'2026-09-12T00:00:00Z'),
  ('deepseek-reasoner','deepseek','^deepseek-reasoner(-|$)',0.55,2.19,0.14,0,0,'2026-09-12T00:00:00Z'),
  ('llama-3.3-70b-versatile','groq','^llama-3\.3-70b-versatile(-|$)',0.59,0.79,0,0,0,'2026-09-12T00:00:00Z'),
  ('llama-3.1-8b-instant','groq','^llama-3\.1-8b-instant(-|$)',0.05,0.08,0,0,0,'2026-09-12T00:00:00Z');
```

`gpt-5-mini`'s pattern must be tested BEFORE `gpt-5`'s would match it: `findPricing` returns the FIRST matching row, so `loadModelPricing` orders rows by `length(pattern) DESC` (the more specific pattern first). Pin that in `packages/db/test/pricing.test.ts`: `findPricing('gpt-5-mini', await loadModelPricing(db))!.id === 'gpt-5-mini'`. Verify each BYOK number against the provider's public price page at implementation time and correct the INSERT — the numbers above are the plan author's seed, not a source of truth; the test asserts ids, not prices.

Append idx 19 and 20 to `_journal.json`. Commit the migrations BEFORE `pnpm db:check`.

- [ ] **Step 5: `resolveModelConfig`, `loadModelPricing`, the meters**

`packages/db/src/model-config.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm'
import {
  MANAGED_MODELS, ProbeResult, qualityTierFor, type CredentialHealth, type LlmEffort, type LlmProviderId, type ModelConfigRole,
  type ProbeResultView, type QualityTier,
} from '@aesa/contracts'
import { agentModelConfig, llmCredentials } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

export interface ResolvedModelConfig {
  mode: 'managed' | 'byok'
  credentialId: string | null
  provider: LlmProviderId
  model: string
  effort: LlmEffort | null
  fallbackToManaged: boolean
  tier: QualityTier
  modelGeneration: number
  modelGenerationAt: Date | null
  credential: { label: string; baseUrl: string | null; healthStatus: CredentialHealth; lastProbe: ProbeResultView | null } | null
}

export function managedConfig(role: ModelConfigRole): ResolvedModelConfig {
  return {
    mode: 'managed', credentialId: null, provider: 'anthropic', model: MANAGED_MODELS[role], effort: null, fallbackToManaged: false,
    tier: 'calibrated', modelGeneration: 1, modelGenerationAt: null, credential: null,
  }
}

/**
 * The ONE reader of an agent's model choice — the api (run rows, the Model card) and the worker (every
 * model call) resolve through here, so they can never disagree. A byok row whose credential is gone
 * (ON DELETE SET NULL) resolves as managed; the catalog tier is downgraded to `limited` when the last
 * probe found no structured output at all (the probe may lower a tier, never raise one).
 */
export async function resolveModelConfig(tx: OrgTx, agentId: string | null, role: ModelConfigRole): Promise<ResolvedModelConfig> {
  const scope = agentId === null ? isNull(agentModelConfig.agentId) : eq(agentModelConfig.agentId, agentId)
  const [row] = await tx.select().from(agentModelConfig).where(and(eq(agentModelConfig.orgId, tx.orgId), scope, eq(agentModelConfig.role, role)))
  if (!row) return managedConfig(role)
  const base = { ...managedConfig(role), modelGeneration: row.modelGeneration, modelGenerationAt: row.modelGenerationAt, effort: row.effort as LlmEffort | null, fallbackToManaged: row.fallbackToManaged }
  if (row.mode !== 'byok' || !row.credentialId) return base
  const [cred] = await tx.select().from(llmCredentials).where(and(eq(llmCredentials.orgId, tx.orgId), eq(llmCredentials.id, row.credentialId)))
  if (!cred) return base
  const provider = cred.provider as LlmProviderId
  const model = row.model ?? MANAGED_MODELS[role]
  const probe = cred.lastProbe ? ProbeResult.safeParse(cred.lastProbe) : null
  const lastProbe = probe?.success ? probe.data : null
  const catalogTier = qualityTierFor(provider, model)
  const tier: QualityTier = lastProbe?.structured === 'none' ? 'limited' : catalogTier
  return {
    mode: 'byok', credentialId: cred.id, provider, model, effort: base.effort, fallbackToManaged: row.fallbackToManaged, tier,
    modelGeneration: row.modelGeneration, modelGenerationAt: row.modelGenerationAt,
    credential: { label: cred.label, baseUrl: cred.baseUrl, healthStatus: cred.healthStatus as CredentialHealth, lastProbe },
  }
}
```

`packages/db/src/pricing.ts`:

```ts
import { desc, lte, sql } from 'drizzle-orm'
import type { ModelPricing } from '@aesa/llm'
import type { Db } from './client.ts'
import { modelPricing } from './schema/index.ts'

/** The platform's price table as `@aesa/llm`'s `ModelPricing[]`: the newest row per id whose
 * `effective_from` has passed, most specific pattern first (`findPricing` takes the FIRST match, and
 * `^gpt-5(-|$)` would otherwise swallow `gpt-5-mini`). Empty table → `[]`, and the caller falls back
 * to `PRICING_SEED`. Type-only import from `@aesa/llm`, like `metering.ts`. */
export async function loadModelPricing(db: Db): Promise<ModelPricing[]> {
  const rows = await db.select().from(modelPricing).where(lte(modelPricing.effectiveFrom, sql`now()`))
    .orderBy(desc(sql`length(${modelPricing.pattern})`), desc(modelPricing.effectiveFrom))
  const seen = new Set<string>()
  const out: ModelPricing[] = []
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, pattern: new RegExp(r.pattern), inputPerMtok: r.inputPerMtok, outputPerMtok: r.outputPerMtok, cacheReadPerMtok: r.cacheReadPerMtok, cacheWrite5mPerMtok: r.cacheWrite5mPerMtok, cacheWrite1hPerMtok: r.cacheWrite1hPerMtok })
  }
  return out
}
```

`model_pricing` is read with the raw `db` handle, not `withOrg` (platform data; `aesa_app` has SELECT) — `loadModelPricing` is called once by the worker's composition root, which holds the raw handle.

`packages/db/src/metering.ts`: `LLM_METERS` gains `costMicrosByok: 'llm_cost_micros_byok'`; the sink's insert adds `credentialId: rec.credentialId, mode: rec.mode, costUnknown: rec.costUnknown`, and the cost bump becomes `bumpMeter(tx, rec.orgId, day, rec.mode === 'byok' ? LLM_METERS.costMicrosByok : LLM_METERS.costMicros, rec.costMicros)`. In `packages/llm/src/metering/types.ts` add `mode: 'managed' | 'byok'` and `credentialId: string | null` to `MeterRecord`; in `with-metering.ts` fill them from `req.meta.mode ?? 'managed'` / `req.meta.credentialId ?? null` (Task 4 adds those two optional fields to `ChatMeta` — add them to `ChatMeta` NOW too, both optional, so this commit typechecks). Add to `packages/db/test/metering.test.ts`: a record with `mode: 'byok'` bumps `llm_cost_micros_byok` and leaves `llm_cost_micros` absent, and the row carries `credential_id` + `cost_unknown`.

Exports from `packages/db/src/index.ts`: `resolveModelConfig`, `managedConfig`, `type ResolvedModelConfig`, `loadModelPricing`.

- [ ] **Step 6: Run the db suite**

Run: `pnpm --filter @aesa/db test`
Expected: PASS — `migrations.test.ts` with the four new names in `EXPECTED_TABLES` (`agent_model_config`, `llm_credential_secrets`, `llm_credentials`, `model_pricing`, sorted into place), `rls.test.ts` with `'model_pricing'` in `RLS_EXEMPT`.

- [ ] **Step 7: Gate and commit**

```bash
git add packages/db/migrations && git commit -m "feat(db): migrations 0019–0020 — llm_credentials, llm_credential_secrets (platform-only), agent_model_config, model_pricing; llm_calls mode/credential/cost_unknown

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(db): resolveModelConfig (the one reader of an agent's model choice), loadModelPricing, the byok cost meter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `@aesa/crypto` `createPinnedFetch`; `@aesa/llm` — the port additions, the `'none'` rung, the OpenAI-compatible adapter, `probeProvider`, `createByokProvider`, the two-adapter contract suite

**Files:**
- Create: `packages/crypto/test/pinned-fetch-fn.test.ts`, `packages/llm/src/core/shared.ts`, `packages/llm/src/core/probe.ts`, `packages/llm/src/adapters/openai-compatible/index.ts`, `packages/llm/src/adapters/openai-compatible/models.ts`, `packages/llm/src/adapters/openai-compatible/map-errors.ts`, `packages/llm/test/openai-compatible.test.ts`, `packages/llm/test/structured-none.test.ts`, `packages/llm/test/probe.test.ts`, `packages/llm/test/contract.test.ts`, `packages/llm/src/testing/contract-suite.ts`
- Modify: `packages/crypto/src/ssrf/pinned-fetch.ts`, `packages/crypto/src/index.ts`, `packages/llm/package.json` (`"openai": "7.15.0"`), `packages/llm/src/core/types.ts`, `packages/llm/src/core/structured.ts`, `packages/llm/src/core/registry.ts`, `packages/llm/src/adapters/anthropic/index.ts` (import the shared helpers; add `listModels`), `packages/llm/src/pricing/seed.ts` (+ the BYOK rows, same numbers as 0020), `packages/llm/src/index.ts`, `packages/llm/test/structured.test.ts` (the old "`none` makes zero calls" case flips)

**Interfaces:**
- Consumes: `@aesa/crypto` `validateOutboundUrl`, `resolvePublic`, `buildPinnedDispatcher`, `fetchThroughPinnedDispatcher`, `Secret`; `@aesa/contracts` `LlmProviderId`, `PROVIDER_PRESETS`, `ProbeResultView`.
- Produces (`@aesa/crypto`): `PinnedTransportInit.signal?: AbortSignal` (combined with the timeout via `AbortSignal.any`); `createPinnedFetch(opts?: { resolver?: Resolver; allowNonstandardPort?: boolean; timeoutMs?: number; maxBodyBytes?: number }): typeof fetch` — a `fetch`-shaped function: validates the URL, resolves a public address, pins it, forwards `method`/`headers`/`body`/`signal`, throws `PinnedFetchError('redirect_not_followed')` on any 3xx.
- Produces (`@aesa/llm`): `LlmProvider.listModels?(signal?: AbortSignal): Promise<string[]>`; `ChatMeta.mode?: 'managed' | 'byok'`, `ChatMeta.credentialId?: string`; `ParseStrategy` + `'plain'`; `createOpenAiCompatibleProvider(opts: { kind: LlmProviderId; apiKey: Secret; baseUrl: string; fetchFn?: typeof fetch; capabilitiesOverride?: (model: string, preset: Capabilities) => Capabilities })`; `OPENAI_COMPATIBLE_MODELS: Record<Exclude<LlmProviderId,'anthropic'>, Record<string, Capabilities>>`, `PRESET_QUIRKS`; `probeProvider(provider: LlmProvider, model: string, meta: Omit<ChatMeta,'role'|'idempotencyKey'> & { idempotencyPrefix: string }, signal?: AbortSignal): Promise<ProbeResultView>`; `createByokProvider(opts: ByokProviderOptions): LlmProvider`; `BYOK_MAX_CONCURRENT_PER_CREDENTIAL = 2`; `withMeta(inner, patch: Pick<ChatMeta,'mode'|'credentialId'>)`; `runProviderContract(name, makeProvider)` (the shared scenario table both adapter tests run).

- [ ] **Step 1: `createPinnedFetch` — failing test**

`packages/crypto/test/pinned-fetch-fn.test.ts` (reuse the server helpers `packages/crypto/test/ssrf.test.ts` already has for a local TLS/HTTP origin; read that file first and lift its `startServer`/`fakeResolver` into a shared `test/helpers/ssrf-server.ts` if they are inline):

```ts
import { describe, expect, it } from 'vitest'
import { createPinnedFetch, PinnedFetchError } from '../src/index.ts'

const privateResolver = async () => [{ address: '10.0.0.5', family: 4 as const }]
const rebindingResolver = (() => { let n = 0; return async () => (n++ === 0 ? [{ address: '93.184.216.34', family: 4 as const }] : [{ address: '127.0.0.1', family: 4 as const }]) })()

describe('createPinnedFetch', () => {
  it('refuses http, an IP literal, and a hostname that resolves privately', async () => {
    const f = createPinnedFetch({ resolver: privateResolver })
    await expect(f('http://llm.example.com/v1/chat')).rejects.toThrow(/https/)
    await expect(f('https://10.0.0.5/v1/chat')).rejects.toThrow(/hostname/)
    await expect(f('https://llm.example.com/v1/chat')).rejects.toThrow(/private|blocked|public/i)
  })
  it('resolves on EVERY call, so a rebinding hostname is refused on the second request', async () => {
    const f = createPinnedFetch({ resolver: rebindingResolver, timeoutMs: 200 })
    await f('https://llm.example.com/v1/models').catch(() => undefined)   // the first resolves public and fails only on connect
    await expect(f('https://llm.example.com/v1/models')).rejects.toThrow(/private|blocked|public/i)
  })
  it('forwards method/headers/body/signal and throws on a redirect', async () => {
    // Against the local origin helper: assert the echoed request shape, then a 302 route → PinnedFetchError('redirect_not_followed').
    // (Follow ssrf.test.ts's existing local-origin pattern exactly.)
  })
  it('an aborted signal rejects promptly', async () => {
    const f = createPinnedFetch({ resolver: async () => [{ address: '93.184.216.34', family: 4 as const }] })
    const ac = new AbortController(); ac.abort()
    await expect(f('https://llm.example.com/v1/models', { signal: ac.signal })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Implement it**

In `pinned-fetch.ts`: add `signal?: AbortSignal` to `PinnedTransportInit`; in `fetchThroughPinnedDispatcher` build `signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)`. Then:

```ts
export interface CreatePinnedFetchOptions { resolver?: Resolver; allowNonstandardPort?: boolean; timeoutMs?: number; maxBodyBytes?: number }

/**
 * A `fetch`-shaped function for an SDK's `fetch` option (the OpenAI and Anthropic clients both take
 * one): every request is validated (https, hostname, no credentials), resolved to a public address
 * and pinned to it — DNS rebinding between the api's write-time check and this call cannot swap the
 * target — and never follows a redirect. Headers arrive as a `Headers`, an array or a record and
 * are normalized; the SDKs send string bodies. A URL object is accepted for the same reason.
 */
export function createPinnedFetch(opts: CreatePinnedFetchOptions = {}): typeof fetch {
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = validateOutboundUrl(href, { allowNonstandardPort: opts.allowNonstandardPort })
    const { address, family } = await resolvePublic(url.hostname, { resolver: opts.resolver })
    const headers: Record<string, string> = {}
    new Headers(init.headers ?? undefined).forEach((v, k) => { headers[k] = v })
    return fetchThroughPinnedDispatcher(url, buildPinnedDispatcher(address, family), {
      method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : undefined,
      signal: init.signal ?? undefined, timeoutMs: opts.timeoutMs, maxBodyBytes: opts.maxBodyBytes, redirect: 'error',
    })
  }
  return fn as typeof fetch
}
```

Export `createPinnedFetch`, `type CreatePinnedFetchOptions` from `packages/crypto/src/index.ts`. Run `pnpm --filter @aesa/crypto test` → PASS (the existing `ssrf.test.ts` unchanged).

- [ ] **Step 3: The port additions and the shared helpers**

`packages/llm/src/core/types.ts`: `ChatMeta` gains `mode?: 'managed' | 'byok'` and `credentialId?: string` (Task 3 may already have added them — keep ONE definition); `ParseStrategy` becomes `'native' | 'json_mode' | 'plain' | 'repair' | 'extract' | 'none'`; `LlmProvider` gains `listModels?(signal?: AbortSignal): Promise<string[]>`. Every wrapper (`withMetering`, `withLimiter`, `withStructuredLadder`, the fake) forwards `listModels` when the inner has one: `...(inner.listModels ? { listModels: (s?: AbortSignal) => inner.listModels!(s) } : {})`.

`packages/llm/src/core/shared.ts` — lifted verbatim from the Anthropic adapter (delete the copies there and import): `scrubSecrets`, `parseRetryAfterMs`, `CONTEXT_LENGTH_PATTERN`, `envelopeSchema`, `toJsonObjectSchema`. Extend `scrubSecrets`' key pattern to cover the other providers' prefixes: `/(sk-|gsk_|sk-or-|sk-ant-)[A-Za-z0-9_-]{6,}/g` (the shared pattern replaces the adapter's `sk-` one; the existing Anthropic scrub tests still pass).

The Anthropic adapter gains `listModels`: `const page = await client.models.list({ limit: 100 }, { signal }); return page.data.map((m) => m.id)` wrapped in the same `mapError`. (Verify the method exists on 0.124.0 — `node_modules/@anthropic-ai/sdk/resources/models.d.ts`.)

- [ ] **Step 4: The `'none'` rung — failing test, then the ladder**

`packages/llm/test/structured-none.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFakeProvider, withStructuredLadder, type ChatRequest } from '../src/index.ts'

const Schema = z.object({ answer: z.enum(['yes', 'no']), n: z.number().int() })
const req = (): ChatRequest<z.infer<typeof Schema>> => ({
  model: 'plain-model', system: [{ id: 's', text: 'Be brief.', stability: 'static' }], messages: [{ role: 'user', content: 'Is water wet?' }],
  output: { name: 'probe', schema: Schema }, maxOutputTokens: 64, meta: { orgId: 'org', role: 'probe', idempotencyKey: 'k' },
})

describe('withStructuredLadder on a model with structuredOutput none', () => {
  it('makes ONE plain call carrying the JSON instruction and parses the reply: parseStrategy plain', async () => {
    const fake = createFakeProvider([{ text: '{"answer":"yes","n":7}' }], { capabilities: { structuredOutput: 'none', tools: false } })
    const res = await withStructuredLadder(fake).chat(req())
    expect(res.parsed).toEqual({ answer: 'yes', n: 7 })
    expect(res.parseStrategy).toBe('plain')
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.output).toBeUndefined()                                  // a PLAIN call — no adapter rung asked for
    expect(fake.calls[0]!.system.at(-1)!.text).toMatch(/ONE JSON object/)          // the instruction rides as the last (volatile) system block
    expect(fake.calls[0]!.meta.idempotencyKey).toBe('k:plain')
  })
  it('prose around the JSON falls through to repair, then extract', async () => {
    const fake = createFakeProvider([{ text: 'Sure! Here you go: {"answer":"no","n":3} Hope that helps.' }, { text: 'still prose {"answer":"no","n":3}' }], { capabilities: { structuredOutput: 'none', tools: false } })
    const res = await withStructuredLadder(fake).chat(req())
    expect(res.parsed).toEqual({ answer: 'no', n: 3 })
    expect(res.parseStrategy).toBe('extract')
    expect(fake.calls.map((c) => c.meta.idempotencyKey)).toEqual(['k:plain', 'k:repair'])
  })
  it('a refusal on the plain call returns immediately', async () => {
    const fake = createFakeProvider([{ text: '', finish: 'refusal' }], { capabilities: { structuredOutput: 'none', tools: false } })
    const res = await withStructuredLadder(fake).chat(req())
    expect(res.finish).toBe('refusal'); expect(res.parsed).toBeNull(); expect(fake.calls).toHaveLength(1)
  })
})
```

In `structured.ts`, replace the `if (!last) { … return … }` block with the plain rung:

```ts
      if (!last) {
        // caps.structuredOutput === 'none' (Phase 6, ruling ledger 74): neither adapter rung exists,
        // so ask in plain text — the instruction rides as one more VOLATILE system block so the
        // adapter's stability ordering holds — and parse the reply here. A direct parse is `plain`;
        // anything else falls through to the repair + extract rungs below exactly as a failed
        // json_mode reply would.
        const jsonSchema = JSON.stringify(z.toJSONSchema(output.schema))
        const plain = await inner.chat<T>({
          ...req, output: undefined,
          system: [...req.system, { id: 'json-instruction', stability: 'volatile', text: `Reply with ONE JSON object that satisfies this JSON schema exactly, and nothing else — no prose, no code fence.\n${jsonSchema}` }],
          meta: { ...req.meta, idempotencyKey: `${baseKey}:plain` },
        })
        usage = sumUsage(usage, plain.usage)
        latencyMs += plain.latencyMs
        last = plain
        if (isRefusal(plain)) return { ...plain, usage, latencyMs }
        const direct = tryParse(plain.text, output.schema)
        if (direct !== undefined) return { ...plain, usage, latencyMs, parsed: direct, parseStrategy: 'plain' }
      }
```

(`z` is already imported in `structured.ts`.) Update `structured.test.ts`'s "`none` makes zero calls" case to expect the plain call. Run `pnpm --filter @aesa/llm test` → PASS.

- [ ] **Step 5: The OpenAI-compatible adapter — failing tests**

Install first: in `packages/llm/package.json` add `"openai": "7.15.0"` to `dependencies`, run `pnpm install`, then read `node_modules/openai/resources/chat/completions/completions.d.ts` and `node_modules/openai/core/error.d.ts` (or wherever 7.15.0 puts `RateLimitError`/`AuthenticationError`/`PermissionDeniedError`/`BadRequestError`/`APIUserAbortError`/`APIConnectionError`/`InternalServerError`/`APIError`) and confirm: the request fields `messages`, `max_tokens`, `max_completion_tokens`, `response_format` (`{ type: 'json_schema', json_schema: { name, schema, strict } }` and `{ type: 'json_object' }`), `reasoning_effort`; the response fields `choices[0].message.content`, `choices[0].message.refusal`, `choices[0].finish_reason` (`stop|length|content_filter|tool_calls`), `usage.prompt_tokens`, `usage.completion_tokens`, `usage.prompt_tokens_details.cached_tokens`, `usage.completion_tokens_details.reasoning_tokens`; and `client.models.list()`. Record the verified names in the adapter's header comment, as the Anthropic adapter does.

`packages/llm/test/openai-compatible.test.ts` (same `capturingFetch`/`jsonResponse` helpers as `anthropic.test.ts` — lift them into `test/helpers/fetch-stub.ts`):

```ts
import { Secret } from '@aesa/crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createOpenAiCompatibleProvider } from '../src/adapters/openai-compatible/index.ts'
import { LlmError } from '../src/core/errors.ts'
import type { ChatRequest } from '../src/core/types.ts'
import { capturingFetch, jsonResponse } from './helpers/fetch-stub.ts'

const Schema = z.object({ category: z.enum(['toys', 'other']), is_spam: z.boolean() })
type Verdict = z.infer<typeof Schema>
const base = (over: Partial<ChatRequest<Verdict>> = {}): ChatRequest<Verdict> => ({
  model: 'gpt-5-mini',
  system: [{ id: 'a', text: 'Rules.', stability: 'static' }, { id: 'b', text: 'Persona.', stability: 'agent' }, { id: 'c', text: 'Now.', stability: 'volatile' }],
  messages: [{ role: 'user', content: 'hello' }],
  output: { name: 'triage', schema: Schema },
  maxOutputTokens: 256, meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'k' }, ...over,
})
const completion = (over: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-5-mini',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"decision":{"category":"toys","is_spam":false}}', refusal: null } }],
  usage: { prompt_tokens: 12, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
  ...over,
})
const make = (fetchFn: typeof fetch, kind: 'openai' | 'deepseek' | 'custom' = 'openai') =>
  createOpenAiCompatibleProvider({ kind, apiKey: new Secret('sk-test-key-1234567890'), baseUrl: 'https://api.example.test/v1', fetchFn })

describe('createOpenAiCompatibleProvider', () => {
  it('concatenates the system blocks IN ORDER into one system message and sends the native json_schema envelope non-strict', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion()))
    const res = await make(fetchFn).chat(base())
    const body = bodies[0]!
    expect((body.messages as { role: string; content: string }[])[0]).toEqual({ role: 'system', content: 'Rules.\n\nPersona.\n\nNow.' })
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'triage', strict: false } })
    expect(body.max_completion_tokens).toBe(256)                                  // OpenAI's parameter; DeepSeek/custom send max_tokens
    expect(res.parsed).toEqual({ category: 'toys', is_spam: false })
    expect(res.parseStrategy).toBe('native')
    expect(res.usage).toMatchObject({ inputTokens: 8, cacheReadTokens: 4, outputTokens: 6, cacheWriteTokens: 0, apiCalls: 1 })   // prompt 12 − cached 4
    expect(res.provider).toBe('openai'); expect(res.providerRequestId).toBe('chatcmpl-1')
  })
  it('json_mode sends response_format json_object AND mentions JSON in the system text (DeepSeek requires the word)', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion()))
    const res = await make(fetchFn, 'deepseek').chat(base({ model: 'deepseek-chat', output: { name: 'triage', schema: Schema, mode: 'json_mode' } }))
    expect(bodies[0]!.response_format).toEqual({ type: 'json_object' })
    expect((bodies[0]!.messages as { content: string }[])[0]!.content).toMatch(/JSON/)
    expect(bodies[0]!.max_tokens).toBe(256)
    expect(res.parseStrategy).toBe('json_mode')
  })
  it('a plain call (no output) sends no response_format and returns parsed null', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK', refusal: null } }] })))
    const res = await make(fetchFn).chat(base({ output: undefined }))
    expect(bodies[0]!.response_format).toBeUndefined(); expect(res.text).toBe('OK'); expect(res.parsed).toBeNull()
  })
  it('effort maps to reasoning_effort only for a model whose capabilities say so', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion()))
    await make(fetchFn).chat(base({ model: 'gpt-5', effort: 'high' }))
    expect(bodies[0]!.reasoning_effort).toBe('high')
    await make(fetchFn, 'custom').chat(base({ model: 'qwen3:8b', effort: 'high' }))
    expect(bodies[1]!.reasoning_effort).toBeUndefined()
  })
  it('finish and refusal mapping', async () => {
    const { fetchFn } = capturingFetch(() => jsonResponse(completion({ choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: null, refusal: 'no' } }] })))
    const res = await make(fetchFn).chat(base())
    expect(res.finish).toBe('refusal'); expect(res.parsed).toBeNull()
    const { fetchFn: f2 } = capturingFetch(() => jsonResponse(completion({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{', refusal: null } }] })))
    expect((await make(f2).chat(base())).finish).toBe('length')
  })
  it.each([
    [401, 'auth', false], [403, 'auth', false], [429, 'rate_limit', true], [500, 'transient', true], [400, 'permanent', false],
  ])('HTTP %s → LlmError %s (retryable %s), with the key scrubbed from the message', async (status, code, retryable) => {
    const { fetchFn } = capturingFetch(() => jsonResponse({ error: { message: `bad sk-test-key-1234567890 Bearer sk-test-key-1234567890`, type: 'x' } }, { status, headers: status === 429 ? { 'retry-after': '3' } : {} }))
    const err = await make(fetchFn).chat(base()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).code).toBe(code); expect((err as LlmError).retryable).toBe(retryable)
    expect((err as LlmError).message).not.toContain('sk-test-key')
    if (status === 429) expect((err as LlmError).retryAfterMs).toBe(3000)
  })
  it('a 400 whose message names the context length is context_too_long', async () => {
    const { fetchFn } = capturingFetch(() => jsonResponse({ error: { message: "This model's maximum context length is 128000 tokens", type: 'invalid_request_error' } }, { status: 400 }))
    expect(((await make(fetchFn).chat(base()).catch((e: unknown) => e)) as LlmError).code).toBe('context_too_long')
  })
  it('listModels returns the ids', async () => {
    const { fetchFn } = capturingFetch(() => jsonResponse({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }, { id: 'gpt-5-mini', object: 'model' }] }))
    expect(await make(fetchFn).listModels!()).toEqual(['gpt-5', 'gpt-5-mini'])
  })
  it('capabilities: a listed model, an unlisted model (json_mode, no effort), and the override hook', () => {
    const p = make(capturingFetch(() => jsonResponse(completion())).fetchFn)
    expect(p.capabilities('gpt-5')).toEqual({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null })
    expect(p.capabilities('mystery')).toEqual({ structuredOutput: 'json_mode', tools: false, effort: false, cacheMinTokens: null })
    const o = createOpenAiCompatibleProvider({ kind: 'custom', apiKey: new Secret('sk-x'), baseUrl: 'https://x.test/v1', capabilitiesOverride: (_m, c) => ({ ...c, structuredOutput: 'none' }) })
    expect(o.capabilities('anything').structuredOutput).toBe('none')
  })
})
```

- [ ] **Step 6: Write the adapter**

`packages/llm/src/adapters/openai-compatible/models.ts`:

```ts
import type { LlmProviderId } from '@aesa/contracts'
import type { Capabilities } from '../../core/types.ts'

export type OpenAiCompatibleKind = Exclude<LlmProviderId, 'anthropic'>

/** Provider quirks the request builder needs (spec §provider table). */
export interface PresetQuirks {
  /** OpenAI's reasoning models reject `max_tokens`; everyone else rejects `max_completion_tokens`. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens'
  /** DeepSeek's json_object mode 400s unless the prompt contains the word JSON; harmless everywhere else, so always on. */
  jsonModeNeedsPromptMention: true
  /** Deviation 12: never `strict: true`. */
  strictJsonSchema: false
}
export const PRESET_QUIRKS: Record<OpenAiCompatibleKind, PresetQuirks> = {
  openai: { maxTokensParam: 'max_completion_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  deepseek: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  groq: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  together: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  openrouter: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  custom: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
}

const NATIVE: Capabilities = { structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }
const NATIVE_NO_EFFORT: Capabilities = { structuredOutput: 'native', tools: true, effort: false, cacheMinTokens: null }
const JSON_ONLY: Capabilities = { structuredOutput: 'json_mode', tools: false, effort: false, cacheMinTokens: null }

/** Per (preset, model) capability seed (spec §provider table); the probe overrides downward. `cacheMinTokens` is null everywhere: these providers cache automatically, nothing to place. */
export const OPENAI_COMPATIBLE_MODELS: Record<OpenAiCompatibleKind, Record<string, Capabilities>> = {
  openai: { 'gpt-5': NATIVE, 'gpt-5-mini': NATIVE },
  deepseek: { 'deepseek-chat': JSON_ONLY, 'deepseek-reasoner': JSON_ONLY },
  groq: { 'llama-3.3-70b-versatile': NATIVE_NO_EFFORT, 'llama-3.1-8b-instant': JSON_ONLY },
  together: { 'meta-llama/Llama-3.3-70B-Instruct-Turbo': JSON_ONLY, 'meta-llama/Llama-3.1-8B-Instruct-Turbo': JSON_ONLY },
  openrouter: { 'anthropic/claude-opus-5': NATIVE_NO_EFFORT, 'anthropic/claude-haiku-4.5': NATIVE_NO_EFFORT },
  custom: {},
}
/** An unlisted model: json_object mode (every OpenAI-compatible server accepts it), no tools, no effort. */
export const UNKNOWN_OPENAI_COMPATIBLE_MODEL: Capabilities = JSON_ONLY
```

`packages/llm/src/adapters/openai-compatible/map-errors.ts` — `mapError(err)` mirroring the Anthropic one over `OpenAI.RateLimitError` (`retry-after` header via `parseRetryAfterMs`), `AuthenticationError`/`PermissionDeniedError` → `auth`, `BadRequestError` → `CONTEXT_LENGTH_PATTERN` ? `context_too_long` : `permanent`, `APIUserAbortError` → `transient`, `InternalServerError`/`APIConnectionError` → `transient` (with `withCauseMessage`), `APIError` → `permanent`, else `permanent`; every message through `scrubSecrets`.

`packages/llm/src/adapters/openai-compatible/index.ts`:

```ts
import OpenAI from 'openai'
import type { Secret } from '@aesa/crypto'
import { z } from 'zod'
import { envelopeSchema, toJsonObjectSchema } from '../../core/shared.ts'
import type { Capabilities, ChatRequest, ChatResult, ChatUsage, LlmProvider, ParseStrategy, StructuredMode } from '../../core/types.ts'
import { mapError } from './map-errors.ts'
import { OPENAI_COMPATIBLE_MODELS, PRESET_QUIRKS, UNKNOWN_OPENAI_COMPATIBLE_MODEL, type OpenAiCompatibleKind } from './models.ts'

export interface CreateOpenAiCompatibleProviderOptions {
  kind: OpenAiCompatibleKind
  apiKey: Secret
  baseUrl: string
  fetchFn?: typeof fetch
  /** The probe's stored verdict, applied over the preset (Task 5's resolver passes it). */
  capabilitiesOverride?: (model: string, preset: Capabilities) => Capabilities
}

function mapFinish(reason: string | null | undefined, refusal: string | null | undefined): ChatResult<unknown>['finish'] {
  if (refusal) return 'refusal'
  switch (reason) { case 'stop': case 'tool_calls': return 'stop'; case 'length': return 'length'; case 'content_filter': return 'refusal'; default: return 'unknown' }
}

export function createOpenAiCompatibleProvider(opts: CreateOpenAiCompatibleProviderOptions): LlmProvider {
  const client = new OpenAI({ apiKey: opts.apiKey.expose(), baseURL: opts.baseUrl, maxRetries: 0, ...(opts.fetchFn ? { fetch: opts.fetchFn } : {}) })
  const quirks = PRESET_QUIRKS[opts.kind]
  const capabilitiesFor = (model: string): Capabilities => {
    const preset = OPENAI_COMPATIBLE_MODELS[opts.kind][model] ?? UNKNOWN_OPENAI_COMPATIBLE_MODEL
    return opts.capabilitiesOverride ? opts.capabilitiesOverride(model, preset) : preset
  }

  return {
    kind: opts.kind,
    capabilities: capabilitiesFor,
    async listModels(signal?: AbortSignal): Promise<string[]> {
      try { const ids: string[] = []; for await (const m of client.models.list({ signal })) ids.push(m.id); return ids } catch (err) { throw mapError(err) }
    },
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const caps = capabilitiesFor(req.model)
      const mode: StructuredMode | undefined = req.output ? (req.output.mode ?? (caps.structuredOutput === 'native' ? 'native' : 'json_mode')) : undefined
      // Spec §Prompt blocks → caching: the same static → agent → volatile order, concatenated into
      // ONE system message so the provider's automatic prefix caching benefits.
      let system = req.system.map((b) => b.text).join('\n\n')
      let responseFormat: Record<string, unknown> | undefined
      if (req.output && mode === 'native') {
        responseFormat = { type: 'json_schema', json_schema: { name: req.output.name, strict: quirks.strictJsonSchema, schema: toJsonObjectSchema(envelopeSchema(req.output.schema)) } }
      } else if (req.output && mode === 'json_mode') {
        responseFormat = { type: 'json_object' }
        system += `\n\nRespond with a JSON object of the shape ${JSON.stringify(toJsonObjectSchema(envelopeSchema(req.output.schema)))}. JSON only.`
      }
      const body: Record<string, unknown> = {
        model: req.model,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
        [quirks.maxTokensParam]: req.maxOutputTokens,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(req.effort && caps.effort ? { reasoning_effort: req.effort } : {}),
      }
      const start = performance.now()
      let res: OpenAI.Chat.Completions.ChatCompletion
      try { res = await client.chat.completions.create(body as never, { signal: req.signal }) } catch (err) { throw mapError(err) }
      const latencyMs = Math.round(performance.now() - start)
      const choice = res.choices[0]
      const text = choice?.message?.content ?? ''
      const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const usage: ChatUsage = { inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached), outputTokens: res.usage?.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0, apiCalls: 1 }
      let parsed: T | null = null
      let parseStrategy: ParseStrategy = 'none'
      if (req.output && mode && text) {
        try {
          const outcome = envelopeSchema(req.output.schema).safeParse(JSON.parse(text))
          if (outcome.success) { parsed = outcome.data.decision; parseStrategy = mode }
        } catch { /* not JSON — parsed stays null; the ladder decides what happens next */ }
      }
      return { text, parsed, parseStrategy, usage, finish: mapFinish(choice?.finish_reason, choice?.message?.refusal), provider: opts.kind, model: res.model ?? req.model, latencyMs, providerRequestId: res.id }
    },
  }
}
```

(`z` import only if `toJsonObjectSchema` needs it locally — otherwise drop it; the plan shows the shape, the implementer keeps ESLint clean.) Run `pnpm --filter @aesa/llm test test/openai-compatible.test.ts` → PASS.

- [ ] **Step 7: `probeProvider` — failing test, then the function**

`packages/llm/test/probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createFakeProvider, LlmError, probeProvider, withStructuredLadder } from '../src/index.ts'

const meta = { orgId: 'org', mode: 'byok' as const, credentialId: 'cred', idempotencyPrefix: 'probe:cred:1' }
const good = { parsed: { answer: 'yes', n: 7 } }

describe('probeProvider', () => {
  it('lists models, chats once, then proves the structured rung that worked (native)', async () => {
    const fake = Object.assign(createFakeProvider([{ text: 'OK' }, good], { capabilities: { structuredOutput: 'native' } }), { listModels: async () => ['m1', 'm2'] })
    const r = await probeProvider(withStructuredLadder(fake), 'm1', meta)
    expect(r).toMatchObject({ ok: true, models: ['m1', 'm2'], chat: 'ok', structured: 'native', error: null })
    expect(fake.calls.map((c) => c.meta.idempotencyKey)).toEqual(['probe:cred:1:chat', 'probe:cred:1:structured:native'])
    expect(fake.calls.every((c) => c.meta.role === 'probe')).toBe(true)
  })
  it('a json_mode-only model reports json_mode; a model that parses nothing reports none but ok', async () => {
    const fake = createFakeProvider([{ text: 'OK' }, { text: 'nope' }, { text: 'nope' }], { capabilities: { structuredOutput: 'json_mode' } })
    const r = await probeProvider(fake, 'm', meta)     // the RAW fake: the probe drives the rungs itself
    expect(r).toMatchObject({ ok: true, chat: 'ok', structured: 'none', models: null })
  })
  it('an auth failure on the chat step is ok false with the code, and no structured step runs', async () => {
    const fake = createFakeProvider([{ error: new LlmError('401 bad key', 'auth', false) }])
    const r = await probeProvider(fake, 'm', meta)
    expect(r).toMatchObject({ ok: false, chat: 'failed', structured: null, error: { code: 'auth' } })
    expect(fake.calls).toHaveLength(1)
  })
  it('a models-list failure is not fatal: models null, the rest proceeds', async () => {
    const fake = Object.assign(createFakeProvider([{ text: 'OK' }, good]), { listModels: async () => { throw new LlmError('403', 'auth', false) } })
    expect((await probeProvider(fake, 'm', meta)).models).toBeNull()
  })
})
```

`packages/llm/src/core/probe.ts`:

```ts
import { z } from 'zod'
import type { ProbeResultView } from '@aesa/contracts'
import { LlmError } from './errors.ts'
import type { ChatMeta, LlmProvider } from './types.ts'

const ProbeSchema = z.object({ answer: z.enum(['yes', 'no']), n: z.number().int() })
export const PROBE_MAX_OUTPUT_TOKENS = 64
export const PROBE_TIMEOUT_MS = 20_000

export interface ProbeMeta { orgId: string; mode: 'byok' | 'managed'; credentialId?: string; idempotencyPrefix: string }

/**
 * Spec §Capabilities are probed, not assumed: the models list (when the adapter has one — a failure
 * here is informational), one tiny chat, then the 2-field structured probe at `native` and, failing
 * that, `json_mode` — driven against the RAW adapter (never the ladder) so the answer says which
 * rung the endpoint itself honours. Every call is metered under role `probe` when the caller wraps
 * the provider in `withMetering`. `ok` is "the chat step worked"; `structured: 'none'` is a
 * downgrade, not a failure.
 */
export async function probeProvider(provider: LlmProvider, model: string, meta: ProbeMeta, signal?: AbortSignal): Promise<ProbeResultView> {
  const start = performance.now()
  const probedAt = new Date().toISOString()
  const base: Omit<ChatMeta, 'idempotencyKey'> = { orgId: meta.orgId, role: 'probe', mode: meta.mode, credentialId: meta.credentialId }
  const budget = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const sig = signal ? AbortSignal.any([signal, budget]) : budget
  let models: string[] | null = null
  if (provider.listModels) { try { models = await provider.listModels(sig) } catch { models = null } }
  try {
    await provider.chat({ model, system: [], messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxOutputTokens: 8, signal: sig, meta: { ...base, idempotencyKey: `${meta.idempotencyPrefix}:chat` } })
  } catch (err) {
    const e = err instanceof LlmError ? err : new LlmError(String(err), 'permanent', false)
    return { ok: false, probedAt, models, chat: 'failed', structured: null, latencyMs: Math.round(performance.now() - start), error: { code: e.code, message: e.message.slice(0, 200) } }
  }
  const caps = provider.capabilities(model)
  const ask = (mode: 'native' | 'json_mode') => provider.chat({
    model, system: [{ id: 'probe', text: 'You answer a yes/no question and echo a number.', stability: 'static' }],
    messages: [{ role: 'user', content: 'Is water wet? Also give the number 7.' }],
    output: { name: 'probe', schema: ProbeSchema, mode }, maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, signal: sig,
    meta: { ...base, idempotencyKey: `${meta.idempotencyPrefix}:structured:${mode}` },
  })
  let structured: 'native' | 'json_mode' | 'none' = 'none'
  const rungs: ('native' | 'json_mode')[] = caps.structuredOutput === 'native' ? ['native', 'json_mode'] : ['json_mode']
  for (const mode of rungs) {
    try { const r = await ask(mode); if (r.parsed !== null) { structured = mode; break } } catch { /* a throwing rung is a failed rung */ }
  }
  return { ok: true, probedAt, models, chat: 'ok', structured, latencyMs: Math.round(performance.now() - start), error: null }
}
```

- [ ] **Step 8: `createByokProvider`, `withMeta`, the seed rows, the exports**

In `registry.ts`:

```ts
export const BYOK_MAX_CONCURRENT_PER_CREDENTIAL = 2

/** Stamps `mode`/`credentialId` onto every request's meta (outermost, so the metering row and the limiter key both see them). */
export function withMeta(inner: LlmProvider, patch: Pick<ChatMeta, 'mode' | 'credentialId'>): LlmProvider {
  return { kind: inner.kind, capabilities: (m) => inner.capabilities(m), ...(inner.listModels ? { listModels: (s?: AbortSignal) => inner.listModels!(s) } : {}),
    chat: (req) => inner.chat({ ...req, meta: { ...req.meta, ...patch } }) }
}

export interface ByokProviderOptions {
  provider: LlmProviderId
  apiKey: Secret
  /** The validated https base URL for `custom`; a preset's own URL otherwise. */
  baseUrl: string
  orgId: string
  credentialId: string
  sink: MeterSink
  /** Shared across every BYOK provider on the process; keyed `byok:${orgId}:${credentialId}` so a stalled tenant never starves another. */
  limiter: LlmLimiter
  fetchFn?: typeof fetch
  pricing?: ModelPricing[]
  /** The stored probe verdict: `'none'` forces the plain rung regardless of the preset. */
  structuredOverride?: 'native' | 'json_mode' | 'none' | null
  /** `raw: true` returns the bare adapter with metering only (the probe drives the rungs itself). */
  raw?: boolean
}

export function createByokProvider(o: ByokProviderOptions): LlmProvider {
  const override = o.structuredOverride && o.structuredOverride !== 'native'
    ? (_m: string, c: Capabilities): Capabilities => ({ ...c, structuredOutput: c.structuredOutput === 'none' ? 'none' : o.structuredOverride! })
    : undefined
  const adapter: LlmProvider = o.provider === 'anthropic'
    ? createAnthropicProvider({ apiKey: o.apiKey, fetchFn: o.fetchFn })
    : createOpenAiCompatibleProvider({ kind: o.provider, apiKey: o.apiKey, baseUrl: o.baseUrl, fetchFn: o.fetchFn, capabilitiesOverride: override })
  const metered = withMetering(adapter, o.sink, { pricing: o.pricing, cacheTtl: '5m' })
  const stamped = withMeta(metered, { mode: 'byok', credentialId: o.credentialId })
  if (o.raw) return stamped
  const limited = withLimiter(stamped, o.limiter, () => `byok:${o.orgId}:${o.credentialId}`)
  return withStructuredLadder(limited)
}
```

(An Anthropic BYOK key with a `structuredOverride` keeps the Anthropic adapter's own capability table — the override applies to the OpenAI-compatible adapter only, where the preset is a guess; note this in the function's comment.) `createManagedProvider` gains an optional `fetchFn` pass-through (already there) and nothing else.

`pricing/seed.ts`: append rows for `gpt-5`, `gpt-5-mini`, `deepseek-chat`, `deepseek-reasoner`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` with the SAME numbers as 0020's INSERT and prefix-anchored patterns, `gpt-5-mini` BEFORE `gpt-5`; add a `pricing.test.ts` case pinning `findPricing('gpt-5-mini').id === 'gpt-5-mini'`.

`index.ts` exports: `createOpenAiCompatibleProvider`, `OPENAI_COMPATIBLE_MODELS`, `PRESET_QUIRKS`, `UNKNOWN_OPENAI_COMPATIBLE_MODEL`, `probeProvider`, `PROBE_TIMEOUT_MS`, `createByokProvider`, `withMeta`, `BYOK_MAX_CONCURRENT_PER_CREDENTIAL`, `type ByokProviderOptions`, `scrubSecrets`, `runProviderContract`.

- [ ] **Step 9: The contract suite (spec Verify: "contract suite green for both adapters")**

`packages/llm/src/testing/contract-suite.ts` exports `runProviderContract(name: string, make: (fetchFn: typeof fetch) => LlmProvider, wire: { ok: (text: string) => Response; refusal: () => Response; status: (code: number, headers?: Record<string,string>) => Response })` — a `describe(name)` with the scenarios both adapters must pass identically: (1) a plain call returns `text`, `parsed: null`, `apiCalls: 1`, `latencyMs` an integer; (2) a structured call at the model's best rung parses the envelope; (3) a schema-violating body is `parsed: null` and does NOT throw; (4) `refusal` → `finish: 'refusal'`; (5) 401 → `auth` not retryable; (6) 429 with `retry-after: 2` → `rate_limit`, retryable, `retryAfterMs: 2000`; (7) 500 → `transient`; (8) a fetch that rejects with an Error whose message carries `Bearer sk-secret` → `transient` and the message is scrubbed; (9) an aborted signal → `transient`; (10) system blocks out of order (volatile before static) → the Anthropic adapter throws `permanent`, the OpenAI-compatible adapter concatenates as given (the suite takes an `expectsOrderedBlocks` flag). `packages/llm/test/contract.test.ts` runs it twice — `runProviderContract('anthropic', …)` with the Anthropic message shape, `runProviderContract('openai-compatible', …)` with the completion shape.

- [ ] **Step 10: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(llm,crypto): the OpenAI-compatible adapter and presets, the ladder's plain rung, probeProvider, createByokProvider, createPinnedFetch, the two-adapter contract suite

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Worker — `provider-resolver.ts`, the `llm.probe` job (store + probe + re-wrap), the `llm.reprobe-sweep` cron, the `provider_health` notification; the queue in its four places; the KEK gate for the `agent` role

**Files:**
- Create: `apps/worker/src/provider-resolver.ts`, `apps/worker/src/jobs/llm-probe.ts`, `apps/worker/src/jobs/llm-reprobe-sweep.ts`, `apps/worker/src/provider-health-notify.ts`, `apps/worker/test/provider-resolver.test.ts`, `apps/worker/test/llm-probe.test.ts`, `apps/worker/test/llm-reprobe-sweep.test.ts`
- Modify: `packages/queue/src/names.ts` (+`llmProbe: 'llm.probe'`), `packages/queue/src/queue-options.ts` (+`[JOB_NAMES.llmProbe]: { policy: 'short', expireInSeconds: 120, retryLimit: 2, retryBackoff: true }`), `apps/worker/src/index.ts` (pre-create + cron registration under `cron`), `apps/api/src/boss.ts` (pre-create), `apps/worker/test/queue-preflight.test.ts` (both `it.each`), `apps/worker/src/config.ts` (production `agent` role requires the KEK ring), `apps/worker/test/config.test.ts`, `apps/worker/src/agent-role.ts` (builds the resolver, registers `llm.probe`, hands `providers` to the jobs — the jobs themselves change in Task 6; this task keeps `deps.provider` on them and ADDS `deps.providers`, so both tasks typecheck), `apps/worker/src/index.ts` (`loadModelPricing` at boot), `apps/app/src/lib/push-routing.ts` (`provider_health` → `/settings/ai`; the route exists from Task 9 — `router.push` to a not-yet-existing route is a no-op until then)

**Interfaces:**
- Consumes: Task 3's `resolveModelConfig`, `llmCredentials`, `llmCredentialSecrets`, `loadOrgDek`, `openSealedForOrg`, `encrypt`, `decrypt`; Task 4's `createByokProvider`, `createManagedProvider`, `probeProvider`, `createPinnedFetch`, `createLlmLimiter`, `scrubSecrets`; `PROVIDER_PRESETS`.
- Produces: `ProviderResolver = { resolve(orgId: string, agentId: string | null, role: ModelConfigRole): Promise<ResolvedProvider>; invalidate(credentialId: string): void }`; `ResolvedProvider = { ok: true; provider: LlmProvider; fallback: LlmProvider | null; config: ResolvedModelConfig } | { ok: false; reason: 'credential_dead' | 'no_kek' | 'no_secret' | 'no_managed_key'; config: ResolvedModelConfig }`; `createProviderResolver(deps: { db; ring: KekRing | null; managed: LlmProvider | null; sink: MeterSink; pricing?: ModelPricing[]; fetchFn?: typeof fetch; logger; now? })`; `staticResolver(provider: LlmProvider, config?: Partial<ResolvedModelConfig>): ProviderResolver` (tests); `openCredentialKey(deps, orgId, credentialId): Promise<{ apiKey: Secret; encryption: 'sealed' | 'dek' } | null>`; `markCredentialDead(tx, orgId, credentialId, error): Promise<boolean>` (guarded `health_status <> 'dead'`); `notifyProviderHealth(deps, orgId, credentialId, label, provider, now)`; `LlmProbePayload = { orgId; credentialId; sealed?: string; reason: 'connect' | 'manual' | 'scheduled' }`; `runLlmProbe(deps, payload, signal)`; `enqueueLlmProbe(boss, orgId, credentialId, opts)`; `runLlmReprobeSweep(deps)`; `REPROBE_INTERVAL_HOURS = 6`, `DEGRADED_AFTER_FAILURES = 2`.

- [ ] **Step 1: The queue in its four places, and the config gate**

`names.ts` + `queue-options.ts` + both pre-create lists (`createQueueRetrying(boss, JOB_NAMES.llmProbe, queueOptionsFor(JOB_NAMES.llmProbe))` — the worker's goes right after `guidanceSuggest` with a comment "Phase 6: the api's `llm.addCredential`/`probeCredential` and the worker's own `llm.reprobe-sweep` both send it") + the preflight test's two `it.each` lists. `config.ts`: after the existing `sync` KEK gate add

```ts
  if (production && roles.has('agent') && !kekRing) {
    throw new Error('AESA_KEK_V<n> and AESA_KEK_ACTIVE are required in production when WORKER_ROLES includes `agent` (BYOK provider keys are opened under the org DEK)')
  }
```

with a `config.test.ts` case for it (mirror the existing `sync` one). Run `pnpm --filter @aesa/worker test test/queue-preflight.test.ts test/config.test.ts` → PASS.

- [ ] **Step 2: `provider-resolver.ts` — failing tests**

`apps/worker/test/provider-resolver.test.ts` (real Postgres via `createTestDatabase`; a fake managed provider; a sealed-then-dek secret seeded by hand; `fetchFn` never called because no test resolves to a real network call — the resolver is asserted on WHICH provider comes back and how it is keyed):

```ts
describe('createProviderResolver', () => {
  it('managed config → the managed provider, no fallback, config.mode managed', …)
  it('byok config with a dek-wrapped secret → a provider whose kind is the credential\'s provider; a second resolve for the same credential returns the SAME instance (cached); invalidate() drops it', …)
  it('byok config with a sealed secret (probe not yet run) → opens the sealed box (no re-wrap here — the probe job owns that)', …)
  it('byok config, credential dead → { ok: false, reason: credential_dead } and NO decrypt (the secret table is never read)', …)
  it('byok config with no ring → { ok: false, reason: no_kek }', …)
  it('byok config with no secret row → { ok: false, reason: no_secret }', …)
  it('fallbackToManaged true → fallback is the managed provider; false → null; true with no managed key → null and a warn line once', …)
  it('a custom credential builds the adapter on its stored base_url; a preset credential on the preset\'s', …)   // assert through a capturing fetchFn: one chat() call and the URL it hit
})
```

Each `it` seeds `agent_model_config` + `llm_credentials` (+ the secret via `withPlatform`, `encryption: 'dek'` with `encrypt(dek, Buffer.from(JSON.stringify({ apiKey: 'sk-test' })), \`${orgId}:llm_credential_secrets:${credentialId}\`)` after `provisionOrgKeys` + `loadOrgDek` with a test ring from `loadKekRing({ AESA_KEK_V1: <32 random bytes b64>, AESA_KEK_ACTIVE: '1' })`).

- [ ] **Step 3: Implement the resolver**

```ts
/**
 * The worker's ONE way to get a model provider for a call (Phase 6). `resolve` reads the agent's
 * config through `resolveModelConfig` (the same reader the api uses), and:
 *  - managed → the process-wide managed provider (built once by agent-role.ts);
 *  - byok → the credential's key, opened under the org DEK (or straight out of the sealed box if the
 *    probe has not re-wrapped it yet), composed by `createByokProvider` and CACHED per credential —
 *    a key is decrypted once per process, not once per draft. `invalidate(credentialId)` is called
 *    by the probe job after every store/re-wrap and by nothing else.
 * Every failure to produce a provider is a typed refusal the job lands as `provider_unavailable`,
 * never a throw: a dead credential, a missing ring (dev only — production refuses to boot),
 * a missing secret row (the store step of `llm.probe` has not run yet). No transaction here spans
 * network I/O — `resolve` only reads; the caller calls the model afterwards.
 */
```

Sketch of `resolve`:

```ts
async resolve(orgId, agentId, role) {
  const config = await withOrg(deps.db, orgId, (tx) => resolveModelConfig(tx, agentId, role))
  const fallback = config.fallbackToManaged ? deps.managed : null
  if (config.mode === 'managed') {
    if (!deps.managed) return { ok: false, reason: 'no_managed_key', config }
    return { ok: true, provider: deps.managed, fallback: null, config }
  }
  if (config.credential?.healthStatus === 'dead') return { ok: false, reason: 'credential_dead', config }
  if (!deps.ring) return { ok: false, reason: 'no_kek', config }
  const cached = cache.get(config.credentialId!)
  if (cached) return { ok: true, provider: cached, fallback, config }
  const opened = await openCredentialKey({ db: deps.db, ring: deps.ring }, orgId, config.credentialId!)
  if (!opened) return { ok: false, reason: 'no_secret', config }
  const baseUrl = config.credential!.baseUrl ?? PROVIDER_PRESETS[config.provider].baseUrl!
  const provider = createByokProvider({
    provider: config.provider, apiKey: opened.apiKey, baseUrl, orgId, credentialId: config.credentialId!, sink: deps.sink, limiter,
    fetchFn: deps.fetchFn ?? createPinnedFetch({ allowNonstandardPort: true, timeoutMs: 120_000 }), pricing: deps.pricing,
    structuredOverride: config.credential!.lastProbe?.structured ?? null,
  })
  cache.set(config.credentialId!, provider)            // Map with a 256-entry cap, oldest evicted
  return { ok: true, provider, fallback, config }
}
```

`openCredentialKey`: `withPlatform(db, \`job:llm.resolve:${credentialId}\`, tx => select secret row)`; if none → null; then `withOrg(db, orgId, async tx => encryption === 'sealed' ? openSealedForOrg(tx, ring, ciphertext) : decrypt((await loadOrgDek(tx, ring)).dek, ciphertext, aad))`; parse `{ apiKey }`; return `{ apiKey: new Secret(apiKey), encryption }`. The AAD is `${orgId}:llm_credential_secrets:${credentialId}` — spell it in ONE exported constant function `secretAad(orgId, credentialId)` the probe job imports.

`markCredentialDead(tx, orgId, credentialId, error)`: `UPDATE llm_credentials SET health_status='dead', last_error=<scrubbed ≤200>, consecutive_failures = consecutive_failures + 1, updated_at=now() WHERE org_id=$1 AND id=$2 AND health_status <> 'dead' RETURNING id` → boolean; plus an audit row `llm.credential_dead` (actor `system:<job>` passed in).

`provider-health-notify.ts` mirrors `reauth-notify.ts`: kind `provider_health`, title `AI provider needs attention`, body `<label> was rejected by <consentName>. Drafting for agents that use it is paused until you update the key in Settings → AI.`, `dedupeKey: provider_health:${credentialId}:${utcDay}`, payload `{ credentialId }`, then `enqueueNotify`.

- [ ] **Step 4: `llm.probe` — failing tests**

`apps/worker/test/llm-probe.test.ts` — `runLlmProbe(deps, payload, signal)` with `deps = { db, ring, sink, logger, enqueueNotify, resolver (createProviderResolver with a fetchFn stub), makeProbeProvider? }`:

```ts
it('connect: stores the sealed key (platform tx), probes through the RAW byok provider, lands healthy + last_probe + models, re-wraps the secret under the DEK (encryption dek, data_key_version), invalidates the resolver cache, audits llm.credential_probed', …)
it('manual re-probe with no sealed payload: reads the dek secret, probes, healthy again, consecutive_failures 0', …)
it('a 401 on the chat step: health dead, last_error scrubbed, ONE provider_health notification (day-deduped: a second run inserts none), audit llm.credential_dead', …)
it('a 500 on the chat step: consecutive_failures 1 keeps the previous health; a second 500 → degraded (DEGRADED_AFTER_FAILURES)', …)
it('a structured probe that only json_mode honours stores structured json_mode; one that nothing honours stores none and resolveModelConfig now reports tier limited', …)
it('a credential deleted mid-flight (no row) returns without throwing and stores nothing', …)
it('every probe call is metered: llm_calls rows with role probe, mode byok, credential_id set', …)
```

The probe steps run through `createByokProvider({ …, raw: true })` so the fetch stub's responses drive them; the stub answers `/models` with a list, `/chat/completions` per scenario.

- [ ] **Step 5: Implement `llm-probe.ts`**

```ts
export const LlmProbePayload = z.object({ orgId: z.string(), credentialId: z.string(), sealed: z.string().optional(), reason: z.enum(['connect', 'manual', 'scheduled']) })
export const llmProbeJob = defineJob({ name: JOB_NAMES.llmProbe, schema: LlmProbePayload, handler: async () => { throw new Error('llm.probe: register through registerLlmProbe') } })
export const REPROBE_INTERVAL_HOURS = 6
export const DEGRADED_AFTER_FAILURES = 2
const ACTOR = `system:${JOB_NAMES.llmProbe}` as const

export async function runLlmProbe(deps: LlmProbeDeps, p: LlmProbePayload, signal: AbortSignal): Promise<'healthy' | 'degraded' | 'dead' | 'skipped'> {
  const now = deps.now?.() ?? new Date()
  // 1. Store (connect only): delete+insert the SEALED blob, platform tx — the mailbox.store-credentials shape.
  if (p.sealed) await withPlatform(deps.db, `job:llm.probe:store:${p.credentialId}`, async (tx) => {
    await tx.delete(llmCredentialSecrets).where(and(eq(llmCredentialSecrets.credentialId, p.credentialId), eq(llmCredentialSecrets.orgId, p.orgId)))
    await tx.insert(llmCredentialSecrets).values({ credentialId: p.credentialId, orgId: p.orgId, keyCiphertext: Buffer.from(p.sealed, 'base64'), encryption: 'sealed' })
  })
  deps.resolver.invalidate(p.credentialId)
  // 2. Read the credential (org tx). Gone → skipped.
  const cred = await withOrg(deps.db, p.orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, p.credentialId)).then((r) => r[0] ?? null))
  if (!cred) return 'skipped'
  // 3. Open the key — no network yet.
  const opened = await openCredentialKey({ db: deps.db, ring: deps.ring }, p.orgId, p.credentialId)
  if (!opened) { deps.logger.warn({ credentialId: p.credentialId }, 'llm.probe: no secret row'); return 'skipped' }
  // 4. The probe itself — network, outside every transaction, against the RAW metered adapter.
  const provider = deps.provider as LlmProviderId
  const model = cred.probeModel ?? presetModel(provider, 'draft')
  if (!model) { deps.logger.warn({ credentialId: p.credentialId }, 'llm.probe: no probe model'); return 'skipped' }
  …
}
```

**Which model does a probe use?** `cred.probeModel` (Task 3's column; Task 8's `addCredential` stores the owner's `probeModel` for `custom` and `presetModel(provider, 'draft')` for a preset), falling back to `presetModel(provider, 'draft')`; a credential with neither (impossible after Task 8) lands `skipped` with a warn.

Steps 4–6 continue: `const raw = createByokProvider({ …, raw: true, sink: deps.sink, structuredOverride: null })`; `const result = await probeProvider(raw, model, { orgId, mode: 'byok', credentialId, idempotencyPrefix: \`probe:${credentialId}:${now.toISOString()}\` }, signal)`; then ONE org transaction: guarded UPDATE of `llm_credentials` (`WHERE id = $1 AND updated_at = <the read's updated_at>` is NOT required — health is monotone per probe; guard on `id` and `org_id` only) setting `lastProbe`, `lastProbedAt: now`, and: `ok && structured !== null` → `healthStatus: 'healthy', consecutiveFailures: 0, lastError: null`; `!ok && error.code === 'auth'` → `markCredentialDead` + `notifyProviderHealth`; `!ok` otherwise → `consecutiveFailures + 1`, `healthStatus: failures + 1 >= DEGRADED_AFTER_FAILURES ? 'degraded' : <unchanged>`, `lastError`; audit `llm.credential_probed` with `{ reason, ok, structured, health }`. Then, if `opened.encryption === 'sealed'`: re-wrap — `withOrg` → `loadOrgDek` → `encrypt(dek, plaintextJson, secretAad(orgId, credentialId))` inside a `withPlatform` UPDATE of the secret row (`encryption: 'dek', dataKeyVersion: version`) guarded on `encryption = 'sealed'`; `deps.resolver.invalidate(credentialId)`. Return the health.

`registerLlmProbe(boss, deps)` wires `registerJob`; `enqueueLlmProbe(boss, orgId, credentialId, { sealed?, reason })` calls `enqueue(boss, llmProbeJob, payload, { entityId: credentialId })` (a `short` queue: a manual re-probe while a scheduled one is still `created` collapses — fine).

- [ ] **Step 6: `llm.reprobe-sweep` cron**

`jobs/llm-reprobe-sweep.ts`: `registerLlmReprobeSweep(boss, { db, logger, enqueueProbe })` → `registerCron(boss, 'llm.reprobe-sweep', '15 */6 * * *', run, { policy: 'singleton', singletonKey: 'llm.reprobe-sweep', retryLimit: 0, expireInSeconds: 300 })`. `runLlmReprobeSweep`: `withPlatform(db, 'job:llm.reprobe-sweep', tx => select id, org_id from llm_credentials where health_status <> 'dead' and (last_probed_at is null or last_probed_at < now() - interval '6 hours'))`, then `enqueueProbe(orgId, id, { reason: 'scheduled' })` per row OUTSIDE the transaction; returns the count. Test: three credentials (healthy old, dead old, healthy fresh) → exactly one enqueue.

- [ ] **Step 7: Wire `agent-role.ts` and `index.ts`**

`agent-role.ts`: the missing-key gate becomes "no `ANTHROPIC_API_KEY` → `managed = null`" (production STILL refuses — a platform with no managed key cannot draft for a tenant that never added one; keep the throw). Build `const sink = createMeterSink(…)`, `const pricing = deps.pricing` (from `index.ts`: `await loadModelPricing(db)`, `[]` → `PRICING_SEED`), `const managed = createManagedProvider({ apiKey, sink, pricing })`, `const providers = createProviderResolver({ db, ring: config.kekRing, managed, sink, pricing, logger })`, register `llm.probe` (`registerLlmProbe(boss, { db, ring: config.kekRing, sink, logger, enqueueNotify, resolver: providers })` — only when `config.kekRing` is set; without a ring log once `BYOK disabled: no KEK ring (llm.probe not registered)`), and pass `providers` to every job's deps beside the existing `provider` (Task 6 removes `provider`). `index.ts`: under `cron`, `registerLlmReprobeSweep(boss, { db, logger, enqueueProbe: (orgId, id, opts) => enqueueLlmProbe(boss, orgId, id, opts) })`. `AgentRoleRegistrars` gains `registerLlmProbe`; `agent-role.test.ts` gains the two gate cases (ring present → registered; absent in dev → skipped with the warn line).

- [ ] **Step 8: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(worker,queue): the provider resolver, llm.probe (store, probe, re-wrap, health), the 6-hourly reprobe cron, provider_health; llm.probe in its four places; the agent role's KEK gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Worker — `ticket.draft`, `agent.sandbox`, `ticket.triage`, `guidance.suggest` on the resolver; the shared evidence helper with the tier cap; `provider_unavailable` and `fallback_to_managed`; `agent_runs.kind = 'triage'`; `memory.capture`'s embed metered and capped; `@aesa/agent` takes the model from its input

**Files:**
- Create: `apps/worker/src/drafting/evidence.ts`, `apps/worker/test/drafting-evidence.test.ts`
- Modify: `packages/agent/src/draft/prompt.ts` (`DraftPromptInput.model: string`; `buildDraftRequest` uses it; `DRAFT_MODEL` stays exported as the managed default), `packages/agent/src/draft/run.ts` (unchanged signature — the model rides in `input`), `packages/agent/src/triage.ts` (`runTriageCall(provider, input, meta, signal, model = TRIAGE_MODEL)` + `runTriageCallDetailed` returning `{ verdict, result }`), `packages/agent/src/guidance/suggest.ts` (`model = GUIDANCE_SUGGEST_MODEL` param), `packages/agent/test/{draft-prompt,triage,guidance-suggest}.test.ts`, `apps/worker/src/jobs/ticket-draft.ts`, `apps/worker/src/jobs/agent-sandbox.ts`, `apps/worker/src/jobs/ticket-triage.ts`, `apps/worker/src/jobs/guidance-suggest.ts`, `apps/worker/src/jobs/memory-capture.ts`, `apps/worker/src/agent-role.ts` (drop `provider` from the job deps), `apps/worker/test/{ticket-draft,agent-sandbox,ticket-triage,guidance-suggest,memory-capture,e2e-phase3,e2e-phase4,e2e-phase5}.test.ts` (deps: `provider: fake` → `providers: staticResolver(fake)`), `apps/api/src/trpc/routers/agents.ts` (`sandboxStart` stamps `resolveModelConfig`'s provider/model)

**Interfaces:**
- Consumes: Task 5's `ProviderResolver`, `staticResolver`, `markCredentialDead`, `notifyProviderHealth`; Task 2's `cappedModelConfidence`; `resolveModelConfig`.
- Produces: `computeEvidence(input: { knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }; reply: Extract<DraftDecision, { outcome: 'reply' }> | null; tier: QualityTier }): EvidenceResult` with `EvidenceResult = { retrievedChunkIds; retrievedAnswerIds; citedChunkIds; usedAnswerIds; memoryConflictIds; groundingScore: number | null; memory: { score; answerId; cosine; approvals } | null; modelRaw: number | null; modelCapped: number | null; evidence: number | null }`; `FALLBACK_CODES = ['auth', 'rate_limit', 'transient'] as const`; `TicketDraftDeps.providers: ProviderResolver` (replacing `provider`), same on `AgentSandboxDeps`, `TicketTriageDeps`, `GuidanceSuggestDeps`; `confidence_breakdown` gains `tier`, `modelCap`, `modelRaw`, `provider`, `modelId`, `mode`, `modelGeneration`.

- [ ] **Step 1: The evidence helper — failing test**

`apps/worker/test/drafting-evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { computeEvidence } from '../src/drafting/evidence.ts'

const chunk = (id: string, score: number) => ({ id, documentId: 'd', headingPath: [], content: 'c', score })
const answer = (id: string, score: number, approvals: number) => ({ id, questionText: 'q', answerBody: 'a', score, approvals, categoryId: null })
const reply = (over: Partial<{ citedChunkIds: string[]; usedAnswerIds: string[]; memoryConflictIds: string[]; confidence: number }>) =>
  ({ outcome: 'reply' as const, body: 'b', categoryKey: 'other', confidence: 0.95, rationale: '', unresolvedQuestions: [], citedChunkIds: [], usedAnswerIds: [], memoryConflictIds: [], ...over })

describe('computeEvidence', () => {
  it('filters invented ids, takes the best validated citation and the best USED answer, and multiplies by the CAPPED model term', () => {
    const r = computeEvidence({
      knowledge: { chunks: [chunk('c1', 0.7), chunk('c2', 0.9)], answers: [answer('a1', 0.92, 3), answer('a2', 0.85, 1)] },
      reply: reply({ citedChunkIds: ['c2', 'ghost'], usedAnswerIds: ['a2', 'ghost'], memoryConflictIds: ['c1', 'nope'], confidence: 0.95 }), tier: 'limited',
    })
    expect(r.citedChunkIds).toEqual(['c2']); expect(r.usedAnswerIds).toEqual(['a2']); expect(r.memoryConflictIds).toEqual(['c1'])
    expect(r.groundingScore).toBe(0.9)
    expect(r.memory).toMatchObject({ answerId: 'a2', cosine: 0.85, approvals: 1 }); expect(r.memory!.score).toBeCloseTo(0.8 / 3, 5)
    expect(r.modelRaw).toBe(0.95); expect(r.modelCapped).toBe(0.6)
    expect(r.evidence).toBeCloseTo(0.9 * 0.6, 5)          // max(0.267, 0.9) × 0.6
  })
  it('calibrated leaves the model term alone; a non-reply yields nulls and empty lists', () => {
    expect(computeEvidence({ knowledge: { chunks: [chunk('c1', 0.8)], answers: [] }, reply: reply({ citedChunkIds: ['c1'], confidence: 0.95 }), tier: 'calibrated' }).evidence).toBeCloseTo(0.76, 5)
    const none = computeEvidence({ knowledge: { chunks: [chunk('c1', 0.8)], answers: [] }, reply: null, tier: 'standard' })
    expect(none).toMatchObject({ citedChunkIds: [], usedAnswerIds: [], groundingScore: null, memory: null, modelRaw: null, modelCapped: null, evidence: null, retrievedChunkIds: ['c1'] })
  })
})
```

(`RetrievedChunk`/`RetrievedAnswer` field names: copy them from `packages/agent/src/retrieval.ts`, not from this sketch.)

- [ ] **Step 2: Write `drafting/evidence.ts`** — lift the duplicated block out of both jobs verbatim (the file structure's "Repo facts" names the lines), add the cap:

```ts
import type { DraftDecision, RetrievedAnswer, RetrievedChunk } from '@aesa/agent'
import type { QualityTier } from '@aesa/contracts'
import { cappedModelConfidence, evidenceScore, memoryScore } from '@aesa/core'
export interface EvidenceResult { /* as in Interfaces */ }
export function computeEvidence(input: { knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }; reply: Extract<DraftDecision, { outcome: 'reply' }> | null; tier: QualityTier }): EvidenceResult {
  const retrievedChunkIds = input.knowledge.chunks.map((c) => c.id)
  const retrievedAnswerIds = input.knowledge.answers.map((a) => a.id)
  const reply = input.reply
  const citedChunkIds = reply ? reply.citedChunkIds.filter((id) => retrievedChunkIds.includes(id)) : []
  const usedAnswerIds = reply ? reply.usedAnswerIds.filter((id) => retrievedAnswerIds.includes(id)) : []
  const memoryConflictIds = reply ? reply.memoryConflictIds.filter((id) => retrievedChunkIds.includes(id) || retrievedAnswerIds.includes(id)) : []
  const citedScores = input.knowledge.chunks.filter((c) => citedChunkIds.includes(c.id)).map((c) => c.score)
  const groundingScore = citedScores.length > 0 ? Math.max(...citedScores) : null
  const bestUsed = input.knowledge.answers.filter((a) => usedAnswerIds.includes(a.id))
    .reduce<{ answer: RetrievedAnswer; score: number } | null>((best, a) => { const s = memoryScore(a.score, a.approvals); return best === null || s > best.score ? { answer: a, score: s } : best }, null)
  const memory = bestUsed ? { score: bestUsed.score, answerId: bestUsed.answer.id, cosine: bestUsed.answer.score, approvals: bestUsed.answer.approvals } : null
  const modelRaw = reply ? reply.confidence : null
  // The ONE place a quality tier touches the maths (plan Global Constraints): the model's own number, clamped.
  const modelCapped = reply ? cappedModelConfidence(reply.confidence, input.tier) : null
  const evidence = reply ? evidenceScore({ memory: memory?.score ?? 0, grounding: groundingScore, model: modelCapped! }) : null
  return { retrievedChunkIds, retrievedAnswerIds, citedChunkIds, usedAnswerIds, memoryConflictIds, groundingScore, memory, modelRaw, modelCapped, evidence }
}
```

- [ ] **Step 3: `ticket.draft` on the resolver — failing tests first**

Add to `apps/worker/test/ticket-draft.test.ts` (deps now `providers: staticResolver(fake, { … })`; the existing cases pass `staticResolver(fake)` = managed/calibrated and keep their assertions):

```ts
it('byok/limited: confidence_breakdown.model is the CAPPED term, .modelRaw the model\'s own, .tier limited, the run row carries the credential\'s provider/model, and drafts.confidence is still the raw number', …)
   // fake reply confidence 0.95 with grounding 0.9 on tier 'limited' → breakdown.model 0.6, evidence 0.54, drafts.confidence 0.95, agent_runs.provider 'custom', model 'qwen3:32b', breakdown.mode 'byok', breakdown.modelGeneration 3
it('config.effort overrides the run\'s first effort: high on the first call', …)                // fake.calls[0].effort === 'high'
it('resolver { ok: false, credential_dead } before the claim: ticket needs_owner/provider_unavailable, ONE escalation notification, no run row, no stamp', …)
it('llm auth on a byok primary with no fallback: the run fails llm_auth, the credential is marked dead (guarded), ONE provider_health notification, the ticket lands needs_owner/provider_unavailable — and the job does NOT rethrow', …)
it('llm auth on a byok primary WITH fallback: the second call goes to the managed fake, the run event fallback is appended, the draft lands, the breakdown says mode managed', …)
it('rate_limit with fallback: same; permanent without fallback: the existing fail path (rethrow, ceiling → agent_failed)', …)
```

`staticResolver(primary, config?, fallback?)` in `provider-resolver.ts`: returns `{ ok: true, provider: primary, fallback: fallback ?? null, config: { ...managedConfig(role), ...config } }` for every resolve; a `staticRefusal(reason, config?)` returns the `ok: false` shape.

- [ ] **Step 4: Implement in `ticket-draft.ts`**

- `TicketDraftDeps`: replace `provider: LlmProvider` with `providers: ProviderResolver` and add `onCredentialDead?: (orgId, credentialId, error) => Promise<void>` — no: keep it inside the job (it has `db` and `enqueueNotify`): import `markCredentialDead` + `notifyProviderHealth`.
- In `runTicketDraft`, right after `const agent = pre.agent` and before rule 3: `const resolved = await deps.providers.resolve(orgId, agent.id, 'draft')`; if `!resolved.ok`: `withOrg` → `escalateTicket({ orgId, ticketId, fromStatus: 'triaged', reason: 'provider_unavailable', dedupeKey: \`provider_unavailable:${ticketId}:${day}\`, day, now, actor: DRAFT_ACTOR, auditAction: 'ticket.escalated', detail: { reason: resolved.reason } })` → enqueueNotify → return. (Logged at warn with `resolved.reason`; no run row, no stamp — same discipline as `no_agent`.)
- `gateAndRecordRun({ …, provider: resolved.config.provider, model: resolved.config.model })`.
- `promptInput(...)` gains `model: resolved.config.model`; `firstEffort` becomes `resolved.config.effort ?? (ownerFeedbackPending ? 'high' : 'medium')` (typed `'low' | 'medium' | 'high'`); the guardrail retry keeps `'high'`.
- `callModel(attempt, guardrailRetry, effort)` wraps the call:

```ts
    let call: DraftCallResult
    try {
      call = await runDraftCall(resolved.provider, promptInput(guardrailRetry, effort), meta, watchdog)
    } catch (err) {
      if (resolved.fallback && err instanceof LlmError && (FALLBACK_CODES as readonly string[]).includes(err.code) && !watchdog.aborted) {
        deps.logger.warn({ runId, code: err.code }, 'ticket.draft: byok call failed; falling back to Managed AI')
        await withOrg(deps.db, orgId, (tx) => appendRunEvent(tx, runId, 'call', { attempt, fallback: true, from: resolved.config.provider, code: err.code }))
        usedFallback = true
        call = await runDraftCall(resolved.fallback, { ...promptInput(guardrailRetry, effort), model: MANAGED_MODELS.draft }, { ...meta, mode: 'managed', credentialId: undefined }, watchdog)
      } else throw err
    }
```

  and the first-call catch (rule 9) gains, BEFORE `fail(...)`: `if (err instanceof LlmError && err.code === 'auth' && resolved.config.mode === 'byok' && !usedFallback) { await deadCredential(); const escalated = await fail('llm_auth', …); if (!escalated) { await withOrg(... escalateTicket(provider_unavailable ...)) ; enqueueNotify } ; return }` where `deadCredential()` = `withOrg` → `markCredentialDead(tx, orgId, credentialId, err.message)` returning true → `notifyProviderHealth(...)`. (Read `fail`'s return: true means the ceiling escalation already happened.)
- The evidence block → `const ev = computeEvidence({ knowledge, reply: replyDecision, tier: resolved.config.tier })`; every later use reads `ev.*`; the breakdown adds `tier: resolved.config.tier, modelCap: QUALITY_CAPS[tier], modelRaw: ev.modelRaw, provider: usedFallback ? 'anthropic' : resolved.config.provider, modelId: usedFallback ? MANAGED_MODELS.draft : resolved.config.model, mode: usedFallback ? 'managed' : resolved.config.mode, modelGeneration: resolved.config.modelGeneration` and `model: ev.modelCapped`. `drafts.confidence` stays `decision.confidence`.
- `agent-sandbox.ts`: the same resolve (agentId from the run row) at preload; `unavailable` → the run lands `failed` with `errorCode: 'provider_unavailable'` (the sandbox has no ticket to escalate); update `agent_runs.provider/model` in the preload tx to the resolved pair; evidence through `computeEvidence`; `SandboxOutputView` gains `tier: z.enum(QUALITY_TIERS).nullable().default(null)` (nullable so old rows parse) and the output writes it.
- `ticket-triage.ts`: `resolve(orgId, ticket.agentId ?? null, 'triage')` before rule 4; `unavailable` → the existing `triage_failed` landing? NO — `needs_owner` with `provider_unavailable` through `insertEscalationNotification(…, 'provider_unavailable')` inside the same guarded write the `triage_failed` branch uses (triage's own three landings predate `escalateTicket`; this fourth follows the local pattern, documented). The spend-guard tx (rule 4) also inserts the `agent_runs` row `{ kind: 'triage', ticketId, agentId, provider, model, status: 'running', input: {} }` and returns its id; the call uses `runTriageCallDetailed(resolved.provider, input, { …meta, runId, agentId }, signal, resolved.config.model)`; the verdict tx and the failure branch both `finishRun` it (usage from `result.usage`; cost via `findPricing`/`computeCostMicros` like the draft job). Fallback: same `FALLBACK_CODES` retry as the draft job (triage is cheap; one retry).
- `guidance-suggest.ts`: `resolve(orgId, draft.agentId, 'triage')`; `unavailable` → skip with an audit `guidance.skipped` reason `provider_unavailable`; model from config.
- `memory-capture.ts`: `load()` also reads `resolveSetting('knowledge.daily_embed_tokens_cap', …)` and today's `KNOWLEDGE_METERS.embedTokens`; at cap → stamp `memory_captured_at` and audit `memory.skipped` reason `embed_cap`, return `'skipped'`; after a successful embed the write tx bumps `bumpMeter(tx, orgId, day, KNOWLEDGE_METERS.embedTokens, tokens)`. Test both.
- `agents.sandboxStart` (api): `const cfg = await resolveModelConfig(tx, input.agentId, 'draft')` → `provider: cfg.provider, model: cfg.model`.
- `@aesa/agent`: `buildDraftRequest` reads `input.model`; `runTriageCallDetailed` is the implementation, `runTriageCall` = `(await runTriageCallDetailed(…)).verdict`; `runGuidanceSuggestCall(provider, input, meta, signal, model = GUIDANCE_SUGGEST_MODEL)`. Update the three agent tests to pass/expect the model.

- [ ] **Step 5: Run every touched suite**

Run: `pnpm --filter @aesa/agent test && pnpm --filter @aesa/worker test && pnpm --filter @aesa/api test test/agents-router.test.ts`
Expected: PASS. The three E2E files only swap `provider` for `providers: staticResolver(provider)`.

- [ ] **Step 6: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(worker,agent,api): every model call resolves the agent's provider; the tier-capped evidence helper; provider_unavailable and fallback_to_managed; triage run rows; memory.capture's embed metered and capped

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `stats.rollup` — graduation by tier, and the `model_generation_at` window

**Files:**
- Modify: `apps/worker/src/jobs/stats-rollup.ts`, `apps/worker/test/stats-rollup.test.ts`

**Interfaces:**
- Consumes: `resolveModelConfig(org, agentId, 'draft')` (inside the rollup's per-org `withOrgIdentity` tx), `graduationRulesFor(tier)`.
- Produces: no new exports; the rollup's step (d) reads `{ canGraduate, minDecisions }` per agent and counts only decisions at or after `modelGenerationAt`.

- [ ] **Step 1: Failing tests (a worked example each, per the Phase 5 lesson)**

```ts
it('a standard-tier agent needs 40 decisions: 30 unchanged approvals in 30 days suggest nothing; 40 suggest', …)
it('a limited-tier agent is never suggested Autopilot and never auto-graduates, even at 60/60 unchanged', …)
it('decisions before model_generation_at do not count: 25 unchanged approvals, then the model changed 3 days ago and 5 more since → the window holds 5 → no suggestion', …)
   // Worked example: generationAt = now − 3d; drafts decided at now − 10d … now − 4d (25 rows) are excluded; now − 2d … now (5 rows) included → total 5 < 20.
it('the demotion backstop and the daily table are UNCHANGED by the tier (limited agent, two rejections → still demoted; category_stats_daily rows identical)', …)
```

- [ ] **Step 2: Implement**

In step (b) (the per-org draft load) the rows already carry `agentId`, `decidedAt` and `createdAt`; in step (d), before evaluating an agent's categories, resolve `const cfg = await resolveModelConfig(org, policy.agentId, 'draft')` ONCE per agent (memoize per pass in a `Map<agentId, ResolvedModelConfig>`), `const rules = graduationRulesFor(cfg.tier)`; skip the graduation branch entirely when `!rules.canGraduate`; build the graduation signals from the agent's decisions filtered by `cfg.modelGenerationAt === null || draft.decidedAt >= cfg.modelGenerationAt`; call `evaluateGraduation` with a `minDecisions` override — extend `evaluateGraduation(s, rules = GRADUATION_RULES)` in `@aesa/core` (a second optional parameter, default unchanged; add one core test) so the rollup passes `rules`. The `graduateCategory` copy stays "would have auto-sent X of your last 20" over the SAME filtered sample. Demotion signals and the daily table are untouched.

- [ ] **Step 3: Run, gate, commit**

```bash
pnpm --filter @aesa/core test && pnpm --filter @aesa/worker test test/stats-rollup.test.ts
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(worker,core): stats.rollup graduates by quality tier and counts only decisions since the agent's model generation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: api — `src/llm/service.ts` (`@aesa/api/llm`) and the `llm` router: list/add/probe/remove connections, per-agent model get/set with the `model_changed` demotion, usage from `llm_calls`

**Files:**
- Create: `apps/api/src/llm/service.ts`, `apps/api/src/trpc/routers/llm.ts`, `apps/api/test/llm-router.test.ts`, `apps/api/test/llm-service.test.ts`
- Modify: `apps/api/package.json` (`"./llm": "./src/llm/service.ts"`), `apps/api/src/trpc/router.ts` (`llm: llmRouter`), `apps/api/src/trpc/routers/agents.ts` (`list` returns `model: { mode, provider, model, credentialLabel }` per agent — one `resolveModelConfig` per agent inside the same tx), `apps/api/test/error-surface.test.ts` (unchanged — it must still pass: the service imports `@aesa/crypto` and `@aesa/contracts`, never `@aesa/llm`)

**Interfaces:**
- Consumes: Task 2's inputs; Task 3's tables, `resolveModelConfig`, `managedConfig`; `sealTo`, `getOrgBoxPublicKeyOrNull`, `validateOutboundUrl`, `resolvePublic`; `demoteCategory`; `JOB_NAMES.llmProbe`; `LLM_MAX_CREDENTIALS`, `PROVIDER_PRESETS`, `presetModel`.
- Produces: `LlmServiceDeps = { api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger; resolver?: Resolver; now?: () => Date }`; `LlmActor = { userId; actor; ip?; userAgent? }`; `listCredentials(deps, orgId): Promise<{ credentials: CredentialView[] }>` with `CredentialView = { id, provider, label, baseUrl, keyFingerprint, healthStatus, lastProbe, lastProbedAt, lastError, createdAt, usage30d: { calls, errors, costMicros, costUnknownCalls, lastErrorCode } , agentsUsing: number }`; `addCredential(deps, orgId, input, actor): Promise<{ ok: true; credentialId } | { ok: false; code: 'keys_not_provisioned' | 'cap_reached' | 'unsafe_url' }>`; `probeCredential(deps, orgId, credentialId, actor): Promise<{ ok: true } | { ok: false; code: 'not_found' }>`; `removeCredential(deps, orgId, credentialId, actor): Promise<{ ok: true; agentsReset: number } | { ok: false; code: 'not_found' }>`; `getAgentModel(deps, orgId, agentId): Promise<{ draft: ResolvedModelConfig; triage: ResolvedModelConfig } | null>`; `setAgentModel(deps, orgId, input, actor): Promise<{ ok: true; generationBumped: boolean; demoted: number } | { ok: false; code: 'not_found' | 'credential_not_found' | 'credential_dead' }>`.

- [ ] **Step 1: Failing service tests**

`apps/api/test/llm-service.test.ts` (real database through `createTestApi`; a capturing `enqueue`; `resolver` injected so no DNS is hit):

```ts
describe('llm service', () => {
  it('addCredential (preset): resolves nothing (a preset URL is not re-validated), seals the key to the org box, inserts the row with the fingerprint and health unknown, audits WITHOUT the key, and enqueues llm.probe with the sealed payload and reason connect', …)
     // assert: enqueue called once with name 'llm.probe', data.sealed is base64, data.reason 'connect'; auditLog row action 'llm.credential_added' detail has no 'apiKey'; row.keyFingerprint matches /^[0-9a-f]{8}…[A-Za-z0-9]{4}$/; llm_credential_secrets is EMPTY (the api never writes it)
  it('addCredential (custom): validates the base URL and resolves it publicly BEFORE the transaction — a private resolution is { ok: false, code: unsafe_url } and nothing is inserted', …)
  it('addCredential: the 6th credential is cap_reached; no box key is keys_not_provisioned', …)
  it('probeCredential enqueues llm.probe reason manual; a foreign id is not_found', …)
  it('removeCredential: agents on it go back to managed (both roles), their generation bumps, every auto category demotes with reason model_changed (ONE notification each), the row and its secret are gone, agentsReset counts them', …)
  it('setAgentModel byok: writes draft + triage rows (models default to the preset\'s), bumps generation ONLY when the draft (mode, credential, model) changed, demotes auto categories on that bump and not on an effort-only change; a dead credential is credential_dead', …)
  it('setAgentModel managed after byok: rows go managed with null model/credential, generation bumps, demotion runs', …)
  it('listCredentials: 30-day usage is summed from llm_calls by credential_id (calls, errors, cost, cost_unknown count, last error code) and agentsUsing counts config rows', …)
})
```

- [ ] **Step 2: Implement the service**

Key parts of `apps/api/src/llm/service.ts` (the header spells the discipline: one tx per call, no network inside, the key touches memory only long enough to seal):

```ts
export async function addCredential(deps: LlmServiceDeps, orgId: string, input: AddCredentialInput, actor: LlmActor): Promise<AddCredentialResult> {
  const now = clock(deps)
  const preset = PROVIDER_PRESETS[input.provider]
  let baseUrl: string | null = null
  if (input.provider === 'custom') {
    // Network BEFORE the transaction (CLAUDE.md, Transactions): https + hostname + public resolution.
    try {
      const url = validateOutboundUrl(input.baseUrl!, { allowNonstandardPort: true })
      await resolvePublic(url.hostname, { resolver: deps.resolver })
      baseUrl = url.href.replace(/\/+$/, '')
    } catch (err) {
      deps.logger.warn({ err: (err as Error).message }, 'llm.addCredential: unsafe base URL')
      return { ok: false, code: 'unsafe_url' }
    }
  }
  const fingerprint = `${createHash('sha256').update(input.apiKey).digest('hex').slice(0, 8)}…${input.apiKey.slice(-4)}`
  return deps.api.withOrg(orgId, async (tx) => {
    const boxPublicKey = await getOrgBoxPublicKeyOrNull(tx)
    if (!boxPublicKey) return { ok: false as const, code: 'keys_not_provisioned' as const }
    const [{ n }] = await tx.select({ n: count() }).from(llmCredentials).where(eq(llmCredentials.orgId, orgId))
    if (n >= LLM_MAX_CREDENTIALS) return { ok: false as const, code: 'cap_reached' as const }
    const sealed = await sealTo(boxPublicKey, Buffer.from(JSON.stringify({ apiKey: input.apiKey }), 'utf8'))
    const [row] = await tx.insert(llmCredentials).values({
      orgId, provider: input.provider, label: input.label, baseUrl, keyFingerprint: fingerprint, probeModel: input.probeModel ?? presetModel(input.provider, 'draft'), createdBy: actor.actor,
    }).returning({ id: llmCredentials.id })
    await audit(tx, { actor: actor.actor, action: 'llm.credential_added', entityType: 'llm_credential', entityId: row!.id, detail: { provider: input.provider, label: input.label, fingerprint, baseUrlHost: baseUrl ? new URL(baseUrl).hostname : null }, ip: actor.ip, userAgent: actor.userAgent })
    // The enqueue is the LAST statement, and the sealed blob rides only the payload; a null id (queue
    // missing) is logged loud and the row stays `unknown` — the owner's "Test connection" re-enqueues.
    const jobId = await deps.enqueue(JOB_NAMES.llmProbe, { orgId, credentialId: row!.id, sealed: sealed.toString('base64'), reason: 'connect' }, { entityId: row!.id })
    if (jobId === null) deps.logger.error({ credentialId: row!.id }, 'llm.addCredential: llm.probe enqueue returned null')
    return { ok: true as const, credentialId: row!.id }
  })
}
```

(`sealTo` is libsodium — CPU, not network; the mailboxes connect route already seals inside its transaction the same way.) `setAgentModel`: read the agent (NOT_FOUND across orgs by RLS); when `byok` read the credential (`credential_not_found` / `credential_dead`); compute the two rows' target values (`draftModel ?? presetModel(provider,'draft') ?? credential.probeModel`, `triageModel ?? presetModel(provider,'triage') ?? that`); read the existing draft row; `changed = !existing || existing.mode !== mode || existing.credentialId !== credentialId || existing.model !== draftModel`; upsert both rows (`onConflictDoUpdate` on the `nullsNotDistinct` unique index — target `[orgId, agentId, role]`), with `modelGeneration: changed ? existing.modelGeneration + 1 : existing.modelGeneration` and `modelGenerationAt: changed ? now : existing.modelGenerationAt` on the DRAFT row only; when `changed`: for each `agent_category_policies` row of the agent with `mode = 'auto'` → `demoteCategory(tx, { …, reason: 'model_changed', actor: actor.actor })`, collecting notification ids; audit `agent.model_changed` `{ mode, provider, draftModel, triageModel, effort, fallbackToManaged, generation }`; after the tx, enqueue `notify.dispatch` per id. `removeCredential` reuses the same "reset to managed + bump + demote" routine for every config row on the credential (`resetAgentsToManaged(tx, credentialId, now, actor)`), then deletes the credential (cascade drops the secret — the api CAN delete the parent row; it never touches the child table). `listCredentials`' usage query: `select credential_id, count(*), count(*) filter (where error_code is not null), sum(cost_micros), count(*) filter (where cost_unknown) from llm_calls where org_id = $1 and created_at >= now() - interval '30 days' and credential_id is not null group by credential_id`, plus the newest `error_code` per credential.

- [ ] **Step 3: The router and its test**

`routers/llm.ts` mirrors `routers/memory.ts`: `list: orgProcedure.query`, `add: managerProcedure.input(AddCredentialInput).mutation` (soft codes → `PRECONDITION_FAILED` for `keys_not_provisioned`/`cap_reached`, `BAD_REQUEST` for `unsafe_url`), `probe: managerProcedure.input(CredentialIdInput)`, `remove: managerProcedure.input(CredentialIdInput)` (`NOT_FOUND`), `agentModel: orgProcedure.input(AgentIdInput).query` (`NOT_FOUND`), `setAgentModel: managerProcedure.input(SetAgentModelInput).mutation` (`NOT_FOUND` / `PRECONDITION_FAILED` for `credential_dead`). `llm-router.test.ts`: a member (non-manager) gets `FORBIDDEN` on `add`; the happy path over tRPC returns the list with the new credential and NEVER a field named `apiKey`/`keyCiphertext` (assert `JSON.stringify(list)` does not contain the pasted key); `agentModel` on a fresh agent is `{ draft: managed, triage: managed }`.

- [ ] **Step 4: Run, gate, commit**

```bash
pnpm --filter @aesa/api test
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(api): the llm router and service — provider connections (seal, probe, remove), per-agent model choice with the model_changed demotion, BYOK usage from llm_calls

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: app — Settings → AI (route 25), the agent edit screen's Model card, push routing

**Files:**
- Create: `apps/app/src/app/(app)/settings/ai.tsx` (`export { AiSettingsScreen as default } from '@/screens/settings/ai'`), `apps/app/src/screens/settings/ai.tsx`, `apps/app/src/screens/settings/ai.test.tsx`, `apps/app/src/screens/settings/model-card.tsx`, `apps/app/src/screens/settings/model-card.test.tsx`
- Modify: `apps/app/src/screens/settings/index.tsx` (the AI row gets `onPress={() => router.push('/settings/ai')} testID="settings-ai"` and loses the badge), `apps/app/src/screens/settings/index.test.tsx`, `apps/app/src/screens/settings/agent-edit.tsx` (renders `<ModelCard agentId={id} canManage={…} />` between the reply-from card and Save), `apps/app/src/lib/push-routing.ts` + test (`provider_health` → `/settings/ai`), `apps/app/src/screens/settings/agents.tsx` (each agent row's subtitle appends ` · <Managed AI | label>` from `agents.list`'s new `model` field), every doc pinning 24 routes (`CLAUDE.md`, `docs/STATUS.md`)

**Interfaces:**
- Consumes: `trpc.llm.list/add/probe/remove/agentModel/setAgentModel`, `trpc.agents.list`; `PROVIDER_PRESETS`, `LLM_PROVIDERS`, `LLM_EFFORTS`, `CredentialHealth`, `canManageWorkspace`.
- Produces: `AiSettingsScreen`, `ModelCard` (`{ agentId: string; canManage: boolean }`), the route.

- [ ] **Step 1: Failing screen tests (jest-expo + RNTL, `await render()`, self-contained `jest.mock` factories — the `autopilot.test.tsx` pattern)**

`ai.test.tsx`: (1) renders the Managed AI card with `MANAGED_MODELS.draft`/`.triage` named; (2) an empty connection list shows the empty state and, for a manager, the "Add a provider" button; a plain member sees no button and every control disabled; (3) the add form: picking `openai` hides the base URL field, picking `custom` shows base URL AND the probe-model field, the consent sentence names the preset's `consentName`, the Add button is disabled until label + key (+ URL for custom) are filled, submit calls `llm.add` with the fields and NEVER with a `baseUrl` for a preset; (4) a credential row shows label, provider label, fingerprint, the health chip (`unknown` → "Checking…", `healthy` → "Healthy", `degraded` → "Degraded", `dead` → "Key rejected"), the last-probe summary ("N models · structured output: native"), the 30-day line ("12 calls · $0.03" or "12 calls · cost unknown"), Test and Remove; Remove asks for confirmation and states how many agents fall back to Managed AI; (5) `unsafe_url` from `add` renders "That endpoint can't be reached safely: it must be an https address on the public internet."; (6) the privacy sentence is always visible in the add form ("Email content will be sent to <consentName> under its terms.").

`model-card.test.tsx`: (1) managed default renders the Managed radio checked and no model fields; (2) with one healthy credential, picking it reveals draft/triage model fields prefilled from the preset (`gpt-5` / `gpt-5-mini`), the effort chips (Default / Low / Medium / High) and the fallback switch; (3) a `dead` credential is listed disabled with "Key rejected"; (4) Save calls `llm.setAgentModel` with the exact input and shows the "Autopilot categories go back to Review when the model changes" note BEFORE saving when the draft model differs from the current one; (5) a non-manager gets everything disabled.

- [ ] **Step 2: Build the screens** — `Screen`/`Card`/`ListRow`/`Chip`/`Button`/`TextField`/`SwitchRow`/`Banner` primitives only; radio cards are the `Pressable role="radio"` pattern from `agent-edit.tsx`; the key field is `secureTextEntry` with `autoCapitalize="none"`/`autoCorrect={false}`; every mutation press is pending-guarded; success invalidates `llm.list`/`agents.list`/`llm.agentModel`. Copy must say "provider" and "key" only here and on the Model card — never on onboarding.

- [ ] **Step 3: Run the app tests, the web export, and the route count**

```bash
pnpm --filter @aesa/app test
pnpm --filter @aesa/app export:web 2>&1 | tail -30      # expect 25 routes
```

- [ ] **Step 4: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "feat(app): Settings → AI (provider connections, probe, remove) and the agent Model card; provider_health push routing; 25 routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The Phase 6 E2E against a mock OpenAI-compatible server (every ladder step, a dead key, fallback, the tier cap, the probe), plus the `flags` demotion scenario in the Phase 5 E2E

**Files:**
- Create: `apps/worker/test/helpers/mock-openai.ts`, `apps/worker/test/e2e-phase6.test.ts`
- Modify: `apps/worker/test/e2e-phase5.test.ts` (+ scenario 9)

**Interfaces:**
- Consumes: everything Tasks 3–8 produced; the `e2e-phase5.test.ts` harness (throwaway database, own pg-boss schema `pgboss_e2e6_<hex>`, `createMockMailbox`, `createMeterSink`, `rawSend`, `waitFor`, no wall-clock sleeps); `@aesa/api/llm` (`addCredential`, `setAgentModel`) and `@aesa/api/deps`.
- Produces: `createMockOpenAi(opts: { mode: 'native' | 'json_mode' | 'plain' | 'prose' | 'refusal'; status?: number; models?: string[]; onRequest?: (body) => void }): { fetchFn: typeof fetch; requests: unknown[]; setMode(mode): void }` — a `fetch`-shaped stub answering `/models` and `/chat/completions` in the OpenAI wire shape (NO real socket — the SSRF-pinned real fetch is unit-tested in `@aesa/crypto`; here the resolver's `fetchFn` seam is injected, and the api's `addCredential` takes a `resolver` stub returning a public address).

- [ ] **Step 1: The scenarios (each an `it`, in this order; each asserts through the database, never a mock's internals)**

1. **Connect + probe.** `addCredential` (custom, `https://llm.example.test/v1`, probeModel `qwen3:32b`) with the resolver stub → the row is `unknown`, `llm_credential_secrets` holds a `sealed` blob; the real `llm.probe` job runs → `healthy`, `last_probe.models` = the mock's list, `.structured = 'native'`, the secret is `dek` with `data_key_version 1`, three `llm_calls` rows role `probe` mode `byok` with the credential id, audit `llm.credential_probed`.
2. **BYOK draft, native.** `setAgentModel` (byok, that credential, draft `qwen3:32b`) → the inbound → `ticket.triage` (on the BYOK triage model; `agent_runs` gains a `triage` row with the mock's provider) → `ticket.draft` → `awaiting_review`; `agent_runs.provider = 'custom'`, `.model = 'qwen3:32b'`; `confidence_breakdown` `{ mode: 'byok', tier: 'limited', modelCap: 0.6, model: 0.6, modelRaw: 0.95 }`; `usage_counters` has `llm_cost_micros_byok` and NO `llm_cost_micros` for today; every `llm_calls` row for the run is `byok` + credential id.
3. **Ladder rungs.** Mock in `json_mode` → the next draft's first `llm_calls` row for the draft role is `parse_strategy = 'json_mode'` (the probe is re-run first so the stored override says `json_mode`, and `createByokProvider` then never asks for native); mock in `plain` → `'plain'`; mock in `prose` → `'extract'` with a `:repair` row beside it.
4. **A dead key.** Mock `status: 401` → the draft run fails `llm_auth`, the credential is `dead` with a scrubbed `last_error`, ONE `provider_health` notification (a second inbound the same day adds none), the ticket is `needs_owner` / `provider_unavailable`, and the NEXT inbound for that agent is parked `provider_unavailable` BEFORE any run row (the resolver's refusal), with no `llm_calls` row.
5. **Fallback.** `setAgentModel` with `fallbackToManaged: true` on a fresh credential; mock `status: 500` → the draft lands from the managed fake, `agent_run_events` carries a `call` event with `fallback: true`, the breakdown says `mode: 'managed'`, and the managed meter `llm_cost_micros` moved while the byok one did not.
6. **The cap holds Autopilot.** Category on `auto` at Eager (70) with ten human decisions behind it, the limited-tier draft with grounding 0.9 and model 0.95 → `decision_reason = 'below_threshold'` (evidence 0.54), the ticket `awaiting_review`, no `outbound_sends` row.
7. **Hostile URLs are refused at the api.** `addCredential` for `http://…`, `https://10.0.0.1/v1`, `https://user:pw@host/v1`, and a hostname the stub resolves to `127.0.0.1` → every one `{ ok: false, code: 'unsafe_url' }` and no row.
8. **Removing the credential resets the agent** → `resolveModelConfig` says managed, the auto category is `review` with `demoted_reason = 'model_changed'`, ONE `demotion` notification, the secret row is gone.

`e2e-phase5.test.ts` scenario 9: **two "should not have sent" flags in 30 days demote the category with reason `flags`** — two auto-sends (the scenario-2 path twice), `flagAutoSent` on each → after the second, `agent_category_policies.mode = 'review'`, `demoted_reason = 'flags'`, ONE `demotion` notification, both answers retired at the second strike.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @aesa/worker test test/e2e-phase6.test.ts test/e2e-phase5.test.ts`
Expected: PASS, no wall-clock sleeps, the throwaway database and the pg-boss schema dropped in `afterAll`.

- [ ] **Step 3: Gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check
git add -A && git commit -m "test(worker): the Phase 6 E2E — connect/probe, BYOK drafting on every ladder rung, a dead key, fallback, the tier cap, hostile URLs, credential removal; the flags demotion scenario

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The external-setup runbook, the docs, the whole-branch review record, and the close-out

**Files:**
- Create: `docs/runbooks/2026-09-phase-6-external-setup.md`, `docs/superpowers/reviews/2026-09-1x-phase-6-final-review.md` (dated the day the review runs)
- Modify: `docs/STATUS.md` (the Phase 6 record: what landed, the 13 deviations, rulings, carries closed, carries still open, the `Next: Phase 7` hand-off with the new baseline; the intro's phase count; every "24 routes"), `CLAUDE.md` (the Layout entries for `packages/llm` — two adapters, the plain rung, `probeProvider`, `createByokProvider`; `packages/db` — the four tables and `resolveModelConfig`/`loadModelPricing`; `apps/worker` — `provider-resolver.ts`, `llm.probe`, `llm.reprobe-sweep`; `apps/api` — the `llm` router/service; the Rules: **ten** short queues incl. `llm.probe`, `QUEUE_OPTIONS` as the four-places rule's option source, the KEK ring required in production for `agent`, `llm_credential_secrets` platform-only beside `mailbox_credentials`, the tier cap on the `model` term, BYOK cost's separate meter, "Phase 6 added NO environment variable" (it did not — the KEK ring was already an env; say that), the `openai` runtime dependency; Commands unchanged), `apps/api/.env.example` + `apps/worker/.env.example` (the KEK paragraph now names `agent`; a "Phase 6" trailer like Phase 5's), `docs/superpowers/plans/2026-09-12-phase-6-provider-choice.md` (the Deviations list amended with anything ruled during execution)

- [ ] **Step 1: The runbook** — what CI cannot do: (a) the KEK ring on every `agent` replica (already provisioned for `sync`/`send` — confirm the SAME ring, or a BYOK key sealed under one ring cannot be opened by a replica holding another); (b) a live walk per preset the business will offer first — OpenAI and Anthropic-BYOK at minimum: add a key, watch the probe land `healthy` with a models list, point one agent at `gpt-5`/`gpt-5-mini`, send a real customer email from Gmail and outlook.com, approve from the phone, confirm the reply and the `llm_calls` rows say `byok`; then revoke the key in the provider's console and confirm the `provider_health` push and the `needs_owner` ticket; (c) the `model_pricing` seed re-verified against each provider's price page (the seed carries the plan author's numbers, and a wrong BYOK price only mis-states the owner's dashboard — but say it); (d) the privacy policy / DPA: under BYOK, email content goes to the provider THE CUSTOMER selected under that provider's terms (spec §Launch risks — the screen already says so; the policy must too); (e) a note that a local Ollama/vLLM needs a public https endpoint in v1.

- [ ] **Step 2: STATUS and CLAUDE.md** — follow the Phase 5 record's shape exactly (headings, "Carries CLOSED", "Carries still open", "Next: Phase 7 — billing, caps, launch hardening" with the new baseline numbers taken from the FINAL gate's raw output: tests, skips, routes = 25).

- [ ] **Step 3: The whole-branch review record** — run `superpowers:requesting-code-review` over `main..phase-6` (split by area for a branch this size: llm+crypto / db+worker / api+app / seams, plus one seams reviewer, as Phase 3–5 did); fix Critical and Important findings in a wave; write `docs/superpowers/reviews/<date>-phase-6-final-review.md` (findings, fixes with SHAs, what was left standing and why); point STATUS at it. **This step is part of THIS task, not an afterthought** (the Phase 5 lesson).

- [ ] **Step 4: Final gate, paste the raw output into the review record, commit**

```bash
export S3_ENDPOINT=http://localhost:9000 S3_REGION=us-east-1 S3_BUCKET=aesa-dev S3_ACCESS_KEY_ID=aesa S3_SECRET_ACCESS_KEY=aesaaesa S3_FORCE_PATH_STYLE=true
pnpm typecheck && pnpm lint && pnpm test && pnpm db:check && pnpm --filter @aesa/app export:web && pnpm e2e
git add -A && git commit -m "docs: Phase 6 runbook, STATUS record and Phase 7 hand-off, CLAUDE.md, the whole-branch final review record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then `superpowers:finishing-a-development-branch` — present the menu; never push, merge or open a PR without Robert.

## Self-review against the spec

- **Spec coverage (Phase 6 paragraph):** OpenAI-compatible adapter + presets → Task 4 (+ catalog in Task 2); `llm_credentials` + `org_data_keys` (existing, reused — deviation 1) + `agent_model_config` + `model_pricing` → Task 3; `llm.probe` with capability probes and quality tiers → Tasks 4 (probe), 5 (job), 2 (tiers); pinned-fetch SSRF at every call → Task 4 (`createPinnedFetch`) wired in Task 5's resolver, and at write time in Task 8; Settings → AI (add/probe/remove, per-agent override) → Tasks 8–9; quality-tier confidence caps and graduation bars → Tasks 2, 6, 7; BYOK dashboards from `llm_calls` → Task 8's `listCredentials.usage30d` rendered in Task 9. **Verify list:** drafting E2E against a mock OpenAI-compatible server on every ladder step → Task 10 scenarios 2–3; hostile base URLs refused → Task 4's crypto test (private IP, rebinding, redirect) + Task 10 scenario 7; a dead key routes tickets to Review with the reason → Task 10 scenario 4 (`needs_owner` / `provider_unavailable` — deviation 7 explains "Review" without a draft); contract suite green for both adapters → Task 4 step 9. **§LLM provider adapter items:** `'none'` rung → Task 4; error policy → Task 6 (narrowed, deviation 7); limiter keys `byok:${orgId}:${credentialId}` → Task 4; `withMetering` writes mode/credential/cost_unknown → Tasks 3–4; `fallback_to_managed` → Task 6; `model_generation` → Tasks 3, 7, 8 (deviation 3); the 6-hourly re-probe → Task 5 (deviation 8). **§Launch risks:** the BYOK consent sentence → Task 9; the DPA → Task 11's runbook.
- **Placeholder scan:** Task 1's `QUEUE_OPTIONS` carries `/* copy */` markers by design (the implementer copies the real numbers from the jobs and deletes the markers — the test asserts the shape, and Step 2 says to correct the test to the job's values, never the reverse). No "TBD"/"similar to Task N"; every test block names its assertions; Task 6's job edits are spelled as code or as exact statements of what changes.
- **Type consistency:** `ResolvedModelConfig` (Task 3) is what `ProviderResolver.resolve` returns inside `ResolvedProvider.config` (Task 5) and what `getAgentModel` returns (Task 8); `ProbeResultView` (Task 2) is `probeProvider`'s return (Task 4), `llm_credentials.last_probe`'s shape (Task 3) and `resolveModelConfig`'s downgrade input; `computeEvidence` (Task 6) takes `QualityTier` from `resolveModelConfig.tier`; `MeterRecord.mode/credentialId` are added ONCE (Task 3's one edit outside `packages/db`, reused by Task 4's `withMeta`); `ParseStrategy 'plain'` is added in Task 4 and read by Task 10's scenario 3; `presetModel`/`probeModel` (Tasks 2, 3) feed Task 5's probe and Task 8's defaults; `AddCredentialInput.probeModel` is declared in Task 2 and stored by Task 8.
- **Recipe walk (the Phase 5 lesson):** Task 2's cap example (0.9 × 0.6 = 0.54 < 0.70), Task 6's helper example (max(0.267, 0.9) × 0.6), Task 7's generation-window example (25 excluded + 5 included → 5 < 20), Task 10 scenario 6 (0.54 vs Eager 0.70) — each recomputation is worked once with numbers.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-12-phase-6-provider-choice.md`. Execute with **superpowers:subagent-driven-development** (a fresh implementer per task, a reviewer between tasks, the whole-branch review in Task 11), on branch `phase-6`.
