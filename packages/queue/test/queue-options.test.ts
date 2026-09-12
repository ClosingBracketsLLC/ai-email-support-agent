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
    expect(queueOptionsFor(JOB_NAMES.ticketDraft)).toEqual({ name: 'ticket.draft', policy: 'short', expireInSeconds: 600, retryLimit: 1, retryDelay: 30, retryBackoff: true })
    expect(queueOptionsFor(JOB_NAMES.ticketTriage)).toMatchObject({ name: 'ticket.triage', policy: 'standard' })
  })
})
