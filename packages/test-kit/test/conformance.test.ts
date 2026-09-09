import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMockMailbox, gmailProvider, graphProvider } from '@aesa/mail'
import { runMailboxConformance, type ConformanceHarness } from '../src/conformance.ts'

const SELF_ADDRESS = 'support@acme.test'

// ---------------------------------------------------------------------------------------------
// mock-gmail / mock-graph — full-featured harnesses over `createMockMailbox`. Both declare
// `expireCursor` and `supportsSend: true`, so every scenario in `conformance.ts` runs for them.
// ---------------------------------------------------------------------------------------------

function makeMockHarness(mode: 'gmail' | 'graph'): () => Promise<ConformanceHarness> {
  return async () => {
    const mailbox = createMockMailbox({ mode, selfAddress: SELF_ADDRESS })
    return {
      async makeClient() {
        return mailbox
      },
      async seedInbound(m) {
        return mailbox.receiveInbound(m)
      },
      seedInboundMutates: true,
      async expireCursor() {
        mailbox.expireCursor()
      },
      supportsSend: true,
    }
  }
}

runMailboxConformance('mock-gmail', makeMockHarness('gmail'))
runMailboxConformance('mock-graph', makeMockHarness('graph'))

// ---------------------------------------------------------------------------------------------
// fixture-gmail / fixture-graph — the SAME conformance scenarios replayed against real adapter
// code (`gmailProvider`/`graphProvider`) wired to a `fetchFn` that serves canned responses from
// `packages/mail/test/fixtures/{gmail,graph}/`. `supportsSend: false` (no `expireCursor`): a
// canned fixture set can't be forced into a fresh cursor-expiry error, and the reference rule is
// never to send unsolicited mail — there is no real mailbox here to observe or dedupe a resend.
//
// A replay harness's `seedInbound` performs NO mutation (`seedInboundMutates: false`) — it ignores
// its input entirely and returns the identity of a message the fixture set was authored (or
// recorded) to already be able to serve back through
// `listChanges`/`getMessage`/`listMessagesForResync`/`getThreadMessageIds`. Every scenario in
// `conformance.ts` only asserts against the `{ id, threadId }` this returns, so that substitution
// is invisible to the shared scenario code — except for the two scenarios that assert a message's
// EXCLUSION, which `seedInboundMutates: false` tells to skip their negative half entirely (a
// second "seed" against a fixture harness is not a second, isolated message).
//
// The routing below is intentionally NOT a byte-exact replay of each fixture's own recorded
// `request` field (the adapter unit tests in `packages/mail` do that, matching one fixture per
// literal method+path+query). It instead dispatches on (method, path shape, a SIGNIFICANT query
// flag) — e.g. `format=metadata` vs `format=full`, or a `$filter`'s field name rather than its
// exact value — because the conformance scenarios exercise several different literal ids/queries
// with the small, fixed fixture set on disk. Two routes are call-counted rather than
// query-matched (Gmail's `/history`, Graph's per-folder `/messages/delta`): the SAME cursor is
// legitimately queried twice within one scenario (once before seeding, once after), and a canned
// fixture can't vary by "how much time has passed" — only by call order.
// ---------------------------------------------------------------------------------------------

function loadFixture(dir: URL, name: string): { response: { status: number; body: unknown } } {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, dir)), 'utf8')) as { response: { status: number; body: unknown } }
}

function respondWith(fixture: { response: { status: number; body: unknown } }): Response {
  return new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status })
}

/** No harness ever mints this id for a real message — every provider's `getMessage` must map it
 * to a 404 the client's error taxonomy turns into `MessageGoneError`. Matches the constant in
 * `conformance.ts` (`UNKNOWN_MESSAGE_ID`) and the two `error-404-getmessage.json` fixtures. */
const UNKNOWN_MESSAGE_ID = 'does-not-exist-message-id'

function gmailFixtureFetch(dir: URL): typeof fetch {
  const profile = loadFixture(dir, 'profile.json')
  const historyEmpty = loadFixture(dir, 'history-empty.json')
  const historyPage1 = loadFixture(dir, 'history-page1.json')
  const messagesList = loadFixture(dir, 'messages-list.json')
  const threadWalk = loadFixture(dir, 'thread-walk.json')
  const messageMetadata = loadFixture(dir, 'message-metadata.json')
  const messageFull = loadFixture(dir, 'message-full-nested.json')
  const errorGetMessage = loadFixture(dir, 'error-404-getmessage.json')

  // First call to /history in this client's lifetime is a quiet poll; every call after that shows
  // the (already-recorded) history page — no seedInbound-triggered mutation is possible against a
  // canned fixture, so "the poll after seeding" is modeled as "the second call", not by matching
  // on the actual startHistoryId query value both calls happen to share.
  let historyCalls = 0

  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()

    if (method === 'GET' && u.pathname === '/gmail/v1/users/me/profile') return respondWith(profile)

    if (method === 'GET' && u.pathname === '/gmail/v1/users/me/history') {
      historyCalls += 1
      return respondWith(historyCalls === 1 ? historyEmpty : historyPage1)
    }

    if (method === 'GET' && u.pathname === '/gmail/v1/users/me/messages') return respondWith(messagesList)

    if (method === 'GET' && u.pathname.startsWith('/gmail/v1/users/me/threads/')) return respondWith(threadWalk)

    const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(u.pathname)
    if (method === 'GET' && messageMatch) {
      const id = messageMatch[1]
      if (id === UNKNOWN_MESSAGE_ID) return respondWith(errorGetMessage)
      return respondWith(u.searchParams.get('format') === 'metadata' ? messageMetadata : messageFull)
    }

    throw new Error(`gmailFixtureFetch: no route for ${method} ${u.pathname}${u.search}`)
  }) as unknown as typeof fetch
}

type GraphFolder = 'inbox' | 'sentitems' | 'junkemail'

function graphFixtureFetch(dir: URL): typeof fetch {
  const folderFixtures: Record<GraphFolder, { response: { status: number; body: unknown } }> = {
    inbox: loadFixture(dir, 'mailfolder-inbox.json'),
    sentitems: loadFixture(dir, 'mailfolder-sentitems.json'),
    junkemail: loadFixture(dir, 'mailfolder-junkemail.json'),
  }
  const messagesList = loadFixture(dir, 'messages-list.json')
  const threadWalk = loadFixture(dir, 'thread-walk.json')
  const messageMetadata = loadFixture(dir, 'message-metadata.json')
  const messageFull = loadFixture(dir, 'message-full-html.json')
  const errorGetMessage = loadFixture(dir, 'error-404-getmessage.json')
  const inboxContent = loadFixture(dir, 'inbox-delta-page1.json')

  // Per-folder call counter: 1st call is `profile()`'s own `$deltatoken=latest` priming, 2nd is
  // the first `listChanges` poll (quiet — nothing primed since), 3rd+ shows content. Only the
  // inbox folder is ever driven past call #2 by the scenarios below.
  const deltaCalls = new Map<GraphFolder, number>()

  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const method = (init?.method ?? 'GET').toUpperCase()

    if (method === 'GET' && u.pathname === '/v1.0/me') {
      return new Response(JSON.stringify({ mail: SELF_ADDRESS }), { status: 200 })
    }

    const aliasMatch = /^\/v1\.0\/me\/mailFolders\/(inbox|sentitems|junkemail)$/.exec(u.pathname)
    if (method === 'GET' && aliasMatch) {
      return respondWith(folderFixtures[aliasMatch[1] as GraphFolder])
    }

    const deltaMatch = /^\/v1\.0\/me\/mailFolders\/(inbox|sentitems|junkemail)\/messages\/delta$/.exec(u.pathname)
    if (method === 'GET' && deltaMatch) {
      const folder = deltaMatch[1] as GraphFolder
      const count = (deltaCalls.get(folder) ?? 0) + 1
      deltaCalls.set(folder, count)

      if (count === 1) {
        return new Response(
          JSON.stringify({
            value: [],
            '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=primed-${folder}`,
          }),
          { status: 200 },
        )
      }
      if (folder === 'inbox' && count >= 3) return respondWith(inboxContent)
      return new Response(
        JSON.stringify({
          value: [],
          '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=quiet-${folder}-${count}`,
        }),
        { status: 200 },
      )
    }

    if (method === 'GET' && u.pathname === '/v1.0/me/messages') {
      const filter = u.searchParams.get('$filter') ?? ''
      return respondWith(filter.includes('conversationId') ? threadWalk : messagesList)
    }

    const messageMatch = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(u.pathname)
    if (method === 'GET' && messageMatch) {
      const id = messageMatch[1]
      if (id === UNKNOWN_MESSAGE_ID) return respondWith(errorGetMessage)
      return respondWith(u.searchParams.has('$expand') ? messageFull : messageMetadata)
    }

    throw new Error(`graphFixtureFetch: no route for ${method} ${u.pathname}${u.search}`)
  }) as unknown as typeof fetch
}

function makeGmailFixtureHarness(): () => Promise<ConformanceHarness> {
  return async () => {
    const dir = new URL('../../mail/test/fixtures/gmail/', import.meta.url)
    const client = gmailProvider(gmailFixtureFetch(dir)).client('fixture-token', SELF_ADDRESS)
    return {
      async makeClient() {
        return client
      },
      // Ignores the input entirely — see the file header. Matches history-page1.json's arrival
      // record, messages-list.json and thread-walk.json above.
      async seedInbound() {
        return { id: 'msg-a1', threadId: 'thread-a1' }
      },
      seedInboundMutates: false,
      supportsSend: false,
    }
  }
}

function makeGraphFixtureHarness(): () => Promise<ConformanceHarness> {
  return async () => {
    const dir = new URL('../../mail/test/fixtures/graph/', import.meta.url)
    const client = graphProvider(graphFixtureFetch(dir)).client('fixture-token', SELF_ADDRESS)
    return {
      async makeClient() {
        return client
      },
      // Ignores the input entirely — see the file header. Matches inbox-delta-page1.json,
      // messages-list.json and thread-walk.json above.
      async seedInbound() {
        return { id: 'msg-in-1', threadId: 'thread-in-1' }
      },
      seedInboundMutates: false,
      supportsSend: false,
    }
  }
}

runMailboxConformance('fixture-gmail', makeGmailFixtureHarness())
runMailboxConformance('fixture-graph', makeGraphFixtureHarness())
