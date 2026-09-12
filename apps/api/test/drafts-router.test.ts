/**
 * The `drafts` router (and `inbox.resolve`): input → service → tRPC error mapping. The service's own
 * transactions are covered by drafts-service.test.ts; this suite is about what a client sees.
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drafts, outboundSends, workspaces } from '@aesa/db'
import type { EnqueueFn } from '../src/deps.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import {
  SEED_DRAFT_BODY, WEB, createTestApi, insertAgent, insertConnectedMailbox, insertTicket, listen, seedPendingDraft, signInWithOtp,
} from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

describe('drafts router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let sent: { name: string; entityId: string }[]
  let seq = 0

  beforeAll(async () => {
    sent = []
    const enqueue: EnqueueFn = async (name, _data, opts) => { sent.push({ name, entityId: opts.entityId }); return 'job-1' }
    t = await createTestApi({}, { enqueue })
    base = await listen(t.app)
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => { sent.length = 0 })

  async function seedOrg() {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `router-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const address = `support${n}@acme.test`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const agentId = await insertAgent(t.api, orgId, connectionId, address)
    await t.api.withOrg(orgId, (tx) => tx.update(workspaces).set({ agentEnabled: true }).where(eq(workspaces.orgId, orgId)))
    return { orgId, c, userId: signed.user.id, connectionId, agentId }
  }

  async function seedReviewable(org: Awaited<ReturnType<typeof seedOrg>>, opts: { viewedAt?: Date | null } = {}) {
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review',
      customerEmail: 'casey@customer.test', subject: 'Where is my order?', lastInboundAt: new Date(), inboundCount: 1,
    })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, {
      agentId: org.agentId, viewedAt: opts.viewedAt === undefined ? new Date() : opts.viewedAt,
    })
    return { ticket, draft }
  }

  it('get returns the draft view and its ticket summary; undoUntil appears only once approved', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)

    const before = await org.c.drafts.get.query({ draftId: draft.id })
    expect(before.draft).toMatchObject({
      id: draft.id, ticketId: ticket.id, version: 1, status: 'pending', body: SEED_DRAFT_BODY, finalBody: null,
      decision: 'review', decisionReason: 'ok', isRedraft: false, send: null, undoUntil: null,
      agentAddress: `support${seq}@acme.test`,
    })
    expect(before.draft.confidence).toBeCloseTo(0.75, 5)
    expect(before.draft.expiresAt).toBeInstanceOf(Date)
    expect(before.ticket).toMatchObject({ id: ticket.id, subject: 'Where is my order?', status: 'awaiting_review' })

    const approved = await org.c.drafts.approve.mutate({ draftId: draft.id })
    expect(approved.undoUntil.getTime()).toBe(approved.sendAfter.getTime())

    const after = await org.c.drafts.get.query({ draftId: draft.id })
    expect(after.draft.status).toBe('approved')
    expect(after.draft.send).toMatchObject({ id: approved.sendId, status: 'queued', sentAt: null, lastError: null })
    expect(after.draft.undoUntil?.getTime()).toBe(approved.sendAfter.getTime())
    expect(sent).toEqual([{ name: 'send.execute', entityId: approved.sendId }])
  })

  it('markViewed reports whether it stamped, approve refuses an unviewed draft with PRECONDITION_FAILED not_viewed', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org, { viewedAt: null })

    await expect(org.c.drafts.approve.mutate({ draftId: draft.id }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' }, message: 'not_viewed' })

    expect(await org.c.drafts.markViewed.mutate({ draftId: draft.id })).toEqual({ viewed: true })
    const ok = await org.c.drafts.approve.mutate({ draftId: draft.id })
    expect(ok.sendId).toBeTruthy()
  })

  it('a guardrail refusal is a BAD_REQUEST carrying the findings in data.findings (the errorFormatter passes a non-500 cause through)', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)

    const err = await org.c.drafts.approve
      .mutate({ draftId: draft.id, body: 'Hi Casey,\n\nGrab the deal at https://evil.com/deal.\n\nThanks' })
      .then(() => null, (e: unknown) => e as { message: string; data: { code: string; findings?: { code: string; severity: string }[] } })
    expect(err).not.toBeNull()
    expect(err!.data.code).toBe('BAD_REQUEST')
    expect(err!.message).toBe('guardrail')
    expect(err!.data.findings?.map((f) => f.code)).toContain('url_not_allowed')
    expect(err!.data.findings?.every((f) => f.severity === 'fail')).toBe(true)

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draft.id)))
    expect(row).toMatchObject({ status: 'pending' })
  })

  it('hold never throws for its two soft outcomes and reject returns the resolution', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    expect(await org.c.drafts.hold.mutate({ draftId: draft.id })).toEqual({ held: false, code: 'not_holdable' })

    await org.c.drafts.approve.mutate({ draftId: draft.id })
    expect(await org.c.drafts.hold.mutate({ draftId: draft.id })).toEqual({ held: true })

    const second = await seedReviewable(org)
    expect(await org.c.drafts.reject.mutate({ draftId: second.draft.id, action: 'handle', reason: '' })).toEqual({ resolution: 'escalate_terminal', guidanceAdded: false })
    await expect(org.c.drafts.reject.mutate({ draftId: second.draft.id, action: 'handle', reason: '' }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' }, message: 'not_pending' })
  })

  it('resume brings a job-held draft back to review; inbox.resolve resolves the ticket', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'held' })
    await t.api.withOrg(org.orgId, (tx) => tx.insert(outboundSends).values({
      orgId: org.orgId, draftId: draft.id, ticketId: ticket.id, connectionId: org.connectionId, agentId: org.agentId,
      status: 'held', sendAfter: new Date(), lastError: 'reauth_required',
    }))

    const view = await org.c.drafts.get.query({ draftId: draft.id })
    expect(view.draft.send).toMatchObject({ status: 'held', lastError: 'reauth_required' })

    expect(await org.c.drafts.resume.mutate({ draftId: draft.id })).toEqual({ resumed: true })
    expect((await org.c.drafts.get.query({ draftId: draft.id })).draft.status).toBe('pending')
    expect(await org.c.drafts.resume.mutate({ draftId: draft.id })).toEqual({ resumed: false })

    expect(await org.c.inbox.resolve.mutate({ ticketId: ticket.id })).toEqual({ resolved: true })
    expect(await org.c.inbox.resolve.mutate({ ticketId: ticket.id })).toEqual({ resolved: false })
  })

  it('reject with addToGuidance reports guidanceAdded and the guidance really grew', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)

    expect(await org.c.drafts.reject.mutate({ draftId: draft.id, action: 'handle', reason: 'Never quote a delivery date.', addToGuidance: true }))
      .toEqual({ resolution: 'escalate_terminal', guidanceAdded: true })
    expect((await org.c.workspace.get.query()).operatingGuidance).toBe('- Never quote a delivery date.')
  })

  it('flagAutoSent flags a sent auto reply once (PRECONDITION_FAILED on a human one, on a repeat, NOT_FOUND across workspaces)', async () => {
    const org = await seedOrg()
    const other = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'waiting_on_customer' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId })
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts)
      .set({ status: 'sent', decisionSource: 'auto', decidedAt: new Date(), autoDecidedAt: new Date(), finalBody: SEED_DRAFT_BODY })
      .where(eq(drafts.id, draft.id)))

    await expect(other.c.drafts.flagAutoSent.mutate({ draftId: draft.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    expect(await org.c.drafts.flagAutoSent.mutate({ draftId: draft.id })).toEqual({ ok: true })
    await expect(org.c.drafts.flagAutoSent.mutate({ draftId: draft.id }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' }, message: 'not_flaggable' })

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draft.id)))
    expect(row!.flaggedAt).toBeInstanceOf(Date)
    expect(row!.flaggedBy).toBe(org.userId)

    const human = await seedReviewable(org)
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts)
      .set({ status: 'sent', decisionSource: 'app', decidedAt: new Date() }).where(eq(drafts.id, human.draft.id)))
    await expect(org.c.drafts.flagAutoSent.mutate({ draftId: human.draft.id }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' }, message: 'not_flaggable' })
  })

  it('every draft id from another workspace is NOT_FOUND', async () => {
    const org = await seedOrg()
    const other = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)

    await expect(other.c.drafts.get.query({ draftId: draft.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(other.c.drafts.approve.mutate({ draftId: draft.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(other.c.drafts.hold.mutate({ draftId: draft.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(other.c.drafts.resume.mutate({ draftId: draft.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(other.c.drafts.reject.mutate({ draftId: draft.id, action: 'handle', reason: '' })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(other.c.drafts.get.query({ draftId: randomUUID() })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    expect(await other.c.drafts.markViewed.mutate({ draftId: draft.id })).toEqual({ viewed: false })
    expect(await other.c.inbox.resolve.mutate({ ticketId: ticket.id })).toEqual({ resolved: false })

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draft.id)))
    expect(row).toMatchObject({ status: 'pending' })
  })
})
