/**
 * Task 18: the Gmail Pub/Sub and Microsoft Graph inbound webhooks. Neither route carries a session —
 * each test mints no real provider credential: Gmail's OIDC verification is replaced by
 * `ServerDeps.verifyGoogleJwt` (except one test, which deliberately exercises the real `jose` path
 * against a garbage token to prove it fails fast with no network JWKS fetch); Graph's `clientState` is
 * real (`hashToken('action', …)`, the same kind mailbox-renew-watch.ts stores), since that check is
 * pure and needs no network at all.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken } from '@aesa/crypto'
import { mailboxConnections } from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import type { EnqueueFn, ServerDeps } from '../src/deps.ts'
import { createTestApi } from './helpers/app.ts'

interface EnqueueCall { name: string; data: { orgId: string } & Record<string, unknown>; opts: { entityId: string; debounceSeconds?: number } }

function createRecordingEnqueue(): { fn: EnqueueFn; calls: EnqueueCall[] } {
  const calls: EnqueueCall[] = []
  const fn: EnqueueFn = async (name, data, opts) => { calls.push({ name, data, opts }); return `job-${calls.length}` }
  return { fn, calls }
}

/** Bypasses Better Auth's sign-in flow entirely — these tests only need a row that
 * `mailbox_connections.connected_by_user_id` can reference, not a real session. */
async function insertUser(t: Awaited<ReturnType<typeof createTestApi>>, email: string): Promise<string> {
  const { rows } = await t.handle.pool.query<{ id: string }>('INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id', ['Test User', email])
  return rows[0]!.id
}

async function insertMailboxConnection(
  t: Awaited<ReturnType<typeof createTestApi>>,
  orgId: string,
  userId: string,
  fields: { provider: 'gmail' | 'microsoft'; emailAddress: string; pushSubscriptionId?: string; pushClientStateHash?: string | null },
): Promise<string> {
  const [row] = await t.api.withOrg(orgId, (tx) =>
    tx.insert(mailboxConnections).values({
      orgId,
      provider: fields.provider,
      providerAccountId: `acct-${randomUUID()}`,
      emailAddress: fields.emailAddress,
      status: 'connected',
      pushSubscriptionId: fields.pushSubscriptionId ?? null,
      pushClientStateHash: fields.pushClientStateHash ?? null,
      connectedByUserId: userId,
    }).returning(),
  )
  return row!.id
}

const gmailData = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64')

describe('POST /webhooks/gmail', () => {
  const SERVICE_ACCOUNT = 'pubsub-sa@project.iam.gserviceaccount.com'
  const GMAIL_ENV = { GMAIL_PUBSUB_AUDIENCE: 'test-audience', GMAIL_PUBSUB_SA_EMAIL: SERVICE_ACCOUNT }

  describe('armed, with a stubbed OIDC verifier', () => {
    let t: Awaited<ReturnType<typeof createTestApi>>
    let enqueueCalls: EnqueueCall[]
    let verifyImpl: NonNullable<ServerDeps['verifyGoogleJwt']>
    let orgId: string
    let connectionId: string

    beforeAll(async () => {
      const rec = createRecordingEnqueue()
      enqueueCalls = rec.calls
      verifyImpl = async () => ({ email: SERVICE_ACCOUNT, email_verified: true })
      // A stable wrapper is what registerGmailWebhook captures once at server-build time; it forwards
      // to `verifyImpl` fresh on every call, so individual tests below can swap behavior mid-suite —
      // same trick connect-flow.test.ts uses for `mailProviders`.
      t = await createTestApi(GMAIL_ENV, { enqueue: rec.fn, verifyGoogleJwt: (jwt) => verifyImpl(jwt) })
      orgId = randomUUID()
      const userId = await insertUser(t, 'owner-gmail@acme.test')
      connectionId = await insertMailboxConnection(t, orgId, userId, { provider: 'gmail', emailAddress: 'support@acme.test' })
    })
    afterAll(async () => { await t.close() })

    it('happy path verifies the bearer token, resolves the mailbox, and enqueues a debounced mailbox.sync', async () => {
      const res = await t.app.inject({
        method: 'POST', url: '/webhooks/gmail',
        headers: { authorization: 'Bearer good-token', 'content-type': 'application/json' },
        payload: { message: { messageId: 'msg-happy', data: gmailData({ emailAddress: 'support@acme.test', historyId: 555 }) } },
      })
      expect(res.statusCode).toBe(200)
      const call = enqueueCalls.find((c) => c.name === JOB_NAMES.mailboxSync && c.data.connectionId === connectionId)
      expect(call).toBeDefined()
      expect(call!.data.orgId).toBe(orgId)
      expect(call!.opts).toMatchObject({ entityId: connectionId, debounceSeconds: 10 })
    })

    it('a token that fails OIDC verification (e.g. the wrong audience) 403s and enqueues nothing', async () => {
      verifyImpl = async () => { throw new Error('aud mismatch') }
      const before = enqueueCalls.length
      const res = await t.app.inject({
        method: 'POST', url: '/webhooks/gmail',
        headers: { authorization: 'Bearer bad-audience-token', 'content-type': 'application/json' },
        payload: { message: { messageId: 'msg-bad-aud', data: gmailData({ emailAddress: 'support@acme.test', historyId: 556 }) } },
      })
      expect(res.statusCode).toBe(403)
      expect(enqueueCalls.length).toBe(before)
      verifyImpl = async () => ({ email: SERVICE_ACCOUNT, email_verified: true }) // restore for the tests below
    })

    it('a replayed messageId 200s without enqueuing a second sync', async () => {
      const payload = { message: { messageId: 'msg-dup', data: gmailData({ emailAddress: 'support@acme.test', historyId: 557 }) } }
      const headers = { authorization: 'Bearer good-token', 'content-type': 'application/json' }
      const first = await t.app.inject({ method: 'POST', url: '/webhooks/gmail', headers, payload })
      expect(first.statusCode).toBe(200)
      const afterFirst = enqueueCalls.filter((c) => c.name === JOB_NAMES.mailboxSync).length

      const second = await t.app.inject({ method: 'POST', url: '/webhooks/gmail', headers, payload })
      expect(second.statusCode).toBe(200)
      const afterSecond = enqueueCalls.filter((c) => c.name === JOB_NAMES.mailboxSync).length
      expect(afterSecond).toBe(afterFirst)
    })

    it('an unknown mailbox address 200s (ack, so Pub/Sub stops redelivering) without enqueuing', async () => {
      const before = enqueueCalls.length
      const res = await t.app.inject({
        method: 'POST', url: '/webhooks/gmail',
        headers: { authorization: 'Bearer good-token', 'content-type': 'application/json' },
        payload: { message: { messageId: 'msg-unknown', data: gmailData({ emailAddress: 'nobody@nowhere.test', historyId: 558 }) } },
      })
      expect(res.statusCode).toBe(200)
      expect(enqueueCalls.length).toBe(before)
    })
  })

  it('unset GMAIL_PUBSUB_* config 404s — the endpoint is not armed', async () => {
    const t = await createTestApi()
    try {
      const res = await t.app.inject({
        method: 'POST', url: '/webhooks/gmail',
        headers: { 'content-type': 'application/json' },
        payload: { message: { messageId: 'x', data: gmailData({ emailAddress: 'a@b.test', historyId: 1 }) } },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })

  it('the real jose verifier (no seam override) fails fast on a structurally invalid token — no network JWKS fetch', async () => {
    const t = await createTestApi(GMAIL_ENV)
    try {
      const start = Date.now()
      const res = await t.app.inject({
        method: 'POST', url: '/webhooks/gmail',
        headers: { authorization: 'Bearer not-a-jwt', 'content-type': 'application/json' },
        payload: { message: { messageId: 'x', data: gmailData({ emailAddress: 'a@b.test', historyId: 1 }) } },
      })
      expect(res.statusCode).toBe(403)
      // A structurally invalid compact JWS is rejected by jose before it ever resolves a key from the
      // remote JWKS — confirmed separately (0ms, JWSInvalid) — so this stays fast with no network access.
      expect(Date.now() - start).toBeLessThan(2000)
    } finally {
      await t.close()
    }
  }, 10_000)
})

describe('POST /webhooks/microsoft', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let enqueueCalls: EnqueueCall[]
  let orgId: string
  let userId: string

  beforeAll(async () => {
    const rec = createRecordingEnqueue()
    enqueueCalls = rec.calls
    t = await createTestApi({}, { enqueue: rec.fn })
    orgId = randomUUID()
    userId = await insertUser(t, 'owner-ms@acme.test')
  })
  afterAll(async () => { await t.close() })

  it('the subscription validation handshake echoes ?validationToken= as text/plain', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/webhooks/microsoft?validationToken=abc123' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.body).toBe('abc123')
  })

  it('a matching clientState enqueues a debounced mailbox.sync and 202s', async () => {
    const token = 'graph-token-good'
    const connectionId = await insertMailboxConnection(t, orgId, userId, {
      provider: 'microsoft', emailAddress: 'support-ms-good@acme.test',
      pushSubscriptionId: 'sub-good', pushClientStateHash: hashToken('action', token),
    })
    const before = enqueueCalls.length
    const res = await t.app.inject({
      method: 'POST', url: '/webhooks/microsoft', headers: { 'content-type': 'application/json' },
      payload: { value: [{ subscriptionId: 'sub-good', clientState: token, changeType: 'created', resourceData: { id: 'msg-good' } }] },
    })
    expect(res.statusCode).toBe(202)
    const call = enqueueCalls.slice(before).find((c) => c.name === JOB_NAMES.mailboxSync && c.data.connectionId === connectionId)
    expect(call).toBeDefined()
    expect(call!.data.orgId).toBe(orgId)
    expect(call!.opts).toMatchObject({ entityId: connectionId, debounceSeconds: 10 })
  })

  it('a wrong clientState skips that item (constant-time check fails, warns) but still 202s with no enqueue', async () => {
    await insertMailboxConnection(t, orgId, userId, {
      provider: 'microsoft', emailAddress: 'support-ms-wrong@acme.test',
      pushSubscriptionId: 'sub-wrong', pushClientStateHash: hashToken('action', 'the-real-token'),
    })
    const before = enqueueCalls.length
    const res = await t.app.inject({
      method: 'POST', url: '/webhooks/microsoft', headers: { 'content-type': 'application/json' },
      payload: { value: [{ subscriptionId: 'sub-wrong', clientState: 'an-attacker-guess', changeType: 'created', resourceData: { id: 'msg-wrong' } }] },
    })
    expect(res.statusCode).toBe(202)
    expect(enqueueCalls.length).toBe(before)
  })

  it('an unresolvable subscriptionId is skipped (no match, no enqueue) but still 202s', async () => {
    const before = enqueueCalls.length
    const res = await t.app.inject({
      method: 'POST', url: '/webhooks/microsoft', headers: { 'content-type': 'application/json' },
      payload: { value: [{ subscriptionId: 'sub-does-not-exist', clientState: 'whatever', changeType: 'created', resourceData: { id: 'msg-x' } }] },
    })
    expect(res.statusCode).toBe(202)
    expect(enqueueCalls.length).toBe(before)
  })

  it('a batch with one good item and one bad item enqueues exactly once and still 202s (never 500s the whole batch)', async () => {
    const goodToken = 'graph-token-mixed-good'
    const goodConnectionId = await insertMailboxConnection(t, orgId, userId, {
      provider: 'microsoft', emailAddress: 'support-ms-mixed-good@acme.test',
      pushSubscriptionId: 'sub-mixed-good', pushClientStateHash: hashToken('action', goodToken),
    })
    await insertMailboxConnection(t, orgId, userId, {
      provider: 'microsoft', emailAddress: 'support-ms-mixed-bad@acme.test',
      pushSubscriptionId: 'sub-mixed-bad', pushClientStateHash: hashToken('action', 'expected-token'),
    })
    const before = enqueueCalls.length
    const res = await t.app.inject({
      method: 'POST', url: '/webhooks/microsoft', headers: { 'content-type': 'application/json' },
      payload: {
        value: [
          { subscriptionId: 'sub-mixed-good', clientState: goodToken, changeType: 'created', resourceData: { id: 'msg-mixed-good' } },
          { subscriptionId: 'sub-mixed-bad', clientState: 'wrong-guess', changeType: 'created', resourceData: { id: 'msg-mixed-bad' } },
        ],
      },
    })
    expect(res.statusCode).toBe(202)
    const newSyncCalls = enqueueCalls.slice(before).filter((c) => c.name === JOB_NAMES.mailboxSync)
    expect(newSyncCalls).toHaveLength(1)
    expect(newSyncCalls[0]!.data.connectionId).toBe(goodConnectionId)
  })

  it('a re-notification with the same subscriptionId/resourceData.id dedupes away (the poll sweep is the safety net)', async () => {
    const token = 'graph-token-redup'
    const connectionId = await insertMailboxConnection(t, orgId, userId, {
      provider: 'microsoft', emailAddress: 'support-ms-redup@acme.test',
      pushSubscriptionId: 'sub-redup', pushClientStateHash: hashToken('action', token),
    })
    const payload = { value: [{ subscriptionId: 'sub-redup', clientState: token, changeType: 'created', resourceData: { id: 'msg-redup' } }] }
    const first = await t.app.inject({ method: 'POST', url: '/webhooks/microsoft', headers: { 'content-type': 'application/json' }, payload })
    expect(first.statusCode).toBe(202)
    const afterFirst = enqueueCalls.filter((c) => c.name === JOB_NAMES.mailboxSync && c.data.connectionId === connectionId).length
    expect(afterFirst).toBe(1)

    const second = await t.app.inject({ method: 'POST', url: '/webhooks/microsoft', headers: { 'content-type': 'application/json' }, payload })
    expect(second.statusCode).toBe(202)
    const afterSecond = enqueueCalls.filter((c) => c.name === JOB_NAMES.mailboxSync && c.data.connectionId === connectionId).length
    expect(afterSecond).toBe(1)
  })
})
