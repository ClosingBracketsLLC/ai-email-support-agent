/**
 * The `agent` role's job wiring: `ticket.triage` and `ticket.draft`. Split out of `index.ts` so the
 * production-refuses/dev-warns-and-skips gating around a missing `ANTHROPIC_API_KEY` is
 * unit-testable without a real pg-boss instance — `register` is an injectable seam (defaulting to
 * the two real registrars) that tests replace with spies.
 *
 * ONE provider is built for the whole role and handed to BOTH jobs: `createManagedProvider` wraps
 * the raw Anthropic adapter in metering (every rung of the structured-output ladder becomes its own
 * `llm_calls` row), the shared per-model concurrency pool, and the ladder itself. Triage's calls
 * are therefore metered too now — a deliberate change from Phase 2's bare adapter; triage keeps its
 * own `usage_counters` spend guard on top.
 */
import { emptyRetriever } from '@aesa/agent'
import { createManagedProvider } from '@aesa/llm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { createMeterSink, type Db } from '@aesa/db'
import type { WorkerConfig } from './config.ts'
import { registerTicketDraft, type TicketDraftDeps } from './jobs/ticket-draft.ts'
import { registerTicketTriage, type TicketTriageDeps } from './jobs/ticket-triage.ts'

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

/** The two registrars, as one injectable seam. */
export interface AgentRoleRegistrars {
  registerTriage: (boss: PgBoss, deps: TicketTriageDeps) => Promise<void>
  registerDraft: (boss: PgBoss, deps: TicketDraftDeps) => Promise<void>
}

const DEFAULT_REGISTRARS: AgentRoleRegistrars = { registerTriage: registerTicketTriage, registerDraft: registerTicketDraft }

/**
 * Registers `ticket.triage` and `ticket.draft` when `WORKER_ROLES` includes `agent`. A missing
 * `ANTHROPIC_API_KEY`: refuses to start in production (an `agent`-role worker with no model access
 * would sit there looking healthy while silently never drafting anything — better to fail loud at
 * boot), but in dev/test just logs a warning and skips registration so local dev without a key
 * still boots for every other role.
 */
export async function maybeRegisterAgentRole(deps: AgentRoleDeps, register: AgentRoleRegistrars = DEFAULT_REGISTRARS): Promise<void> {
  if (!deps.config.roles.has('agent')) return

  if (!deps.config.anthropicApiKey) {
    if (deps.config.env === 'production') {
      throw new Error('ANTHROPIC_API_KEY is required in production when WORKER_ROLES includes `agent`')
    }
    deps.logger.warn('ANTHROPIC_API_KEY missing; skipping ticket.triage/ticket.draft registration (agent role inactive)')
    return
  }

  const provider = createManagedProvider({ apiKey: deps.config.anthropicApiKey, sink: createMeterSink(deps.db) })
  await register.registerTriage(deps.boss, {
    db: deps.db, provider, logger: deps.logger, enqueueNotify: deps.enqueueNotify, enqueueDraft: deps.enqueueDraft,
  })
  await register.registerDraft(deps.boss, {
    db: deps.db, provider, retriever: emptyRetriever, logger: deps.logger,
    enqueueNotify: deps.enqueueNotify, enqueueDraft: deps.enqueueDraft,
  })
}
