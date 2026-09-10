/**
 * The draft service (`src/drafts/service.ts`) driven directly — the ONE implementation the `drafts`
 * router and (Task 19) the `/a/:draftId` review pages both call. Every case here is about what the
 * transaction writes, so it asserts on rows, not on HTTP.
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { desc, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { APPROVE_UNDO_SECONDS } from '@aesa/contracts'
import { auditLog, draftActionTokens, drafts, notifications, outboundSends, tickets, workspaces } from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import {
  approveDraft, holdDraft, levenshteinRatio, markViewed, rejectDraft, resolveTicket, resumeDraft,
  type DraftActor, type DraftServiceDeps,
} from '../src/drafts/service.ts'
import type { EnqueueFn } from '../src/deps.ts'
import { createAppLogger } from '../src/logging.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import {
  SEED_DRAFT_BODY, WEB, createTestApi, insertAgent, insertConnectedMailbox, insertTicket, listen, seedPendingDraft, signInWithOtp,
} from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

interface Recorded { name: string; data: Record<string, unknown>; opts: { entityId: string; startAfter?: Date; debounceSeconds?: number } }

describe('draft service', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let deps: DraftServiceDeps
  let sent: Recorded[]
  let seq = 0

  beforeAll(async () => {
    t = await createTestApi()
    base = await listen(t.app)
    sent = []
    const enqueue: EnqueueFn = async (name, data, opts) => {
      sent.push({ name, data, opts })
      return `job-${sent.length}`
    }
    deps = { api: t.api, enqueue, logger: createAppLogger({ level: 'silent' }) }
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => { sent.length = 0 })

  /** A fresh org with a connected mailbox, an active agent, and the agent switched on. */
  async function seedOrg(opts: { agentEnabled?: boolean; killSwitch?: boolean } = {}) {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `svc-${n}@example.com`, 'Owner')
    const { orgId } = await client(base, signed.cookie).workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const address = `support${n}@acme.test`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const agentId = await insertAgent(t.api, orgId, connectionId, address)
    await t.api.withOrg(orgId, (tx) => tx.update(workspaces)
      .set({ agentEnabled: opts.agentEnabled ?? true, killSwitch: opts.killSwitch ?? false })
      .where(eq(workspaces.orgId, orgId)))
    const actor: DraftActor = { userId: signed.user.id, actor: `user:${signed.user.id}`, source: 'app', ip: '127.0.0.1', userAgent: 'vitest' }
    return { orgId, userId: signed.user.id, connectionId, agentId, actor, cookie: signed.cookie }
  }

  /** An `awaiting_review` ticket with one live, already-viewed draft on it — the state Approve expects. */
  async function seedReviewable(org: Awaited<ReturnType<typeof seedOrg>>, draftOpts: Parameters<typeof seedPendingDraft>[3] = {}) {
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review',
      customerEmail: 'casey@customer.test', subject: 'Where is my order?', lastInboundAt: new Date(), inboundCount: 1,
    })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), ...draftOpts })
    return { ticket, draft }
  }

  const readDraft = (orgId: string, draftId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(drafts).where(eq(drafts.id, draftId)))[0])
  const readSend = (orgId: string, draftId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))[0])
  const readTicket = (orgId: string, ticketId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(tickets).where(eq(tickets.id, ticketId)))[0])
  const readAudit = (orgId: string, action: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.createdAt)))

  // -- approve --

  it('approves an unchanged draft: final_body is the model body, ratio 0, one queued send 15 s out, one enqueue, one audit row', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)
    const before = Date.now()

    const res = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(res).toMatchObject({ ok: true, edited: false })
    if (!res.ok) throw new Error('unreachable')

    const after = await readDraft(org.orgId, draft.id)
    expect(after).toMatchObject({ status: 'approved', finalBody: SEED_DRAFT_BODY, editDistanceRatio: 0, decisionSource: 'app', decidedBy: org.userId })
    expect(after!.decidedAt).toBeInstanceOf(Date)

    const send = await readSend(org.orgId, draft.id)
    expect(send).toMatchObject({ id: res.sendId, status: 'queued', ticketId: ticket.id, connectionId: org.connectionId, agentId: org.agentId, attempts: 0 })
    const delta = send!.sendAfter.getTime() - before
    expect(delta).toBeGreaterThanOrEqual(APPROVE_UNDO_SECONDS * 1000 - 1_000)
    expect(delta).toBeLessThanOrEqual(APPROVE_UNDO_SECONDS * 1000 + 5_000)
    expect(res.sendAfter.getTime()).toBe(send!.sendAfter.getTime())

    expect(sent).toEqual([{
      name: JOB_NAMES.sendExecute,
      data: { orgId: org.orgId, sendId: res.sendId },
      opts: { entityId: res.sendId, startAfter: send!.sendAfter },
    }])

    const rows = await readAudit(org.orgId, 'draft.approved')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: `user:${org.userId}`, entityType: 'draft', entityId: draft.id })
    expect(rows[0]!.detail).toMatchObject({ ticketId: ticket.id, edited: false, editDistanceRatio: 0, source: 'app' })
  })

  it('approves an edited draft: final_body is the normalized edit, ratio > 0, edited true', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const edited = 'Hi Casey,\n\nYour order ships on Thursday and you will get tracking by email.\n\nThanks'

    const res = await approveDraft(deps, org.orgId, { draftId: draft.id, body: edited }, org.actor)
    expect(res).toMatchObject({ ok: true, edited: true })

    const after = await readDraft(org.orgId, draft.id)
    expect(after!.finalBody).toBe(edited)
    expect(after!.body).toBe(SEED_DRAFT_BODY)          // the model's own body is never overwritten
    expect(after!.editDistanceRatio!).toBeGreaterThan(0)
    expect(after!.editDistanceRatio!).toBeLessThan(1)
  })

  it('refuses an unviewed draft from the app (not_viewed) and writes nothing; the same draft from email stamps viewed_at and approves', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org, { viewedAt: null })

    expect(await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)).toEqual({ ok: false, code: 'not_viewed' })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending', viewedAt: null })
    expect(await readSend(org.orgId, draft.id)).toBeUndefined()
    expect(sent).toEqual([])

    const res = await approveDraft(deps, org.orgId, { draftId: draft.id }, { ...org.actor, source: 'email' })
    expect(res).toMatchObject({ ok: true })
    const after = await readDraft(org.orgId, draft.id)
    expect(after).toMatchObject({ status: 'approved', decisionSource: 'email' })
    expect(after!.viewedAt).toBeInstanceOf(Date)
  })

  it('refuses when the agent is switched off (agent_disabled) or the kill switch is on (kill_switch), writing nothing', async () => {
    const off = await seedOrg({ agentEnabled: false })
    const a = await seedReviewable(off)
    expect(await approveDraft(deps, off.orgId, { draftId: a.draft.id }, off.actor)).toEqual({ ok: false, code: 'agent_disabled' })
    expect(await readDraft(off.orgId, a.draft.id)).toMatchObject({ status: 'pending' })
    expect(await readSend(off.orgId, a.draft.id)).toBeUndefined()

    const killed = await seedOrg({ killSwitch: true })
    const b = await seedReviewable(killed)
    expect(await approveDraft(deps, killed.orgId, { draftId: b.draft.id }, killed.actor)).toEqual({ ok: false, code: 'kill_switch' })
    expect(await readDraft(killed.orgId, b.draft.id)).toMatchObject({ status: 'pending' })
    expect(sent).toEqual([])
  })

  it('refuses an edit the guardrails fail (url_not_allowed) with NO state change and the action token NOT consumed', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const [token] = await t.api.withOrg(org.orgId, (tx) => tx.insert(draftActionTokens).values({
      orgId: org.orgId, draftId: draft.id, userId: org.userId, tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning())

    const res = await approveDraft(
      deps, org.orgId,
      { draftId: draft.id, body: 'Hi Casey,\n\nGrab the deal at https://evil.com/deal.\n\nThanks' },
      { ...org.actor, source: 'email' },
      { consumeTokenId: token!.id },
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('guardrail')
    expect(res.findings?.map((f) => f.code)).toContain('url_not_allowed')

    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending', finalBody: null })
    expect(await readSend(org.orgId, draft.id)).toBeUndefined()
    const [after] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(draftActionTokens).where(eq(draftActionTokens.id, token!.id)))
    expect(after!.consumedAt).toBeNull()
    expect(sent).toEqual([])
  })

  it('consumes the action token in the same transaction on success, and throws (rolling back) when it is already consumed', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const [token] = await t.api.withOrg(org.orgId, (tx) => tx.insert(draftActionTokens).values({
      orgId: org.orgId, draftId: draft.id, userId: org.userId, tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning())

    const res = await approveDraft(deps, org.orgId, { draftId: draft.id }, { ...org.actor, source: 'email' }, { consumeTokenId: token!.id })
    expect(res.ok).toBe(true)
    const [consumed] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(draftActionTokens).where(eq(draftActionTokens.id, token!.id)))
    expect(consumed!.consumedAt).toBeInstanceOf(Date)

    // A second click on the same link: the draft is no longer pending, so it never reaches the token.
    expect(await approveDraft(deps, org.orgId, { draftId: draft.id }, { ...org.actor, source: 'email' }, { consumeTokenId: token!.id }))
      .toEqual({ ok: false, code: 'not_pending' })

    // A fresh pending draft with an ALREADY consumed token: the guarded consume matches 0 rows and throws.
    const second = await seedReviewable(org)
    await expect(approveDraft(
      deps, org.orgId, { draftId: second.draft.id }, { ...org.actor, source: 'email' }, { consumeTokenId: token!.id },
    )).rejects.toThrow()
    expect(await readDraft(org.orgId, second.draft.id)).toMatchObject({ status: 'pending' })
    expect(await readSend(org.orgId, second.draft.id)).toBeUndefined()
  })

  it('is not_found for a draft in another org and not_pending for an already decided one', async () => {
    const org = await seedOrg()
    const other = await seedOrg()
    const { draft } = await seedReviewable(org)
    expect(await approveDraft(deps, other.orgId, { draftId: draft.id }, other.actor)).toEqual({ ok: false, code: 'not_found' })
    expect(await holdDraft(deps, other.orgId, draft.id, other.actor)).toEqual({ ok: false, code: 'not_found' })
    expect(await resumeDraft(deps, other.orgId, draft.id, other.actor)).toEqual({ ok: false, code: 'not_found' })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending' })
  })

  it('serializes two concurrent approvals of the same draft: exactly one wins, one send row, one enqueue', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)

    const [a, b] = await Promise.all([
      approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor),
      approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor),
    ])
    const winners = [a, b].filter((r) => r.ok)
    expect(winners).toHaveLength(1)
    expect([a, b].filter((r) => !r.ok)).toEqual([{ ok: false, code: 'not_pending' }])

    const all = await t.api.withOrg(org.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draft.id)))
    expect(all).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(await readAudit(org.orgId, 'draft.approved')).toHaveLength(1)
  })

  // -- hold (the undo window) --

  it('holds an approved draft inside the window (send held, draft back to pending) and re-approving re-queues the SAME send row', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const first = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    if (!first.ok) throw new Error('approve failed')

    expect(await holdDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending' })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: first.sendId, status: 'held' })
    expect((await readAudit(org.orgId, 'draft.held'))).toHaveLength(1)

    // Attempts is bumped by the send worker; prove the re-queue resets it on the SAME ledger row.
    await t.api.withOrg(org.orgId, (tx) => tx.update(outboundSends)
      .set({ attempts: 2, lastError: 'held:owner_undo', claimToken: randomUUID() })
      .where(eq(outboundSends.id, first.sendId)))

    const second = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(second).toMatchObject({ ok: true, sendId: first.sendId })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: first.sendId, status: 'queued', attempts: 0, lastError: null, claimToken: null })
    const all = await t.api.withOrg(org.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draft.id)))
    expect(all).toHaveLength(1)
  })

  it('is too_late once the send is claimed, and not_holdable while the draft is still pending', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    expect(await holdDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: false, code: 'not_holdable' })

    const approved = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    if (!approved.ok) throw new Error('approve failed')
    await t.api.withOrg(org.orgId, (tx) => tx.update(outboundSends)
      .set({ status: 'claimed', claimedAt: new Date(), claimToken: randomUUID() })
      .where(eq(outboundSends.id, approved.sendId)))

    expect(await holdDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: false, code: 'too_late' })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'approved' })
  })

  // -- resume (a draft the send job put on hold) --

  it('resumes a job-held draft (held → pending, the send row stays held) and the next approve re-queues that same send', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'held' })
    const [send] = await t.api.withOrg(org.orgId, (tx) => tx.insert(outboundSends).values({
      orgId: org.orgId, draftId: draft.id, ticketId: ticket.id, connectionId: org.connectionId, agentId: org.agentId,
      status: 'held', sendAfter: new Date(), attempts: 1, lastError: 'held:workspace_kill_switch',
    }).returning())

    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending' })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: send!.id, status: 'held' })
    expect(await readAudit(org.orgId, 'draft.resumed')).toHaveLength(1)

    // Not held any more.
    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: false, code: 'not_held' })

    const res = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(res).toMatchObject({ ok: true, sendId: send!.id })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: send!.id, status: 'queued', attempts: 0, lastError: null })
  })

  // -- reject --

  it('rejects for a redraft: the draft is rejected, the ticket goes back to triaged with the feedback, and ticket.draft is enqueued', async () => {
    const org = await seedOrg()
    const promptedAt = new Date('2026-03-01T10:00:00Z')
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review',
      lastAgentRunAt: new Date(), lastAgentFinishedAt: new Date(), lastAgentPromptedAt: promptedAt, agentFailureCount: 1,
    })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'redraft', reason: 'Mention the 30-day return window.' }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'redraft' })

    expect(await readDraft(org.orgId, draft.id)).toMatchObject({
      status: 'rejected', rejectAction: 'redraft', rejectReason: 'Mention the 30-day return window.', decisionSource: 'app', decidedBy: org.userId,
    })
    const after = await readTicket(org.orgId, ticket.id)
    expect(after).toMatchObject({
      status: 'triaged', ownerRedraftFeedback: 'Mention the 30-day return window.', redraftCount: 1,
      agentFailureCount: 0, lastAgentRunAt: null, lastAgentFinishedAt: null,
    })
    expect(after!.lastAgentPromptedAt?.toISOString()).toBe(promptedAt.toISOString())   // the per-day run cap is NOT reset

    expect(sent).toEqual([{ name: JOB_NAMES.ticketDraft, data: { orgId: org.orgId, ticketId: ticket.id }, opts: { entityId: ticket.id } }])
    const rows = await readAudit(org.orgId, 'draft.rejected_for_redraft')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toMatchObject({ reasonLen: 'Mention the 30-day return window.'.length, redraftCount: 1 })
  })

  it('escalates at the redraft cap: needs_owner/redraft_limit_reached, one notification, notify.dispatch enqueued', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review', redraftCount: 2,
    })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'redraft', reason: 'Still not right.' }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'escalate_limit' })

    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'rejected' })
    const after = await readTicket(org.orgId, ticket.id)
    expect(after).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'redraft_limit_reached', redraftCount: 0, ownerRedraftFeedback: null })
    expect(after!.escalationNotifiedAt).toBeNull()          // a real page: the dispatcher stamps it

    const pushes = await t.api.withOrg(org.orgId, (tx) => tx.select().from(notifications).where(eq(notifications.kind, 'escalation')))
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.dedupeKey).toContain(`redraft_limit:${ticket.id}:`)
    expect(sent).toEqual([{ name: JOB_NAMES.notifyDispatch, data: { orgId: org.orgId, notificationId: pushes[0]!.id }, opts: { entityId: pushes[0]!.id } }])
    expect((await readAudit(org.orgId, 'draft.rejected'))[0]!.detail).toMatchObject({ resolution: 'escalate_limit' })
  })

  it("takes the ticket over on a blank reason: needs_owner/owner_handling, pre-stamped and silent, nothing enqueued", async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'handle', reason: '' }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'escalate_terminal' })

    const after = await readTicket(org.orgId, ticket.id)
    expect(after).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'owner_handling' })
    expect(after!.escalationNotifiedAt).toBeInstanceOf(Date)
    expect(await t.api.withOrg(org.orgId, (tx) => tx.select().from(notifications))).toHaveLength(0)
    expect(sent).toEqual([])
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'rejected', rejectAction: 'handle' })
  })

  it('falls back to the terminal escalation when the ticket already left awaiting_review, in the same transaction', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'needs_owner', needsOwnerReason: 'tripwire' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'redraft', reason: 'Try again please.' }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'escalate_terminal' })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'rejected' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'owner_handling' })
    expect(sent).toEqual([])
  })

  it('is not_pending when the draft was already decided', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'handle', reason: '' }, org.actor)).toEqual({ ok: false, code: 'not_pending' })
  })

  // -- markViewed / resolveTicket --

  it('markViewed stamps a pending draft once and returns false for a decided one', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org, { viewedAt: null })
    expect(await markViewed(deps, org.orgId, draft.id, org.actor)).toBe(true)
    const first = await readDraft(org.orgId, draft.id)
    expect(first!.viewedAt).toBeInstanceOf(Date)

    expect(await markViewed(deps, org.orgId, draft.id, org.actor)).toBe(true)
    expect((await readDraft(org.orgId, draft.id))!.viewedAt!.toISOString()).toBe(first!.viewedAt!.toISOString())  // COALESCE: never re-stamped

    await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(await markViewed(deps, org.orgId, draft.id, org.actor)).toBe(false)
  })

  it('resolveTicket supersedes the live approved draft, holds its send, clears the redraft cycle and audits', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review', redraftCount: 1, ownerRedraftFeedback: 'earlier feedback',
    })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })
    const approved = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    if (!approved.ok) throw new Error('approve failed')

    expect(await resolveTicket(deps, org.orgId, ticket.id, org.actor)).toBe(true)
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'resolved', redraftCount: 0, ownerRedraftFeedback: null })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'superseded' })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: approved.sendId, status: 'held' })
    expect(await readAudit(org.orgId, 'ticket.resolved')).toHaveLength(1)

    expect(await resolveTicket(deps, org.orgId, ticket.id, org.actor)).toBe(false)   // already resolved
  })

  it('resolveTicket supersedes a pending draft too and leaves other orgs alone', async () => {
    const org = await seedOrg()
    const other = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)
    expect(await resolveTicket(deps, other.orgId, ticket.id, other.actor)).toBe(false)
    expect(await resolveTicket(deps, org.orgId, ticket.id, org.actor)).toBe(true)
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'superseded' })
  })

  // -- the ratio --

  it('levenshteinRatio: 0 for identical (and empty) strings, 1 for a full rewrite, in between for an edit', () => {
    expect(levenshteinRatio('same text', 'same text')).toBe(0)
    expect(levenshteinRatio('', '')).toBe(0)
    expect(levenshteinRatio('abcd', 'wxyz')).toBe(1)
    expect(levenshteinRatio('kitten', 'sitting')).toBeCloseTo(3 / 7, 10)
    expect(levenshteinRatio('abc', '')).toBe(1)
  })
})
