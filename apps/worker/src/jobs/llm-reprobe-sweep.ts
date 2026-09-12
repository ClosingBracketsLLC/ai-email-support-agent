/**
 * `llm.reprobe-sweep` — every six hours, re-ask every live BYOK credential whether it still works.
 * A key can be revoked, rotated or rate-limited into uselessness by its owner at any time, and
 * without this the workspace would only find out when a customer's reply failed to draft.
 *
 * `dead` credentials are skipped outright: they already paged their owner, the resolver already
 * refuses them, and re-probing a revoked key every six hours forever buys nothing. One `withPlatform`
 * pass reads the whole platform's due credentials (the same cross-org shape `sweeps.daily` and
 * `mailbox.poll-sweep` use); the enqueues happen AFTER it, never inside a transaction.
 */
import { sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { llmCredentials, withPlatform, type Db } from '@aesa/db'
import { registerCron } from '@aesa/queue'
import { errorMessage } from '../err-message.ts'
import { REPROBE_INTERVAL_HOURS } from './llm-probe.ts'

export interface LlmReprobeSweepDeps {
  db: Db
  logger: pino.Logger
  enqueueProbe: (orgId: string, credentialId: string, opts: { reason: 'scheduled' }) => Promise<unknown>
}

/** Returns how many probes were actually handed to the queue. */
export async function runLlmReprobeSweep(deps: LlmReprobeSweepDeps): Promise<number> {
  const due = await withPlatform(deps.db, 'job:llm.reprobe-sweep', (tx) =>
    tx
      .select({ id: llmCredentials.id, orgId: llmCredentials.orgId })
      .from(llmCredentials)
      .where(sql`${llmCredentials.healthStatus} <> 'dead' and (${llmCredentials.lastProbedAt} is null or ${llmCredentials.lastProbedAt} < now() - interval '${sql.raw(String(REPROBE_INTERVAL_HOURS))} hours')`))

  let enqueued = 0
  for (const row of due) {
    try {
      await deps.enqueueProbe(row.orgId, row.id, { reason: 'scheduled' })
      enqueued += 1
    } catch (err) {
      // One tenant's enqueue failing must not cost every other tenant its re-probe; the next run
      // picks this credential up again, because nothing about it was written.
      deps.logger.warn({ credentialId: row.id, error: errorMessage(err) }, 'llm_reprobe_sweep_enqueue_failed')
    }
  }
  return enqueued
}

export async function registerLlmReprobeSweep(boss: PgBoss, deps: LlmReprobeSweepDeps): Promise<void> {
  await registerCron(
    boss,
    'llm.reprobe-sweep',
    '15 */6 * * *',
    async () => {
      await runLlmReprobeSweep(deps)
    },
    { policy: 'singleton', singletonKey: 'llm.reprobe-sweep', retryLimit: 0, expireInSeconds: 300 },
  )
}
