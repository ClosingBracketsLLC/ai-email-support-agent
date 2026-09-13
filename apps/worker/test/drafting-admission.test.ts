/**
 * The managed-draft admission pool against real Postgres. Two REAL pool clients, never a mock: the
 * whole point of the slot being a session-level `pg_try_advisory_lock` is that a second connection —
 * here, a second concurrent `acquire` on the same pool — genuinely cannot take a slot the first one
 * holds, and only a real database can demonstrate that.
 *
 * The waits are deliberately tiny (`waitMs`/`pollMs` overrides) so the suite never sleeps for the
 * production 60 s.
 */
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { createAdmissionPool, noAdmission } from '../src/drafting/admission.ts'

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>

const live = new AbortController().signal

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
  // Warm the pool: the first `connect()` also opens a socket and runs the role's startup options,
  // which would otherwise make the "a second acquire times out" timing a race with TCP.
  await app.db.execute(sql`SELECT 1`)
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})

describe('createAdmissionPool', () => {
  it('one slot: the first acquire holds it, a second waits and gives up, and the release frees it', async () => {
    const admission = createAdmissionPool(app.pool, 1, { waitMs: 200, pollMs: 20 })

    const first = await admission.acquire(live)
    expect(first).not.toBeNull()

    // A second caller on the SAME pool takes a different client and finds slot 0 held.
    const startedAt = Date.now()
    const second = await admission.acquire(live)
    expect(second).toBeNull()
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180)

    await first!.release()

    const third = await admission.acquire(live)
    expect(third).not.toBeNull()
    await third!.release()
  })

  it('two slots: two callers hold one each, and the third is refused until one of them releases', async () => {
    const admission = createAdmissionPool(app.pool, 2, { waitMs: 150, pollMs: 20 })

    const a = await admission.acquire(live)
    const b = await admission.acquire(live)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()

    expect(await admission.acquire(live)).toBeNull()

    await a!.release()
    const c = await admission.acquire(live)
    expect(c).not.toBeNull()

    await b!.release()
    await c!.release()
  })

  it('returns the held client to the pool on release — a slot is never a leaked connection', async () => {
    const admission = createAdmissionPool(app.pool, 1, { waitMs: 50, pollMs: 20 })
    const idleBefore = app.pool.idleCount

    const slot = await admission.acquire(live)
    expect(slot).not.toBeNull()
    expect(app.pool.idleCount).toBe(idleBefore - 1)   // the client is checked OUT while the slot is held

    await slot!.release()

    expect(app.pool.idleCount).toBe(idleBefore)
    // And the lock really is gone, not just the client: a fresh acquire succeeds at once.
    const again = await admission.acquire(live)
    expect(again).not.toBeNull()
    await again!.release()
  })

  it('returns the client on a TIMED-OUT acquire too', async () => {
    const admission = createAdmissionPool(app.pool, 1, { waitMs: 60, pollMs: 20 })
    const held = await admission.acquire(live)
    const idleWhileHeld = app.pool.idleCount

    expect(await admission.acquire(live)).toBeNull()

    expect(app.pool.idleCount).toBe(idleWhileHeld)
    await held!.release()
  })

  it('a second release() is a no-op — a `finally` that runs twice must not double-unlock', async () => {
    const admission = createAdmissionPool(app.pool, 1, { waitMs: 50, pollMs: 20 })
    const slot = await admission.acquire(live)
    const idleBefore = app.pool.idleCount

    await slot!.release()
    await slot!.release()

    expect(app.pool.idleCount).toBe(idleBefore + 1)
  })

  it('an already-aborted signal returns null AT ONCE, without checking a client out', async () => {
    const admission = createAdmissionPool(app.pool, 4, { waitMs: 10_000, pollMs: 20 })
    const idleBefore = app.pool.idleCount
    const aborted = AbortSignal.abort()

    const startedAt = Date.now()
    expect(await admission.acquire(aborted)).toBeNull()

    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(app.pool.idleCount).toBe(idleBefore)
  })

  it('an abort DURING the wait cuts it short rather than sitting out the full budget', async () => {
    const admission = createAdmissionPool(app.pool, 1, { waitMs: 10_000, pollMs: 20 })
    const held = await admission.acquire(live)
    const controller = new AbortController()

    const startedAt = Date.now()
    setTimeout(() => controller.abort(), 60)
    expect(await admission.acquire(controller.signal)).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(2_000)

    await held!.release()
  })

  it('slots = 0 is `noAdmission`: acquire resolves immediately with a no-op release', async () => {
    const off = createAdmissionPool(app.pool, 0)
    const idleBefore = app.pool.idleCount

    const slot = await off.acquire(live)

    expect(slot).not.toBeNull()
    expect(app.pool.idleCount).toBe(idleBefore)   // no client was ever taken
    await expect(slot!.release()).resolves.toBeUndefined()
  })

  it('noAdmission itself always admits', async () => {
    const slot = await noAdmission.acquire(AbortSignal.abort())
    expect(slot).not.toBeNull()
    await slot!.release()
  })
})
