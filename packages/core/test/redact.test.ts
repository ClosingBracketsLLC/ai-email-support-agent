import { describe, expect, it } from 'vitest'
import {
  redactBreadcrumbMessage, redactHeaders, redactQueryParams, redactText, redactUrl, scrubKeys,
  SCRUB_KEYS, SENSITIVE_HEADER_NAMES,
} from '../src/index.ts'

describe('redactUrl', () => {
  it('redacts every query value, not only t=', () => {
    expect(redactUrl('/a/123?t=SECRET&code=ABC&x=')).toBe('/a/123?t=[redacted]&code=[redacted]&x=[redacted]')
  })
  it('redacts long base64url path segments (tokens in paths) but keeps ids and words', () => {
    const tok = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'   // 35 chars
    expect(redactUrl(`/a/${tok}/approve`)).toBe('/a/[redacted]/approve')
    expect(redactUrl('/tickets/0190f7a2-1c3e-7e2a-9b1a-3c5d6e7f8a9b')).toBe('/tickets/0190f7a2-1c3e-7e2a-9b1a-3c5d6e7f8a9b')
  })
})

describe('redactText', () => {
  const SECRET = 'tok_SUPER_SECRET_SESSION_TOKEN'
  const QUERY = 'insert into "session" ("token") values ($1)'

  it('collapses a Failed query: tail (bound SQL parameters) wherever it appears, not only inside an Error', () => {
    expect(redactText(`boom: Failed query: ${QUERY}\nparams: ${SECRET}`)).toBe('boom: Failed query: [redacted]')
  })

  it('masks a URL found inside free text, leaving the rest of the message untouched', () => {
    expect(redactText('see https://x.test/cb?code=abc123 for details')).toBe('see https://x.test/cb?code=[redacted] for details')
  })

  it('is a pass-through on text carrying neither a URL nor "Failed query:"', () => {
    expect(redactText('curl/8.4.0')).toBe('curl/8.4.0')
  })
})

describe('scrubKeys', () => {
  it('deletes every SCRUB_KEYS entry (case-insensitively), keeping the rest', () => {
    const rec: Record<string, unknown> = {
      body: 'x', bodyText: 'x', detail: 'x', payload: 'x', apiKey: 'x', key: 'x', token: 'x',
      cookie: 'x', Authorization: 'x', safe: 'survives',
    }
    scrubKeys(rec)
    expect(rec).toEqual({ safe: 'survives' })
    // Every canonical key SCRUB_KEYS names is exercised above — this pins the exact set.
    expect([...SCRUB_KEYS].sort()).toEqual(['apikey', 'authorization', 'body', 'bodytext', 'cookie', 'detail', 'key', 'payload', 'token'])
  })

  it('recurses one level into a nested plain object, not only the top level', () => {
    const rec = { request: { body: 'sensitive', ok: 'fine' }, safe: 'x' }
    scrubKeys(rec)
    expect((rec.request as Record<string, unknown>).body).toBeUndefined()
    expect((rec.request as Record<string, unknown>).ok).toBe('fine')
    expect(rec.safe).toBe('x')
  })

  it('never recurses into an array (arrays are left as-is, not walked as objects)', () => {
    const rec = { items: [{ token: 'x' }] }
    scrubKeys(rec)
    expect((rec.items[0] as Record<string, unknown>).token).toBe('x')
  })

  it('is a no-op on undefined', () => {
    expect(() => scrubKeys(undefined)).not.toThrow()
  })
})

describe('redactHeaders', () => {
  it('deletes every SENSITIVE_HEADER_NAMES entry (case-insensitively)', () => {
    const headers: Record<string, string> = { cookie: 'a', Authorization: 'b', 'X-Api-Key': 'c', 'user-agent': 'curl/8' }
    redactHeaders(headers)
    expect(headers.cookie).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
    expect(headers['X-Api-Key']).toBeUndefined()
    expect(headers['user-agent']).toBe('curl/8')
    expect([...SENSITIVE_HEADER_NAMES].sort()).toEqual(['authorization', 'cookie', 'x-api-key'])
  })

  /**
   * The header-VALUE gap the fix round closed: a `referer` (or `origin`) header carrying a full URL
   * — following navigation from `/a/:draftId?t=<token>` — is not itself a sensitive header NAME, so
   * name-filtering alone leaves the action token inside it untouched.
   */
  it('redacts the action token out of a referer header value, not only the sensitive-named headers', () => {
    const headers: Record<string, string> = { referer: 'https://app.example.com/a/draft-123?t=SECRET_ACTION_TOKEN' }
    redactHeaders(headers)
    expect(headers.referer).not.toContain('SECRET_ACTION_TOKEN')
    expect(headers.referer).toBe('https://app.example.com/a/draft-123?t=[redacted]')
  })

  it('is a no-op on undefined', () => {
    expect(() => redactHeaders(undefined)).not.toThrow()
  })

  // Phase 7 fix wave: the declared type is `Record<string, string>`, but the value comes off a
  // Sentry event nobody validated. A scrubber never throws — and never passes a non-string through
  // unredacted either: it is dropped.
  it('drops a non-string header value instead of throwing or passing it through', () => {
    const headers = { referer: ['https://x/a/d?t=TOK', 'b'], 'content-length': 12, nul: null, ok: 'fine' } as unknown as Record<string, string>
    expect(() => redactHeaders(headers)).not.toThrow()
    expect(headers).toEqual({ ok: 'fine' })
  })
})

describe('redactQueryParams', () => {
  it('redacts every value in a raw query string, keeping keys', () => {
    expect(redactQueryParams('t=SECRET&x=')).toBe('t=[redacted]&x=[redacted]')
  })

  it('redacts every value in an object form', () => {
    expect(redactQueryParams({ t: 'SECRET', code: 'ABC' })).toEqual({ t: '[redacted]', code: '[redacted]' })
  })

  it('redacts every value in a [key, value][] pairs form', () => {
    expect(redactQueryParams([['t', 'SECRET']])).toEqual([['t', '[redacted]']])
  })

  /** Folded nit: no Sentry path assigns `query_string: null` today, but a scrubber must never be
   *  the thing that throws — `null` is guarded exactly like `undefined`, not just tolerated by luck. */
  it('never throws on null or undefined, normalising both to undefined', () => {
    expect(redactQueryParams(undefined)).toBeUndefined()
    expect(redactQueryParams(null)).toBeUndefined()
  })
})

describe('redactBreadcrumbMessage', () => {
  const SECRET = 'Dear customer, here is your refund confirmation for order #48213'

  /**
   * The exact leak the fix round closed: the default `consoleIntegration` renders a logged error
   * into the breadcrumb `message` via `util.format`, so `console.error('[pg-boss]', drizzleErr)`
   * produces a message that comfortably fits under the 200-char cap — truncation ALONE (the old
   * behaviour: `if (message.length > 200) message = message.slice(0, 200)`) never fires for it, so
   * the customer's `final_body` text would have passed through completely untouched.
   */
  it('redacts a Failed query: tail even when the whole raw message already fits under the 200-char cap', () => {
    const message = `Failed query: insert into "drafts" ("final_body") values ($1)\nparams: ${SECRET}`
    expect(message.length).toBeLessThan(200)   // pins the scenario: length-only truncation would never have fired
    const out = redactBreadcrumbMessage(message)
    expect(out).toBe('Failed query: [redacted]')
    expect(out).not.toContain(SECRET)
  })

  it('truncates to 200 chars after redaction when the redacted text is still long', () => {
    const out = redactBreadcrumbMessage('x'.repeat(300))
    expect(out).toHaveLength(200)
  })

  it('leaves a short, unremarkable message untouched', () => {
    expect(redactBreadcrumbMessage('mailbox.sync: no new messages')).toBe('mailbox.sync: no new messages')
  })
})
