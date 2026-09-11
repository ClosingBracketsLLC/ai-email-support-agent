/**
 * The `memory` router and its service (`src/memory/service.ts`): the owner's view of what the agent
 * remembers — the Verify list (candidates waiting to be sampled and answers parked for review), the
 * active set, the retired set — plus the four decisions they can make about one answer and the
 * privacy escape hatch, "forget everything you learned from this customer".
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEMORY_EXPIRY_DAYS } from '@aesa/core'
import { auditLog, categories, customerHash, drafts, ensureCustomerHashSalt, resolvedAnswers, workspaces } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import {
  SEED_DRAFT_BODY, WEB, createTestApi, insertConnectedMailbox, insertTicket, listen, seedPendingDraft, signInWithOtp,
} from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

const DAY_MS = 86_400_000

describe('memory router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let seq = 0
  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  async function setupOrg() {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `memory-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const address = `support${n}@memory.test`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address, replyFromConnection: false })
    return { orgId, c, connectionId, agentId: added.agentId, userId: signed.user.id, cookie: signed.cookie, address, seq: n }
  }

  async function seedAnswer(
    orgId: string, values: Partial<typeof resolvedAnswers.$inferInsert> = {},
  ): Promise<typeof resolvedAnswers.$inferSelect> {
    const [row] = await t.api.withOrg(orgId, (tx) => tx.insert(resolvedAnswers).values({
      orgId, questionText: 'When does my order ship?', answerBody: 'It ships the next working day.',
      expiresAt: new Date(Date.now() + MEMORY_EXPIRY_DAYS * DAY_MS), ...values,
    }).returning())
    return row!
  }

  const readAnswer = (orgId: string, id: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.id, id)))[0])
  const readAudit = (orgId: string, action: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)))

  it('memory.summary counts by status and the candidates waiting; memory.list to_check returns candidates and needs_review (newest first) with category/agent labels and excerpts, active returns active, retired returns retired', async () => {
    const org = await setupOrg()
    const [category] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(categories).where(eq(categories.key, 'order_status')))
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId })

    const older = new Date(Date.now() - 2 * DAY_MS)
    const candidate = await seedAnswer(org.orgId, {
      status: 'candidate', agentId: org.agentId, categoryId: category!.id, sourceTicketId: ticket.id,
      questionText: 'Q'.repeat(400), answerBody: 'A'.repeat(400), createdAt: older,
    })
    const parked = await seedAnswer(org.orgId, { status: 'needs_review', reviewReason: 'model_conflict', approvals: 2, strikes: 1 })
    const live = await seedAnswer(org.orgId, { status: 'active', approvals: 3, reuseCount: 4, wasEdited: true, lastApprovedAt: older })
    const gone = await seedAnswer(org.orgId, { status: 'retired', retiredReason: 'expired' })

    expect(await org.c.memory.summary.query()).toEqual({ candidate: 1, active: 1, needsReview: 1, retired: 1, toCheck: 2 })

    const toCheck = await org.c.memory.list.query({ tab: 'to_check' })
    expect(toCheck.answers.map((a) => a.id)).toEqual([parked.id, candidate.id])      // newest first
    expect(toCheck.answers[1]).toMatchObject({
      status: 'candidate', approvals: 0, strikes: 0, reuseCount: 0, wasEdited: false,
      categoryLabel: 'Order status', agentAddress: org.address, sourceTicketId: ticket.id,
    })
    // Excerpts, not whole bodies: the list is a scannable view, not the answer store.
    expect(toCheck.answers[1]!.question).toHaveLength(200)
    expect(toCheck.answers[1]!.answer).toHaveLength(280)
    expect(toCheck.answers[0]).toMatchObject({ status: 'needs_review', reviewReason: 'model_conflict', approvals: 2, strikes: 1, categoryLabel: null, agentAddress: null })

    const active = await org.c.memory.list.query({ tab: 'active' })
    expect(active.answers.map((a) => a.id)).toEqual([live.id])
    expect(active.answers[0]).toMatchObject({ approvals: 3, reuseCount: 4, wasEdited: true })
    expect(active.answers[0]!.lastApprovedAt).toEqual(older)

    const retired = await org.c.memory.list.query({ tab: 'retired' })
    expect(retired.answers.map((a) => a.id)).toEqual([gone.id])
    expect(retired.answers[0]).toMatchObject({ retiredReason: 'expired' })

    // Another workspace sees none of it.
    const other = await setupOrg()
    expect(await other.c.memory.summary.query()).toEqual({ candidate: 0, active: 0, needsReview: 0, retired: 0, toCheck: 0 })
    expect((await other.c.memory.list.query({ tab: 'to_check' })).answers).toEqual([])
  })

  it('keep: needs_review → active (review_reason cleared); retire: active|needs_review|candidate → retired (owner); both audited; a foreign id is NOT_FOUND', async () => {
    const org = await setupOrg()
    const other = await setupOrg()

    const parked = await seedAnswer(org.orgId, { status: 'needs_review', reviewReason: 'edited_reuse' })
    expect(await org.c.memory.keep.mutate({ answerId: parked.id })).toEqual({ ok: true })
    expect(await readAnswer(org.orgId, parked.id)).toMatchObject({ status: 'active', reviewReason: null })
    expect((await readAudit(org.orgId, 'memory.kept'))[0]).toMatchObject({ actor: `user:${org.userId}`, entityType: 'resolved_answer', entityId: parked.id })

    // Keeping something that is not parked for review changes nothing.
    await expect(org.c.memory.keep.mutate({ answerId: parked.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })

    for (const status of ['active', 'needs_review', 'candidate'] as const) {
      const row = await seedAnswer(org.orgId, { status })
      expect(await org.c.memory.retire.mutate({ answerId: row.id })).toEqual({ ok: true })
      expect(await readAnswer(org.orgId, row.id)).toMatchObject({ status: 'retired', retiredReason: 'owner' })
      await expect(org.c.memory.retire.mutate({ answerId: row.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    }
    expect(await readAudit(org.orgId, 'memory.retired')).toHaveLength(3)

    const foreign = await seedAnswer(other.orgId, { status: 'active' })
    await expect(org.c.memory.retire.mutate({ answerId: foreign.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(org.c.memory.keep.mutate({ answerId: randomUUID() })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    expect(await readAnswer(other.orgId, foreign.id)).toMatchObject({ status: 'active' })
  })

  it('confirmCandidate: candidate → active with approvals 1, last_approved_at and expires_at = now + 365 d', async () => {
    const org = await setupOrg()
    const candidate = await seedAnswer(org.orgId, { status: 'candidate', expiresAt: new Date(Date.now() + DAY_MS) })

    const before = Date.now()
    expect(await org.c.memory.confirmCandidate.mutate({ answerId: candidate.id })).toEqual({ ok: true })

    const after = await readAnswer(org.orgId, candidate.id)
    expect(after).toMatchObject({ status: 'active', approvals: 1 })
    expect(after!.lastApprovedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000)
    const expectedExpiry = before + MEMORY_EXPIRY_DAYS * DAY_MS
    expect(Math.abs(after!.expiresAt.getTime() - expectedExpiry)).toBeLessThan(10_000)
    expect((await readAudit(org.orgId, 'memory.confirmed'))[0]).toMatchObject({ entityId: candidate.id })

    // Only a candidate can be confirmed.
    await expect(org.c.memory.confirmCandidate.mutate({ answerId: candidate.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('rejectCandidate: the candidate is retired (sampled_bad) and its source draft is flagged (flag path shared with drafts.flagAutoSent)', async () => {
    const org = await setupOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'waiting_on_customer' })
    const seeded = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId })
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({
      status: 'sent', decisionSource: 'auto', decidedAt: new Date(), autoDecidedAt: new Date(), finalBody: SEED_DRAFT_BODY,
    }).where(eq(drafts.id, seeded.id)))
    const candidate = await seedAnswer(org.orgId, { status: 'candidate', sourceDraftId: seeded.id })

    expect(await org.c.memory.rejectCandidate.mutate({ answerId: candidate.id })).toEqual({ ok: true })
    expect(await readAnswer(org.orgId, candidate.id)).toMatchObject({ status: 'retired', retiredReason: 'sampled_bad' })

    const [draft] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, seeded.id)))
    expect(draft!.flaggedAt).toBeInstanceOf(Date)
    expect(draft!.flaggedBy).toBe(org.userId)
    expect(await readAudit(org.orgId, 'draft.flagged')).toHaveLength(1)

    // A candidate with no source draft (or one that can no longer be flagged) is still retired.
    const orphan = await seedAnswer(org.orgId, { status: 'candidate' })
    expect(await org.c.memory.rejectCandidate.mutate({ answerId: orphan.id })).toEqual({ ok: true })
    expect(await readAnswer(org.orgId, orphan.id)).toMatchObject({ status: 'retired', retiredReason: 'sampled_bad' })
    await expect(org.c.memory.rejectCandidate.mutate({ answerId: orphan.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('deleteByCustomer deletes every answer whose hash matches the email, returns the count, audits a count (never the email), and a workspace with no salt deletes 0', async () => {
    const org = await setupOrg()
    const salt = await t.api.withOrg(org.orgId, (tx) => ensureCustomerHashSalt(tx, org.orgId))
    const email = 'Casey@Customer.test'
    const hash = customerHash(salt, email)
    const mine = await seedAnswer(org.orgId, { status: 'active', sourceCustomerHash: hash })
    const alsoMine = await seedAnswer(org.orgId, { status: 'retired', sourceCustomerHash: hash })
    const someoneElse = await seedAnswer(org.orgId, { status: 'active', sourceCustomerHash: customerHash(salt, 'other@customer.test') })
    const noCustomer = await seedAnswer(org.orgId, { status: 'active' })

    // The same address in any casing is the same customer (`customerHash` lowercases and trims).
    expect(await org.c.memory.deleteByCustomer.mutate({ email: 'CASEY@Customer.TEST' })).toEqual({ deleted: 2 })
    expect(await readAnswer(org.orgId, mine.id)).toBeUndefined()
    expect(await readAnswer(org.orgId, alsoMine.id)).toBeUndefined()
    expect(await readAnswer(org.orgId, someoneElse.id)).toBeDefined()
    expect(await readAnswer(org.orgId, noCustomer.id)).toBeDefined()

    const rows = await readAudit(org.orgId, 'memory.deleted_by_customer')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toEqual({ count: 2 })
    expect(JSON.stringify(rows[0]!.detail)).not.toContain('casey')
    expect(JSON.stringify(rows[0]!.detail)).not.toContain(hash)

    // A workspace that has never captured an answer has no salt — and mints none just to delete.
    const fresh = await setupOrg()
    expect(await fresh.c.memory.deleteByCustomer.mutate({ email: 'casey@customer.test' })).toEqual({ deleted: 0 })
    const [ws] = await t.api.withOrg(fresh.orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, fresh.orgId)))
    expect(ws!.customerHashSalt).toBeNull()
  })

  it('members can read; only managers can mutate', async () => {
    const org = await setupOrg()
    const candidate = await seedAnswer(org.orgId, { status: 'candidate' })

    const memberEmail = `memory-member-${org.seq}@example.com`
    const memberSignIn = await signInWithOtp(t.app, t.mail, memberEmail, 'Bob')
    const { invitationId } = await org.c.team.invite.mutate({ email: memberEmail, role: 'member' })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/accept-invitation',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { invitationId },
    })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/set-active',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { organizationId: org.orgId },
    })
    const asMember = client(base, memberSignIn.cookie)

    expect(await asMember.memory.summary.query()).toMatchObject({ candidate: 1 })
    expect((await asMember.memory.list.query({ tab: 'to_check' })).answers).toHaveLength(1)
    for (const call of [
      asMember.memory.keep.mutate({ answerId: candidate.id }),
      asMember.memory.retire.mutate({ answerId: candidate.id }),
      asMember.memory.confirmCandidate.mutate({ answerId: candidate.id }),
      asMember.memory.rejectCandidate.mutate({ answerId: candidate.id }),
      asMember.memory.deleteByCustomer.mutate({ email: 'casey@customer.test' }),
    ]) {
      await expect(call).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
    }
    expect(await readAnswer(org.orgId, candidate.id)).toMatchObject({ status: 'candidate' })
  })
})
