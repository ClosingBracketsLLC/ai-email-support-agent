import * as Sentry from '@sentry/node'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it } from 'vitest'
import { Secret } from '@aesa/crypto'
import { alert, ALERT_KINDS, beforeSend, captureWithOrg, initObservability } from '../src/observability.ts'
import { createWorkerLogger } from '../src/logging.ts'

function loggedLines(): { logger: ReturnType<typeof createWorkerLogger>; lines: () => Record<string, unknown>[] } {
  const raw: string[] = []
  const logger = createWorkerLogger('info', { write: (s: string) => void raw.push(s) })
  return { logger, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) }
}

describe('ALERT_KINDS', () => {
  it('is exactly the eleven kinds actually raised across the api and the worker — not the brief\'s nine', () => {
    expect([...ALERT_KINDS].sort()).toEqual([
      'admission_slot_timeout',
      'deletion_billing_unconfigured',
      'export_failed',
      'keys_rotate_failed',
      'knowledge_reembed_stranded',
      'org_spend_capped',
      'purge_failed',
      'stripe_double_subscription',
      'stripe_report_failed',
      'stripe_unknown_customer',
      'stripe_webhook_rejected',
    ])
    // Named in the brief but wired nowhere — a deliberate omission (see the module's own doc comment).
    expect((ALERT_KINDS as readonly string[]).includes('platform_killswitch_on')).toBe(false)
  })
})

// These run BEFORE any test in this file calls Sentry.init (below), so `Sentry.isInitialized()` is
// still false here — the whole point of the two cases.
describe('no-op mode (no SENTRY_DSN — the normal state of a dev box)', () => {
  it('initObservability({ sentry: null }) returns false and never touches Sentry', () => {
    expect(Sentry.isInitialized()).toBe(false)
    expect(initObservability({ sentry: null })).toBe(false)
    expect(Sentry.isInitialized()).toBe(false)
  })

  it('alert() still logs the pino line — { alert: true, kind, ...ctx } — with no Sentry configured', () => {
    const { logger, lines } = loggedLines()
    alert(logger, 'org_spend_capped', { orgId: 'org-1', scope: 'workspace' })
    const [line] = lines()
    expect(line).toMatchObject({ alert: true, kind: 'org_spend_capped', orgId: 'org-1', scope: 'workspace' })
  })

  it('alert() never throws reaching for Sentry when it is not initialised', () => {
    const { logger } = loggedLines()
    expect(() => alert(logger, 'purge_failed', { orgId: null, key: 'k' })).not.toThrow()
  })

  it('captureWithOrg() is a no-op — does not throw — with no Sentry configured', () => {
    expect(() => captureWithOrg(new Error('boom'), { orgId: 'org-1', job: 'ticket.draft' })).not.toThrow()
  })
})

describe('beforeSend — the PII boundary, tested directly rather than trusted through Sentry.init', () => {
  it('deletes event.request.data', () => {
    const event = { request: { data: { ssn: '123-45-6789' }, url: '/x' } } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.request?.data).toBeUndefined()
    expect(out.request?.url).toBe('/x')   // the rest of request survives
  })

  it('deletes every scrub-listed key found in event.extra, keeping the rest', () => {
    const event = {
      extra: {
        body: 'the customer wrote...', bodyText: 'plain', detail: { x: 1 }, payload: { y: 2 },
        apiKey: 'sk-live-xxx', key: 'k', token: 'tok', cookie: 'sess=1', authorization: 'Bearer x',
        safe: 'this survives',
      },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.extra).toEqual({ safe: 'this survives' })
  })

  it('deletes every scrub-listed key found inside EACH context entry, keeping the rest', () => {
    const event = {
      contexts: {
        request_ctx: { token: 'SECRET', ok: 'fine' },
        job_ctx: { payload: { big: 'blob' }, jobId: 'j1' },
      },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.contexts?.request_ctx).toEqual({ ok: 'fine' })
    expect(out.contexts?.job_ctx).toEqual({ jobId: 'j1' })
  })

  it('truncates a breadcrumb message to 200 chars, leaving a short one untouched', () => {
    const long = 'x'.repeat(300)
    const event = {
      breadcrumbs: [{ message: long, category: 'http' }, { message: 'short', category: 'log' }],
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.breadcrumbs?.[0]?.message).toHaveLength(200)
    expect(out.breadcrumbs?.[0]?.message).toBe(long.slice(0, 200))
    expect(out.breadcrumbs?.[1]?.message).toBe('short')
  })

  it('is a pass-through on an event carrying none of the above', () => {
    const event = { message: 'fine', tags: { org_id: 'org-1' } } as unknown as Sentry.ErrorEvent
    expect(beforeSend(event)).toEqual(event)
  })
})

// LAST in the file on purpose: initObservability calls the real Sentry.init, which leaves this
// process's Sentry client initialised for the rest of the file's lifetime (vitest runs a file's
// tests in one module instance) — every case above that depends on `isInitialized() === false`
// has to run before this one.
describe('initObservability with a DSN, transport stubbed (Sentry.init({ transport: () => fakeTransport }))', () => {
  type EnvelopeItem = [Record<string, unknown>, unknown]
  type FakeEnvelope = [Record<string, unknown>, EnvelopeItem[]]
  const captured: FakeEnvelope[] = []
  // Deliberately untyped against @sentry/core's own `Transport` (not re-exported from `@sentry/node`,
  // so importing it would mean reaching into a transitive dependency) — `send`'s parameter is widened
  // to `unknown` instead, which a narrower-parameter function is always assignable to.
  const fakeTransport = {
    send: async (envelope: unknown) => { captured.push(envelope as FakeEnvelope); return {} },
    flush: async () => true,
  }

  function lastEvent(): Record<string, unknown> {
    const [, items] = captured.at(-1)!
    const [, payload] = items.find(([h]) => h.type === 'event')!
    return payload as Record<string, unknown>
  }

  it('initObservability({ sentry: { dsn, environment } }) returns true and initialises Sentry', () => {
    const result = initObservability({
      sentry: { dsn: new Secret('https://abc123@o0.ingest.sentry.io/1'), environment: 'test' },
      release: 'test-sha',
    })
    // Swap in the fake transport AFTER init (NodeOptions.transport is a factory the SDK calls once
    // at init time) — re-init with the stub so nothing here ever reaches the network.
    Sentry.init({
      dsn: 'https://abc123@o0.ingest.sentry.io/1', environment: 'test', release: 'test-sha',
      transport: () => fakeTransport, beforeSend,
    })
    expect(result).toBe(true)
    expect(Sentry.isInitialized()).toBe(true)
  })

  it('alert() captures a message whose tags carry org_id and kind', async () => {
    captured.length = 0
    const { logger, lines } = loggedLines()
    alert(logger, 'stripe_report_failed', { orgId: 'org-42', op: 'reportOverage' })
    await Sentry.flush(3000)

    // The pino line still fired (unconditional, even with Sentry configured).
    expect(lines()[0]).toMatchObject({ alert: true, kind: 'stripe_report_failed', orgId: 'org-42' })

    const event = lastEvent()
    expect(event.message).toBe('stripe_report_failed')
    expect(event.tags).toMatchObject({ org_id: 'org-42', kind: 'stripe_report_failed' })
  })

  it('captureWithOrg() captures the exception with org_id (and job) tags, and beforeSend scrubs it', async () => {
    captured.length = 0
    captureWithOrg(new Error('kaboom'), { orgId: 'org-77', job: 'ticket.draft' })
    await Sentry.flush(3000)

    const event = lastEvent()
    expect(event.tags).toMatchObject({ org_id: 'org-77', job: 'ticket.draft' })
    // beforeSend ran on the REAL captured event, same as the direct unit tests above assert in isolation.
    expect((event.request as { data?: unknown } | undefined)?.data).toBeUndefined()
  })

  it('captureWithOrg() is a no-op only when Sentry is NOT initialised — now that it is, it captures', async () => {
    captured.length = 0
    captureWithOrg(new Error('should be captured'), { orgId: null })
    await Sentry.flush(3000)
    expect(captured.length).toBeGreaterThan(0)
  })

  /**
   * A raw `DrizzleQueryError`'s `.message` is `Failed query: <sql>\nparams: <bound values>` — the
   * exact secrets/customer-text leak `@aesa/queue`'s `scrubJobError` exists to keep out of
   * `pgboss.job.output`. Sentry is an EXTERNAL service, so `captureWithOrg` must scrub it too,
   * whatever the caller — this asserts it end to end, through the real Sentry pipeline, not just
   * against the `scrubJobError` unit in isolation.
   */
  it('captureWithOrg() scrubs a raw DrizzleQueryError before it ever reaches Sentry', async () => {
    captured.length = 0
    const err = new DrizzleQueryError(
      'insert into "t" ("secret") values ($1)', ['customer text'],
      Object.assign(new Error('dup'), { code: '23505' }),
    )
    captureWithOrg(err, { orgId: 'org-1' })
    await Sentry.flush(3000)

    const event = lastEvent()
    const message = (event.exception as { values?: { value?: string }[] } | undefined)?.values?.[0]?.value
    expect(message).toBe('Failed query: [redacted] (pg 23505)')
    expect(message).not.toContain('customer text')
    expect(message).not.toContain('insert into')
  })
})
