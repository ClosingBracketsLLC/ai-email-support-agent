/**
 * The draft service (`src/drafts/service.ts`) driven directly — the ONE implementation the `drafts`
 * router and (Task 19) the `/a/:draftId` review pages both call. Every case here is about what the
 * transaction writes, so it asserts on rows, not on HTTP.
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, desc, eq, inArray } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { APPROVE_UNDO_SECONDS, OPERATING_GUIDANCE_MAX } from '@aesa/contracts'
import {
  agentCategoryPolicies, auditLog, categories, draftActionTokens, drafts, notifications, outboundSends, resolvedAnswers, tickets, workspaces,
} from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import {
  LIVE_DRAFT_STATUSES, approveDraft, flagAutoSent, holdDraft, levenshteinRatio, markViewed, rejectDraft, resolveTicket, resumeDraft, withDeadlockRetry,
  type DraftActor, type DraftServiceDeps,
} from '../src/drafts/service.ts'
import type { ApiFacade, EnqueueFn } from '../src/deps.ts'
import { createAppLogger } from '../src/logging.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import {
  SEED_DRAFT_BODY, WEB, createTestApi, insertAgent, insertConnectedMailbox, insertTicket, listen, seedPendingDraft, signInWithOtp,
} from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

interface Recorded { name: string; data: Record<string, unknown>; opts: { entityId: string; startAfter?: Date; debounceSeconds?: number } }

/**
 * The real facade, with one seam an interleaving test needs: the transaction is held OPEN (every row
 * lock it took still held, nothing committed) once the service's body finishes, until the test
 * releases it. That is what lets a second, competing transaction run against a half-finished one.
 */
function pausingApi(api: ApiFacade, gate: { reached: () => void; release: Promise<void> }): ApiFacade {
  return {
    ...api,
    withOrg: (orgId, fn) => api.withOrg(orgId, async (tx) => {
      const out = await fn(tx)
      gate.reached()
      await gate.release
      return out
    }),
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

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

  /**
   * The state Task 6's auto landing leaves behind: an `auto_sending` ticket, a draft already
   * `approved` with `decision_source: 'auto'` and its `final_body` written, a `queued` send two
   * minutes out (the agent's hold window), and the draft's category on Autopilot. `categoryId` is
   * passed back in so a second auto-send can be seeded into the SAME (agent, category) — which is
   * what every demotion signal is counted over.
   */
  async function seedAutoSending(
    org: Awaited<ReturnType<typeof seedOrg>>,
    opts: { categoryId?: string; usedAnswerIds?: string[]; status?: 'approved' | 'sent' } = {},
  ) {
    const now = new Date()
    const categoryId = opts.categoryId ?? (await t.api.withOrg(org.orgId, async (tx) => {
      const [row] = await tx.insert(categories)
        .values({ orgId: org.orgId, key: `order_status-${randomUUID().slice(0, 8)}`, label: 'Order status' })
        .returning({ id: categories.id })
      await tx.insert(agentCategoryPolicies)
        .values({ orgId: org.orgId, agentId: org.agentId, categoryId: row!.id, mode: 'auto', autoSendMinConfidence: 80, graduatedAt: now })
      return row!.id
    }))

    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'auto_sending', categoryId,
      customerEmail: 'casey@customer.test', subject: 'Where is my order?', lastInboundAt: now, inboundCount: 1,
    })
    const seeded = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId })
    const status = opts.status ?? 'approved'
    const [draft] = await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({
      status, finalBody: SEED_DRAFT_BODY, decisionSource: 'auto', decidedAt: now, autoDecidedAt: now,
      categoryId, usedAnswerIds: opts.usedAnswerIds ?? [],
    }).where(eq(drafts.id, seeded.id)).returning())
    const [send] = await t.api.withOrg(org.orgId, (tx) => tx.insert(outboundSends).values({
      orgId: org.orgId, draftId: seeded.id, ticketId: ticket.id, connectionId: org.connectionId, agentId: org.agentId,
      status: status === 'sent' ? 'sent' : 'queued', sendAfter: new Date(now.getTime() + 2 * 60_000),
      ...(status === 'sent' ? { sentAt: now } : {}),
    }).returning())
    return { ticket, draft: draft!, send: send!, categoryId }
  }

  /** One `resolved_answers` row, as `memory.capture` would have written it. */
  async function seedAnswer(
    orgId: string, values: Partial<typeof resolvedAnswers.$inferInsert> = {},
  ): Promise<typeof resolvedAnswers.$inferSelect> {
    const [row] = await t.api.withOrg(orgId, (tx) => tx.insert(resolvedAnswers).values({
      orgId, questionText: 'When does my order ship?', answerBody: 'It ships the next working day.',
      expiresAt: new Date(Date.now() + 365 * 86_400_000), ...values,
    }).returning())
    return row!
  }

  const readPolicy = (orgId: string, agentId: string, categoryId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(agentCategoryPolicies)
      .where(and(eq(agentCategoryPolicies.agentId, agentId), eq(agentCategoryPolicies.categoryId, categoryId))))[0])
  const readAnswer = (orgId: string, answerId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.id, answerId)))[0])
  const readWorkspace = (orgId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(workspaces).where(eq(workspaces.orgId, orgId)))[0])
  const readNotifications = (orgId: string, kind: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(notifications).where(eq(notifications.kind, kind)))

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

  // A1 (final-C I2 / final-E I1): the approve gate and the send gate MUST build the same policy from
  // the same four trusted texts. `trustedTexts: []` at approve let an owner edit quoting the
  // workspace's own guidance through, and `send.execute` step 2 then destroyed the draft with
  // `landTerminal('guardrail:trusted_text_leak')` 15 seconds later.
  const GUIDANCE = 'Always confirm the order number before you promise a delivery date to any customer who writes in about shipping.'

  it('refuses an edit that quotes ten consecutive words of the workspace guidance (trusted_text_leak), writing nothing', async () => {
    const org = await seedOrg()
    await t.api.withOrg(org.orgId, (tx) => tx.update(workspaces).set({ operatingGuidance: GUIDANCE }).where(eq(workspaces.orgId, org.orgId)))
    const { draft } = await seedReviewable(org)
    const [token] = await t.api.withOrg(org.orgId, (tx) => tx.insert(draftActionTokens).values({
      orgId: org.orgId, draftId: draft.id, userId: org.userId, tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning())

    // Ten consecutive words of GUIDANCE, verbatim, inside an otherwise ordinary reply.
    const leak = 'Hi Casey,\n\nAlways confirm the order number before you promise a delivery date — so could you send it over?\n\nThanks'
    const res = await approveDraft(deps, org.orgId, { draftId: draft.id, body: leak }, org.actor, { consumeTokenId: token!.id })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('guardrail')
    expect(res.findings?.map((f) => f.code)).toContain('trusted_text_leak')

    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending', finalBody: null })
    expect(await readSend(org.orgId, draft.id)).toBeUndefined()
    const [after] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(draftActionTokens).where(eq(draftActionTokens.id, token!.id)))
    expect(after!.consumedAt).toBeNull()
    expect(sent).toEqual([])
  })

  it('a clean edit still approves against the full policy — the guidance is loaded, it is just not quoted', async () => {
    const org = await seedOrg()
    await t.api.withOrg(org.orgId, (tx) => tx.update(workspaces).set({ operatingGuidance: GUIDANCE }).where(eq(workspaces.orgId, org.orgId)))
    const { draft } = await seedReviewable(org)

    const clean = 'Hi Casey,\n\nCould you send me your order number? I will check the shipping date and come straight back.\n\nThanks'
    const res = await approveDraft(deps, org.orgId, { draftId: draft.id, body: clean }, org.actor)
    expect(res).toMatchObject({ ok: true, edited: true })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'approved', finalBody: clean })
  })

  // A5 (final-C M4): the retried body is meant to be "a fresh set of reads" — and a fresh clock with
  // them, or the retry stamps `decided_at` and `send_after` from before the deadlock it lost.
  it('a deadlocked approve retries with a FRESH clock: decided_at and send_after come from the retry', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    const t0 = new Date('2026-09-10T10:00:00.000Z')
    const t1 = new Date('2026-09-10T10:00:05.000Z')
    const stamps = [t0, t1]
    let attempts = 0
    // How drizzle surfaces a deadlock: the SQLSTATE sits on the wrapped pg error, not the wrapper.
    const deadlock = (): Error => Object.assign(new Error('Failed query: update "drafts" …'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    })
    const api: ApiFacade = {
      ...t.api,
      withOrg: (id, fn) => { if (++attempts === 1) throw deadlock(); return t.api.withOrg(id, fn) },
    }

    const res = await approveDraft({ ...deps, api, now: () => stamps.shift() ?? t1 }, org.orgId, { draftId: draft.id }, org.actor)
    expect(res.ok).toBe(true)
    expect(attempts).toBe(2)
    expect((await readDraft(org.orgId, draft.id))!.decidedAt!.toISOString()).toBe(t1.toISOString())
    expect((await readSend(org.orgId, draft.id))!.sendAfter.toISOString())
      .toBe(new Date(t1.getTime() + APPROVE_UNDO_SECONDS * 1000).toISOString())
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
    const audits = await readAudit(org.orgId, 'draft.resumed')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ from: 'held' })

    // Not held (or failed) any more.
    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: false, code: 'not_resumable' })

    const res = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(res).toMatchObject({ ok: true, sendId: send!.id })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: send!.id, status: 'queued', attempts: 0, lastError: null })
  })

  // A3 (final-E I2): a terminal send failure (`landTerminal`, `landDeadLetter`) leaves the draft
  // `failed` and the ticket `needs_owner/send_failed`. `failed` had no outgoing edge, so the
  // runbook's documented recovery — "fix the cause, then approve the draft again" — was a dead
  // button and the send matrix's `failed → queued` edge was unreachable.
  it('resumes a draft a FAILED send left behind: draft → pending, ticket needs_owner/send_failed → awaiting_review, the send row still failed', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'needs_owner', needsOwnerReason: 'send_failed',
    })
    const notifiedAt = new Date(Date.now() - 60_000)
    await t.api.withOrg(org.orgId, (tx) => tx.update(tickets).set({ escalationNotifiedAt: notifiedAt }).where(eq(tickets.id, ticket.id)))
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'failed' })
    const [send] = await t.api.withOrg(org.orgId, (tx) => tx.insert(outboundSends).values({
      orgId: org.orgId, draftId: draft.id, ticketId: ticket.id, connectionId: org.connectionId, agentId: org.agentId,
      status: 'failed', sendAfter: new Date(), attempts: 3, lastError: 'guardrail:trusted_text_leak',
    }).returning())

    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending' })
    const after = await readTicket(org.orgId, ticket.id)
    expect(after).toMatchObject({ status: 'awaiting_review', needsOwnerReason: null })
    // The page already went out; re-stamping it would re-page the owner about a ticket they are on.
    expect(after!.escalationNotifiedAt!.toISOString()).toBe(notifiedAt.toISOString())
    // The ledger row keeps its history — the re-approve revives THIS row, it does not start a second.
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: send!.id, status: 'failed', attempts: 3 })
    const audits = await readAudit(org.orgId, 'draft.resumed')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ from: 'failed' })

    // The whole point: approve now works, and re-queues the same ledger row.
    const res = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(res).toMatchObject({ ok: true, sendId: send!.id })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: send!.id, status: 'queued', attempts: 0, lastError: null })
  })

  it('resumes a failed draft whose ticket is NOT needs_owner/send_failed and leaves that ticket exactly as it was', async () => {
    const org = await seedOrg()
    // `landStale` fails the draft but sends the ticket back to `triaged` for a re-draft — it never
    // escalates, so there is no needs_owner to walk back.
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'triaged' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'failed' })

    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'triaged', needsOwnerReason: null })
  })

  // Round 2, re-review 1: `failed` is OUTSIDE `drafts_live_per_ticket_uidx` and the target `pending`
  // is inside it, so a resume on a ticket that already got a re-draft used to raise a raw 23505 —
  // a masked 500 on a button, not a soft outcome. (The `landStale` shape reaches exactly this: the
  // draft fails, the ticket goes back to `triaged` and a re-draft is enqueued.)
  it('refuses a resume when the ticket already has a live draft, writing nothing', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'triaged' })
    const failed = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'failed' })
    const live = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId })   // the re-draft landed first

    expect(await resumeDraft(deps, org.orgId, failed.id, org.actor)).toEqual({ ok: false, code: 'not_resumable' })
    expect(await readDraft(org.orgId, failed.id)).toMatchObject({ status: 'failed' })
    expect(await readDraft(org.orgId, live.id)).toMatchObject({ status: 'pending' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'triaged' })
    expect(await readAudit(org.orgId, 'draft.resumed')).toEqual([])
  })

  // Round 3: a `failed` draft is the owner's to bring back only while the TICKET is still theirs —
  // `needs_owner/send_failed` (the send job's own escalation) or `triaged` (the stale hand-back).
  // `resolveTicket` leaves `failed` drafts alone (terminal, by design) and `reopenIfEligible` never
  // touches drafts, so a resolved/new/waiting ticket can carry one from a prior cycle; resuming it
  // would strand a `pending` draft that 23505s the next `ticket.draft` insert after re-triage.
  it('refuses a resume on a ticket escalated for some OTHER reason — only the send job\'s own escalation is walked back', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, {
      connectionId: org.connectionId, agentId: org.agentId, status: 'needs_owner', needsOwnerReason: 'owner_handling',
    })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'failed' })

    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: false, code: 'not_resumable' })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'failed' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'owner_handling' })
    expect(await readAudit(org.orgId, 'draft.resumed')).toEqual([])
  })

  it('refuses a resume on a RESOLVED ticket carrying a stale failed draft, writing nothing', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'resolved' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'failed' })

    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: false, code: 'not_resumable' })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'failed' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'resolved' })
    expect(await readAudit(org.orgId, 'draft.resumed')).toEqual([])
  })

  it('a HELD draft is resumable whatever the ticket says — the precondition is the failed path\'s alone', async () => {
    const org = await seedOrg()
    // `landHeld` never moves the ticket, so a held draft always sits on `awaiting_review` in
    // practice; this pins that the round-3 precondition did not narrow the hold path by accident.
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'needs_owner', needsOwnerReason: 'tripwire' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'held' })

    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'tripwire' })
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

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'redraft', reason: 'Mention the 30-day return window.', addToGuidance: false }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'redraft', guidanceAdded: false })

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

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'redraft', reason: 'Still not right.', addToGuidance: false }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'escalate_limit', guidanceAdded: false })

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

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'handle', reason: '', addToGuidance: false }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })

    const after = await readTicket(org.orgId, ticket.id)
    expect(after).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'owner_handling' })
    expect(after!.escalationNotifiedAt).toBeInstanceOf(Date)
    expect(await t.api.withOrg(org.orgId, (tx) => tx.select().from(notifications))).toHaveLength(0)
    expect(sent).toEqual([])
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'rejected', rejectAction: 'handle' })
  })

  it('resolves terminally when the ticket already left awaiting_review — the draft is rejected and the ticket is left exactly as its owner left it', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'needs_owner', needsOwnerReason: 'tripwire' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })

    const res = await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'redraft', reason: 'Try again please.', addToGuidance: false }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'rejected' })
    // `awaiting_review` is the only status a reject escalates FROM: this ticket was already escalated
    // for another reason, and overwriting that with `owner_handling` would erase why it is waiting.
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'tripwire' })
    expect(await readAudit(org.orgId, 'ticket.escalated')).toHaveLength(0)
    // The resolution the caller is told and the one on the audit row are the same, and both say what
    // actually happened: nothing was escalated, so it is never reported as `escalate_limit`.
    const audited = (await readAudit(org.orgId, 'draft.rejected'))[0]!.detail as { resolution: string; escalated: boolean }
    expect(audited).toMatchObject({ resolution: 'escalate_terminal', escalated: false })
    expect(res).toEqual({ ok: true, resolution: audited.resolution, guidanceAdded: false })
    expect(sent).toEqual([])
  })

  it('is not_pending when the draft was already decided', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'handle', reason: '', addToGuidance: false }, org.actor)).toEqual({ ok: false, code: 'not_pending' })
  })

  // -- Phase 5: the auto-send loop (hold, resume, flag), reject-to-guidance and inline demotion --

  it('holdDraft on an auto-send: send held, draft back to pending with auto_held_at, ticket auto_sending → awaiting_review, audit draft.held { auto: true }', async () => {
    const org = await seedOrg()
    const { ticket, draft, send } = await seedAutoSending(org)

    expect(await holdDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })

    const after = await readDraft(org.orgId, draft.id)
    expect(after).toMatchObject({ status: 'pending', finalBody: SEED_DRAFT_BODY })
    expect(after!.autoHeldAt).toBeInstanceOf(Date)
    expect(after!.autoDecidedAt).toBeInstanceOf(Date)              // the durable auto mark survives
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: send.id, status: 'held' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'awaiting_review' })

    const rows = await readAudit(org.orgId, 'draft.held')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toMatchObject({ draftId: draft.id, ticketId: ticket.id, sendId: send.id, auto: true })
  })

  it('holdDraft on a HUMAN approval leaves auto_held_at null, the ticket alone, and audits auto: false', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)
    await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)

    expect(await holdDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    expect((await readDraft(org.orgId, draft.id))!.autoHeldAt).toBeNull()
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'awaiting_review' })
    expect((await readAudit(org.orgId, 'draft.held'))[0]!.detail).toMatchObject({ auto: false })
  })

  it('resumeDraft on a held auto draft returns the ticket to awaiting_review as well', async () => {
    const org = await seedOrg()
    const { ticket, draft, send } = await seedAutoSending(org)
    // What `send.execute`'s `landHeld` leaves on an auto-sending ticket: both rows held, the ticket
    // still counting down in `auto_sending`.
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({ status: 'held' }).where(eq(drafts.id, draft.id)))
    await t.api.withOrg(org.orgId, (tx) => tx.update(outboundSends)
      .set({ status: 'held', lastError: 'held:workspace_kill_switch' }).where(eq(outboundSends.id, send.id)))

    expect(await resumeDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'pending' })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ status: 'held' })
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'awaiting_review' })
    expect((await readAudit(org.orgId, 'draft.resumed'))[0]!.detail).toMatchObject({ from: 'held', ticketReturned: true })
  })

  it('an edited approve of a draft that was auto-held demotes the category (hold_then_edit) and enqueues guidance.suggest', async () => {
    const org = await seedOrg()
    const { draft, categoryId } = await seedAutoSending(org)
    expect(await holdDraft(deps, org.orgId, draft.id, org.actor)).toEqual({ ok: true })
    await markViewed(deps, org.orgId, draft.id, org.actor)
    sent.length = 0

    const edited = 'Hi Casey,\n\nYour order ships on Thursday and you will get tracking by email.\n\nThanks'
    const res = await approveDraft(deps, org.orgId, { draftId: draft.id, body: edited }, org.actor)
    expect(res).toMatchObject({ ok: true, edited: true })

    const policy = await readPolicy(org.orgId, org.agentId, categoryId)
    expect(policy).toMatchObject({ mode: 'review', demotedReason: 'hold_then_edit' })
    expect(policy!.demotedAt).toBeInstanceOf(Date)

    const [demotion] = await readNotifications(org.orgId, 'demotion')
    expect(demotion).toBeDefined()
    expect(sent.map((s) => s.name).sort()).toEqual([JOB_NAMES.guidanceSuggest, JOB_NAMES.notifyDispatch, JOB_NAMES.sendExecute].sort())
    expect(sent.find((s) => s.name === JOB_NAMES.guidanceSuggest)).toMatchObject({
      data: { orgId: org.orgId, draftId: draft.id }, opts: { entityId: draft.id },
    })
    expect(sent.find((s) => s.name === JOB_NAMES.notifyDispatch)).toMatchObject({
      data: { orgId: org.orgId, notificationId: demotion!.id }, opts: { entityId: demotion!.id },
    })
    expect((await readAudit(org.orgId, 'autonomy.demoted'))[0]!.detail).toMatchObject({ categoryId, reason: 'hold_then_edit' })
  })

  it('an unchanged approve enqueues no guidance.suggest, and an edited approve of a draft that was never auto-held demotes nothing', async () => {
    const org = await seedOrg()
    const { draft } = await seedReviewable(org)
    await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    expect(sent.map((s) => s.name)).toEqual([JOB_NAMES.sendExecute])

    // The same auto-send, parked by `landHeld` (a kill lever) and brought back to review WITHOUT a
    // Hold — so `auto_held_at` is null and the edit below is an ordinary review decision.
    const auto = await seedAutoSending(org)
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({ status: 'pending', viewedAt: new Date() }).where(eq(drafts.id, auto.draft.id)))
    await t.api.withOrg(org.orgId, (tx) => tx.update(outboundSends).set({ status: 'held' }).where(eq(outboundSends.id, auto.send.id)))
    sent.length = 0
    const edited = 'Hi Casey,\n\nYour order ships on Thursday and you will get tracking by email.\n\nThanks'
    expect(await approveDraft(deps, org.orgId, { draftId: auto.draft.id, body: edited }, org.actor)).toMatchObject({ ok: true, edited: true })
    expect(sent.map((s) => s.name).sort()).toEqual([JOB_NAMES.guidanceSuggest, JOB_NAMES.sendExecute].sort())
    expect(await readPolicy(org.orgId, org.agentId, auto.categoryId)).toMatchObject({ mode: 'auto' })
    expect(await readNotifications(org.orgId, 'demotion')).toHaveLength(0)
  })

  it('rejectDraft with addToGuidance appends "- <reason>" to operating_guidance (audited as a length) and returns guidanceAdded: true; over the 8,000 cap it appends nothing and returns false', async () => {
    const org = await seedOrg()
    const first = await seedReviewable(org)
    const reason = 'Never promise a refund date.'

    const res = await rejectDraft(deps, org.orgId, { draftId: first.draft.id, action: 'handle', reason, addToGuidance: true }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: true })
    expect((await readWorkspace(org.orgId))!.operatingGuidance).toBe(`- ${reason}`)

    const appended = await readAudit(org.orgId, 'workspace.guidance.append')
    expect(appended).toHaveLength(1)
    expect(appended[0]!.detail).toMatchObject({ length: `- ${reason}`.length })
    expect(JSON.stringify(appended[0]!.detail)).not.toContain('refund')

    // A second append goes on its own line, under the cap.
    const second = await seedReviewable(org)
    const res2 = await rejectDraft(deps, org.orgId, { draftId: second.draft.id, action: 'handle', reason: 'Always give the order number.', addToGuidance: true }, org.actor)
    expect(res2).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: true })
    expect((await readWorkspace(org.orgId))!.operatingGuidance).toBe(`- ${reason}\n- Always give the order number.`)

    // At the cap nothing is appended and the owner is told so.
    const full = 'x'.repeat(OPERATING_GUIDANCE_MAX)
    await t.api.withOrg(org.orgId, (tx) => tx.update(workspaces).set({ operatingGuidance: full }).where(eq(workspaces.orgId, org.orgId)))
    const third = await seedReviewable(org)
    const res3 = await rejectDraft(deps, org.orgId, { draftId: third.draft.id, action: 'handle', reason: 'One rule too many.', addToGuidance: true }, org.actor)
    expect(res3).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })
    expect((await readWorkspace(org.orgId))!.operatingGuidance).toBe(full)
    expect(await readAudit(org.orgId, 'workspace.guidance.append')).toHaveLength(2)
  })

  it('rejectDraft strikes every answer the draft used (used_answer_ids); the second strike retires it', async () => {
    const org = await seedOrg()
    const fresh = await seedAnswer(org.orgId, { status: 'active', strikes: 0 })
    const onStrikeOne = await seedAnswer(org.orgId, { status: 'active', strikes: 1 })
    const flagged = await seedAnswer(org.orgId, { status: 'needs_review', strikes: 1, reviewReason: 'model_conflict' })
    const untouched = await seedAnswer(org.orgId, { status: 'active', strikes: 0 })

    const { draft } = await seedReviewable(org)
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts)
      .set({ usedAnswerIds: [fresh.id, onStrikeOne.id, flagged.id] }).where(eq(drafts.id, draft.id)))

    await rejectDraft(deps, org.orgId, { draftId: draft.id, action: 'handle', reason: '', addToGuidance: false }, org.actor)

    expect(await readAnswer(org.orgId, fresh.id)).toMatchObject({ status: 'active', strikes: 1, retiredReason: null })
    expect(await readAnswer(org.orgId, onStrikeOne.id)).toMatchObject({ status: 'retired', strikes: 2, retiredReason: 'strikes' })
    expect(await readAnswer(org.orgId, flagged.id)).toMatchObject({ status: 'retired', strikes: 2, retiredReason: 'strikes' })
    expect(await readAnswer(org.orgId, untouched.id)).toMatchObject({ status: 'active', strikes: 0 })
  })

  it('two rejects in 7 days in an auto category demote it (rejections) — the second reject carries the notification', async () => {
    const org = await seedOrg()
    const { categoryId } = await seedAutoSending(org)

    async function rejectOne() {
      const ticket = await insertTicket(t.api, org.orgId, {
        connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review', categoryId,
      })
      const seeded = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })
      await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({ categoryId }).where(eq(drafts.id, seeded.id)))
      return rejectDraft(deps, org.orgId, { draftId: seeded.id, action: 'handle', reason: '', addToGuidance: false }, org.actor)
    }

    sent.length = 0
    expect(await rejectOne()).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })
    expect(await readPolicy(org.orgId, org.agentId, categoryId)).toMatchObject({ mode: 'auto' })
    expect(sent).toEqual([])

    expect(await rejectOne()).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })
    expect(await readPolicy(org.orgId, org.agentId, categoryId)).toMatchObject({ mode: 'review', demotedReason: 'rejections' })

    const [demotion] = await readNotifications(org.orgId, 'demotion')
    expect(demotion).toBeDefined()
    expect(sent).toEqual([{ name: JOB_NAMES.notifyDispatch, data: { orgId: org.orgId, notificationId: demotion!.id }, opts: { entityId: demotion!.id } }])
  })

  it("flagAutoSent on a sent auto draft stamps flagged_at/by, strikes the used answers, retires this draft's own candidate (sampled_bad), and the second flag in 30 days demotes (flags)", async () => {
    const org = await seedOrg()
    const used = await seedAnswer(org.orgId, { status: 'active', strikes: 1 })
    const first = await seedAutoSending(org, { status: 'sent', usedAnswerIds: [used.id] })
    const candidate = await seedAnswer(org.orgId, { status: 'candidate', sourceDraftId: first.draft.id })
    const otherCandidate = await seedAnswer(org.orgId, { status: 'candidate' })

    sent.length = 0
    expect(await flagAutoSent(deps, org.orgId, first.draft.id, org.actor)).toEqual({ ok: true })

    const flaggedDraft = await readDraft(org.orgId, first.draft.id)
    expect(flaggedDraft!.flaggedAt).toBeInstanceOf(Date)
    expect(flaggedDraft).toMatchObject({ flaggedBy: org.userId, status: 'sent' })
    expect(await readAnswer(org.orgId, used.id)).toMatchObject({ status: 'retired', strikes: 2, retiredReason: 'strikes' })
    expect(await readAnswer(org.orgId, candidate.id)).toMatchObject({ status: 'retired', retiredReason: 'sampled_bad' })
    expect(await readAnswer(org.orgId, otherCandidate.id)).toMatchObject({ status: 'candidate' })
    expect((await readAudit(org.orgId, 'draft.flagged'))[0]!.detail).toMatchObject({ draftId: first.draft.id, ticketId: first.ticket.id, source: 'app' })
    expect(await readPolicy(org.orgId, org.agentId, first.categoryId)).toMatchObject({ mode: 'auto' })
    expect(sent).toEqual([])

    // Two flags inside the 30-day window is a demotion, and it pages.
    const second = await seedAutoSending(org, { categoryId: first.categoryId, status: 'sent' })
    expect(await flagAutoSent(deps, org.orgId, second.draft.id, org.actor)).toEqual({ ok: true })
    expect(await readPolicy(org.orgId, org.agentId, first.categoryId)).toMatchObject({ mode: 'review', demotedReason: 'flags' })
    const [demotion] = await readNotifications(org.orgId, 'demotion')
    expect(sent).toEqual([{ name: JOB_NAMES.notifyDispatch, data: { orgId: org.orgId, notificationId: demotion!.id }, opts: { entityId: demotion!.id } }])
  })

  it('flagAutoSent refuses a human-approved draft and a draft already flagged (not_flaggable), and an unknown draft (not_found)', async () => {
    const org = await seedOrg()
    const human = await seedReviewable(org)
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts)
      .set({ status: 'sent', decisionSource: 'app', decidedAt: new Date() }).where(eq(drafts.id, human.draft.id)))
    expect(await flagAutoSent(deps, org.orgId, human.draft.id, org.actor)).toEqual({ ok: false, code: 'not_flaggable' })

    const auto = await seedAutoSending(org, { status: 'sent' })
    expect(await flagAutoSent(deps, org.orgId, auto.draft.id, org.actor)).toEqual({ ok: true })
    expect(await flagAutoSent(deps, org.orgId, auto.draft.id, org.actor)).toEqual({ ok: false, code: 'not_flaggable' })

    // Still counting down, not sent yet: nothing to flag.
    const queued = await seedAutoSending(org)
    expect(await flagAutoSent(deps, org.orgId, queued.draft.id, org.actor)).toEqual({ ok: false, code: 'not_flaggable' })

    expect(await flagAutoSent(deps, org.orgId, randomUUID(), org.actor)).toEqual({ ok: false, code: 'not_found' })
  })

  // Task 9 review, Important 1: the learning writes (`resolved_answers`, `workspaces`,
  // `agent_category_policies`) are the FOURTH position in the global lock order and must run AFTER
  // the ticket work — the worker's `applyDraftOutcome` locks the ticket and THEN flags a conflicting
  // answer `needs_review` in one transaction, so taking them first could deadlock a landing against a
  // reject that shares one answer id. This pins the REDRAFT branch, the one that returns early: every
  // write still lands, in one transaction, on the branch most at risk of skipping them.
  it('a reject that re-drafts does its ticket work first and still lands every learning write: the ticket flip, the strike, the guidance line and the demotion', async () => {
    const org = await seedOrg()
    const { categoryId } = await seedAutoSending(org)
    const used = await seedAnswer(org.orgId, { status: 'active', strikes: 1 })

    /** A reviewable ticket + draft in the auto category. */
    async function seedInCategory() {
      const ticket = await insertTicket(t.api, org.orgId, {
        connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review', categoryId,
      })
      const seeded = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date() })
      await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({ categoryId }).where(eq(drafts.id, seeded.id)))
      return { ticket, draft: seeded }
    }

    // One earlier rejection in the 7-day window, so THIS reject is the second and demotes.
    const first = await seedInCategory()
    await rejectDraft(deps, org.orgId, { draftId: first.draft.id, action: 'handle', reason: '', addToGuidance: false }, org.actor)
    expect(await readPolicy(org.orgId, org.agentId, categoryId)).toMatchObject({ mode: 'auto' })

    const second = await seedInCategory()
    await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({ usedAnswerIds: [used.id] }).where(eq(drafts.id, second.draft.id)))
    sent.length = 0

    const reason = 'Never quote a courier ETA.'
    const res = await rejectDraft(deps, org.orgId, { draftId: second.draft.id, action: 'redraft', reason, addToGuidance: true }, org.actor)
    expect(res).toEqual({ ok: true, resolution: 'redraft', guidanceAdded: true })

    // The ticket work happened...
    expect(await readTicket(org.orgId, second.ticket.id)).toMatchObject({ status: 'triaged', ownerRedraftFeedback: reason, redraftCount: 1 })
    const redraftAudit = await readAudit(org.orgId, 'draft.rejected_for_redraft')
    expect(redraftAudit).toHaveLength(1)
    expect(redraftAudit[0]!.detail).toMatchObject({ draftId: second.draft.id, ticketId: second.ticket.id })

    // ...and every learning write still landed, on the branch that returns early.
    expect(await readAnswer(org.orgId, used.id)).toMatchObject({ status: 'retired', strikes: 2, retiredReason: 'strikes' })
    expect((await readWorkspace(org.orgId))!.operatingGuidance).toBe(`- ${reason}`)
    const appended = await readAudit(org.orgId, 'workspace.guidance.append')
    expect(appended).toHaveLength(1)
    expect(appended[0]!.detail).toMatchObject({ length: `- ${reason}`.length, draftId: second.draft.id })
    expect(await readPolicy(org.orgId, org.agentId, categoryId)).toMatchObject({ mode: 'review', demotedReason: 'rejections' })

    const [demotion] = await readNotifications(org.orgId, 'demotion')
    expect(sent).toEqual([
      { name: JOB_NAMES.ticketDraft, data: { orgId: org.orgId, ticketId: second.ticket.id }, opts: { entityId: second.ticket.id } },
      { name: JOB_NAMES.notifyDispatch, data: { orgId: org.orgId, notificationId: demotion!.id }, opts: { entityId: demotion!.id } },
    ])
  })

  it('a deadlocked reject retries with a FRESH clock, exactly as approve/hold/resolve do', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)
    const t0 = new Date('2026-09-10T10:00:00.000Z')
    const t1 = new Date('2026-09-10T10:00:05.000Z')
    const stamps = [t0, t1]
    let attempts = 0
    const deadlock = (): Error => Object.assign(new Error('Failed query: update "drafts" …'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    })
    const api: ApiFacade = {
      ...t.api,
      withOrg: (id, fn) => { if (++attempts === 1) throw deadlock(); return t.api.withOrg(id, fn) },
    }

    const res = await rejectDraft(
      { ...deps, api, now: () => stamps.shift() ?? t1 }, org.orgId,
      { draftId: draft.id, action: 'handle', reason: '', addToGuidance: false }, org.actor,
    )
    expect(res).toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })
    expect(attempts).toBe(2)
    expect((await readDraft(org.orgId, draft.id))!.decidedAt!.toISOString()).toBe(t1.toISOString())
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'owner_handling' })
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

  it('resolveTicket cannot leave an approved draft with a queued send behind, even when an approve is mid-flight', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)

    // The interleave, deterministically: the approve runs to the end of its transaction and is held
    // there — draft `approved`, send `queued`, nothing committed, every lock still held — while the
    // resolve runs on its own pooled connection. Before the lock-order fix the resolve read the draft
    // WITHOUT a lock, so it saw `pending`, marked the ticket resolved, and its supersede (guarded on
    // that stale status) then matched 0 rows: ticket `resolved`, draft `approved`, send `queued` and
    // a send.execute job already scheduled — the reply went out after the owner said they had it.
    let reached = (): void => {}
    let release = (): void => {}
    const gate = {
      reached: () => reached(),
      release: new Promise<void>((r) => { release = () => r() }),
      arrived: new Promise<void>((r) => { reached = () => r() }),
    }
    const approving = approveDraft({ ...deps, api: pausingApi(t.api, gate) }, org.orgId, { draftId: draft.id }, org.actor)
    await gate.arrived

    const resolving = resolveTicket(deps, org.orgId, ticket.id, org.actor)
    await delay(150)          // let the resolve reach the statement that must block on the approve
    release()

    const [approve, resolved] = await Promise.all([approving, resolving])
    expect(resolved).toBe(true)

    const draftAfter = await readDraft(org.orgId, draft.id)
    const sendAfter = await readSend(org.orgId, draft.id)
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'resolved' })
    // The invariant, whichever side won the race: never an approved draft with a live send on a
    // resolved ticket.
    expect(draftAfter!.status === 'approved' && sendAfter?.status === 'queued').toBe(false)
    expect(draftAfter).toMatchObject({ status: 'superseded' })
    if (approve.ok) expect(sendAfter).toMatchObject({ status: 'held' })
    else expect(approve).toEqual({ ok: false, code: 'not_pending' })
  })

  // A2 (final-C I1): a `held` draft is LIVE as far as `drafts_live_per_ticket_uidx` is concerned
  // (migration 0011 covers pending|approved|held|sending). Leaving it behind meant the next draft
  // cycle on that ticket — a customer reply reopens it, triage runs, `ticket.draft` INSERTs — died on
  // a 23505 the job does not treat as a lost race, and kept dying until sweeps.daily expired it.
  it('resolveTicket retires a job-held draft (held → expired), leaving NO live draft and a clear ticket for the next draft cycle', async () => {
    const org = await seedOrg()
    const ticket = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, status: 'awaiting_review' })
    const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId, viewedAt: new Date(), status: 'held' })
    await t.api.withOrg(org.orgId, (tx) => tx.insert(outboundSends).values({
      orgId: org.orgId, draftId: draft.id, ticketId: ticket.id, connectionId: org.connectionId, agentId: org.agentId,
      status: 'held', sendAfter: new Date(), attempts: 1, lastError: 'held:workspace_kill_switch',
    }))

    expect(await resolveTicket(deps, org.orgId, ticket.id, org.actor)).toBe(true)
    expect(await readTicket(org.orgId, ticket.id)).toMatchObject({ status: 'resolved' })
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'expired' })
    expect(await readAudit(org.orgId, 'draft.expired')).toHaveLength(1)

    // The partial unique's OWN status set: nothing left in it for this ticket...
    const stillLive = await t.api.withOrg(org.orgId, (tx) => tx.select({ id: drafts.id }).from(drafts)
      .where(and(eq(drafts.ticketId, ticket.id), inArray(drafts.status, [...LIVE_DRAFT_STATUSES]))!))
    expect(stillLive).toEqual([])
    // ...so the insert `ticket.draft` does after a reopen succeeds instead of raising 23505.
    const next = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId })
    expect(next.status).toBe('pending')
  })

  it('resolveTicket holds a CLAIMED send as well as a queued one — the in-flight job\'s pre-send flip then matches nothing', async () => {
    const org = await seedOrg()
    const { ticket, draft } = await seedReviewable(org)
    const approved = await approveDraft(deps, org.orgId, { draftId: draft.id }, org.actor)
    if (!approved.ok) throw new Error('approve failed')

    // `send.execute` claimed the row (the 15 s window elapsed) but has not reached its pre-send flip.
    await t.api.withOrg(org.orgId, (tx) => tx.update(outboundSends)
      .set({ status: 'claimed', claimedAt: new Date(), claimToken: randomUUID(), claimExpiresAt: new Date(Date.now() + 120_000) })
      .where(eq(outboundSends.id, approved.sendId)))

    expect(await resolveTicket(deps, org.orgId, ticket.id, org.actor)).toBe(true)
    expect(await readDraft(org.orgId, draft.id)).toMatchObject({ status: 'superseded' })
    expect(await readSend(org.orgId, draft.id)).toMatchObject({ id: approved.sendId, status: 'held', lastError: 'held:ticket_resolved' })
    expect(await readAudit(org.orgId, 'draft.superseded')).toHaveLength(1)
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

  it('withDeadlockRetry retries a deadlock victim exactly once, and nothing else', async () => {
    const deadlock = (): Error => Object.assign(new Error('deadlock detected'), { code: '40P01' })
    // How drizzle actually surfaces it: the SQLSTATE sits on the wrapped pg error, not the wrapper.
    const wrappedDeadlock = (): Error => Object.assign(new Error('Failed query: update "drafts" …'), { cause: deadlock() })

    let calls = 0
    const retried = await withDeadlockRetry(async () => {
      calls += 1
      if (calls === 1) throw deadlock()
      return 'committed'
    })
    expect(retried).toBe('committed')
    expect(calls).toBe(1 + 1)

    calls = 0
    expect(await withDeadlockRetry(async () => {
      calls += 1
      if (calls === 1) throw wrappedDeadlock()
      return 'committed'
    })).toBe('committed')
    expect(calls).toBe(2)

    // A different SQLSTATE is someone else's problem: rethrown untouched, no second attempt.
    calls = 0
    await expect(withDeadlockRetry(async () => {
      calls += 1
      throw Object.assign(new Error('duplicate key'), { code: '23505' })
    })).rejects.toMatchObject({ code: '23505' })
    expect(calls).toBe(1)

    // Two deadlocks in a row: the caller sees the error rather than a third attempt.
    calls = 0
    await expect(withDeadlockRetry(async () => {
      calls += 1
      throw deadlock()
    })).rejects.toMatchObject({ code: '40P01' })
    expect(calls).toBe(2)

    // The service's own throw (an already-consumed action token) is never retried.
    calls = 0
    await expect(withDeadlockRetry(async () => {
      calls += 1
      throw new Error('draft action token was already consumed')
    })).rejects.toThrow('already consumed')
    expect(calls).toBe(1)
  })

  it('levenshteinRatio: 0 for identical (and empty) strings, 1 for a full rewrite, in between for an edit', () => {
    expect(levenshteinRatio('same text', 'same text')).toBe(0)
    expect(levenshteinRatio('', '')).toBe(0)
    expect(levenshteinRatio('abcd', 'wxyz')).toBe(1)
    expect(levenshteinRatio('kitten', 'sitting')).toBeCloseTo(3 / 7, 10)
    expect(levenshteinRatio('abc', '')).toBe(1)
  })
})
