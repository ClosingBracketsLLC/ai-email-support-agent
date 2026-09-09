import { describe, expect, it } from 'vitest'
import { createMailLimiter } from '../src/limiter.ts'

// The blocked branch of Semaphore.acquire() never resolves on its own — only a matching release()
// unblocks it — so a short real-time wait is a deterministic proof of "still pending," not a race.
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createMailLimiter', () => {
  it('serializes two acquires on the same connection: the second resolves only after the first releases', async () => {
    const limiter = createMailLimiter()

    const release1 = await limiter.acquire('conn-1')
    let acquired2 = false
    const p2 = limiter.acquire('conn-1').then((release) => {
      acquired2 = true
      return release
    })

    await settle()
    expect(acquired2).toBe(false)

    release1()
    const release2 = await p2
    expect(acquired2).toBe(true)
    release2()
  })

  it('different connections proceed concurrently even though each is limited to one in-flight call', async () => {
    const limiter = createMailLimiter({ processConcurrent: 8 })

    const releaseA = await limiter.acquire('conn-a')
    const releaseB = await limiter.acquire('conn-b')
    // both resolved without either releasing — proves they did not serialize against each other
    releaseA()
    releaseB()
  })

  it('caps concurrency process-wide across many connections', async () => {
    const limiter = createMailLimiter({ processConcurrent: 2, perConnectionConcurrent: 1 })

    const release1 = await limiter.acquire('conn-a')
    const release2 = await limiter.acquire('conn-b')

    let acquired3 = false
    const p3 = limiter.acquire('conn-c').then((release) => {
      acquired3 = true
      return release
    })

    await settle()
    expect(acquired3).toBe(false) // both process-wide slots are held by conn-a and conn-b

    release1()
    const release3 = await p3
    expect(acquired3).toBe(true)

    release2()
    release3()
  })

  it('honors a perConnectionConcurrent above 1', async () => {
    const limiter = createMailLimiter({ perConnectionConcurrent: 2, processConcurrent: 8 })

    const release1 = await limiter.acquire('conn-x')
    const release2 = await limiter.acquire('conn-x') // second slot on the same connection: must not block

    let acquired3 = false
    const p3 = limiter.acquire('conn-x').then((release) => {
      acquired3 = true
      return release
    })

    await settle()
    expect(acquired3).toBe(false)

    release1()
    const release3 = await p3
    expect(acquired3).toBe(true)

    release2()
    release3()
  })

  it('a released connection gate can be re-acquired later without leaking cross-connection state', async () => {
    const limiter = createMailLimiter({ perConnectionConcurrent: 1 })
    const release1 = await limiter.acquire('conn-reuse')
    release1()
    // a second, independent acquire on the same id after full release must not block
    const release2 = await limiter.acquire('conn-reuse')
    release2()
  })

  it('release is idempotent: calling it twice does not free an extra slot', async () => {
    const limiter = createMailLimiter({ perConnectionConcurrent: 1, processConcurrent: 1 })
    const release1 = await limiter.acquire('conn-y')
    release1()
    release1() // must not double-free

    let acquired2 = false
    const release2 = await limiter.acquire('conn-y').then((release) => {
      acquired2 = true
      return release
    })
    expect(acquired2).toBe(true)

    let acquired3 = false
    const p3 = limiter.acquire('conn-y').then((release) => {
      acquired3 = true
      return release
    })
    await settle()
    // if release1()'s second call had incremented availability again, this would resolve immediately
    expect(acquired3).toBe(false)

    release2()
    const release3 = await p3
    expect(acquired3).toBe(true)
    release3()
  })
})
