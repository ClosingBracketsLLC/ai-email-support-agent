import type PgBoss from 'pg-boss'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { JOB_SIGNAL_MARGIN_SECONDS } from '@aesa/core'
import { defineJob, registerJob, scrubJobError } from '../src/define-job.ts'
import { enqueue } from '../src/enqueue.ts'
import { JOB_NAMES } from '../src/names.ts'
import { QUEUE_OPTIONS } from '../src/queue-options.ts'
import { deleteAllJobs, queryJobs, startTestBoss, uniqueName } from './helpers/boss.ts'

describe('defineJob / enqueue', () => {
  it('refuses a schema without orgId at definition time', () => {
    expect(() => defineJob({ name: 'x', schema: z.object({ ticketId: z.string() }) as never, queue: { expireInSeconds: 60 }, handler: async () => {} }))
      .toThrow(/orgId/)
  })

  it('refuses expireInSeconds at or below the signal margin', () => {
    expect(() => defineJob({ name: 'x', schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds: JOB_SIGNAL_MARGIN_SECONDS }, handler: async () => {} }))
      .toThrow(/expireInSeconds/)
  })

  it('resolves a JOB_NAMES name with no `queue` from QUEUE_OPTIONS', () => {
    // The whole point of the table: a job file that names a real queue and passes no options gets
    // that queue's options, `policy: 'short'` included — pg-boss's singleton index depends on it.
    const def = defineJob({ name: JOB_NAMES.ticketDraft, schema: z.object({ orgId: z.uuid() }), handler: async () => {} })
    expect(def.queue).toEqual(QUEUE_OPTIONS[JOB_NAMES.ticketDraft])
    expect(def.queue.policy).toBe('short')
  })

  it('refuses a name that is in neither QUEUE_OPTIONS nor the call', () => {
    expect(() => defineJob({ name: 'nope.unknown', schema: z.object({ orgId: z.uuid() }), handler: async () => {} }))
      .toThrow(/no queue options/)
  })

  it('registerJob scrubs a DrizzleQueryError before pg-boss records it', () => {
    const err = new DrizzleQueryError('insert into "t" ("secret") values ($1)', ['customer text'], Object.assign(new Error('dup'), { code: '23505' }))
    const scrubbed = scrubJobError(err) as Error
    expect(scrubbed.message).toBe('Failed query: [redacted] (pg 23505)')
    expect(scrubbed.message).not.toContain('customer text')
    expect(scrubJobError(new Error('plain'))).toEqual(new Error('plain'))
  })

  it('enqueue validates the payload and sets the org-scoped singletonKey', async () => {
    const def = defineJob({ name: 'test.enq', schema: z.object({ orgId: z.uuid(), ticketId: z.string() }), queue: { expireInSeconds: 60 }, handler: async () => {} })
    const boss = { send: vi.fn().mockResolvedValue('job-1') } as unknown as PgBoss
    const orgId = crypto.randomUUID()
    await enqueue(boss, def, { orgId, ticketId: 't1' }, { entityId: 't1', priority: 5 })
    expect(boss.send).toHaveBeenCalledWith('test.enq', { orgId, ticketId: 't1' }, expect.objectContaining({ singletonKey: `${orgId}:t1`, priority: 5 }))
    await expect(enqueue(boss, def, { ticketId: 't1' } as never, { entityId: 't1' })).rejects.toThrow(/orgId/)
  })

  describe('with a real boss', () => {
    let boss: PgBoss
    beforeAll(async () => { boss = await startTestBoss() })
    afterAll(async () => { await boss.stop({ graceful: false, wait: true }) })

    it('hands the handler an AbortSignal whose deadline is expireInSeconds - JOB_SIGNAL_MARGIN_SECONDS', async () => {
      const name = uniqueName('test.signal')
      const expireInSeconds = JOB_SIGNAL_MARGIN_SECONDS + 2                 // 2 s of handler time
      let observed: { aborted: boolean; elapsedMs: number } | null = null
      const done = new Promise<void>((resolve) => {
        const def = defineJob({
          name, schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds, retryLimit: 0 },
          handler: async ({ signal }) => {
            const startedAt = Date.now()
            await new Promise<void>((r) => { signal.addEventListener('abort', () => r(), { once: true }); setTimeout(r, 8_000) })
            observed = { aborted: signal.aborted, elapsedMs: Date.now() - startedAt }
            resolve()
          },
        })
        registerJob(boss, def, { pollingIntervalSeconds: 0.5 }).then(() => enqueue(boss, def, { orgId: crypto.randomUUID() }, { entityId: 'e' }))
      })
      await done
      try {
        const seen = observed as unknown as { aborted: boolean; elapsedMs: number }
        expect(seen.aborted).toBe(true)                                     // not the 8 s fallback
        expect(seen.elapsedMs).toBeGreaterThan((expireInSeconds - JOB_SIGNAL_MARGIN_SECONDS) * 1000 - 500)
        expect(seen.elapsedMs).toBeLessThan((expireInSeconds - JOB_SIGNAL_MARGIN_SECONDS) * 1000 + 1500)
      } finally {
        await deleteAllJobs(name)
        await boss.deleteQueue(name)
      }
    }, 20_000)

    it('fails a zod-invalid payload permanently instead of retrying it', async () => {
      // boss.fail() is not an option here: pg-boss's fail SQL re-inserts a job with retry_count < retry_limit
      // as 'retry', so a fresh job (retryLimit: 3) would be retried — and fail identically — up to 3 times
      // before finally reaching 'failed'. registerJob instead deletes the job outright on the first sight of
      // an invalid payload, so this asserts deletion (no row left, handler never invoked), not a 'failed' row.
      const name = uniqueName('invalid')
      const calls: unknown[] = []
      const def = defineJob({
        name,
        schema: z.object({ orgId: z.uuid(), n: z.number() }),
        queue: { expireInSeconds: 60, retryLimit: 3 },
        handler: async ({ data }) => { calls.push(data) },
      })
      try {
        await registerJob(boss, def, { pollingIntervalSeconds: 0.5 })
        // bypass enqueue()'s validation: send a raw, schema-violating payload
        await boss.send(name, { orgId: 'not-a-uuid', n: 'NaN' })
        await vi.waitFor(async () => {
          const rows = await queryJobs(name)
          expect(rows).toHaveLength(0)
        })
        expect(calls).toHaveLength(0)
      } finally {
        await deleteAllJobs(name)
        await boss.deleteQueue(name)
      }
    }, 20_000)
  })
})
