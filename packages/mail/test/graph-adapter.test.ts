import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { FOLDER_LABELS, graphProvider } from '../src/adapters/graph/index.ts'
import { CursorExpiredError, MailApiError, MessageGoneError, ProviderAuthError } from '../src/errors.ts'

import mailFolderInboxFixture from './fixtures/graph/mailfolder-inbox.json' with { type: 'json' }
import mailFolderSentitemsFixture from './fixtures/graph/mailfolder-sentitems.json' with { type: 'json' }
import mailFolderJunkemailFixture from './fixtures/graph/mailfolder-junkemail.json' with { type: 'json' }
import messageMetadataFixture from './fixtures/graph/message-metadata.json' with { type: 'json' }
import messageFullHtmlFixture from './fixtures/graph/message-full-html.json' with { type: 'json' }
import messageFullDraftFixture from './fixtures/graph/message-full-draft.json' with { type: 'json' }
import error404GetMessageFixture from './fixtures/graph/error-404-getmessage.json' with { type: 'json' }
import error404DeltaFixture from './fixtures/graph/error-404-delta.json' with { type: 'json' }
import error410DeltaFixture from './fixtures/graph/error-410-delta.json' with { type: 'json' }
import error429Fixture from './fixtures/graph/error-429.json' with { type: 'json' }
import inboxDeltaPage1Fixture from './fixtures/graph/inbox-delta-page1.json' with { type: 'json' }
import inboxDeltaPage2Fixture from './fixtures/graph/inbox-delta-page2.json' with { type: 'json' }
import sentitemsDeltaFixture from './fixtures/graph/sentitems-delta.json' with { type: 'json' }
import junkemailDeltaFixture from './fixtures/graph/junkemail-delta.json' with { type: 'json' }
import sendCreateReplyFixture from './fixtures/graph/send-createreply.json' with { type: 'json' }
import sendPatchFixture from './fixtures/graph/send-patch.json' with { type: 'json' }
import sendSendFixture from './fixtures/graph/send-send.json' with { type: 'json' }
import sendExistingDraftNotDraftFixture from './fixtures/graph/send-existing-draft-not-draft.json' with { type: 'json' }

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

/** Matches an incoming request's method+path?query against fixtures' own `request` field — same
 * shape/helper as the Gmail adapter's test (`gmail-adapter.test.ts`), reused verbatim per the
 * task brief's instruction to keep the fixture shape consistent across providers. */
function fixtureFetch(map: Record<string, Fixture>): typeof fetch {
  const byKey = new Map<string, Fixture>()
  for (const fixture of Object.values(map)) {
    byKey.set(buildKey(fixture.request.method, fixture.request.path, fixture.request.query), fixture)
  }
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()
    // Re-serialize through URLSearchParams (not the raw `u.search`) so a query built by hand in a
    // fixture's opaque nextLink/deltaLink string (literal `$`) and one built via
    // `url.searchParams.append()` in `client.ts` (which percent-encodes `$` as `%24`, the
    // application/x-www-form-urlencoded rule) canonicalize to the SAME key either way.
    const qs = u.searchParams.toString()
    const key = `${method} ${u.pathname}${qs ? `?${qs}` : ''}`
    const fixture = byKey.get(key)
    if (!fixture) {
      throw new Error(`fixtureFetch: no fixture registered for "${key}". Known: ${[...byKey.keys()].join(' | ')}`)
    }
    return new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status, headers: fixture.response.headers })
  }) as unknown as typeof fetch
}

describe('graphProvider', () => {
  it('kind is "microsoft"', () => {
    expect(graphProvider().kind).toBe('microsoft')
  })

  it('folder -> label mapping matches the brief exactly', () => {
    expect(FOLDER_LABELS).toEqual({ inbox: ['INBOX'], sentitems: ['SENT'], junkemail: ['JUNK'] })
  })

  describe('OAuth', () => {
    it('authorizationUrl: builds the login.microsoftonline.com/common URL with PKCE params', () => {
      const provider = graphProvider()
      const url = new URL(
        provider.authorizationUrl({
          clientId: 'client-1',
          redirectUri: 'https://api.acme.test/api/auth/callback/microsoft',
          state: 'state-xyz',
          codeChallenge: 'challenge-abc',
          loginHint: 'jane@example.com',
        }),
      )

      expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
      expect(url.searchParams.get('client_id')).toBe('client-1')
      expect(url.searchParams.get('redirect_uri')).toBe('https://api.acme.test/api/auth/callback/microsoft')
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('scope')).toBe('offline_access User.Read Mail.ReadWrite Mail.Send')
      expect(url.searchParams.get('code_challenge')).toBe('challenge-abc')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('state')).toBe('state-xyz')
      expect(url.searchParams.get('login_hint')).toBe('jane@example.com')
    })

    it('authorizationUrl: omits login_hint when not given', () => {
      const url = new URL(graphProvider().authorizationUrl({ clientId: 'c', redirectUri: 'https://x/y', state: 's', codeChallenge: 'ch' }))
      expect(url.searchParams.has('login_hint')).toBe(false)
    })

    it('exchangeCode: POSTs the token endpoint, GETs /me, and derives emailAddress + providerAccountId', async () => {
      let call = 0
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        call += 1
        if (call === 1) {
          expect(String(url)).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
          expect(init?.method).toBe('POST')
          const body = new URLSearchParams(String(init?.body))
          expect(body.get('client_id')).toBe('client-1')
          expect(body.get('client_secret')).toBe('secret-1')
          expect(body.get('redirect_uri')).toBe('https://api.acme.test/callback')
          expect(body.get('code')).toBe('auth-code-1')
          expect(body.get('code_verifier')).toBe('verifier-1')
          expect(body.get('grant_type')).toBe('authorization_code')
          return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }), { status: 200 })
        }
        expect(String(url)).toBe('https://graph.microsoft.com/v1.0/me')
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-1')
        return new Response(
          JSON.stringify({ id: 'ms-oid-1', mail: 'Jane@Example.COM', userPrincipalName: 'jane_example.com#EXT#@x.onmicrosoft.com' }),
          { status: 200 },
        )
      }) as unknown as typeof fetch

      const provider = graphProvider(fetchFn)
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
      expect(result.providerAccountId).toBe('ms-oid-1')
      expect(call).toBe(2)
    })

    it('exchangeCode: falls back to userPrincipalName when `mail` is null', async () => {
      let call = 0
      const fetchFn = vi.fn(async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 })
        return new Response(JSON.stringify({ id: 'oid-2', mail: null, userPrincipalName: 'Jane@Contoso.onmicrosoft.com' }), { status: 200 })
      }) as unknown as typeof fetch
      const result = await graphProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' })
      expect(result.emailAddress).toBe('jane@contoso.onmicrosoft.com')
    })

    it('exchangeCode: missing refresh_token throws ProviderAuthError', async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch
      await expect(
        graphProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' }),
      ).rejects.toBeInstanceOf(ProviderAuthError)
    })

    it('exchangeCode: invalid_grant from the token endpoint throws ProviderAuthError', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70000: bad code' }), { status: 400 }),
      ) as unknown as typeof fetch
      await expect(
        graphProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' }),
      ).rejects.toBeInstanceOf(ProviderAuthError)
    })

    it('exchangeCode: a failing /me fetch throws MailApiError (the token exchange itself succeeded)', async () => {
      let call = 0
      const fetchFn = vi.fn(async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 })
        return new Response('', { status: 500 })
      }) as unknown as typeof fetch
      await expect(
        graphProvider(fetchFn).exchangeCode({ clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v' }),
      ).rejects.toBeInstanceOf(MailApiError)
    })

    it('refresh: POSTs grant_type=refresh_token and returns the ROTATED refresh token', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('refresh_token')).toBe('old-refresh')
        return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }), { status: 200 })
      }) as unknown as typeof fetch

      const result = await graphProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'old-refresh' })
      // The key contract point: Microsoft rotates the refresh token on EVERY refresh — the
      // adapter must hand back the NEW one, unlike Gmail (which doesn't rotate it at all).
      expect(result.refreshToken).toBe('rotated-refresh')
      expect(result.accessToken).toBe('new-access')
      expect(result.accessTokenExpiresAt).toBeInstanceOf(Date)
    })

    it('refresh: falls back to the input refresh token when Microsoft unexpectedly omits one', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }), { status: 200 }),
      ) as unknown as typeof fetch
      const result = await graphProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'old-refresh' })
      expect(result.refreshToken).toBe('old-refresh')
    })

    it('refresh: forwards the caller AbortSignal to fetch', async () => {
      const controller = new AbortController()
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal)
        return new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 })
      }) as unknown as typeof fetch
      await graphProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'r', signal: controller.signal })
    })

    it('refresh: invalid_grant throws ProviderAuthError — reauth_required, not transient', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS700082: refresh token expired' }), { status: 400 }),
      ) as unknown as typeof fetch
      await expect(graphProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })).rejects.toBeInstanceOf(ProviderAuthError)
    })

    it('refresh: a non-invalid_grant failure throws plain MailApiError (transient — credentials.ts retries)', async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 })) as unknown as typeof fetch
      await expect(graphProvider(fetchFn).refresh({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })).rejects.toMatchObject({
        name: 'MailApiError',
        status: 500,
      })
    })

    it('revoke: resolves WITHOUT making any request — Microsoft has no revocation endpoint for this flow', async () => {
      const fetchFn = vi.fn()
      await expect(graphProvider(fetchFn as unknown as typeof fetch).revoke({ clientId: 'c', clientSecret: 's', refreshToken: 'r' })).resolves.toBeUndefined()
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })

  describe('client: profile', () => {
    it('fetches /me for emailAddress, then primes each folder\'s delta cursor to "now" via $deltatoken=latest (no backfill)', async () => {
      const calls: string[] = []
      const fetchFn = vi.fn(async (url: string | URL) => {
        const u = new URL(String(url))
        calls.push(u.pathname)
        if (u.pathname === '/v1.0/me') {
          expect(u.searchParams.get('$select')).toBe('mail,userPrincipalName')
          return new Response(JSON.stringify({ mail: 'Support@Acme.test', userPrincipalName: 'support@acme.test' }), { status: 200 })
        }
        expect(u.searchParams.get('$deltatoken')).toBe('latest')
        expect(u.searchParams.get('$select')).toBe('id,conversationId')
        const folder = u.pathname.split('/')[4]
        return new Response(
          JSON.stringify({
            value: [],
            '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=seed-${folder}`,
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch

      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const result = await client.profile()

      expect(result.emailAddress).toBe('support@acme.test')
      expect(result.cursor).toEqual({
        deltaTokens: {
          inbox: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=seed-inbox',
          sentitems: 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$deltatoken=seed-sentitems',
          junkemail: 'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages/delta?$deltatoken=seed-junkemail',
        },
      })
      expect(calls).toEqual([
        '/v1.0/me',
        '/v1.0/me/mailFolders/inbox/messages/delta',
        '/v1.0/me/mailFolders/sentitems/messages/delta',
        '/v1.0/me/mailFolders/junkemail/messages/delta',
      ])
    })

    it('a folder that returns no deltaLink on priming throws MailApiError (nothing safe to seed the cursor with)', async () => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        const u = new URL(String(url))
        if (u.pathname === '/v1.0/me') return new Response(JSON.stringify({ mail: 'a@b.com' }), { status: 200 })
        return new Response(JSON.stringify({ value: [] }), { status: 200 }) // no @odata.deltaLink
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).rejects.toMatchObject({ name: 'MailApiError' })
    })
  })

  describe('client: listChanges', () => {
    const seedCursor = {
      deltaTokens: {
        inbox: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=seed-inbox',
        sentitems: 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$deltatoken=seed-sent',
        junkemail: 'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages/delta?$deltatoken=seed-junk',
      },
    }

    it('pages across all three folders in order (inbox, sentitems, junkemail); newCursor is set ONLY once every folder has drained', async () => {
      const client = graphProvider(
        fixtureFetch({
          inboxP1: inboxDeltaPage1Fixture,
          inboxP2: inboxDeltaPage2Fixture,
          sent: sentitemsDeltaFixture,
          junk: junkemailDeltaFixture,
        }),
      ).client('tok-1', SELF_ADDRESS)

      const page1 = await client.listChanges(seedCursor)
      expect(page1.records).toEqual([{ id: 'msg-in-1', messageIds: [{ id: 'msg-in-1', threadId: 'thread-in-1' }] }])
      expect(page1.newCursor).toBeUndefined()
      expect(page1.nextPageToken).toBeDefined()

      // still inbox — its own second (draining) page
      const page2 = await client.listChanges(seedCursor, page1.nextPageToken)
      expect(page2.records).toEqual([{ id: 'msg-in-2', messageIds: [{ id: 'msg-in-2', threadId: 'thread-in-2' }] }])
      expect(page2.newCursor).toBeUndefined()
      expect(page2.nextPageToken).toBeDefined()

      // moved on to sentitems, drains in one page
      const page3 = await client.listChanges(seedCursor, page2.nextPageToken)
      expect(page3.records).toEqual([{ id: 'msg-sent-1', messageIds: [{ id: 'msg-sent-1', threadId: 'thread-sent-1' }] }])
      expect(page3.newCursor).toBeUndefined()
      expect(page3.nextPageToken).toBeDefined()

      // moved on to junkemail (the LAST folder) — this is the call that finally sets newCursor
      const page4 = await client.listChanges(seedCursor, page3.nextPageToken)
      expect(page4.records).toEqual([{ id: 'msg-junk-1', messageIds: [{ id: 'msg-junk-1', threadId: 'thread-junk-1' }] }])
      expect(page4.nextPageToken).toBeUndefined()
      expect(page4.newCursor).toEqual({
        deltaTokens: {
          inbox: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=new-inbox',
          sentitems: 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/delta?$deltatoken=new-sent',
          junkemail: 'https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages/delta?$deltatoken=new-junk',
        },
      })
    })

    it('404 SyncStateNotFound on a folder delta -> CursorExpiredError', async () => {
      const client = graphProvider(fixtureFetch({ err: error404DeltaFixture })).client('tok-1', SELF_ADDRESS)
      const cursor = { deltaTokens: { inbox: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired-token-404' } }
      await expect(client.listChanges(cursor)).rejects.toBeInstanceOf(CursorExpiredError)
    })

    it('410 (resync required) on a folder delta -> CursorExpiredError', async () => {
      const client = graphProvider(fixtureFetch({ err: error410DeltaFixture })).client('tok-1', SELF_ADDRESS)
      const cursor = { deltaTokens: { inbox: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired-token-410' } }
      await expect(client.listChanges(cursor)).rejects.toBeInstanceOf(CursorExpiredError)
    })

    it('a missing delta token for the current folder throws MailApiError (caller skipped profile()) without making any request', async () => {
      const fetchFn = vi.fn()
      const client = graphProvider(fetchFn as unknown as typeof fetch).client('tok-1', SELF_ADDRESS)
      await expect(client.listChanges({ deltaTokens: {} })).rejects.toMatchObject({ name: 'MailApiError', reason: 'missingDeltaToken' })
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })

  describe('client: getMessage', () => {
    it('metadata: $select excludes body and $expand entirely, bodyText is null, folder resolves to SENT', async () => {
      const fetchFn = vi.fn(
        fixtureFetch({
          folderInbox: mailFolderInboxFixture,
          folderSent: mailFolderSentitemsFixture,
          folderJunk: mailFolderJunkemailFixture,
          msg: messageMetadataFixture,
        }),
      )
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-meta-1', { format: 'metadata' })

      const msgCall = fetchFn.mock.calls.find(([u]) => String(u).includes('/messages/msg-meta-1'))!
      const calledUrl = new URL(String(msgCall[0]))
      expect(calledUrl.pathname).toBe('/v1.0/me/messages/msg-meta-1')
      expect(calledUrl.searchParams.get('$select')).toBe(
        'internetMessageHeaders,from,toRecipients,ccRecipients,subject,conversationId,receivedDateTime,hasAttachments,isDraft,parentFolderId',
      )
      expect(calledUrl.searchParams.has('$expand')).toBe(false)

      expect(msg.bodyText).toBeNull()
      expect(msg.fromAddr).toBe('support@acme.test')
      expect(msg.toAddrs).toEqual(['jane@example.com'])
      expect(msg.ccAddrs).toEqual([])
      expect(msg.deliveredTo).toEqual(['support@acme.test'])
      expect(msg.subject).toBe("Re: Order #4521 hasn't shipped")
      expect(msg.rfcMessageId).toBe('<graph-marker1@outlook.com>')
      expect(msg.inReplyTo).toBe('<graph-abc123@outlook.com>')
      expect(msg.references).toEqual(['<graph-original-999@outlook.com>', '<graph-abc123@outlook.com>'])
      expect(msg.authenticationResults).toBeNull()
      expect(msg.autoSubmitted).toBe('no')
      expect(msg.precedence).toBeNull()
      expect(msg.listId).toBeNull()
      expect(msg.labelIds).toEqual(['SENT'])
      expect(msg.internalDate).toEqual(new Date('2025-08-25T13:41:40.000Z'))
      expect(msg.hasAttachments).toBe(false)
      expect(msg.attachments).toEqual([])
      expect(msg.markerDraftId).toBe('9f1c2b34-graph-marker')
    })

    it('full (html body): folder resolves to JUNK, html body converted to text and scrubbed, topmost Authentication-Results wins', async () => {
      const fetchFn = vi.fn(
        fixtureFetch({
          folderInbox: mailFolderInboxFixture,
          folderSent: mailFolderSentitemsFixture,
          folderJunk: mailFolderJunkemailFixture,
          msg: messageFullHtmlFixture,
        }),
      )
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-full-1', { format: 'full' })

      expect(msg.id).toBe('msg-full-1')
      expect(msg.threadId).toBe('thread-full-1')
      expect(msg.labelIds).toEqual(['JUNK'])
      expect(msg.fromAddr).toBe('jane@example.com')
      expect(msg.toAddrs).toEqual(['support@acme.test'])
      expect(msg.ccAddrs).toEqual(['billing@example.com']) // Billing@Example.com lowercased
      expect(msg.subject).toBe('Re: Order #4521 double charge')

      // Two Authentication-Results headers on the wire — the TOPMOST (the real stamp) wins.
      expect(msg.authenticationResults).toMatch(/^mx\.outlook\.com/)
      expect(msg.authenticationResults).toContain('dmarc=pass')
      expect(msg.authenticationResults).not.toContain('relay.example.net')

      // html -> text conversion, then the Luhn-valid card number scrubbed.
      expect(msg.bodyText).toContain('Thanks for the update')
      expect(msg.bodyText).toContain('[card removed]')
      expect(msg.bodyText).not.toContain('4111')

      expect(msg.hasAttachments).toBe(true)
      expect(msg.attachments).toEqual([{ filename: 'receipt.pdf', mime: 'application/pdf', size: 45210 }])
    })

    it('isDraft:true overrides the folder mapping to [\'DRAFT\'] regardless of which folder it physically lives in', async () => {
      const fetchFn = vi.fn(
        fixtureFetch({
          folderInbox: mailFolderInboxFixture,
          folderSent: mailFolderSentitemsFixture,
          folderJunk: mailFolderJunkemailFixture,
          msg: messageFullDraftFixture,
        }),
      )
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-draft-1', { format: 'full' })
      expect(msg.labelIds).toEqual(['DRAFT'])
    })

    it('404 becomes MessageGoneError', async () => {
      const fetchFn = vi.fn(fixtureFetch({ err: error404GetMessageFixture }))
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getMessage('gone-1', { format: 'full' })).rejects.toBeInstanceOf(MessageGoneError)
    })

    it('an unresolvable parentFolderId (custom folder outside the three synced ones) maps to an empty labelIds', async () => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        const u = new URL(String(url))
        if (u.pathname === '/v1.0/me/mailFolders/inbox') return new Response(JSON.stringify({ id: 'folder-inbox-id' }), { status: 200 })
        if (u.pathname === '/v1.0/me/mailFolders/sentitems') return new Response(JSON.stringify({ id: 'folder-sent-id' }), { status: 200 })
        if (u.pathname === '/v1.0/me/mailFolders/junkemail') return new Response(JSON.stringify({ id: 'folder-junk-id' }), { status: 200 })
        return new Response(
          JSON.stringify({ id: 'msg-x', conversationId: 'thread-x', isDraft: false, parentFolderId: 'folder-other-id', internetMessageHeaders: [] }),
          { status: 200 },
        )
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-x', { format: 'metadata' })
      expect(msg.labelIds).toEqual([])
    })

    it('resolves a folder purely by ALIAS (GET /me/mailFolders/sentitems), with no displayName in play, and a parentFolderId matching that resolved id maps to [\'SENT\']', async () => {
      const calledPaths: string[] = []
      const fetchFn = vi.fn(async (url: string | URL) => {
        const u = new URL(String(url))
        calledPaths.push(u.pathname)
        // Each folder-resolution response carries ONLY {id} — no `displayName` field exists
        // anywhere in this stub, proving resolution needs none.
        if (u.pathname === '/v1.0/me/mailFolders/inbox') {
          expect(u.searchParams.get('$select')).toBe('id')
          return new Response(JSON.stringify({ id: 'locale-inbox-id' }), { status: 200 })
        }
        if (u.pathname === '/v1.0/me/mailFolders/sentitems') {
          expect(u.searchParams.get('$select')).toBe('id')
          return new Response(JSON.stringify({ id: 'locale-sent-id' }), { status: 200 })
        }
        if (u.pathname === '/v1.0/me/mailFolders/junkemail') {
          expect(u.searchParams.get('$select')).toBe('id')
          return new Response(JSON.stringify({ id: 'locale-junk-id' }), { status: 200 })
        }
        // The message itself lives in the folder Graph resolved for "sentitems" — its
        // `displayName` (in a non-English locale, e.g. "Éléments envoyés") never enters this test
        // at all, since nothing here ever reads or compares it.
        return new Response(
          JSON.stringify({
            id: 'msg-locale-1',
            conversationId: 'thread-locale-1',
            isDraft: false,
            parentFolderId: 'locale-sent-id',
            internetMessageHeaders: [],
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch

      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const msg = await client.getMessage('msg-locale-1', { format: 'metadata' })
      expect(msg.labelIds).toEqual(['SENT'])
      expect(calledPaths).toContain('/v1.0/me/mailFolders/inbox')
      expect(calledPaths).toContain('/v1.0/me/mailFolders/sentitems')
      expect(calledPaths).toContain('/v1.0/me/mailFolders/junkemail')
    })
  })

  describe('client: sendReply', () => {
    it('two-phase happy path: createReply -> PATCH (body + from + marker) -> send; returns {id, threadId, providerDraftId} all keyed off the draft', async () => {
      const fetchFn = vi.fn(
        fixtureFetch({ createReply: sendCreateReplyFixture, patch: sendPatchFixture, send: sendSendFixture }),
      )
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)

      const result = await client.sendReply({
        threadId: 'thread-ignored-by-graph',
        to: 'jane@example.com',
        subject: 'Broken leash',
        inReplyTo: '<abc@mail.example.com>',
        references: '<root@x> <abc@mail.example.com>',
        bodyText: 'Hi Jane,\n\nSorry about that.',
        from: 'sales@acme.test',
        replyToProviderMessageId: 'msg-reply-target-1',
        extraHeaders: { 'X-Aesa-Draft': 'draft-abc-123' },
      })

      // threadId comes from createReply's OWN response (the real conversationId), not the input.
      expect(result).toEqual({ id: 'draft-1', threadId: 'thread-100', providerDraftId: 'draft-1' })
      expect(fetchFn).toHaveBeenCalledTimes(3)

      const [, createInit] = fetchFn.mock.calls[0]!
      expect(createInit?.method).toBe('POST')

      const [, patchInit] = fetchFn.mock.calls[1]!
      expect(patchInit?.method).toBe('PATCH')
      const patchBody = JSON.parse(String(patchInit?.body)) as {
        body: { contentType: string; content: string }
        from?: { emailAddress: { address: string } }
        singleValueExtendedProperties?: { id: string; value: string }[]
      }
      expect(patchBody.body).toEqual({ contentType: 'text', content: 'Hi Jane,\n\nSorry about that.' })
      expect(patchBody.from).toEqual({ emailAddress: { address: 'sales@acme.test' } })
      // The test only requires the marker VALUE to appear in the PATCH body — see the report for
      // which PS_INTERNET_HEADERS property-id syntax was chosen and why.
      expect(patchBody.singleValueExtendedProperties).toHaveLength(1)
      expect(patchBody.singleValueExtendedProperties![0]!.value).toBe('draft-abc-123')
      expect(patchBody.singleValueExtendedProperties![0]!.id).toContain('X-Aesa-Draft')

      const [, sendInit] = fetchFn.mock.calls[2]!
      expect(sendInit?.method).toBe('POST')
      expect(sendInit?.body).toBeUndefined()
    })

    it('omits singleValueExtendedProperties when no marker header is given, but still stamps `from` with selfAddress (the fallback)', async () => {
      const fetchFn = vi.fn(fixtureFetch({ createReply: sendCreateReplyFixture, patch: sendPatchFixture, send: sendSendFixture }))
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await client.sendReply({
        threadId: 't',
        to: 'jane@example.com',
        subject: 'x',
        inReplyTo: '<a@b>',
        references: '<a@b>',
        bodyText: 'hi',
        replyToProviderMessageId: 'msg-reply-target-1',
      })
      const [, patchInit] = fetchFn.mock.calls[1]!
      const patchBody = JSON.parse(String(patchInit?.body)) as Record<string, unknown>
      expect(patchBody.singleValueExtendedProperties).toBeUndefined()
      // `CreateGraphClientOptions.selfAddress` docstring promises this is stamped as `from`
      // whenever the input doesn't override it — no `r.from` was given here, so it must fall back.
      expect(patchBody.from).toEqual({ emailAddress: { address: SELF_ADDRESS } })
    })

    it('an explicit `from` on the input overrides the selfAddress fallback', async () => {
      const fetchFn = vi.fn(fixtureFetch({ createReply: sendCreateReplyFixture, patch: sendPatchFixture, send: sendSendFixture }))
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await client.sendReply({
        threadId: 't',
        to: 'jane@example.com',
        subject: 'x',
        inReplyTo: '<a@b>',
        references: '<a@b>',
        bodyText: 'hi',
        from: 'sales@acme.test',
        replyToProviderMessageId: 'msg-reply-target-1',
      })
      const [, patchInit] = fetchFn.mock.calls[1]!
      const patchBody = JSON.parse(String(patchInit?.body)) as Record<string, unknown>
      expect(patchBody.from).toEqual({ emailAddress: { address: 'sales@acme.test' } })
    })

    it('re-entry: existingDraftId + isDraft:false (already sent by a previous, interrupted attempt) returns without sending again', async () => {
      const fetchFn = vi.fn(fixtureFetch({ existing: sendExistingDraftNotDraftFixture }))
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)

      const result = await client.sendReply({
        threadId: 'thread-ignored',
        to: 'jane@example.com',
        subject: 'x',
        inReplyTo: '<a@b>',
        references: '<a@b>',
        bodyText: 'hi',
        existingDraftId: 'existing-draft-1',
      })

      expect(result).toEqual({ id: 'existing-draft-1', threadId: 'thread-200', providerDraftId: 'existing-draft-1' })
      expect(fetchFn).toHaveBeenCalledTimes(1) // only the re-entry GET — no PATCH, no send
    })

    it('missing replyToProviderMessageId (and no existingDraftId) throws MailApiError 400 with no fetch made', async () => {
      const fetchFn = vi.fn()
      const client = graphProvider(fetchFn as unknown as typeof fetch).client('tok-1', SELF_ADDRESS)
      await expect(
        client.sendReply({ threadId: 't', to: 'a@b.com', subject: 's', inReplyTo: '<a@b>', references: '<a@b>', bodyText: 'x' }),
      ).rejects.toMatchObject({ name: 'MailApiError', status: 400 })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it("is EXCLUDED from the 5xx retry: the final /send POST is attempted exactly once", async () => {
      let sendCalls = 0
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url))
        if (u.pathname.endsWith('/createReply')) return new Response(JSON.stringify({ id: 'draft-1', conversationId: 'thread-100' }), { status: 201 })
        if (init?.method === 'PATCH') return new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 })
        if (u.pathname.endsWith('/send')) {
          sendCalls += 1
          return new Response(JSON.stringify({ error: { code: 'ServiceUnavailable' } }), { status: 503 })
        }
        throw new Error(`unexpected request ${String(url)}`)
      }) as unknown as typeof fetch

      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(
        client.sendReply({
          threadId: 'thread-100',
          to: 'jane@example.com',
          subject: 'x',
          inReplyTo: '<a@b>',
          references: '<a@b>',
          bodyText: 'test',
          replyToProviderMessageId: 'msg-reply-target-1',
        }),
      ).rejects.toMatchObject({ name: 'MailApiError', status: 503 })
      expect(sendCalls).toBe(1)
    })

    it('is EXCLUDED from the timeout retry: a timed-out send is attempted exactly once', async () => {
      let sendCalls = 0
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url))
        if (u.pathname.endsWith('/createReply')) return new Response(JSON.stringify({ id: 'draft-1', conversationId: 'thread-100' }), { status: 201 })
        if (init?.method === 'PATCH') return new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 })
        if (u.pathname.endsWith('/send')) {
          sendCalls += 1
          throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
        }
        throw new Error(`unexpected request ${String(url)}`)
      }) as unknown as typeof fetch

      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(
        client.sendReply({
          threadId: 'thread-100',
          to: 'jane@example.com',
          subject: 'x',
          inReplyTo: '<a@b>',
          references: '<a@b>',
          bodyText: 'test',
          replyToProviderMessageId: 'msg-reply-target-1',
        }),
      ).rejects.toMatchObject({ name: 'MailApiError', status: 0, reason: 'timeout' })
      expect(sendCalls).toBe(1)
    })

    describe('onDraftCreated', () => {
      it('is awaited with the createReply draft id BEFORE the PATCH fires', async () => {
        const fetchFn = vi.fn(fixtureFetch({ createReply: sendCreateReplyFixture, patch: sendPatchFixture, send: sendSendFixture }))
        const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
        const onDraftCreated = vi.fn(async (id: string) => {
          // Call order proof: only the createReply request has fired when this runs.
          expect(id).toBe('draft-1')
          expect(fetchFn).toHaveBeenCalledTimes(1)
          const [, createInit] = fetchFn.mock.calls[0]!
          expect(createInit?.method).toBe('POST')
        })

        const result = await client.sendReply({
          threadId: 'thread-ignored',
          to: 'jane@example.com',
          subject: 'x',
          inReplyTo: '<a@b>',
          references: '<a@b>',
          bodyText: 'hi',
          replyToProviderMessageId: 'msg-reply-target-1',
          onDraftCreated,
        })

        expect(onDraftCreated).toHaveBeenCalledTimes(1)
        expect(result).toEqual({ id: 'draft-1', threadId: 'thread-100', providerDraftId: 'draft-1' })
        expect(fetchFn).toHaveBeenCalledTimes(3) // createReply, PATCH, send — all still ran
      })

      it('a throwing callback aborts the send before the PATCH', async () => {
        const fetchFn = vi.fn(fixtureFetch({ createReply: sendCreateReplyFixture, patch: sendPatchFixture, send: sendSendFixture }))
        const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
        const boom = new Error('persist failed')

        await expect(
          client.sendReply({
            threadId: 'thread-ignored',
            to: 'jane@example.com',
            subject: 'x',
            inReplyTo: '<a@b>',
            references: '<a@b>',
            bodyText: 'hi',
            replyToProviderMessageId: 'msg-reply-target-1',
            onDraftCreated: async () => {
              throw boom
            },
          }),
        ).rejects.toBe(boom)

        // Only the createReply call happened — the throw aborted before the PATCH and the send.
        expect(fetchFn).toHaveBeenCalledTimes(1)
      })

      it('is never called on the existingDraftId re-entry path', async () => {
        const fetchFn = vi.fn(fixtureFetch({ existing: sendExistingDraftNotDraftFixture }))
        const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
        const onDraftCreated = vi.fn(async () => {})

        const result = await client.sendReply({
          threadId: 'thread-ignored',
          to: 'jane@example.com',
          subject: 'x',
          inReplyTo: '<a@b>',
          references: '<a@b>',
          bodyText: 'hi',
          existingDraftId: 'existing-draft-1',
          onDraftCreated,
        })

        expect(result).toEqual({ id: 'existing-draft-1', threadId: 'thread-200', providerDraftId: 'existing-draft-1' })
        expect(onDraftCreated).not.toHaveBeenCalled()
      })
    })
  })

  describe('client: subscribe / renewSubscription / unsubscribe', () => {
    it('subscribe: POSTs /subscriptions for /me/messages with a ~4230-minute expiry', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://graph.microsoft.com/v1.0/subscriptions')
        expect(init?.method).toBe('POST')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.changeType).toBe('created')
        expect(body.notificationUrl).toBe('https://api.acme.test/webhooks/graph')
        expect(body.resource).toBe('/me/messages')
        expect(body.clientState).toBe('state-abc')
        const expiry = new Date(body.expirationDateTime as string)
        const deltaMinutes = (expiry.getTime() - Date.now()) / 60_000
        expect(deltaMinutes).toBeGreaterThan(4229)
        expect(deltaMinutes).toBeLessThanOrEqual(4230)
        return new Response(JSON.stringify({ id: 'sub-1', expirationDateTime: expiry.toISOString() }), { status: 201 })
      }) as unknown as typeof fetch

      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const result = await client.subscribe({ topicOrUrl: 'https://api.acme.test/webhooks/graph', clientState: 'state-abc' })
      expect(result.subscriptionId).toBe('sub-1')
      expect(result.expiresAt).toBeInstanceOf(Date)
    })

    it('renewSubscription: PATCHes /subscriptions/{id} with a fresh expirationDateTime', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://graph.microsoft.com/v1.0/subscriptions/sub-1')
        expect(init?.method).toBe('PATCH')
        const body = JSON.parse(String(init?.body)) as { expirationDateTime: string }
        return new Response(JSON.stringify({ id: 'sub-1', expirationDateTime: body.expirationDateTime }), { status: 200 })
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.renewSubscription('sub-1')).resolves.toMatchObject({ subscriptionId: 'sub-1' })
    })

    it('unsubscribe: DELETEs /subscriptions/{id}', async () => {
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://graph.microsoft.com/v1.0/subscriptions/sub-1')
        expect(init?.method).toBe('DELETE')
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.unsubscribe('sub-1')).resolves.toBeUndefined()
    })
  })

  describe('client: listMessagesForResync / getThreadMessageIds', () => {
    it('listMessagesForResync: a date-only $filter (no address terms — the sync walk filters those later), paginated via nextLink', async () => {
      let call = 0
      const fetchFn = vi.fn(async (url: string | URL) => {
        call += 1
        const u = new URL(String(url))
        if (call === 1) {
          expect(u.pathname).toBe('/v1.0/me/messages')
          expect(u.searchParams.get('$filter')).toMatch(/^receivedDateTime ge \d{4}-\d{2}-\d{2}T/)
          expect(u.searchParams.get('$select')).toBe('id,conversationId')
          expect(u.searchParams.get('$top')).toBe('50')
          return new Response(
            JSON.stringify({ value: [{ id: 'm1', conversationId: 't1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=p2' }),
            { status: 200 },
          )
        }
        expect(String(url)).toBe('https://graph.microsoft.com/v1.0/me/messages?$skiptoken=p2')
        return new Response(JSON.stringify({ value: [{ id: 'm2', conversationId: 't2' }] }), { status: 200 })
      }) as unknown as typeof fetch

      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      const page1 = await client.listMessagesForResync(['a@acme.test', 'b@acme.test'], 30)
      expect(page1.ids).toEqual([{ id: 'm1', threadId: 't1' }])
      expect(page1.nextPageToken).toBe('https://graph.microsoft.com/v1.0/me/messages?$skiptoken=p2')

      const page2 = await client.listMessagesForResync(['a@acme.test', 'b@acme.test'], 30, page1.nextPageToken)
      expect(page2.ids).toEqual([{ id: 'm2', threadId: 't2' }])
      expect(page2.nextPageToken).toBeUndefined()
    })

    it('getThreadMessageIds: filters by conversationId, drains all pages internally, returns id-only entries', async () => {
      let call = 0
      const fetchFn = vi.fn(async (url: string | URL) => {
        call += 1
        const u = new URL(String(url))
        if (call === 1) {
          expect(u.pathname).toBe('/v1.0/me/messages')
          expect(u.searchParams.get('$filter')).toBe("conversationId eq 'thread-9'")
          expect(u.searchParams.get('$select')).toBe('id')
          return new Response(
            JSON.stringify({ value: [{ id: 'm1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=p2' }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ value: [{ id: 'm2' }] }), { status: 200 })
      }) as unknown as typeof fetch

      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getThreadMessageIds('thread-9')).resolves.toEqual([{ id: 'm1' }, { id: 'm2' }])
    })
  })

  describe('client: findSentByMarker', () => {
    /** Each entry in `pages` is one server response page (in `$orderby=receivedDateTime desc`
     * order); every page but the last carries a fabricated `@odata.nextLink`. */
    function findMarkerFetch(pages: { id: string; markerValue?: string }[][]): typeof fetch {
      let call = 0
      return (async (url: string | URL) => {
        const page = pages[call]
        if (!page) throw new Error(`findMarkerFetch: unexpected call #${call} to ${String(url)}`)
        call += 1
        const value = page.map((m) => ({
          id: m.id,
          internetMessageHeaders: m.markerValue !== undefined ? [{ name: 'X-Aesa-Draft', value: m.markerValue }] : [],
        }))
        const body: Record<string, unknown> = { value }
        if (call < pages.length) body['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page-${call}`
        return new Response(JSON.stringify(body), { status: 200 })
      }) as unknown as typeof fetch
    }

    it('matches the newest candidate', async () => {
      const client = graphProvider(
        findMarkerFetch([[{ id: 'm3', markerValue: 'draft-x' }, { id: 'm2' }, { id: 'm1' }]]),
      ).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-x', 5)).resolves.toBe('m3')
    })

    it('matches an older candidate still within scanLimit', async () => {
      const client = graphProvider(
        findMarkerFetch([[{ id: 'm4' }, { id: 'm3' }, { id: 'm2', markerValue: 'draft-y' }, { id: 'm1' }]]),
      ).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-y', 3)).resolves.toBe('m2')
    })

    it('no match, thread fully examined (size <= scanLimit) -> null', async () => {
      const client = graphProvider(findMarkerFetch([[{ id: 'm2' }, { id: 'm1' }]])).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-none', 5)).resolves.toBeNull()
    })

    it('no match with candidates REMAINING beyond scanLimit -> throws MailApiError("thread too busy", 429)', async () => {
      const client = graphProvider(
        findMarkerFetch([[{ id: 'm5' }, { id: 'm4' }, { id: 'm3' }, { id: 'm2' }, { id: 'm1' }]]),
      ).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-none', 2)).rejects.toMatchObject({
        name: 'MailApiError',
        message: 'thread too busy',
        status: 429,
      })
    })

    it('paginates via @odata.nextLink, matching an older candidate on the second page', async () => {
      const client = graphProvider(
        findMarkerFetch([[{ id: 'm2' }, { id: 'm1' }], [{ id: 'm0', markerValue: 'draft-z' }]]),
      ).client('tok-1', SELF_ADDRESS)
      await expect(client.findSentByMarker('t1', 'draft-z', 5)).resolves.toBe('m0')
    })
  })

  describe('client: error taxonomy', () => {
    it('401: throws ProviderAuthError with NO retry', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { code: 'InvalidAuthenticationToken', message: 'bad token' } }), { status: 401 })
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('stale-tok', SELF_ADDRESS)
      await expect(client.getThreadMessageIds('t1')).rejects.toBeInstanceOf(ProviderAuthError)
      expect(calls).toBe(1)
    })

    it('429: retries once after a jittered delay, then throws ProviderRateLimitError honouring Retry-After', async () => {
      const fetchFn = vi.fn(fixtureFetch({ err: error429Fixture }))
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.profile()).rejects.toMatchObject({ name: 'ProviderRateLimitError', retryAfterMs: 45_000 })
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('5xx (non-send): retries once after a jittered delay, then throws MailApiError', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { code: 'InternalServerError', message: 'oops' } }), { status: 503 })
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getThreadMessageIds('t1')).rejects.toMatchObject({ name: 'MailApiError', status: 503 })
      expect(calls).toBe(2)
    })

    it('timeout (non-send): retries once after a jittered delay, then throws typed MailApiError(status 0, reason timeout)', async () => {
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getThreadMessageIds('t1')).rejects.toMatchObject({ name: 'MailApiError', status: 0, reason: 'timeout' })
      expect(calls).toBe(2)
    })

    it('an unrelated thrown error (e.g. AbortError) propagates unchanged, with no retry', async () => {
      const original = Object.assign(new Error('aborted'), { name: 'AbortError' })
      let calls = 0
      const fetchFn = vi.fn(async () => {
        calls += 1
        throw original
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await expect(client.getThreadMessageIds('t1')).rejects.toBe(original)
      expect(calls).toBe(1)
    })

    it('every request carries Prefer: IdType="ImmutableId" and a hard timeout signal', async () => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect((init?.headers as Record<string, string>).Prefer).toBe('IdType="ImmutableId"')
        return new Response(JSON.stringify({ value: [] }), { status: 200 })
      }) as unknown as typeof fetch
      const client = graphProvider(fetchFn).client('tok-1', SELF_ADDRESS)
      await client.getThreadMessageIds('t1')
    })
  })

  it('no fixture contains auth material', async () => {
    const dir = new URL('./fixtures/graph/', import.meta.url)
    for (const f of await readdir(dir)) {
      const text = await readFile(new URL(f, dir), 'utf8')
      expect(text.includes('Bearer '), `${f} contains a bearer token`).toBe(false)
      expect(text.includes('PRIVATE KEY'), `${f} contains key material`).toBe(false)
    }
  })
})
