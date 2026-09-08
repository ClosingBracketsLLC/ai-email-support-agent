import type PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineJob, registerJob } from '../src/define-job.ts'
import { enqueue } from '../src/enqueue.ts'
import { deleteAllJobs, startTestBoss, uniqueName } from './helpers/boss.ts'

describe('defineJob / enqueue', () => {
  it('refuses a schema without orgId at definition time', () => {
    expect(() => defineJob({ name: 'x', schema: z.object({ ticketId: z.string() }) as never, queue: { expireInSeconds: 60 }, handler: async () => {} }))
      .toThrow(/orgId/)
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

    it('hands the handler an AbortSignal that fires at expireInSeconds - 30', async () => {
      const name = uniqueName('test.signal')
      let observed: { aborted: boolean } | null = null
      const done = new Promise<void>((resolve) => {
        const def = defineJob({
          name, schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds: 31, retryLimit: 0 },
          handler: async ({ signal }) => {
            await new Promise<void>((r) => { signal.addEventListener('abort', () => r(), { once: true }); setTimeout(r, 5_000) })
            observed = { aborted: signal.aborted }
            resolve()
          },
        })
        registerJob(boss, def, { pollingIntervalSeconds: 0.5 }).then(() => enqueue(boss, def, { orgId: crypto.randomUUID() }, { entityId: 'e' }))
      })
      await done
      expect(observed).toEqual({ aborted: true })       // aborted after ~1 s, well before the 5 s fallback
      await deleteAllJobs(name); await boss.deleteQueue(name)
    }, 15_000)
  })
})
