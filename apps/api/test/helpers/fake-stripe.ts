/**
 * A `StripePort` that never leaves the process: every call is recorded, every result is canned, and
 * `constructEvent` verifies by the crudest rule there is (`signature === 'valid'`) so no suite has to
 * mint a real HMAC. The point of the port existing at all is that this file can exist — nothing
 * below `src/billing/service.ts` or `src/billing/webhook.ts` knows what a Stripe SDK is.
 *
 * `rawBodies` is load-bearing, not diagnostic: the webhook suite asserts the EXACT bytes Fastify
 * handed the port, which is the only way to prove the encapsulated parser really kept the string
 * instead of round-tripping it through `JSON.parse`/`JSON.stringify`.
 */
import type { StripeEvent, StripePort } from '../../src/billing/stripe.ts'

export interface StripeCall { method: string; params: unknown }

export interface FakeStripe {
  port: StripePort
  /** Every call in order, newest last. */
  calls: StripeCall[]
  /** The exact `rawBody` string each `constructEvent` saw. */
  rawBodies: string[]
  /** Method names in here throw instead of answering — the `stripe_unavailable` path. */
  failing: Set<keyof StripePort>
  /** Runs (awaited) at the start of the named call — lets a test observe what is COMMITTED mid-flow. */
  onCall: Partial<Record<keyof StripePort, () => Promise<void> | void>>
}

export function createFakeStripe(): FakeStripe {
  const calls: StripeCall[] = []
  const rawBodies: string[] = []
  const failing = new Set<keyof StripePort>()
  const onCall: FakeStripe['onCall'] = {}

  async function enter(method: keyof StripePort, params: unknown): Promise<void> {
    calls.push({ method, params })
    await onCall[method]?.()
    if (failing.has(method)) throw new Error(`stripe: fake failure in ${method}`)
  }

  let seq = 0
  const port: StripePort = {
    async createCustomer(p) {
      await enter('createCustomer', p)
      return { id: `cus_fake_${++seq}` }
    },
    async createCheckoutSession(p) {
      await enter('createCheckoutSession', p)
      return { url: `https://checkout.stripe.test/c/${++seq}` }
    },
    async createPortalSession(p) {
      await enter('createPortalSession', p)
      return { url: `https://portal.stripe.test/p/${++seq}` }
    },
    async cancelSubscription(subscriptionId) {
      await enter('cancelSubscription', { subscriptionId })
    },
    async constructEvent(rawBody, signature) {
      rawBodies.push(rawBody)
      await enter('constructEvent', { signature })
      if (signature !== 'valid') throw new Error('stripe: signature verification failed')
      return JSON.parse(rawBody) as StripeEvent
    },
  }

  return { port, calls, rawBodies, failing, onCall }
}

/** `calls` filtered to one method — the shape every assertion here wants. */
export const callsTo = (fake: FakeStripe, method: keyof StripePort): StripeCall[] =>
  fake.calls.filter((c) => c.method === method)
