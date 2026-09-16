/**
 * A `StripeUsagePort` that never leaves the process: every call is recorded in order and every
 * result is canned. The port exists precisely so this file can exist — nothing in
 * `src/billing/report-usage.ts` knows what a Stripe SDK is, so the whole cron is drivable with no
 * network and no fixtures. (The api's `test/helpers/fake-stripe.ts` is the same idea for its half.)
 */
import type { StripeUsagePort } from '../../src/billing/stripe.ts'

export interface UsageCall { method: keyof StripeUsagePort; params: unknown }

export interface FakeStripeUsage {
  port: StripeUsagePort
  /** Every call in order, newest last. */
  calls: UsageCall[]
  /** Method names in here throw instead of answering — the reporting-failed path. */
  failing: Set<keyof StripeUsagePort>
}

export function createFakeStripeUsage(): FakeStripeUsage {
  const calls: UsageCall[] = []
  const failing = new Set<keyof StripeUsagePort>()

  async function enter(method: keyof StripeUsagePort, params: unknown): Promise<void> {
    calls.push({ method, params })
    // The shape the REAL port throws: a plain Error with a scrubbed sentence, never an SDK object.
    if (failing.has(method)) throw new Error(`stripe: ${method} failed: fake failure`)
  }

  const port: StripeUsagePort = {
    reportOverage: (p) => enter('reportOverage', p),
    setDomainQuantity: (p) => enter('setDomainQuantity', p),
  }

  return { port, calls, failing }
}

/** `calls` filtered to one method — the shape every assertion here wants. */
export const usageCallsTo = (fake: FakeStripeUsage, method: keyof StripeUsagePort): UsageCall[] =>
  fake.calls.filter((c) => c.method === method)
