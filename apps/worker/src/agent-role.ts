/**
 * The `agent` role's job wiring: `ticket.triage`. Split out of `index.ts` so the production-refuses/
 * dev-warns-and-skips gating around a missing `ANTHROPIC_API_KEY` is unit-testable without a real
 * pg-boss instance — `register` is an injectable seam (defaults to the real `registerTicketTriage`)
 * that tests replace with a spy.
 */
import { createAnthropicProvider } from '@aesa/llm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import type { Db } from '@aesa/db'
import type { WorkerConfig } from './config.ts'
import { registerTicketTriage, type TicketTriageDeps } from './jobs/ticket-triage.ts'

export interface AgentRoleDeps {
  boss: PgBoss
  db: Db
  logger: pino.Logger
  config: WorkerConfig
  /** index.ts wires this to `enqueueNotifyDispatch`, the real `notify.dispatch` enqueue (Task 16). */
  enqueueNotify: TicketTriageDeps['enqueueNotify']
}

/**
 * Registers `ticket.triage` when `WORKER_ROLES` includes `agent`. A missing `ANTHROPIC_API_KEY`:
 * refuses to start in production (an `agent`-role worker with no model access would sit there
 * looking healthy while silently never triaging anything — better to fail loud at boot), but in
 * dev/test just logs a warning and skips registration so local dev without a key still boots for
 * every other role.
 */
export async function maybeRegisterAgentRole(
  deps: AgentRoleDeps,
  register: (boss: PgBoss, jobDeps: TicketTriageDeps) => Promise<void> = registerTicketTriage,
): Promise<void> {
  if (!deps.config.roles.has('agent')) return

  if (!deps.config.anthropicApiKey) {
    if (deps.config.env === 'production') {
      throw new Error('ANTHROPIC_API_KEY is required in production when WORKER_ROLES includes `agent`')
    }
    deps.logger.warn('ANTHROPIC_API_KEY missing; skipping ticket.triage registration (agent role inactive)')
    return
  }

  const provider = createAnthropicProvider({ apiKey: deps.config.anthropicApiKey })
  await register(deps.boss, { db: deps.db, provider, logger: deps.logger, enqueueNotify: deps.enqueueNotify })
}
