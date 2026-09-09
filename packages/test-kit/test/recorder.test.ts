import { describe, expect, it } from 'vitest'
import { assertScrubbed, createRecordingFetch, FORBIDDEN_SUBSTRINGS, type FixtureFile } from '../src/recorder.ts'

// Ported from doge-buddy `packages/gmail/test/record-fixtures.test.ts` — unit coverage for the
// scrub-assertion the recorder runs on every captured fixture right before writing it to disk.
// This is defense-in-depth on top of the recorder's structural scrub (fixture files never carry a
// headers field, so Authorization is excluded by construction) — it exists to catch anything
// unexpected: a response body that happens to echo a header, or a raw string leaking a bearer
// token or private key material from somewhere the structural exclusion can't see.
describe('assertScrubbed', () => {
  it('passes a clean set of fixtures through without throwing', () => {
    expect(() =>
      assertScrubbed([
        {
          name: 'profile.json',
          fixture: {
            request: { method: 'GET', path: '/gmail/v1/users/me/profile' },
            response: { status: 200, body: { emailAddress: 'admin@acme.test', historyId: '3025' } },
          },
        },
      ]),
    ).not.toThrow()
  })

  it('throws, naming the offending file, when a fixture contains "Bearer x"', () => {
    expect(() =>
      assertScrubbed([
        {
          name: 'leaky.json',
          fixture: {
            request: { method: 'GET', path: '/x' },
            response: { status: 200, body: { note: 'Bearer x' } },
          },
        },
      ]),
    ).toThrow(/leaky\.json/)
  })

  it('throws when a fixture nests an Authorization: Bearer header anywhere, even without a top-level headers field', () => {
    expect(() =>
      assertScrubbed([
        {
          name: 'nested-leak.json',
          fixture: {
            request: { method: 'GET', path: '/x' },
            response: { status: 200, body: { echo: { headers: { Authorization: 'Bearer abc123' } } } },
          },
        },
      ]),
    ).toThrow(/nested-leak\.json/)
  })

  it('throws when a fixture value contains PRIVATE KEY material', () => {
    expect(() =>
      assertScrubbed([
        {
          name: 'key-leak.json',
          fixture: { request: { method: 'GET', path: '/x' }, response: { status: 200, body: { note: '-----BEGIN PRIVATE KEY-----' } } },
        },
      ]),
    ).toThrow(/key-leak\.json/)
  })

  it('lists EVERY offending file, not just the first, when multiple fixtures leak', () => {
    expect(() =>
      assertScrubbed([
        { name: 'a.json', fixture: { request: { method: 'GET', path: '/a' }, response: { status: 200, body: 'Bearer nope' } } },
        { name: 'b.json', fixture: { request: { method: 'GET', path: '/b' }, response: { status: 200, body: 'clean' } } },
        {
          name: 'c.json',
          fixture: { request: { method: 'GET', path: '/c' }, response: { status: 200, body: '-----BEGIN PRIVATE KEY-----' } },
        },
      ]),
    ).toThrow(/a\.json[\s\S]*c\.json|c\.json[\s\S]*a\.json/)
  })

  it('FORBIDDEN_SUBSTRINGS is exactly the binding two-item contract', () => {
    expect(FORBIDDEN_SUBSTRINGS).toEqual(['Bearer ', 'PRIVATE KEY'])
  })
})

describe('createRecordingFetch', () => {
  it('captures method/path/query/status/body under the name named by target.current at call time', async () => {
    const target: { current: string | null } = { current: null }
    const captured = new Map<string, FixtureFile>()
    const realFetch = (async (url: string | URL) => {
      const u = new URL(String(url))
      expect(u.pathname).toBe('/gmail/v1/users/me/messages')
      return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = realFetch
    try {
      const recordingFetch = createRecordingFetch(target, captured)
      target.current = 'messages-list.json'
      await recordingFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in%3Ainbox&pageToken=p2')
    } finally {
      globalThis.fetch = originalFetch
    }

    const entry = captured.get('messages-list.json')
    expect(entry).toBeDefined()
    expect(entry!.name).toBe('messages-list.json')
    expect(entry!.fixture.request).toEqual({
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
      query: { q: 'in:inbox', pageToken: 'p2' },
    })
    expect(entry!.fixture.response).toEqual({ status: 200, body: { messages: [{ id: 'm1' }] } })
  })

  it('captures a repeated query param as an array', async () => {
    const target: { current: string | null } = { current: 'metadata.json' }
    const captured = new Map<string, FixtureFile>()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    try {
      const recordingFetch = createRecordingFetch(target, captured)
      await recordingFetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From&metadataHeaders=To',
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(captured.get('metadata.json')!.fixture.request.query).toEqual({
      format: 'metadata',
      metadataHeaders: ['From', 'To'],
    })
  })

  it('an untargeted call (target.current is null) captures nothing', async () => {
    const target: { current: string | null } = { current: null }
    const captured = new Map<string, FixtureFile>()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    try {
      const recordingFetch = createRecordingFetch(target, captured)
      await recordingFetch('https://oauth2.googleapis.com/token', { method: 'POST', body: 'grant_type=...' })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(captured.size).toBe(0)
  })

  it('NEVER captures request headers — the fixture shape has no headers key even when the fetch sent an Authorization header', async () => {
    const target: { current: string | null } = { current: 'profile.json' }
    const captured = new Map<string, FixtureFile>()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      // The caller DID send a real bearer token on the wire — the recorder must still exclude it
      // from the captured fixture, structurally, not by best-effort redaction.
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer super-secret-token')
      return new Response(JSON.stringify({ emailAddress: 'admin@acme.test', historyId: '1' }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const recordingFetch = createRecordingFetch(target, captured)
      await recordingFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: 'Bearer super-secret-token' },
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    const entry = captured.get('profile.json')!
    expect(entry.fixture.request).not.toHaveProperty('headers')
    expect(Object.keys(entry.fixture.request).sort()).toEqual(['method', 'path'])
    // Defense-in-depth: the captured fixture, serialized, never contains the token either.
    expect(JSON.stringify(entry.fixture)).not.toContain('super-secret-token')
    expect(() => assertScrubbed([entry])).not.toThrow()
  })

  it('a retried call overwrites the same name with its own final response', async () => {
    const target: { current: string | null } = { current: 'flaky.json' }
    const captured = new Map<string, FixtureFile>()
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1
        ? new Response(JSON.stringify({ error: 'transient' }), { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const recordingFetch = createRecordingFetch(target, captured)
      await recordingFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile')
      await recordingFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(captured.size).toBe(1)
    expect(captured.get('flaky.json')!.fixture.response).toEqual({ status: 200, body: { ok: true } })
  })
})
