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
  it('is exactly the twelve kinds actually raised across the api and the worker — the eleven Tasks 4–8 left plus the fix wave\'s foreign-subscription alert (R31)', () => {
    expect([...ALERT_KINDS].sort()).toEqual([
      'admission_slot_timeout',
      'deletion_billing_unconfigured',
      'export_failed',
      'keys_rotate_failed',
      'knowledge_reembed_stranded',
      'org_spend_capped',
      'purge_failed',
      'stripe_double_subscription',
      'stripe_foreign_subscription_event',
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
  })

  /**
   * Critical 2: `requestDataIntegration` (a default integration) copies `request.headers` onto the
   * event UNFILTERED — its own filtering helper only applies on the span path, not the event one —
   * so a captured api error would otherwise hand Sentry the live Better Auth session cookie
   * verbatim. `request.cookies` is a second, parsed copy of the same thing. Both must go, and a
   * harmless header must survive so this isn't a "delete everything" test in disguise.
   */
  it('deletes request.cookies and strips sensitive request.headers, keeping harmless ones', () => {
    const event = {
      request: {
        headers: { cookie: 'better-auth.session_token=SECRET', authorization: 'Bearer SECRET', 'x-api-key': 'sk-1', 'user-agent': 'curl/8' },
        cookies: { 'better-auth.session_token': 'SECRET' },
      },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.request?.cookies).toBeUndefined()
    expect(out.request?.headers?.cookie).toBeUndefined()
    expect(out.request?.headers?.authorization).toBeUndefined()
    expect(out.request?.headers?.['x-api-key']).toBeUndefined()
    expect(out.request?.headers?.['user-agent']).toBe('curl/8')
  })

  /**
   * Fix round 2: header NAME filtering alone misses this — `referer`/`origin` are not sensitive
   * header NAMES, but a `referer` following navigation from `/a/:draftId?t=<token>` carries that
   * token verbatim in its VALUE. `@aesa/core`'s `redactHeaders` now runs every surviving header
   * value through `redactText`, same as `request.url`.
   */
  it('redacts the action token out of a referer header VALUE, not only the sensitive-named headers', () => {
    const event = {
      request: { headers: { referer: 'https://app.example.com/a/draft-123?t=SECRET_ACTION_TOKEN', 'user-agent': 'curl/8' } },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.request?.headers?.referer).not.toContain('SECRET_ACTION_TOKEN')
    expect(out.request?.headers?.referer).toBe('https://app.example.com/a/draft-123?t=[redacted]')
    expect(out.request?.headers?.['user-agent']).toBe('curl/8')   // an ordinary value survives untouched
  })

  /**
   * Critical 2: the `/a/:draftId?t=` one-click review link's `t` query param IS the credential that
   * approves and sends a customer reply — `request.url` and `request.query_string` both carry it on
   * a captured review-route error, and `withIsolationScope` forking means this reaches
   * `captureWithOrg`'s events too, not only Fastify's own `onError` path.
   */
  it('redacts the action token out of request.url and request.query_string, in every QueryParams shape', () => {
    const asString = beforeSend({
      request: { url: '/a/draft-123?t=SECRET_ACTION_TOKEN', query_string: 't=SECRET_ACTION_TOKEN' },
    } as unknown as Sentry.ErrorEvent)
    expect(asString.request?.url).not.toContain('SECRET_ACTION_TOKEN')
    expect(asString.request?.url).toBe('/a/draft-123?t=[redacted]')
    expect(asString.request?.query_string).toBe('t=[redacted]')

    const asObject = beforeSend({
      request: { query_string: { t: 'SECRET_ACTION_TOKEN' } },
    } as unknown as Sentry.ErrorEvent)
    expect(JSON.stringify(asObject.request?.query_string)).not.toContain('SECRET_ACTION_TOKEN')
    expect(asObject.request?.query_string).toEqual({ t: '[redacted]' })

    const asPairs = beforeSend({
      request: { query_string: [['t', 'SECRET_ACTION_TOKEN']] },
    } as unknown as Sentry.ErrorEvent)
    expect(JSON.stringify(asPairs.request?.query_string)).not.toContain('SECRET_ACTION_TOKEN')
    expect(asPairs.request?.query_string).toEqual([['t', '[redacted]']])
  })

  /**
   * Critical 1: by the time an event reaches `beforeSend`, Sentry has already turned the thrown
   * Error into a plain `{ type, value }` pair — there is no `instanceof DrizzleQueryError` left to
   * check, only the `.message` STRING, which for a real `DrizzleQueryError` is exactly
   * `Failed query: <sql>\nparams: <bound values>` (for `drafts`, that bound value can be
   * `final_body`: customer reply text). This is the event-level backstop for every path into
   * Sentry that does NOT go through `captureWithOrg` at all — Fastify's own `onError` hook and the
   * default `onUncaughtException`/`onUnhandledRejection` integrations both call
   * `Sentry.captureException` on the raw error directly.
   */
  it("redacts a 'Failed query:' exception value the same way the local log path already does", () => {
    const event = {
      exception: {
        values: [{
          type: 'DrizzleQueryError',
          value: 'Failed query: insert into "drafts" ("final_body") values ($1)\nparams: Dear customer, here is our refund policy...',
        }],
      },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    const message = out.exception?.values?.[0]?.value
    expect(message).toBe('Failed query: [redacted]')
    expect(message).not.toContain('refund policy')
  })

  it('masks a bare URL found inside any other exception message (the same redactText rule, not only "Failed query:")', () => {
    const event = {
      exception: { values: [{ type: 'Error', value: 'fetch failed: https://example.com/x?token=SECRET123456789012345678901234' }] },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.exception?.values?.[0]?.value).not.toContain('SECRET123456789012345678901234')
  })

  it('deletes every scrub-listed key found in event.extra, case-insensitively, keeping the rest', () => {
    const event = {
      extra: {
        body: 'the customer wrote...', bodyText: 'plain', detail: { x: 1 }, payload: { y: 2 },
        apiKey: 'sk-live-xxx', key: 'k', token: 'tok', cookie: 'sess=1', Authorization: 'Bearer x',
        safe: 'this survives',
      },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.extra).toEqual({ safe: 'this survives' })
  })

  /** Minor: `SCRUB_KEYS` used to be one level deep, so `extra.request = { body: … }` survived. */
  it('scrubs one level into a nested plain object too, not only the top level', () => {
    const event = {
      extra: { request: { body: 'sensitive customer text', ok: 'fine' }, safe: 'x' },
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect((out.extra?.request as Record<string, unknown> | undefined)?.body).toBeUndefined()
    expect((out.extra?.request as Record<string, unknown> | undefined)?.ok).toBe('fine')
    expect(out.extra?.safe).toBe('x')
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

  /**
   * Fix round 2 (the finding the re-reviewer's `util.format` repro landed): the default
   * `consoleIntegration` renders `boss.on('error', (e) => console.error('[pg-boss]', e))`
   * (`packages/queue/src/pg-boss.ts`) into the breadcrumb's `message`, and a `DrizzleQueryError`'s
   * `Failed query: <sql>\nparams: <bound values>` comfortably fits under the 200-char cap — length
   * truncation ALONE (the pre-fix-round-2 behaviour) never fires for it, so the raw SQL and its
   * bound customer text (a `drafts.final_body`, say) would have ridden along untouched on whatever
   * event Sentry captures NEXT.
   */
  it('redacts a Failed query: breadcrumb message even when it already fits under the 200-char cap', () => {
    const message = 'DrizzleQueryError: Failed query: insert into "drafts" ("final_body") values ($1)\nparams: Dear customer, your refund has been processed.'
    expect(message.length).toBeLessThan(200)   // pins the scenario: length-only truncation would never have fired
    const event = { breadcrumbs: [{ message, category: 'console' }] } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.breadcrumbs?.[0]?.message).toBe('DrizzleQueryError: Failed query: [redacted]')
    expect(out.breadcrumbs?.[0]?.message).not.toContain('refund')
  })

  /**
   * Important 5: the default `consoleIntegration` records `data.arguments` — the raw argument array
   * — beside the formatted message, so `console.error('[pg-boss]', e)` (packages/queue/src/pg-boss.ts)
   * would otherwise put a raw pg error object (a `DatabaseError`'s `detail`/`where` can repeat the
   * offending row value) into breadcrumb data untruncated — truncating only `message` never touches it.
   */
  it('drops breadcrumb.data entirely (a console breadcrumb can carry the raw argument array, DB error detail included)', () => {
    const event = {
      breadcrumbs: [{
        message: '[pg-boss] connection error', category: 'console',
        data: { arguments: ['[pg-boss]', { detail: 'Key (email)=(customer@example.com) already exists.' }] },
      }],
    } as unknown as Sentry.ErrorEvent
    const out = beforeSend(event)
    expect(out.breadcrumbs?.[0]?.data).toBeUndefined()
    expect(out.breadcrumbs?.[0]?.message).toBe('[pg-boss] connection error')   // the rest of the breadcrumb survives
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

  it('initObservability({ sentry: { dsn, environment } }) returns true, initialises Sentry, and ACTUALLY wires beforeSend', () => {
    const result = initObservability({
      sentry: { dsn: new Secret('https://abc123@o0.ingest.sentry.io/1'), environment: 'test' },
      release: 'test-sha',
    })
    expect(result).toBe(true)
    expect(Sentry.isInitialized()).toBe(true)
    // Important 4: both this test file's OTHER tests and the real production pipeline rely on
    // initObservability's own Sentry.init call passing `beforeSend` through — assert that BEFORE
    // the re-init below (which passes `beforeSend` explicitly again) would otherwise make this
    // assertion pass even if initObservability's own options object had dropped it.
    expect(Sentry.getClient()?.getOptions().beforeSend).toBe(beforeSend)

    // Swap in the fake transport AFTER init (NodeOptions.transport is a factory the SDK calls once
    // at init time) — re-init with the stub so nothing here ever reaches the network.
    Sentry.init({
      dsn: 'https://abc123@o0.ingest.sentry.io/1', environment: 'test', release: 'test-sha',
      transport: () => fakeTransport, beforeSend,
    })
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

  it('captureWithOrg() captures the exception with org_id (and job) tags', async () => {
    captured.length = 0
    captureWithOrg(new Error('kaboom'), { orgId: 'org-77', job: 'ticket.draft' })
    await Sentry.flush(3000)

    const event = lastEvent()
    expect(event.tags).toMatchObject({ org_id: 'org-77', job: 'ticket.draft' })
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
   * against the `scrubJobError` unit in isolation. TWO layers apply here: `captureWithOrg`'s own
   * `scrubJobError` call turns it into `Failed query: [redacted] (pg 23505)` first, then
   * `beforeSend`'s event-level redaction (unit-tested directly above) collapses everything from
   * `Failed query:` onward again — coarser, but it is the layer that has to hold even when a raw
   * DrizzleQueryError reaches Sentry a DIFFERENT way, which is why the final value carries no
   * `(pg 23505)` suffix.
   */
  it('captureWithOrg() scrubs a raw DrizzleQueryError before it ever reaches Sentry (both layers)', async () => {
    captured.length = 0
    const err = new DrizzleQueryError(
      'insert into "t" ("secret") values ($1)', ['customer text'],
      Object.assign(new Error('dup'), { code: '23505' }),
    )
    captureWithOrg(err, { orgId: 'org-1' })
    await Sentry.flush(3000)

    const event = lastEvent()
    const message = (event.exception as { values?: { value?: string }[] } | undefined)?.values?.[0]?.value
    expect(message).toBe('Failed query: [redacted]')
    expect(message).not.toContain('customer text')
    expect(message).not.toContain('insert into')
    expect(message).not.toContain('23505')
  })

  /**
   * Minor: `alert()`/`captureWithOrg()`'s own Sentry calls are wrapped in try/catch (matching
   * `notifyJobFailure`'s seam) so a failure ANYWHERE inside the protected block can never turn an
   * already-handled failure into an unhandled one — several `alert()` sites sit inside last-resort
   * catches (`workspace-purge.ts`'s rows phase, which rethrows; `report-usage.ts`'s `op: 'record'`
   * catch). `@sentry/node`'s own named exports are frozen ESM bindings vitest cannot `vi.spyOn`
   * (confirmed empirically: "Module namespace is not configurable in ESM"), so this proves the
   * try/catch a different way — a throwing GETTER on `ctx.orgId`, read a second time only INSIDE
   * the protected block (`alert()`'s pino line reads it once, unprotected, first — that access must
   * still succeed and log) — rather than by hoping Sentry's own internals happen not to throw.
   */
  describe('the Sentry half never escapes, even when something inside it throws', () => {
    it("alert() does not throw when ctx.orgId's SECOND read (inside the Sentry half) throws — the pino line's own read still succeeds", () => {
      const { logger, lines } = loggedLines()
      let reads = 0
      const evilCtx = { get orgId() { reads += 1; if (reads > 1) throw new Error('boom'); return 'org-1' }, key: 'k' }
      expect(() => alert(logger, 'purge_failed', evilCtx as unknown as { orgId?: string | null } & Record<string, string | number | boolean | null>)).not.toThrow()
      expect(lines()[0]).toMatchObject({ alert: true, kind: 'purge_failed', orgId: 'org-1' })
      expect(reads).toBeGreaterThan(1)   // proves the second, protected read actually happened and threw
    })

    it("captureWithOrg() does not throw when ctx.orgId's read (inside the Sentry half) throws", () => {
      const evilCtx = { get orgId(): string { throw new Error('boom') } }
      expect(() => captureWithOrg(new Error('boom'), evilCtx as unknown as { orgId?: string | null })).not.toThrow()
    })
  })
})
