/**
 * The `agent` role's job wiring: `ticket.triage`, `ticket.draft` and `agent.sandbox`. Split out of
 * `index.ts` so the production-refuses/dev-warns-and-skips gating around a missing
 * `ANTHROPIC_API_KEY` is unit-testable without a real pg-boss instance — `register` is an
 * injectable seam (defaulting to the three real registrars) that tests replace with spies.
 *
 * ONE retriever, too (Phase 4): `createRetriever` over the SAME embedder `createKnowledgeDeps`
 * builds for the `knowledge` role (`createKnowledgeEmbedder` — Voyage when a key is configured, the
 * hash embedder in dev/test), so the model that WROTE a workspace's vectors is always the model that
 * queries them; `embedding_model` is part of the vector leg's WHERE, and a mismatch would silently
 * return nothing from it. The optional reranker rides along under `KNOWLEDGE_RERANK=on`.
 *
 * ONE provider is built for the whole role and handed to ALL THREE jobs: `createManagedProvider`
 * wraps the raw Anthropic adapter in metering (every rung of the structured-output ladder becomes
 * its own `llm_calls` row), the shared per-model concurrency pool, and the ladder itself. Triage's
 * calls are therefore metered too now — a deliberate change from Phase 2's bare adapter; triage
 * keeps its own `usage_counters` spend guard on top.
 */
import { createManagedProvider } from '@aesa/llm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { createMeterSink, type Db } from '@aesa/db'
import { createRetriever } from '@aesa/knowledge'
import type { WorkerConfig } from './config.ts'
import { registerAgentSandbox, type AgentSandboxDeps } from './jobs/agent-sandbox.ts'
import { registerTicketDraft, type TicketDraftDeps } from './jobs/ticket-draft.ts'
import { registerTicketTriage, type TicketTriageDeps } from './jobs/ticket-triage.ts'
import { createKnowledgeEmbedder, createKnowledgeReranker } from './knowledge-deps.ts'

export interface AgentRoleDeps {
  boss: PgBoss
  db: Db
  logger: pino.Logger
  config: WorkerConfig
  /** index.ts wires this to `enqueueNotifyDispatch`, the real `notify.dispatch` enqueue. */
  enqueueNotify: TicketTriageDeps['enqueueNotify']
  /** index.ts wires this to `enqueueTicketDraft` — triage's hand-off and the job's own `org_busy` retry. */
  enqueueDraft: TicketDraftDeps['enqueueDraft']
}

/** The three registrars, as one injectable seam. */
export interface AgentRoleRegistrars {
  registerTriage: (boss: PgBoss, deps: TicketTriageDeps) => Promise<void>
  registerDraft: (boss: PgBoss, deps: TicketDraftDeps) => Promise<void>
  registerSandbox: (boss: PgBoss, deps: AgentSandboxDeps) => Promise<void>
}

const DEFAULT_REGISTRARS: AgentRoleRegistrars = {
  registerTriage: registerTicketTriage,
  registerDraft: registerTicketDraft,
  registerSandbox: registerAgentSandbox,
}

/**
 * Registers `ticket.triage`, `ticket.draft` and `agent.sandbox` when `WORKER_ROLES` includes
 * `agent`. A missing `ANTHROPIC_API_KEY`: refuses to start in production (an `agent`-role worker
 * with no model access would sit there looking healthy while silently never drafting anything —
 * better to fail loud at boot), but in dev/test just logs a warning and skips registration so
 * local dev without a key still boots for every other role.
 */
export async function maybeRegisterAgentRole(deps: AgentRoleDeps, register: AgentRoleRegistrars = DEFAULT_REGISTRARS): Promise<void> {
  if (!deps.config.roles.has('agent')) return

  if (!deps.config.anthropicApiKey) {
    if (deps.config.env === 'production') {
      throw new Error('ANTHROPIC_API_KEY is required in production when WORKER_ROLES includes `agent`')
    }
    deps.logger.warn('ANTHROPIC_API_KEY missing; skipping ticket.triage/ticket.draft/agent.sandbox registration (agent role inactive)')
    return
  }

  const provider = createManagedProvider({
    apiKey: deps.config.anthropicApiKey,
    sink: createMeterSink(deps.db, { onError: (err) => deps.logger.warn({ err }, 'llm metering write failed') }),
  })
  // Built ONCE, shared by draft and sandbox: an embedder per job would be two per-model rate
  // budgets and two chances to disagree about the model.
  const retriever = createRetriever({
    db: deps.db,
    embedder: createKnowledgeEmbedder(deps.config, deps.logger),
    reranker: createKnowledgeReranker(deps.config),
    logger: deps.logger,
  })
  await register.registerTriage(deps.boss, {
    db: deps.db, provider, logger: deps.logger, enqueueNotify: deps.enqueueNotify, enqueueDraft: deps.enqueueDraft,
  })
  await register.registerDraft(deps.boss, {
    db: deps.db, provider, retriever, logger: deps.logger,
    enqueueNotify: deps.enqueueNotify, enqueueDraft: deps.enqueueDraft,
  })
  await register.registerSandbox(deps.boss, { db: deps.db, provider, retriever, logger: deps.logger })
}
