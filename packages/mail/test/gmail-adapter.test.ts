import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { gmailProvider, METADATA_HEADERS } from '../src/adapters/gmail/index.ts'
import { parseAuthResults } from '../src/auth-results.ts'
import { CursorExpiredError, MailApiError, MessageGoneError, ProviderAuthError } from '../src/errors.ts'

import historyPage1Fixture from './fixtures/gmail/history-page1.json' with { type: 'json' }
import historyPaged1Fixture from './fixtures/gmail/history-paged-1.json' with { type: 'json' }
import historyPaged2Fixture from './fixtures/gmail/history-paged-2.json' with { type: 'json' }
import historyEmptyFixture from './fixtures/gmail/history-empty.json' with { type: 'json' }
import messageMetadataFixture from './fixtures/gmail/message-metadata.json' with { type: 'json' }
import messageFullNestedFixture from './fixtures/gmail/message-full-nested.json' with { type: 'json' }
import messageRelayOnlyFixture from './fixtures/gmail/message-relay-only.json' with { type: 'json' }
import sendReplyFixture from './fixtures/gmail/send-reply.json' with { type: 'json' }
import error404Fixture from './fixtures/gmail/error-404.json' with { type: 'json' }
import error429Fixture from './fixtures/gmail/error-429.json' with { type: 'json' }

const SELF_ADDRESS = 'support@acme.test'

interface Fixture {
  request: { method: string; path: string; query?: Record<string, string | string[]> }
  response: { status: number; body: unknown; headers?: Record<string, string> }
}

function buildKey(method: string, path: string, query?: Record<string, string | string[]>): string {
  const params = new URLSearchParams()
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, item)
      else params.append(k, v)
    }
  }
  const qs = params.toString()
  return `${method.toUpperCase()} ${path}${qs ? `?${qs}` : ''}`
}

/** Matches an incoming request's method+path?query against fixtures' own `request` field — modeled
 * on doge-buddy's `packages/gmail/test/client.test.ts` helper, extended with response `headers`
 * (Retry-After) since this port's `ProviderRateLimitError` carries `retryAfterMs`. */
function fixtureFetch(map: Record<string, Fixture>): typeof fetch {
  const byKey = new Map<string, Fixture>()
  for (const fixture of Object.values(map)) {
    byKey.set(buildKey(fixture.request.method, fixture.request.path, fixture.request.query), fixture)
  }
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${u.pathname}${u.search}`
    const fixture = byKey.get(key)
    if (!fixture) {
      throw new Error(`fixtureFetch: no fixture registered for "${key}". Known: ${[...byKey.keys()].join(' | ')}`)
    }
    return new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status, headers: fixture.response.headers })
  }) as unknown as typeof fetch
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

/** An unsigned JWT-shaped string good enough for `decodeIdTokenSub` — no signature check is
 * performed (the token arrived over TLS directly from Google in the same response). */
function fakeIdToken(sub: string): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub, email: 'jane@example.com' }))
  return `${header}.${payload}.fake-signature`
}

describe('gmailProvider', () => {
  it('kind is "gmail"', () => {
    expect(gmailProvider().kind).toBe('gmail')
  })

  describe('OAuth', () => {
    it('authorizationUrl: builds the accounts.google.com URL with PKCE + offline-consent params', () => {
      const provider = gmailProvider()
      const url = new URL(
        provider.authorizationUrl({
          clientId: 'client-1',
          redirectUri: 'https://api.acme.test/api/auth/callback/google',
          state: 'state-xyz',
          codeChallenge: 'challenge-abc',
          loginHint: 'jane@example.com',
        }),
      )

      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
      expect(url.searchParams.get('client_id')).toBe('client-1')
      expect(url.searchParams.get('redirect_uri')).toBe('https://api.acme.test/api/auth/callback/google')
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email',
      )
      expect(url.searchParams.get('access_type')).toBe('offline')
      expect(url.searchParams.get('prompt')).toBe('consent')
      expect(url.searchParams.get('code_challenge')).toBe('challenge-abc')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('state')).toBe('state-xyz')
      expect(url.searchParams.get('login_hint')).toBe('jane@example.com')
    })

    it('authorizationUrl: omits login_hint when not given', () => {
      const url = new URL(
        gmailProvider().authorizationUrl({ clientId: 'c', redirectUri: 'https://x/y', state: 's', codeChallenge: 'ch' }),
      )
      expect(url.searchParams.has('login_hint')).toBe(false)
    })

    it('exchangeCode: POSTs the token endpoint, decodes the id_token sub, fetches the profile, and lowercases the email', async () => {
      let call = 0
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        call += 1
        if (call === 1) {
          expect(String(url)).toBe('https://oauth2.googleapis.com/token')
          expect(init?.method).toBe('POST')
          const body = new URLSearchParams(String(init?.body))
          expect(body.get('client_id')).toBe('client-1')
          expect(body.get('client_secret')).toBe('secret-1')
          expect(body.get('redirect_uri')).toBe('https://api.acme.test/callback')
          expect(body.get('code')).toBe('auth-code-1')
          expect(body.get('code_verifier')).toBe('verifier-1')
          expect(body.get('grant_type')).toBe('authorization_code')
          return new Response(
            JSON.stringify({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600,
              id_token: fakeIdToken('google-sub-1'),
            }),
            { status: 200 },
          )
        }
        expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile')
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-1')
        return new Response(JSON.stringify({ emailAddress: 'Jane@Example.COM' }), { status: 200 })
      }) as unknown as typeof fetch

      const provider = gmailProvider(fetchFn)
      const result = await provider.exchangeCode({
        clientId: 'client-1',
        clientSecret: 'secret-1',
        redirectUri: 'https://api.acme.test/callback',
        code: 'auth-code-1',
        codeVerifier: 'verifier-1',
      })

      expect(result.tokens.refreshToken).toBe('refresh-1')
      expect(result.tokens.accessToken).toBe('access-1')
      expect(result.tokens.accessTokenExpiresAt).toBeInstanceOf(Date)
      expect(result.emailAddress).toBe('jane@example.com')
      expect(result.providerAccountId).toBe('google-sub-1')
      expect(call).toBe(2)
    })

    it('exchangeCode: missing refresh_token throws ProviderAuthError', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ access_token: 'a', expires_in: 3600, id_token: fakeIdToken('s') }), { status: 200 }),
      ) as unknown as typeof fetch
      await expect(
        gmailProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' }),
      ).rejects.toBeInstanceOf(ProviderAuthError)
    })

    it('exchangeCode: missing id_token throws ProviderAuthError', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 }),
      ) as unknown as typeof fetch
      await expect(
        gmailProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' }),
      ).rejects.toBeInstanceOf(ProviderAuthError)
    })

    it('exchangeCode: invalid_grant from the token endpoint throws ProviderAuthError', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }), { status: 400 }),
      ) as unknown as typeof fetch
      await expect(
        gmailProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' }),
      ).rejects.toBeInstanceOf(ProviderAuthError)
    })

    it('exchangeCode: a failing profile fetch throws MailApiError (not ProviderAuthError — the token exchange itself succeeded)', async () => {
      let call = 0
      const fetchFn = vi.fn(async () => {
        call += 1
        if (call === 1) {
          return new Response(
            JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, id_token: fakeIdToken('s') }),
            { status: 200 },
          )
        }
        return new Response('', { status: 500 })
      }) as unknown as typeof fetch
      await expect(
        gmailProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' }),
      ).rejects.toBeInstanceOf(MailApiError)
    })

    it('refresh: POSTs grant_type=refresh_token and returns the fresh TokenSet', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://oauth2.googleapis.com/token')
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('refresh_token')).toBe('old-refresh')
        return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 })
      }) as unknown as typeof fetch

      const result = await gmailProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'old-refresh' })
      // Google's refresh grant does NOT echo a refresh_token — the adapter must hand back the
      // token it was given, never an empty string (credentials.ts refuses an empty refresh token).
      expect(result.refreshToken).toBe('old-refresh')
      expect(result.accessToken).toBe('new-access')
      expect(result.accessTokenExpiresAt).toBeInstanceOf(Date)
    })

    it('refresh: uses the NEW refresh_token when Google does echo one', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'rotated', expires_in: 3600 }), { status: 200 }),
      ) as unknown as typeof fetch
      const result = await gmailProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'old' })
      expect(result.refreshToken).toBe('rotated')
    })

    it('refresh: forwards the caller AbortSignal to fetch', async () => {
      const controller = new AbortController()
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal)
        return new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 })
      }) as unknown as typeof fetch
      await gmailProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'r', signal: controller.signal })
    })

    it('refresh: invalid_grant throws ProviderAuthError — the worker treats this as reauth_required, not transient', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 }),
      ) as unknown as typeof fetch
      await expect(gmailProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })).rejects.toBeInstanceOf(
        ProviderAuthError,
      )
    })

    it('refresh: a non-invalid_grant failure throws plain MailApiError (transient — credentials.ts retries)', async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 })) as unknown as typeof fetch
      await expect(gmailProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })).rejects.toMatchObject({
        name: 'MailApiError',
        status: 500,
      })
    })

    it('revoke: POSTs token to /revoke and resolves on 200', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://oauth2.googleapis.com/revoke')
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('token')).toBe('refresh-1')
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch
      await expect(gmailProvider(fetchFn).revoke({ clientId: 'c', clientSecret: 's', refreshToken: 'refresh-1' })).resolves.toBeUndefined()
    })

    it('revoke: a 400 (already revoked/expired) is treated as success, not an error', async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 })) as unknown as typeof fetch
      await expect(gmailProvider(fetchFn).revoke({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })).resolves.toBeUndefined()
    })

    it('revoke: a 500 throws MailApiError', async () => {
      const fetchFn = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch
      await expect(gmailProvider(fetchFn).revoke({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })).rejects.toBeInstanceOf(MailApiError)
    })
  })

  describe('client: profile / listChanges', () => {
    it('profile: builds GET /profile and normalizes emailAddress + historyId cursor', async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ emailAddress: 'Support@Acme.test', historyId: '115' }), { status: 200 }))
      const client = gmailProvider(fetchFn as unknown as typeof fetch).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).resolves.toEqual({ emailAddress: 'support@acme.test', cursor: { historyId: '115' } })
    })

    it('listChanges: a real page — messagesAdded on the arrival record only, label-change records map to an empty list', async () => {
      const client = gmailProvider(fixtureFetch({ page1: historyPage1Fixture })).client('tok-1', SELF_ADDRESS)
      const page = await client.listChanges({ historyId: '100' })
      expect(page.nextPageToken).toBeUndefined()
      expect(page.records).toEqual([
        { id: '105', messageIds: [{ id: 'msg-a1', threadId: 'thread-a1' }] },
        { id: '110', messageIds: [] },
        { id: '115', messageIds: [{ id: 'msg-a2', threadId: 'thread-a2' }] },
      ])
      // newCursor is the SYNC WALK's job (it must see every drained page first), not this client's.
      expect(page.newCursor).toBeUndefined()
    })

    it('listChanges: a quiet poll — Gmail omits the `history` key entirely — maps to []', async () => {
      expect(historyEmptyFixture.response.body).not.toHaveProperty('history')
      const client = gmailProvider(fixtureFetch({ empty: historyEmptyFixture })).client('tok-1', SELF_ADDRESS)
      await expect(client.listChanges({ historyId: '999' })).resolves.toEqual({ records: [], nextPageToken: undefined })
    })

    it('listChanges: pages via startHistoryId + pageToken', async () => {
      const client = gmailProvider(fixtureFetch({ page1: historyPaged1Fixture, page2: historyPaged2Fixture })).client('tok-1', SELF_ADDRESS)

      const page1 = await client.listChanges({ historyId: '200' })
      expect(page1.nextPageToken).toBe('page-2-token')
      expect(page1.records).toEqual([{ id: '201', messageIds: [{ id: 'msg-p1', threadId: 'thread-p1' }] }])

      const page2 = await client.listChanges({ historyId: '200' }, 'page-2-token')
      expect(page2.nextPageToken).toBeUndefined()
      expect(page2.records).toEqual([{ id: '210', messageIds: [{ id: 'msg-p2', threadId: 'thread-p2' }] }])
    })

    it('listChanges: a missing cursor defaults startHistoryId to "0"', async () => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        expect(new URL(String(url)).searchParams.get('startHistoryId')).toBe('0')
        return new Response(JSON.stringify({ historyId: '0' }), { status: 200 })
      })
      const client = gmailProvider(fetchFn as unknown as typeof fetch).client('tok-1', SELF_ADDRESS)
      await client.listChanges(undefined)
    })

    it('listChanges: 404 becomes CursorExpiredError', async () => {
      const client = gmailProvider(fixtureFetch({ err: error404Fixture })).client('tok-1', SELF_ADDRESS)
      await expect(client.listChanges({ historyId: '500' })).rejects.toBeInstanceOf(CursorExpiredError)
    })
  })

  describe('client: getMessage', () => {
    it('metadata: requests format=metadata with repeated metadataHeaders in the required order, bodyText is null', async () => {
      const fetchFn = vi.fn(fixtureFetch({ msg: messageMetadataFixture }))
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-meta-1', { format: 'metadata' })

      const calledUrl = new URL(String(fetchFn.mock.calls[0]![0]))
      expect(calledUrl.pathname).toBe('/gmail/v1/users/me/messages/msg-meta-1')
      expect(calledUrl.searchParams.get('format')).toBe('metadata')
      expect(calledUrl.searchParams.getAll('metadataHeaders')).toEqual([...METADATA_HEADERS])
      expect(METADATA_HEADERS[METADATA_HEADERS.length - 1]).toBe('X-Aesa-Draft')

      expect(msg.bodyText).toBeNull()
      expect(msg.fromAddr).toBe('support@acme.test')
      expect(msg.toAddrs).toEqual(['jane@example.com'])
      expect(msg.ccAddrs).toEqual([])
      expect(msg.deliveredTo).toEqual([])
      expect(msg.subject).toBe("Re: Order #4521 hasn't shipped")
      // Gmail hands back "Message-Id" (mixed case) — header lookup must be case-insensitive.
      expect(msg.rfcMessageId).toBe('<CAJ+marker1@mail.gmail.com>')
      expect(msg.inReplyTo).toBe('<CAJ+abc123@mail.gmail.com>')
      expect(msg.references).toEqual(['<original-msg-999@mail.gmail.com>', '<CAJ+abc123@mail.gmail.com>'])
      expect(msg.authenticationResults).toBeNull() // sent copies carry no Authentication-Results
      expect(msg.autoSubmitted).toBe('no')
      expect(msg.precedence).toBeNull()
      expect(msg.listId).toBeNull()
      expect(msg.labelIds).toEqual(['SENT'])
      expect(msg.internalDate).toEqual(new Date(1_756_148_500_000))
      expect(msg.hasAttachments).toBe(false)
      expect(msg.attachments).toEqual([])
      // The whole point of MARKER_HEADER being on METADATA_HEADERS: this is what a metadata-only
      // fetch (findSentByMarker's recovery scan) reads to decide "already sent" vs "send now".
      expect(msg.markerDraftId).toBe('9f1c2b34-5d6e-47a8-9012-3456789abcde')
    })

    it('full (nested multipart, ISO-8859-1 + attachment): normalizes headers, prefers the plain-text leaf honouring its own charset, and scrubs a Luhn card', async () => {
      const client = gmailProvider(fixtureFetch({ msg: messageFullNestedFixture })).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-full-1', { format: 'full' })

      expect(msg.id).toBe('msg-full-1')
      expect(msg.threadId).toBe('thread-full-1')
      expect(msg.labelIds).toEqual(['IMPORTANT', 'CATEGORY_PERSONAL', 'INBOX'])
      expect(msg.internalDate).toEqual(new Date(1_757_000_000_000))
      expect(msg.fromAddr).toBe('jane@example.com')
      // Outlook/Gmail-style `"support@acme.test" <support@acme.test>` — display name dropped.
      expect(msg.toAddrs).toEqual(['support@acme.test'])
      expect(msg.ccAddrs).toEqual(['billing@example.com'])
      expect(msg.deliveredTo).toEqual(['support@acme.test'])
      expect(msg.subject).toBe('Re: Order #4521 double charge')
      expect(msg.rfcMessageId).toBe('<CAExampleJane1@mail.gmail.com>')
      expect(msg.inReplyTo).toBe('<CAAcmeSupport1@mail.gmail.com>')
      expect(msg.references).toEqual(['<CAAcmeRoot0@mail.gmail.com>', '<CAAcmeSupport1@mail.gmail.com>'])
      expect(msg.autoSubmitted).toBe('no')
      expect(msg.precedence).toBeNull()
      expect(msg.listId).toBeNull()

      // Two Authentication-Results headers on the wire — the TOPMOST (Gmail's own real stamp) wins,
      // never the second, forged-looking one further down.
      const names = messageFullNestedFixture.response.body.payload.headers.map((h) => h.name)
      expect(names.filter((n) => n === 'Authentication-Results')).toHaveLength(2)
      expect(msg.authenticationResults).toMatch(/^mx\.google\.com/)
      expect(msg.authenticationResults).toContain('dmarc=pass')
      expect(msg.authenticationResults).not.toContain('relay.example.net')
      expect(parseAuthResults(msg.authenticationResults, { authservId: 'mx.google.com' }).dmarcPass).toBe(true)

      // ISO-8859-1 leaf decoded correctly (café's é survives), and the Luhn-valid card scrubbed.
      expect(msg.bodyText).toBe(
        'Thanks for the update - my card ending [card removed] was charged twice. Café order not resolved yet.',
      )
      expect(msg.bodyText).not.toContain('4111')

      // The attachment leaf is never treated as a text candidate, and never decoded — only its
      // metadata is exposed.
      expect(msg.hasAttachments).toBe(true)
      expect(msg.attachments).toEqual([{ filename: 'receipt.pdf', mime: 'application/pdf', size: 45210 }])
      expect(msg.markerDraftId).toBeNull()
    })

    it("a message whose ONLY Authentication-Results header is NOT Gmail's own (a relay's, claiming dmarc=pass) is not trusted", async () => {
      const client = gmailProvider(fixtureFetch({ msg: messageRelayOnlyFixture })).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-relay-1', { format: 'metadata' })

      expect(msg.authenticationResults).toBe('relay.evil.test; dmarc=pass header.from=x.test')
      expect(parseAuthResults(msg.authenticationResults, { authservId: 'mx.google.com' }).dmarcPass).toBe(false)
    })

    it('404 becomes MessageGoneError', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 404, message: 'not found', errors: [{ reason: 'notFound' }] } }),
            { status: 404 },
          ),
      ) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getMessage('gone-1', { format: 'full' })).rejects.toBeInstanceOf(MessageGoneError)
    })
  })

  describe('client: sendReply', () => {
    it('POSTs { raw, threadId } to /messages/send and returns { id, threadId }; extraHeaders pass through into the raw message', async () => {
      const fetchFn = vi.fn(fixtureFetch({ send: sendReplyFixture }))
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)

      const response = await client.sendReply({
        threadId: 'thread-100',
        to: 'jane@example.com',
        subject: 'Broken leash',
        inReplyTo: '<abc@mail.example.com>',
        references: '<root@x> <abc@mail.example.com>',
        bodyText: 'Hi Jane,\n\nSorry about that.',
        extraHeaders: { 'X-Aesa-Draft': 'draft-abc-123' },
      })

      // Contract: sendReply POSTs and returns { id, threadId } as-is — NO read-back GET inside the
      // client (the sync walk ingests the SENT copy; Phase 3's send executor does its own
      // read-back for the real rewritten Message-ID). See report for the divergence from the
      // brief's read-back sentence.
      expect(response).toEqual({ id: 'msg-sent-1', threadId: 'thread-100' })
      expect(fetchFn).toHaveBeenCalledTimes(1)

      const [, init] = fetchFn.mock.calls[0]!
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body)) as { raw: string; threadId: string }
      expect(body.threadId).toBe('thread-100')
      expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/)

      const text = Buffer.from(body.raw, 'base64url').toString()
      expect(text).toContain(`From: ${SELF_ADDRESS}\r\n`)
      expect(text).toContain('To: jane@example.com\r\n')
      expect(text).toContain('Subject: Re: Broken leash\r\n')
      expect(text).toContain('X-Aesa-Draft: draft-abc-123\r\n')
    })

    it('honours an explicit `from` override instead of selfAddress', async () => {
      const fetchFn = vi.fn(fixtureFetch({ send: sendReplyFixture }))
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await client.sendReply({
        threadId: 'thread-100',
        to: 'jane@example.com',
        subject: 'x',
        inReplyTo: '<a@b>',
        references: '<a@b>',
        bodyText: 'hi',
        from: 'sales@acme.test',
      })
      const [, init] = fetchFn.mock.calls[0]!
      const body = JSON.parse(String(init?.body)) as { raw: string }
      const text = Buffer.from(body.raw, 'base64url').toString()
      expect(text).toContain('From: sales@acme.test\r\n')
    })

    it('is EXCLUDED from the 5xx retry: a 503 on send is attempted exactly once', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        return new Response(
          JSON.stringify({ error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }),
          { status: 503 },
        )
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)

      await expect(
        client.sendReply({
          threadId: 'thread-100',
          to: 'jane@example.com',
          subject: 'Broken leash',
          inReplyTo: '<abc@mail.example.com>',
          references: '<abc@mail.example.com>',
          bodyText: 'test',
        }),
      ).rejects.toMatchObject({ name: 'MailApiError', status: 503 })
      expect(calls).toBe(1)
    })

    it('is EXCLUDED from the timeout retry: a timed-out send is attempted exactly once — a transport failure does not prove Gmail never queued it', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)

      await expect(
        client.sendReply({
          threadId: 'thread-100',
          to: 'jane@example.com',
          subject: 'Broken leash',
          inReplyTo: '<abc@mail.example.com>',
          references: '<abc@mail.example.com>',
          bodyText: 'test',
        }),
      ).rejects.toMatchObject({ name: 'MailApiError', status: 0, reason: 'timeout' })
      expect(calls).toBe(1)
    })
  })

  describe('client: subscribe / renewSubscription / unsubscribe', () => {
    it('subscribe: POSTs {topicName} to /watch with NO labelIds filter (SENT-folder events must reach the walk too)', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/watch')
        expect(init?.method).toBe('POST')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({ topicName: 'projects/acme/topics/gmail-push' })
        return new Response(JSON.stringify({ historyId: '500', expiration: '1757100000000' }), { status: 200 })
      }) as unknown as typeof fetch

      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.subscribe({ topicOrUrl: 'projects/acme/topics/gmail-push' })).resolves.toEqual({
        subscriptionId: 'projects/acme/topics/gmail-push',
        expiresAt: new Date(1_757_100_000_000),
      })
    })

    it('renewSubscription: re-issues watch with the subscriptionId as topicName', async () => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body).toEqual({ topicName: 'projects/acme/topics/gmail-push' })
        return new Response(JSON.stringify({ historyId: '600', expiration: '1757200000000' }), { status: 200 })
      }) as unknown as typeof fetch

      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.renewSubscription('projects/acme/topics/gmail-push')).resolves.toEqual({
        subscriptionId: 'projects/acme/topics/gmail-push',
        expiresAt: new Date(1_757_200_000_000),
      })
    })

    it('unsubscribe: POSTs to /stop with no body', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/stop')
        expect(init?.method).toBe('POST')
        expect(init?.body).toBeUndefined()
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.unsubscribe('projects/acme/topics/gmail-push')).resolves.toBeUndefined()
    })
  })

  describe('client: listMessagesForResync / getThreadMessageIds', () => {
    it('listMessagesForResync: builds (to:a OR cc:a OR deliveredto:a OR ...) newer_than:Nd with includeSpamTrash=true', async () => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        const u = new URL(String(url))
        expect(u.pathname).toBe('/gmail/v1/users/me/messages')
        expect(u.searchParams.get('q')).toBe(
          '(to:a@acme.test OR cc:a@acme.test OR deliveredto:a@acme.test OR to:b@acme.test OR cc:b@acme.test OR deliveredto:b@acme.test) newer_than:30d',
        )
        expect(u.searchParams.get('includeSpamTrash')).toBe('true')
        return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }), { status: 200 })
      }) as unknown as typeof fetch

      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.listMessagesForResync(['a@acme.test', 'b@acme.test'], 30)).resolves.toEqual({
        ids: [{ id: 'm1', threadId: 't1' }],
        nextPageToken: undefined,
      })
    })

    it('getThreadMessageIds: builds GET /threads/{id}?format=minimal and returns id-only entries', async () => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        const u = new URL(String(url))
        expect(u.pathname).toBe('/gmail/v1/users/me/threads/thread-9')
        expect(u.searchParams.get('format')).toBe('minimal')
        return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 'thread-9' }, { id: 'm2', threadId: 'thread-9' }] }), {
          status: 200,
        })
      }) as unknown as typeof fetch

      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getThreadMessageIds('thread-9')).resolves.toEqual([{ id: 'm1' }, { id: 'm2' }])
    })
  })

  describe('client: findSentByMarker', () => {
    function scanFetch(threadId: string, orderedIds: string[], markerById: Record<string, string>, goneIds: string[] = []): typeof fetch {
      const gone = new Set(goneIds)
      return (async (url: string | URL) => {
        const u = new URL(String(url))
        if (u.pathname === `/gmail/v1/users/me/threads/${threadId}`) {
          expect(u.searchParams.get('format')).toBe('minimal')
          return new Response(JSON.stringify({ messages: orderedIds.map((id) => ({ id })) }), { status: 200 })
        }
        const match = /^\/gmail\/v1\/users\/me\/messages\/(.+)$/.exec(u.pathname)
        if (match) {
          const id = match[1]!
          if (gone.has(id)) {
            return new Response(JSON.stringify({ error: { code: 404, errors: [{ reason: 'notFound' }] } }), { status: 404 })
          }
          const headers = [{ name: 'From', value: 'jane@example.com' }]
          if (markerById[id]) headers.push({ name: 'X-Aesa-Draft', value: markerById[id]! })
          return new Response(
            JSON.stringify({ id, threadId, labelIds: ['SENT'], internalDate: '1700000000000', payload: { headers } }),
            { status: 200 },
          )
        }
        throw new Error(`scanFetch: unexpected request ${String(url)}`)
      }) as unknown as typeof fetch
    }

    it('matches the newest candidate', async () => {
      const client = gmailProvider(scanFetch('t1', ['m1', 'm2', 'm3'], { m3: 'draft-x' })).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-x', 5)).resolves.toBe('m3')
    })

    it('matches an older candidate still within scanLimit', async () => {
      const client = gmailProvider(scanFetch('t1', ['m1', 'm2', 'm3', 'm4'], { m2: 'draft-y' })).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-y', 3)).resolves.toBe('m2')
    })

    it('no match, thread fully examined (size <= scanLimit) -> null', async () => {
      const client = gmailProvider(scanFetch('t1', ['m1', 'm2'], {})).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-none', 5)).resolves.toBeNull()
    })

    it('no match with candidates REMAINING beyond scanLimit -> throws MailApiError("thread too busy", 429)', async () => {
      const client = gmailProvider(scanFetch('t1', ['m1', 'm2', 'm3', 'm4', 'm5'], {})).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-none', 2)).rejects.toMatchObject({
        name: 'MailApiError',
        message: 'thread too busy',
        status: 429,
      })
    })

    it('a MessageGoneError on one candidate is skipped, not fatal', async () => {
      const client = gmailProvider(scanFetch('t1', ['m1', 'm2', 'm3'], { m1: 'draft-z' }, ['m3'])).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-z', 5)).resolves.toBe('m1')
    })
  })

  describe('client: error taxonomy', () => {
    it('401: throws ProviderAuthError with NO retry — the worker refresh loop owns re-auth', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }), {
          status: 401,
        })
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('stale-tok', SELF_ADDRESS)
      await expect(client.profile()).rejects.toBeInstanceOf(ProviderAuthError)
      expect(calls).toBe(1)
    })

    it('429: retries once after a jittered delay, then throws ProviderRateLimitError honouring Retry-After', async () => {
      const fetchFn = vi.fn(fixtureFetch({ err: error429Fixture }))
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getMessage('msg-429-1', { format: 'full' })).rejects.toMatchObject({
        name: 'ProviderRateLimitError',
        retryAfterMs: 30_000,
      })
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('403 rateLimitExceeded: retries once, then ProviderRateLimitError with retryAfterMs null (no Retry-After header)', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        return new Response(
          JSON.stringify({ error: { code: 403, message: 'quota', errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }] } }),
          { status: 403 },
        )
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).rejects.toMatchObject({ name: 'ProviderRateLimitError', retryAfterMs: null })
      expect(calls).toBe(2)
    })

    it('403 forbidden (non-quota reason): throws plain MailApiError with NO retry', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        return new Response(
          JSON.stringify({ error: { code: 403, message: 'Mail service not enabled', errors: [{ reason: 'forbidden', domain: 'global' }] } }),
          { status: 403 },
        )
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).rejects.toMatchObject({ name: 'MailApiError', status: 403, reason: 'forbidden' })
      expect(calls).toBe(1)
    })

    it('5xx (non-send): retries once after a jittered delay, then throws MailApiError', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }), {
          status: 503,
        })
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).rejects.toMatchObject({ name: 'MailApiError', status: 503 })
      expect(calls).toBe(2)
    })

    it('timeout (non-send): retries once after a jittered delay, then throws typed MailApiError(status 0, reason timeout)', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).rejects.toMatchObject({ name: 'MailApiError', status: 0, reason: 'timeout' })
      expect(calls).toBe(2)
    })

    it('an unrelated thrown error (e.g. AbortError) propagates unchanged, with no retry', async () => {
      let calls = 0
      const original = Object.assign(new Error('aborted'), { name: 'AbortError' })
      const fetchFn = vi.fn(async () => {
        calls += 1
        throw original
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).rejects.toBe(original)
      expect(calls).toBe(1)
    })

    it('404 on an endpoint with no typed mapping (e.g. getThreadMessageIds) surfaces as a plain MailApiError', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ error: { code: 404, errors: [{ reason: 'notFound' }] } }), { status: 404 }),
      ) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getThreadMessageIds('gone-thread')).rejects.toMatchObject({ name: 'MailApiError', status: 404 })
    })

    it('every request carries a hard timeout signal', async () => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return new Response(JSON.stringify({ emailAddress: 'a@b.c', historyId: '1' }), { status: 200 })
      }) as unknown as typeof fetch
      const client = gmailProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await client.profile()
    })
  })

  it('no fixture contains auth material', async () => {
    const dir = new URL('./fixtures/gmail/', import.meta.url)
    for (const f of await readdir(dir)) {
      const text = await readFile(new URL(f, dir), 'utf8')
      expect(text.includes('Bearer '), `${f} contains a bearer token`).toBe(false)
      expect(text.includes('PRIVATE KEY'), `${f} contains key material`).toBe(false)
    }
  })
})
