/**
 * The `agent` role's job wiring: `ticket.triage`, `ticket.draft`, `agent.sandbox`, Phase 5's
 * learning loop (`memory.capture`, `guidance.suggest`) and Phase 6's `llm.probe`. Split out of
 * `index.ts` so the production-refuses/dev-warns-and-skips gating around a missing
 * `ANTHROPIC_API_KEY` (and, for `llm.probe` alone, a missing KEK ring) is unit-testable without a
 * real pg-boss instance — `register` is an injectable seam (defaulting to the six real registrars)
 * that tests replace with spies.
 *
 * ONE embedder, too (Phase 4, extended by Phase 5): `createKnowledgeEmbedder` (Voyage when a key is
 * configured, the hash embedder in dev/test) is built ONCE and shared by the retriever's answers leg
 * AND `memory.capture`'s write — the model that WROTE a workspace's `resolved_answers` vectors must
 * always be the model that queries them (`embedding_model` is part of both legs' WHERE); a second
 * instance here would be a second chance for the two sides to disagree. It is a second INSTANCE from
 * the `knowledge` role's own (the two roles are usually separate replicas), so on a combined
 * `knowledge,agent` replica this call passes `warnOnFallback: false` and the dev fallback is
 * announced once, by the `knowledge` role. The optional reranker rides along under `KNOWLEDGE_RERANK=on`.
 *
 * ONE managed provider is built for the whole role: `createManagedProvider` wraps the raw Anthropic
 * adapter in metering (every rung of the structured-output ladder becomes its own `llm_calls` row),
 * the shared per-model concurrency pool, and the ladder itself. Triage's calls are therefore metered
 * too now — a deliberate change from Phase 2's bare adapter; triage keeps its own `usage_counters`
 * spend guard on top, same as `guidance.suggest`'s own `guidance.daily_suggest_cap` gate.
 *
 * No job receives that provider directly any more (Phase 6). They receive ONE provider RESOLVER:
 * `createProviderResolver` is what turns an agent's model choice into a provider — the managed one
 * above, or the tenant's own key opened under their DEK. It caches a decrypted key per credential
 * and keys that credential's rate budget, so a second instance on the same replica would be a second
 * copy of both; `llm.probe` is handed THIS one precisely so the cache it invalidates is the cache
 * every draft on this replica reads.
 */
import { createManagedProvider, type ModelPricing } from '@aesa/llm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { createMeterSink, type Db } from '@aesa/db'
import { createRetriever } from '@aesa/knowledge'
import type { WorkerConfig } from './config.ts'
import { registerAgentSandbox, type AgentSandboxDeps } from './jobs/agent-sandbox.ts'
import { registerGuidanceSuggest, type GuidanceSuggestDeps } from './jobs/guidance-suggest.ts'
import { registerLlmProbe, type LlmProbeDeps } from './jobs/llm-probe.ts'
import { registerMemoryCapture, type MemoryCaptureDeps } from './jobs/memory-capture.ts'
import { registerTicketDraft, type TicketDraftDeps } from './jobs/ticket-draft.ts'
import { registerTicketTriage, type TicketTriageDeps } from './jobs/ticket-triage.ts'
import { createKnowledgeEmbedder, createKnowledgeReranker } from './knowledge-deps.ts'
import { createProviderResolver } from './provider-resolver.ts'

export interface AgentRoleDeps {
  boss: PgBoss
  db: Db
  logger: pino.Logger
  config: WorkerConfig
  /** index.ts wires this to `enqueueNotifyDispatch`, the real `notify.dispatch` enqueue. */
  enqueueNotify: TicketTriageDeps['enqueueNotify']
  /** index.ts wires this to `enqueueTicketDraft` — triage's hand-off and the job's own `org_busy` retry. */
  enqueueDraft: TicketDraftDeps['enqueueDraft']
  /** index.ts wires this to `enqueueSendExecute` — the auto landing's queued send (Phase 5). */
  enqueueSend: TicketDraftDeps['enqueueSend']
  /** The platform price table (`loadModelPricing` at boot). Undefined — including an EMPTY table —
   *  leaves `withMetering` on its code-seeded `PRICING_SEED`. */
  pricing?: ModelPricing[]
}

/** The six registrars, as one injectable seam. */
export interface AgentRoleRegistrars {
  registerTriage: (boss: PgBoss, deps: TicketTriageDeps) => Promise<void>
  registerDraft: (boss: PgBoss, deps: TicketDraftDeps) => Promise<void>
  registerSandbox: (boss: PgBoss, deps: AgentSandboxDeps) => Promise<void>
  registerMemoryCapture: (boss: PgBoss, deps: MemoryCaptureDeps) => Promise<void>
  registerGuidanceSuggest: (boss: PgBoss, deps: GuidanceSuggestDeps) => Promise<void>
  registerLlmProbe: (boss: PgBoss, deps: LlmProbeDeps) => Promise<void>
}

const DEFAULT_REGISTRARS: AgentRoleRegistrars = {
  registerTriage: registerTicketTriage,
  registerDraft: registerTicketDraft,
  registerSandbox: registerAgentSandbox,
  registerMemoryCapture,
  registerGuidanceSuggest,
  registerLlmProbe,
}

/**
 * Registers all six jobs when `WORKER_ROLES` includes `agent`. Two INDEPENDENT gates decide what
 * each of the two keys buys — and neither of them SKIPS a job any more (Phase 6):
 *
 *  - `ANTHROPIC_API_KEY` (the platform's managed key) is what Managed AI runs on. Missing in
 *    production is still a hard refusal: a replica with no model access would sit there looking
 *    healthy while silently never drafting for the tenants that chose Managed AI. Outside production
 *    it is ONE warning and `managed = null`, and every job still registers — the resolver answers a
 *    BYOK agent normally and refuses a managed one with `no_managed_key`, which each job lands as
 *    `provider_unavailable`. A dev box with only a tenant key is therefore fully functional.
 *  - The KEK ring gates `llm.probe` alone, which opens a tenant's key under the org DEK and needs no
 *    managed provider at all — so a dev box with a ring and no Anthropic key still adds, probes and
 *    re-wraps BYOK credentials.
 */
export async function maybeRegisterAgentRole(deps: AgentRoleDeps, register: AgentRoleRegistrars = DEFAULT_REGISTRARS): Promise<void> {
  if (!deps.config.roles.has('agent')) return

  if (!deps.config.anthropicApiKey && deps.config.env === 'production') {
    throw new Error('ANTHROPIC_API_KEY is required in production when WORKER_ROLES includes `agent`')
  }

  // ONE sink for the role: the managed provider, every BYOK provider the resolver builds and
  // `llm.probe`'s own raw adapter all write their `llm_calls` rows through it.
  const sink = createMeterSink(deps.db, { onError: (err) => deps.logger.warn({ err }, 'llm metering write failed') })
  const provider = deps.config.anthropicApiKey
    ? createManagedProvider({ apiKey: deps.config.anthropicApiKey, sink, ...(deps.pricing ? { pricing: deps.pricing } : {}) })
    : null
  // Phase 6: ONE resolver for the role. It caches a decrypted BYOK key per credential and keys the
  // per-credential rate budget, so a second instance would double both. A null `managed` is a real
  // state, not a bug: it is what makes `resolve` answer `no_managed_key` instead of guessing.
  const providers = createProviderResolver({
    db: deps.db, ring: deps.config.kekRing, managed: provider, sink, logger: deps.logger,
    ...(deps.pricing ? { pricing: deps.pricing } : {}),
  })

  // `llm.probe` needs the ring and NOT the managed provider — it only ever calls the tenant's own
  // endpoint. Registered first, and independently, so a ringed dev box with no Anthropic key can
  // still add and probe a BYOK credential. Production never reaches the else branch: `loadConfig`
  // refuses an `agent` replica without a ring.
  if (deps.config.kekRing) {
    await register.registerLlmProbe(deps.boss, {
      db: deps.db, ring: deps.config.kekRing, sink, logger: deps.logger, enqueueNotify: deps.enqueueNotify,
      resolver: providers, ...(deps.pricing ? { pricing: deps.pricing } : {}),
    })
  } else {
    deps.logger.warn('BYOK disabled: no KEK ring (llm.probe not registered)')
  }

  if (!provider) {
    deps.logger.warn('ANTHROPIC_API_KEY missing: Managed AI is unavailable on this replica; an agent configured for it lands provider_unavailable (BYOK agents are unaffected)')
  }

  // Built ONCE, shared by the retriever AND `memory.capture`: two instances would be two per-model
  // rate budgets and two chances for the write side (memory.capture) and the read side (the
  // retriever's answers leg) to disagree about which model wrote a vector.
  const embedder = createKnowledgeEmbedder(deps.config, deps.logger, { warnOnFallback: !deps.config.roles.has('knowledge') })
  const retriever = createRetriever({
    db: deps.db, embedder, reranker: createKnowledgeReranker(deps.config), logger: deps.logger,
  })
  await register.registerTriage(deps.boss, {
    db: deps.db, providers, logger: deps.logger, enqueueNotify: deps.enqueueNotify, enqueueDraft: deps.enqueueDraft,
  })
  await register.registerDraft(deps.boss, {
    db: deps.db, providers, retriever, logger: deps.logger,
    enqueueNotify: deps.enqueueNotify, enqueueDraft: deps.enqueueDraft, enqueueSend: deps.enqueueSend,
  })
  await register.registerSandbox(deps.boss, { db: deps.db, providers, retriever, logger: deps.logger })
  await register.registerMemoryCapture(deps.boss, { db: deps.db, embedder, logger: deps.logger })
  await register.registerGuidanceSuggest(deps.boss, { db: deps.db, providers, logger: deps.logger })
}
