import type PgBoss from 'pg-boss'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineJob, registerJob } from '../src/define-job.ts'
import { enqueue } from '../src/enqueue.ts'
import { notifyJobFailure, setJobObserver } from '../src/observe.ts'
import { deleteAllJobs, queryJobs, startTestBoss, uniqueName } from './helpers/boss.ts'

describe('notifyJobFailure / setJobObserver', () => {
  afterEach(() => setJobObserver(null))

  it('forwards to the set observer with the given ctx', () => {
    const calls: { err: unknown; ctx: { name: string; jobId: string; orgId: string | null } }[] = []
    setJobObserver({ onFailure: (err, ctx) => calls.push({ err, ctx }) })
    const err = new Error('boom')
    notifyJobFailure(err, { name: 'x.y', jobId: 'job-1', orgId: 'org-1' })
    expect(calls).toEqual([{ err, ctx: { name: 'x.y', jobId: 'job-1', orgId: 'org-1' } }])
  })

  it('is a no-op — never throws — with no observer set', () => {
    setJobObserver(null)
    expect(() => notifyJobFailure(new Error('boom'), { name: 'x.y', jobId: 'job-1', orgId: null })).not.toThrow()
  })

  it("swallows an observer that itself throws — the job's own failure path must never be interrupted by it", () => {
    setJobObserver({ onFailure: () => { throw new Error('observer exploded') } })
    expect(() => notifyJobFailure(new Error('boom'), { name: 'x.y', jobId: 'job-1', orgId: null })).not.toThrow()
  })

  describe('registerJob wiring, with a real boss', () => {
    let boss: PgBoss
    beforeAll(async () => { boss = await startTestBoss() })
    afterAll(async () => { await boss.stop({ graceful: false, wait: true }) })

    it('a throwing handler notifies the observer with { name, jobId, orgId } and STILL fails the job (the scrubbed error rethrown)', async () => {
      const name = uniqueName('test.observe')
      const orgId = crypto.randomUUID()
      const calls: { err: unknown; ctx: { name: string; jobId: string; orgId: string | null } }[] = []
      setJobObserver({ onFailure: (err, ctx) => calls.push({ err, ctx }) })
      const def = defineJob({
        name, schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds: 60, retryLimit: 0 },
        handler: async () => { throw new Error('handler exploded') },
      })
      try {
        await registerJob(boss, def, { pollingIntervalSeconds: 0.5 })
        await enqueue(boss, def, { orgId }, { entityId: 'e' })

        await vi.waitFor(() => { expect(calls).toHaveLength(1) }, { timeout: 10_000 })
        expect(calls[0]!.ctx.name).toBe(name)
        expect(calls[0]!.ctx.orgId).toBe(orgId)
        expect(typeof calls[0]!.ctx.jobId).toBe('string')
        expect((calls[0]!.err as Error).message).toBe('handler exploded')

        // The observer's own view never affects what pg-boss records: the job still lands 'failed'.
        await vi.waitFor(async () => {
          const rows = await queryJobs(name)
          expect(rows.some((r) => r.state === 'failed')).toBe(true)
        }, { timeout: 10_000 })
      } finally {
        await deleteAllJobs(name)
        await boss.deleteQueue(name)
      }
    }, 20_000)

    /**
     * A raw `DrizzleQueryError`'s `.message` is `Failed query: <sql>\nparams: <bound values>` —
     * exactly the customer text / secrets `scrubJobError` exists to keep out of `pgboss.job.output`
     * (CLAUDE.md Secrets). The OBSERVER is the worker's real Sentry wiring in production — an
     * EXTERNAL service — so it must see the SAME scrubbed error `registerJob` is about to rethrow,
     * never the raw one, even though the observer callback runs BEFORE the throw.
     */
    it('a thrown DrizzleQueryError reaches the observer ALREADY scrubbed — never its raw SQL/params', async () => {
      const name = uniqueName('test.observe-scrub')
      const calls: { err: unknown }[] = []
      setJobObserver({ onFailure: (err) => calls.push({ err }) })
      const def = defineJob({
        name, schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds: 60, retryLimit: 0 },
        handler: async () => {
          throw new DrizzleQueryError(
            'insert into "t" ("secret") values ($1)', ['customer text'],
            Object.assign(new Error('dup'), { code: '23505' }),
          )
        },
      })
      try {
        await registerJob(boss, def, { pollingIntervalSeconds: 0.5 })
        await enqueue(boss, def, { orgId: crypto.randomUUID() }, { entityId: 'e' })

        await vi.waitFor(() => { expect(calls).toHaveLength(1) }, { timeout: 10_000 })
        const seen = calls[0]!.err as Error
        expect(seen.message).toBe('Failed query: [redacted] (pg 23505)')
        expect(seen.message).not.toContain('customer text')
        expect(seen.message).not.toContain('insert into')
      } finally {
        await deleteAllJobs(name)
        await boss.deleteQueue(name)
      }
    }, 20_000)

    it('no observer set: registerJob still fails the job, and the missing observer never throws', async () => {
      setJobObserver(null)
      const name = uniqueName('test.observe-none')
      const def = defineJob({
        name, schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds: 60, retryLimit: 0 },
        handler: async () => { throw new Error('handler exploded') },
      })
      try {
        await registerJob(boss, def, { pollingIntervalSeconds: 0.5 })
        await enqueue(boss, def, { orgId: crypto.randomUUID() }, { entityId: 'e' })

        await vi.waitFor(async () => {
          const rows = await queryJobs(name)
          expect(rows.some((r) => r.state === 'failed')).toBe(true)
        }, { timeout: 10_000 })
      } finally {
        await deleteAllJobs(name)
        await boss.deleteQueue(name)
      }
    }, 20_000)
  })
})
