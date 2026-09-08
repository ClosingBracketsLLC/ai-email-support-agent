import type PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { JOB_SIGNAL_MARGIN_SECONDS } from '@aesa/core'
import { defineJob, registerJob } from '../src/define-job.ts'
import { enqueue } from '../src/enqueue.ts'
import { deleteAllJobs, startTestBoss, uniqueName } from './helpers/boss.ts'

describe('defineJob / enqueue', () => {
  it('refuses a schema without orgId at definition time', () => {
    expect(() => defineJob({ name: 'x', schema: z.object({ ticketId: z.string() }) as never, queue: { expireInSeconds: 60 }, handler: async () => {} }))
      .toThrow(/orgId/)
  })

  it('refuses expireInSeconds at or below the signal margin', () => {
    expect(() => defineJob({ name: 'x', schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds: JOB_SIGNAL_MARGIN_SECONDS }, handler: async () => {} }))
      .toThrow(/expireInSeconds/)
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
  })
})
