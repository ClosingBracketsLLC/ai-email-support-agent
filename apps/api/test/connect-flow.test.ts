import { randomBytes } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKekRing, type KekRing } from '@aesa/crypto'
import { categories, mailboxConnections, oauthFlows, openSealedForOrg, provisionOrgKeys } from '@aesa/db'
import type { MailboxProvider, TokenSet } from '@aesa/mail'
import { JOB_NAMES } from '@aesa/queue'
import type { EnqueueFn } from '../src/deps.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

const GMAIL_ENV = { GMAIL_OAUTH_CLIENT_ID: 'gmail-client', GMAIL_OAUTH_CLIENT_SECRET: 'gmail-secret' }

interface EnqueueCall { name: string; data: { orgId: string } & Record<string, unknown>; opts: { entityId: string; debounceSeconds?: number } }

function createRecordingEnqueue(): { fn: EnqueueFn; calls: EnqueueCall[] } {
  const calls: EnqueueCall[] = []
  const fn: EnqueueFn = async (name, data, opts) => {
    calls.push({ name, data, opts })
    return `job-${calls.length}`
  }
  return { fn, calls }
}

/** A `MailboxProvider` double: `authorizationUrl` is the real pure builder (no network — safe to leave
 * as-is), `exchangeCode` is fully test-controlled since it's the one leg that would otherwise hit Google. */
function fakeGmailProvider(exchangeCode: MailboxProvider['exchangeCode']): MailboxProvider {
  return {
    kind: 'gmail',
    authorizationUrl: (p) => {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      u.searchParams.set('client_id', p.clientId)
      u.searchParams.set('redirect_uri', p.redirectUri)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('state', p.state)
      u.searchParams.set('code_challenge', p.codeChallenge)
      u.searchParams.set('code_challenge_method', 'S256')
      return u.toString()
    },
    exchangeCode,
    refresh: async () => { throw new Error('not used by this suite') },
    revoke: async () => {},
    client: () => { throw new Error('not used by this suite') },
  }
}

function fixedExchange(result: { tokens: TokenSet; emailAddress: string; providerAccountId: string }): MailboxProvider['exchangeCode'] {
  return async () => result
}

describe('mailbox connect flow', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let enqueueCalls: EnqueueCall[]
  let providerOverrides: { gmail?: MailboxProvider }
  let a: ReturnType<typeof client>
  let orgId: string
  let userA: { id: string; email: string }
  let cookieA: string

  beforeAll(async () => {
    const rec = createRecordingEnqueue()
    enqueueCalls = rec.calls
    providerOverrides = {}
    t = await createTestApi(GMAIL_ENV, { enqueue: rec.fn, mailProviders: providerOverrides })
    base = await listen(t.app)
    const signed = await signInWithOtp(t.app, t.mail, 'owner-a@example.com', 'Ann')
    cookieA = signed.cookie
    userA = signed.user
    a = client(base, cookieA)
    const { orgId: created } = await a.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    orgId = created
  })
  afterAll(async () => { await t.close() })

  it('startConnect without provisioned keys throws PRECONDITION_FAILED and enqueues keys.provision', async () => {
    await expect(a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
    const provisionCall = enqueueCalls.find((c) => c.name === JOB_NAMES.keysProvision && c.data.orgId === orgId)
    expect(provisionCall).toMatchObject({ opts: { entityId: 'keys', debounceSeconds: 30 } })
  })

  let startUrl: string
  let flowId: string

  it('startConnect with provisioned keys returns a /connect/gmail/start url with no caller-supplied challenge', async () => {
    await t.api.withOrg(orgId, (tx) => provisionOrgKeys(tx, ring))
    const res = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    const url = new URL(res.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${t.config.appBaseUrl}/connect/gmail/start`)
    // Only `state` — the challenge is derived server-side (Task 17 review, Important 1), never taken
    // from this unauthenticated response's own caller.
    expect([...url.searchParams.keys()]).toEqual(['state'])
    expect(url.searchParams.get('state')).toBeTruthy()
    startUrl = res.url
    flowId = res.flowId
  })

  it('GET /connect/gmail/start redirects to the provider with the state and an S256 challenge', async () => {
    const relative = startUrl.slice(t.config.appBaseUrl.length)
    const res = await t.app.inject({ method: 'GET', url: relative })
    expect(res.statusCode).toBe(302)
    const location = new URL(res.headers.location as string)
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('state')).toBeTruthy()
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('an attacker-supplied &challenge= on /start is ignored — the redirect always carries the server-derived, deterministic S256 challenge', async () => {
    const relative = startUrl.slice(t.config.appBaseUrl.length)
    const res = await t.app.inject({ method: 'GET', url: `${relative}&challenge=attacker-junk` })
    expect(res.statusCode).toBe(302)
    const attackerAttemptChallenge = new URL(res.headers.location as string).searchParams.get('code_challenge')
    expect(attackerAttemptChallenge).not.toBe('attacker-junk')

    // Still pending (GET /start never consumes) — hitting it again re-derives the SAME challenge from
    // the same stored, encrypted verifier, proving it's not accepting whatever the caller sends.
    const again = await t.app.inject({ method: 'GET', url: relative })
    expect(new URL(again.headers.location as string).searchParams.get('code_challenge')).toBe(attackerAttemptChallenge)
  })

  it('GET /connect/:provider/start with an unresolvable state 400s', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/connect/gmail/start?state=00000000-0000-0000-0000-000000000000.garbage-nonce' })
    expect(res.statusCode).toBe(400)
  })

  let connectionId: string

  it('callback happy path connects the mailbox as pending_claim, consumes the flow, and enqueues a sealed credentials job', async () => {
    providerOverrides.gmail = fakeGmailProvider(fixedExchange({
      tokens: { refreshToken: 'rt-1', accessToken: 'at-1', accessTokenExpiresAt: null },
      emailAddress: 'support@acme.test',
      providerAccountId: 'acct-1',
    }))

    const state = new URL(startUrl).searchParams.get('state')!
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Connected as support@acme.test')

    const conns = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))
    expect(conns).toHaveLength(1)
    expect(conns[0]).toMatchObject({ status: 'pending_claim', emailAddress: 'support@acme.test', provider: 'gmail' })
    connectionId = conns[0]!.id

    const storeCall = enqueueCalls.find((c) => c.name === JOB_NAMES.storeCredentials)
    expect(storeCall).toBeDefined()
    expect(storeCall!.data).toMatchObject({ orgId, connectionId })
    expect(storeCall!.opts.entityId).toBe(connectionId)

    // Prove the sealed blob round-trips: only the org's own ring can open what the callback sealed.
    const sealed = Buffer.from(storeCall!.data.sealed as string, 'base64')
    const opened = await t.api.withOrg(orgId, (tx) => openSealedForOrg(tx, ring, sealed))
    expect(JSON.parse(opened.toString('utf8'))).toMatchObject({ refreshToken: 'rt-1', accessToken: 'at-1', accessTokenExpiresAt: null })

    const [flow] = await t.api.withOrg(orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, flowId)))
    expect(flow).toMatchObject({ status: 'consumed', connectionId, userId: userA.id })
  })

  it('replaying the already-consumed state 400s and creates no second connection', async () => {
    const state = new URL(startUrl).searchParams.get('state')!
    const before = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(400)
    const after = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))
    expect(after).toHaveLength(before.length)
  })

  it('escapes an email address containing an apostrophe before rendering it into the success page (Task 17 review, Important 2)', async () => {
    providerOverrides.gmail = fakeGmailProvider(fixedExchange({
      tokens: { refreshToken: 'rt-apos', accessToken: 'at-apos', accessTokenExpiresAt: null },
      emailAddress: "o'brien@acme.test", // valid per z.email() (the local part allows '), still HTML-unsafe raw
      providerAccountId: 'acct-apos',
    }))
    const started = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    const state = new URL(started.url).searchParams.get('state')!
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('o&#39;brien@acme.test')
    expect(res.body).not.toContain("o'brien@acme.test")

    // Escaping is presentation-only: the stored row keeps the real, unescaped address.
    const [conn] = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.emailAddress, "o'brien@acme.test")))
    expect(conn).toBeDefined()
  })

  it('a malformed provider-returned email address fails the flow instead of being stored or rendered (Task 17 review, Important 2)', async () => {
    providerOverrides.gmail = fakeGmailProvider(fixedExchange({
      tokens: { refreshToken: 'rt-evil', accessToken: 'at-evil', accessTokenExpiresAt: null },
      emailAddress: '<script>alert(1)</script>', // fails z.email() outright — not merely unescaped, invalid
      providerAccountId: 'acct-evil',
    }))
    const started = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    const state = new URL(started.url).searchParams.get('state')!
    const before = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
    expect(res.body).not.toContain('<script>')
    const after = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))
    expect(after).toHaveLength(before.length)

    const [flow] = await t.api.withOrg(orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
    expect(flow).toMatchObject({ status: 'failed', failureReason: 'invalid_email' })
  })

  it('callback with a tampered nonce is rejected 400 and creates no connection', async () => {
    const started = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    const state = new URL(started.url).searchParams.get('state')!
    const [flowPart, noncePart] = state.split('.')
    const tampered = `${flowPart}.${noncePart!.slice(0, -1)}${noncePart!.at(-1) === 'a' ? 'b' : 'a'}`

    const before = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(tampered)}` })
    expect(res.statusCode).toBe(400)
    const after = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))
    expect(after).toHaveLength(before.length)

    const [flow] = await t.api.withOrg(orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
    expect(flow!.status).toBe('pending')
  })

  it('callback for an email already connected in ANOTHER org marks the flow failed and creates no row', async () => {
    const signedB = await signInWithOtp(t.app, t.mail, 'owner-b@example.com', 'Bea')
    const b = client(base, signedB.cookie)
    const { orgId: orgBId } = await b.workspace.create.mutate({ businessName: 'Beta LLC', timezone: 'UTC' })
    await t.api.withOrg(orgBId, (tx) => provisionOrgKeys(tx, ring))

    const started = await b.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    providerOverrides.gmail = fakeGmailProvider(fixedExchange({
      tokens: { refreshToken: 'rt-b', accessToken: 'at-b', accessTokenExpiresAt: null },
      emailAddress: 'support@acme.test', // same address as orgA's non-disabled connection above
      providerAccountId: 'acct-b',
    }))

    const state = new URL(started.url).searchParams.get('state')!
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(200)

    const [flowB] = await t.api.withOrg(orgBId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
    expect(flowB).toMatchObject({ status: 'failed', failureReason: 'already_connected_elsewhere', connectionId: null })

    const rowsB = await t.api.withOrg(orgBId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgBId)))
    expect(rowsB).toHaveLength(0)
  })

  it("an org-B manager claiming org-A's flowId is NOT_FOUND — RLS-by-construction, not a cross-org leak", async () => {
    const signedD = await signInWithOtp(t.app, t.mail, 'owner-d@example.com', 'Dana')
    const d = client(base, signedD.cookie)
    await d.workspace.create.mutate({ businessName: 'Delta Corp', timezone: 'UTC' })

    // orgA's flowId (already claimed by orgA above) is a real row — just invisible to orgB's RLS scope,
    // so the SELECT inside claimConnection's withOrg(orgB, …) finds nothing, same as a made-up id would.
    await expect(d.mailboxes.claimConnection.mutate({ flowId })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('claimConnection by the starting user connects the mailbox, seeds categories, and enqueues mailbox.sync', async () => {
    const res = await a.mailboxes.claimConnection.mutate({ flowId })
    expect(res).toEqual({ connectionId, emailAddress: 'support@acme.test' })

    const [conn] = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)))
    expect(conn?.status).toBe('connected')

    const cats = await t.api.withOrg(orgId, (tx) => tx.select().from(categories))
    expect(cats.length).toBeGreaterThan(0)

    const syncCall = enqueueCalls.find((c) => c.name === JOB_NAMES.mailboxSync && c.data.connectionId === connectionId)
    expect(syncCall).toBeDefined()
    expect(syncCall!.data.orgId).toBe(orgId)
  })

  it('a successful claim emails the claimed mailbox naming the claiming user and the settings link (Phase 3 pre-flight, reverse-phish trail)', async () => {
    const mail = t.mail.latestTo('support@acme.test')
    expect(mail).toBeDefined()
    expect(mail!.subject).toContain('connected to aesa')
    expect(mail!.text).toContain(userA.email)
    expect(mail!.text).toContain('/settings/mailboxes')
  })

  it('claimConnection by a DIFFERENT user in the same org is FORBIDDEN (the account-linking fix)', async () => {
    providerOverrides.gmail = fakeGmailProvider(fixedExchange({
      tokens: { refreshToken: 'rt-2', accessToken: 'at-2', accessTokenExpiresAt: null },
      emailAddress: 'support2@acme.test',
      providerAccountId: 'acct-2',
    }))
    const started = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    const state = new URL(started.url).searchParams.get('state')!
    const cb = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
    expect(cb.statusCode).toBe(200)

    // A second, admin-role member of orgA who never started this flow.
    const signedC = await signInWithOtp(t.app, t.mail, 'owner-c@example.com', 'Casey')
    await t.handle.pool.query(`INSERT INTO member (organization_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, signedC.user.id])
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/set-active',
      headers: { origin: WEB, cookie: signedC.cookie, 'content-type': 'application/json' },
      payload: { organizationId: orgId },
    })
    const c = client(base, signedC.cookie)

    await expect(c.mailboxes.claimConnection.mutate({ flowId: started.flowId })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })

    const [flowRow] = await t.api.withOrg(orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
    const [stillPending] = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, flowRow!.connectionId!)))
    expect(stillPending?.status).toBe('pending_claim')
  })

  it('a claim that fails (FORBIDDEN, the wrong user) sends no claim-time email', async () => {
    expect(t.mail.latestTo('support2@acme.test')).toBeUndefined()
  })

  it('claimConnection called twice is idempotent — the second call returns the same connection', async () => {
    const first = await a.mailboxes.claimConnection.mutate({ flowId })
    const second = await a.mailboxes.claimConnection.mutate({ flowId })
    expect(second).toEqual(first)
  })

  it('an expired flow 400s at the callback', async () => {
    const started = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    await t.api.withOrg(orgId, (tx) => tx.update(oauthFlows).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(oauthFlows.id, started.flowId)))

    const state = new URL(started.url).searchParams.get('state')!
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(400)
  })

  it('disconnect marks the connection disabled and enqueues mailbox.revoke', async () => {
    await a.mailboxes.disconnect.mutate({ connectionId })
    const [conn] = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)))
    expect(conn?.status).toBe('disabled')

    const revokeCall = enqueueCalls.find((c) => c.name === JOB_NAMES.revokeMailbox && c.data.connectionId === connectionId)
    expect(revokeCall).toBeDefined()
    expect(revokeCall!.data.orgId).toBe(orgId)
  })

  it('re-claiming a flow whose connection was disconnected in the meantime is PRECONDITION_FAILED, not a silent OK (Task 17 review, Important 4)', async () => {
    const syncCallsBefore = enqueueCalls.filter((c) => c.name === JOB_NAMES.mailboxSync && c.data.connectionId === connectionId).length
    // flowId/connectionId still refer to the flow claimed above and just disabled by the disconnect test.
    await expect(a.mailboxes.claimConnection.mutate({ flowId })).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
    const [conn] = await t.api.withOrg(orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)))
    expect(conn?.status).toBe('disabled')
    const syncCallsAfter = enqueueCalls.filter((c) => c.name === JOB_NAMES.mailboxSync && c.data.connectionId === connectionId).length
    expect(syncCallsAfter).toBe(syncCallsBefore)
  })

  it('AADSTS65001 in error_description marks the flow failed with admin_consent_required', async () => {
    const started = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    const state = new URL(started.url).searchParams.get('state')!
    const description = encodeURIComponent('AADSTS65001: The user or administrator has not consented to use the application.')
    const res = await t.app.inject({
      method: 'GET',
      url: `/connect/gmail/callback?error=consent_required&error_description=${description}&state=${encodeURIComponent(state)}`,
    })
    expect(res.statusCode).toBe(200)

    const [flow] = await t.api.withOrg(orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
    expect(flow).toMatchObject({ status: 'failed', failureReason: 'admin_consent_required' })
  })

  it('error=access_denied cancels the flow with a friendly page', async () => {
    const started = await a.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
    const state = new URL(started.url).searchParams.get('state')!
    const res = await t.app.inject({ method: 'GET', url: `/connect/gmail/callback?error=access_denied&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('cancelled')

    const [flow] = await t.api.withOrg(orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
    expect(flow).toMatchObject({ status: 'failed', failureReason: 'access_denied' })
  })
})

/**
 * `enqueue(JOB_NAMES.storeCredentials, …)` returning `null` (final-review Important, I5): a singleton
 * dedupe collision means the connection is left `pending_claim` with NO `mailbox_credentials` row and
 * no way to ever get one from this flow. Its own `describe` (a fresh app/org per test) so this
 * suite's null-returning enqueue stub can't affect connect-flow.test.ts's own shared, order-dependent
 * chain above.
 */
describe('mailbox connect flow: storeCredentials enqueue_failed recovery', () => {
  function createNullingEnqueue(): { fn: EnqueueFn; calls: EnqueueCall[] } {
    const calls: EnqueueCall[] = []
    const fn: EnqueueFn = async (name, data, opts) => {
      calls.push({ name, data, opts })
      return name === JOB_NAMES.storeCredentials ? null : `job-${calls.length}`
    }
    return { fn, calls }
  }

  it('fresh connect: a null storeCredentials enqueue fails the flow and deletes the just-created connection row (it has no tickets yet)', async () => {
    const { fn, calls } = createNullingEnqueue()
    const providerOverrides: { gmail?: MailboxProvider } = {}
    const t2 = await createTestApi(GMAIL_ENV, { enqueue: fn, mailProviders: providerOverrides })
    try {
      const base2 = await listen(t2.app)
      const signed = await signInWithOtp(t2.app, t2.mail, 'owner-enqfail-fresh@example.com', 'Fresh')
      const c = client(base2, signed.cookie)
      const { orgId: orgId2 } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
      await t2.api.withOrg(orgId2, (tx) => provisionOrgKeys(tx, ring))

      providerOverrides.gmail = fakeGmailProvider(fixedExchange({
        tokens: { refreshToken: 'rt-enqfail', accessToken: 'at-enqfail', accessTokenExpiresAt: null },
        emailAddress: 'support@enqfail-fresh.test',
        providerAccountId: 'acct-enqfail-fresh',
      }))
      const started = await c.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
      const state = new URL(started.url).searchParams.get('state')!
      const res = await t2.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain('Connected as')

      const rows = await t2.api.withOrg(orgId2, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId2)))
      expect(rows).toHaveLength(0)

      const [flow] = await t2.api.withOrg(orgId2, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
      expect(flow).toMatchObject({ status: 'failed', failureReason: 'enqueue_failed' })

      expect(calls.some((call) => call.name === JOB_NAMES.storeCredentials)).toBe(true)
    } finally {
      await t2.close()
    }
  })

  it('reconnect: a null storeCredentials enqueue fails the flow and reverts the EXISTING connection to reauth_required (never deletes it)', async () => {
    const { fn, calls } = createNullingEnqueue()
    const providerOverrides: { gmail?: MailboxProvider } = {}
    const t2 = await createTestApi(GMAIL_ENV, { enqueue: fn, mailProviders: providerOverrides })
    try {
      const base2 = await listen(t2.app)
      const signed = await signInWithOtp(t2.app, t2.mail, 'owner-enqfail-reconnect@example.com', 'Reconnect')
      const c = client(base2, signed.cookie)
      const { orgId: orgId2 } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
      await t2.api.withOrg(orgId2, (tx) => provisionOrgKeys(tx, ring))

      // A pre-existing connection this reconnect attempt targets — 'reauth_required', the real-world
      // trigger for a user re-running the connect flow on the same address.
      const [existing] = await t2.api.withOrg(orgId2, (tx) =>
        tx.insert(mailboxConnections).values({
          orgId: orgId2, provider: 'gmail', providerAccountId: 'acct-enqfail-reconnect-old', emailAddress: 'support@enqfail-reconnect.test',
          status: 'reauth_required', connectedByUserId: signed.user.id,
        }).returning())

      providerOverrides.gmail = fakeGmailProvider(fixedExchange({
        tokens: { refreshToken: 'rt-enqfail-2', accessToken: 'at-enqfail-2', accessTokenExpiresAt: null },
        emailAddress: 'support@enqfail-reconnect.test',
        providerAccountId: 'acct-enqfail-reconnect-new',
      }))
      const started = await c.mailboxes.startConnect.mutate({ provider: 'gmail', platform: 'web' })
      const state = new URL(started.url).searchParams.get('state')!
      const res = await t2.app.inject({ method: 'GET', url: `/connect/gmail/callback?code=fake-code&state=${encodeURIComponent(state)}` })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain('Connected as')

      const [after] = await t2.api.withOrg(orgId2, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, existing!.id)))
      expect(after).toBeDefined()
      expect(after?.status).toBe('reauth_required')

      const [flow] = await t2.api.withOrg(orgId2, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, started.flowId)))
      expect(flow).toMatchObject({ status: 'failed', failureReason: 'enqueue_failed', connectionId: existing!.id })

      expect(calls.some((call) => call.name === JOB_NAMES.storeCredentials)).toBe(true)
    } finally {
      await t2.close()
    }
  })
})
