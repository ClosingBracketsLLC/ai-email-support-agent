/**
 * The session-less one-click review pages (`src/review/`). The decisions themselves belong to
 * `src/drafts/service.ts` and are covered by drafts-service.test.ts; this suite is about the HTTP
 * surface: what a mail client's click renders, what it may NOT write, and the fact that every failure
 * mode — unknown draft, wrong token, consumed token, expired token — renders ONE constant page.
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateToken } from '@aesa/crypto'
import { auditLog, draftActionTokens, drafts, outboundSends, workspaces } from '@aesa/db'
import type { ApiFacade, EnqueueFn } from '../src/deps.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { FRIENDLY_COPY } from '../src/review/pages.ts'
import {
  WEB, createTestApi, insertAgent, insertConnectedMailbox, insertTicket, listen, seedPendingDraft, signInWithOtp,
} from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

/** A body with the three characters an unescaped template literal would hand straight to a browser. */
const RISKY_BODY = 'Hi Casey & <script>alert("x")</script>,\n\nYour order ships tomorrow.\n\nThanks'
const GUARDRAIL_BODY = 'Hi Casey,\n\nGrab the deal at https://evil.com/deal.\n\nThanks'

/** The row the digest email mints: one single-use hashed token per (draft, recipient). Returns the RAW token. */
async function mintToken(
  api: ApiFacade, orgId: string, draftId: string, userId: string,
  opts: { expiresAt?: Date; consumedAt?: Date } = {},
): Promise<string> {
  const { token, hash } = generateToken('action')
  await api.withOrg(orgId, (tx) => tx.insert(draftActionTokens).values({
    orgId, draftId, userId, tokenHash: hash,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 3 * 86_400_000),
    consumedAt: opts.consumedAt ?? null,
  }))
  return token
}

describe('review pages (/a/:draftId)', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let sent: { name: string; entityId: string }[]
  let seq = 0

  beforeAll(async () => {
    sent = []
    const enqueue: EnqueueFn = async (name, _data, opts) => { sent.push({ name, entityId: opts.entityId }); return `job-${sent.length}` }
    // info, not the helper's default warn: the request line the `req` serializer emits is what proves
    // `?t=` never reaches a log.
    t = await createTestApi({}, { enqueue }, { logLevel: 'info' })
    base = await listen(t.app)
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => { sent.length = 0 })

  async function seedOrg(opts: { agentEnabled?: boolean } = {}) {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `review-${n}@example.com`, 'Owner')
    const { orgId } = await client(base, signed.cookie).workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const address = `support${n}@acme.test`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const agentId = await insertAgent(t.api, orgId, connectionId, address)
    await t.api.withOrg(orgId, (tx) => tx.update(workspaces)
      .set({ agentEnabled: opts.agentEnabled ?? true }).where(eq(workspaces.orgId, orgId)))
    return { orgId, userId: signed.user.id, connectionId, agentId }
  }

  /** An `awaiting_review` ticket carrying one live draft — the state the review email links to. */
  async function seedReviewable(org: Awaited<ReturnType<typeof seedOrg>>, draftOpts: Parameters<typeof seedPendingDraft>[3] = {}) {
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review',
      customerEmail: 'casey@customer.test', customerName: 'Casey <Q&A>', subject: 'Where is my order?',
      lastInboundAt: new Date(), inboundCount: 1,
    })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, ...draftOpts })
    return { ticket, draft }
  }

  const readDraft = (orgId: string, draftId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(drafts).where(eq(drafts.id, draftId)))[0])
  const readSend = (orgId: string, draftId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))[0])
  const readToken = (orgId: string, draftId: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(draftActionTokens).where(eq(draftActionTokens.draftId, draftId)))
  const readAudit = (orgId: string, action: string, entityId: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId))!))

  const get = (draftId: string, token: string) =>
    t.app.inject({ method: 'GET', url: `/a/${draftId}?t=${encodeURIComponent(token)}` })
  const post = (draftId: string, action: 'approve' | 'hold', token: string) => t.app.inject({
    method: 'POST', url: `/a/${draftId}/${action}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `t=${encodeURIComponent(token)}`,
  })

  // -- GET renders --

  it('GET with a valid token on a pending draft renders the review page, escaped, and writes NOTHING', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org, { body: RISKY_BODY })
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)
    const before = await readDraft(org.orgId, draft.id)

    const res = await get(draft.id, token)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('Reply ready')
    expect(res.body).toContain('Where is my order?')
    expect(res.body).toContain('Casey &lt;Q&amp;A&gt;')
    expect(res.body).toContain('Hi Casey &amp; &lt;script&gt;')
    expect(res.body).not.toContain('<script>')
    expect(res.body).toContain('<form method="post"')
    expect(res.body).toContain('Approve')
    expect(res.body).toContain(`name="t" value="${token}"`)

    // The GET is a pure read: viewed_at is the POST's business (the click on the page that rendered it).
    const after = await readDraft(org.orgId, draft.id)
    expect(after!.viewedAt).toBeNull()
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime())
    expect(after!.status).toBe('pending')
    const [tok] = await readToken(org.orgId, draft.id)
    expect(tok!.consumedAt).toBeNull()
  })

  it('an unknown draft, a wrong token, a consumed token and an expired token all render ONE byte-identical page', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const live = await mintToken(t.api, org.orgId, draft.id, org.userId)
    const consumed = await mintToken(t.api, org.orgId, draft.id, org.userId, { consumedAt: new Date() })
    const expired = await mintToken(t.api, org.orgId, draft.id, org.userId, { expiresAt: new Date(Date.now() - 60_000) })

    const unknown = await get(randomUUID(), live)                       // a real token, the wrong draft
    const wrong = await get(draft.id, generateToken('action').token)    // right shape, never minted
    const used = await get(draft.id, consumed)
    const stale = await get(draft.id, expired)

    for (const res of [unknown, wrong, used, stale]) {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.body).toContain(FRIENDLY_COPY)
    }
    expect(new Set([unknown.body, wrong.body, used.body, stale.body]).size).toBe(1)
    expect(unknown.body).not.toContain('Where is my order?')
  })

  it('GET with a valid token on a sent draft renders the status page, not the review page', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org, { status: 'sent' })
    await t.api.withOrg(org.orgId, (tx) => tx.insert(outboundSends).values({
      orgId: org.orgId, draftId: draft.id, ticketId: ticket.id, connectionId: org.connectionId, agentId: org.agentId,
      status: 'sent', sendAfter: new Date(Date.now() - 7_200_000), sentAt: new Date(Date.now() - 7_200_000),
    }))
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    const res = await get(draft.id, token)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Already handled')
    expect(res.body).toContain('sent 2 hours ago')
    expect(res.body).not.toContain('<form method="post"')
    expect(res.body).toContain('Open in the app')
  })

  // -- POST approve --

  it('POST approve decides through the service: approved from email, viewed stamped, send queued, token consumed, audited', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    const res = await post(draft.id, 'approve', token)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('Approved')

    const after = await readDraft(org.orgId, draft.id)
    expect(after).toMatchObject({ status: 'approved', decisionSource: 'email', decidedBy: org.userId })
    expect(after!.viewedAt).toBeInstanceOf(Date)

    const send = await readSend(org.orgId, draft.id)
    expect(send).toMatchObject({ status: 'queued', ticketId: ticket.id })
    expect(sent).toEqual([{ name: 'send.execute', entityId: send!.id }])

    const [tok] = await readToken(org.orgId, draft.id)
    expect(tok!.consumedAt).toBeInstanceOf(Date)
    expect(await readAudit(org.orgId, 'draft.approved', draft.id)).toHaveLength(1)
  })

  it('a second POST with the same token renders the friendly page and enqueues nothing more', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    expect((await post(draft.id, 'approve', token)).body).toContain('Approved')
    const second = await post(draft.id, 'approve', token)
    expect(second.statusCode).toBe(200)
    expect(second.body).toContain(FRIENDLY_COPY)
    expect(sent).toHaveLength(1)
    expect(await readAudit(org.orgId, 'draft.approved', draft.id)).toHaveLength(1)
  })

  it('two concurrent POSTs with the same token approve exactly once', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    const [a, b] = await Promise.all([post(draft.id, 'approve', token), post(draft.id, 'approve', token)])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)

    expect(await readAudit(org.orgId, 'draft.approved', draft.id)).toHaveLength(1)
    expect(sent).toHaveLength(1)
    const tokens = await readToken(org.orgId, draft.id)
    expect(tokens.filter((row) => row.consumedAt !== null)).toHaveLength(1)
    expect((await readDraft(org.orgId, draft.id))!.status).toBe('approved')
  })

  it('a lever refusal (agent off) renders its own page and leaves the token unspent', async () => {
    const org = await seedOrg({ agentEnabled: false })
    const { draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    const res = await post(draft.id, 'approve', token)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Could not approve')
    expect(res.body).toContain('Turn the agent on')

    expect((await readDraft(org.orgId, draft.id))!.status).toBe('pending')
    expect((await readToken(org.orgId, draft.id))[0]!.consumedAt).toBeNull()
    expect(sent).toHaveLength(0)

    // Still spendable once the owner flips the switch back on.
    await t.api.withOrg(org.orgId, (tx) => tx.update(workspaces).set({ agentEnabled: true }).where(eq(workspaces.orgId, org.orgId)))
    expect((await post(draft.id, 'approve', token)).body).toContain('Approved')
  })

  it('a guardrail refusal lists the codes and leaves the token unspent', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org, { body: GUARDRAIL_BODY })
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    const res = await post(draft.id, 'approve', token)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Could not approve')
    expect(res.body).toContain('url_not_allowed')

    expect((await readDraft(org.orgId, draft.id))!.status).toBe('pending')
    expect((await readToken(org.orgId, draft.id))[0]!.consumedAt).toBeNull()
    expect(sent).toHaveLength(0)
  })

  // -- POST hold --

  it('POST hold inside the undo window holds the send and brings the draft back to review', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const approveToken = await mintToken(t.api, org.orgId, draft.id, org.userId)
    expect((await post(draft.id, 'approve', approveToken)).body).toContain('Approved')

    const holdToken = await mintToken(t.api, org.orgId, draft.id, org.userId)
    const rendered = await get(draft.id, holdToken)
    expect(rendered.body).toContain('Hold')
    expect(rendered.body).toContain(`/a/${draft.id}/hold`)

    const res = await post(draft.id, 'hold', holdToken)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('on hold')

    expect((await readSend(org.orgId, draft.id))!.status).toBe('held')
    expect((await readDraft(org.orgId, draft.id))!.status).toBe('pending')
  })

  it('POST hold on a pending draft renders the status page and changes nothing', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    const res = await post(draft.id, 'hold', token)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Still waiting')
    expect(res.body).not.toContain('on hold')
    expect((await readDraft(org.orgId, draft.id))!.status).toBe('pending')
  })

  // -- the hostile edges --

  it('a malformed :draftId never reaches Postgres: friendly page at 200, on GET and on POST', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)

    for (const res of [
      await get('not-a-uuid', token),
      await get('not-a-uuid', 'garbage'),
      await t.app.inject({ method: 'GET', url: '/a/not-a-uuid' }),
      await post('not-a-uuid', 'approve', token),
      await post('not-a-uuid', 'hold', token),
    ]) {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.body).toContain(FRIENDLY_COPY)
    }
  })

  it('a mangled review link 404s without echoing or logging the token (Fastify\'s stock 404 would do both)', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)
    const before = t.lines.length

    const res = await t.app.inject({ method: 'GET', url: `/a/${draft.id}/extra?t=${encodeURIComponent(token)}` })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain(token)
    expect(t.lines.slice(before).join('')).not.toContain(token)
  })

  it('the request log line masks the token', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const token = await mintToken(t.api, org.orgId, draft.id, org.userId)
    const before = t.lines.length

    await get(draft.id, token)

    const after = t.lines.slice(before).join('')
    expect(after).toContain(`/a/${draft.id}?t=[redacted]`)
    expect(t.lines.join('')).not.toContain(token)
  })
})

describe('review pages are rate limited', () => {
  it('the third GET in a minute is a 429 (API_RATE_LIMIT_PER_MINUTE=2)', async () => {
    const t = await createTestApi({ API_RATE_LIMIT_PER_MINUTE: '2' })
    try {
      const hit = () => t.app.inject({ method: 'GET', url: `/a/${randomUUID()}?t=${generateToken('action').token}` })
      expect((await hit()).statusCode).toBe(200)
      expect((await hit()).statusCode).toBe(200)
      const third = await hit()
      expect(third.statusCode).toBe(429)
      expect(third.headers['retry-after']).toBeDefined()
    } finally {
      await t.close()
    }
  })
})
