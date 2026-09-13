/**
 * The `activity` router (`activity.summary`, Task 18): every count is scoped to the calling org over
 * `withOrg`, computed against a `days`-wide cutoff — except `recent`, which is simply the last 20
 * actually-sent replies regardless of that window (a "recent activity" feed, not a report row).
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog, drafts, LLM_METERS, outboundSends, SEND_METERS, usageCounters } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertAgent, insertConnectedMailbox, insertTicket, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

const DAY_MS = 86_400_000
const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

describe('activity router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  async function seedOrg(email: string) {
    const signed = await signInWithOtp(t.app, t.mail, email, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const address = `support-${email}`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const agentId = await insertAgent(t.api, orgId, connectionId, address)
    return { orgId, c, connectionId, agentId, address }
  }

  async function insertDraft(orgId: string, ticketId: string, agentId: string, overrides: Partial<typeof drafts.$inferInsert>) {
    const now = new Date()
    const [row] = await t.api.withOrg(orgId, (tx) => tx.insert(drafts).values({
      orgId, ticketId, agentId, version: 1, body: 'a reply body', decision: 'review', decisionReason: 'ok',
      status: 'pending', threadSnapshotAt: now, expiresAt: new Date(now.getTime() + 7 * DAY_MS),
      ...overrides,
    }).returning())
    return row!
  }

  async function insertSend(
    orgId: string, draftId: string, ticketId: string, connectionId: string, agentId: string, sentAt: Date,
  ) {
    const [row] = await t.api.withOrg(orgId, (tx) => tx.insert(outboundSends).values({
      orgId, draftId, ticketId, connectionId, agentId, status: 'sent', sendAfter: sentAt, sentAt,
    }).returning())
    return row!
  }

  async function insertEscalated(orgId: string, ticketId: string, createdAt: Date) {
    await t.api.withOrg(orgId, (tx) => tx.insert(auditLog).values({
      orgId, actor: 'system:test', action: 'ticket.escalated', entityType: 'ticket', entityId: ticketId, createdAt,
    }))
  }

  async function insertUsage(orgId: string, day: string, meter: string, value: number) {
    await t.api.withOrg(orgId, (tx) => tx.insert(usageCounters).values({ orgId, day, meter, value }))
  }

  it('summary counts every definition over the days window, lists the last sent newest-first regardless of it, and never counts another org’s rows', async () => {
    const org = await seedOrg('activity-a@example.com')
    const other = await seedOrg('activity-b@example.com')

    const now = new Date()
    const inWindow = new Date(now.getTime() - 2 * DAY_MS)
    const outOfWindow = new Date(now.getTime() - 10 * DAY_MS)
    const today = utcDay(now)
    const oldDay = utcDay(outOfWindow)

    async function seedFullSet(o: Awaited<ReturnType<typeof seedOrg>>) {
      const tDrafted = await insertTicket(t.api, o.orgId, { connectionId: o.connectionId, agentId: o.agentId, subject: 'Drafted' })
      await insertDraft(o.orgId, tDrafted.id, o.agentId, { createdAt: inWindow })

      const tDraftedOut = await insertTicket(t.api, o.orgId, { connectionId: o.connectionId, agentId: o.agentId, subject: 'Drafted long ago' })
      await insertDraft(o.orgId, tDraftedOut.id, o.agentId, { createdAt: outOfWindow })

      const tUnchanged = await insertTicket(t.api, o.orgId, {
        connectionId: o.connectionId, agentId: o.agentId, subject: 'Approved unchanged', customerEmail: 'unchanged@customer.test',
      })
      // Every draft below is created "long ago" (createdAt: outOfWindow) — irrelevant to its own
      // purpose (approved/rejected counts key off decidedAt, not createdAt) but essential so it
      // never pollutes the `drafted` count above, which is the only thing tDrafted/tDraftedOut test.
      const dUnchanged = await insertDraft(o.orgId, tUnchanged.id, o.agentId, {
        status: 'approved', decidedAt: inWindow, decisionSource: 'app', editDistanceRatio: 0, createdAt: outOfWindow,
      })
      const sentUnchanged = await insertSend(o.orgId, dUnchanged.id, tUnchanged.id, o.connectionId, o.agentId, inWindow)

      const tEdited = await insertTicket(t.api, o.orgId, {
        connectionId: o.connectionId, agentId: o.agentId, subject: 'Approved edited', customerEmail: 'edited@customer.test',
      })
      const dEdited = await insertDraft(o.orgId, tEdited.id, o.agentId, {
        status: 'sending', decidedAt: inWindow, decisionSource: 'app', editDistanceRatio: 0.4, createdAt: outOfWindow,
      })
      // This one's send is OUTSIDE the days window — it must still show in `recent` (no window there)
      // but must not count toward `sent`.
      const sentEditedOld = await insertSend(o.orgId, dEdited.id, tEdited.id, o.connectionId, o.agentId, outOfWindow)

      const tHeld = await insertTicket(t.api, o.orgId, { connectionId: o.connectionId, agentId: o.agentId, subject: 'Held edited' })
      await insertDraft(o.orgId, tHeld.id, o.agentId, {
        status: 'held', decidedAt: inWindow, decisionSource: 'email', editDistanceRatio: 0.1, createdAt: outOfWindow,
      })

      const tApprovedOut = await insertTicket(t.api, o.orgId, { connectionId: o.connectionId, agentId: o.agentId, subject: 'Approved long ago' })
      await insertDraft(o.orgId, tApprovedOut.id, o.agentId, {
        status: 'approved', decidedAt: outOfWindow, decisionSource: 'app', editDistanceRatio: 0, createdAt: outOfWindow,
      })

      const tRejected = await insertTicket(t.api, o.orgId, { connectionId: o.connectionId, agentId: o.agentId, subject: 'Rejected' })
      await insertDraft(o.orgId, tRejected.id, o.agentId, {
        status: 'rejected', decidedAt: inWindow, decisionSource: 'app', createdAt: outOfWindow,
      })

      const tRejectedOut = await insertTicket(t.api, o.orgId, { connectionId: o.connectionId, agentId: o.agentId, subject: 'Rejected long ago' })
      await insertDraft(o.orgId, tRejectedOut.id, o.agentId, {
        status: 'rejected', decidedAt: outOfWindow, decisionSource: 'app', createdAt: outOfWindow,
      })

      await insertEscalated(o.orgId, tDrafted.id, inWindow)
      await insertEscalated(o.orgId, tDraftedOut.id, outOfWindow)

      await insertUsage(o.orgId, today, LLM_METERS.costMicros, 1000)
      await insertUsage(o.orgId, today, SEND_METERS.aiHandledConversations, 3)
      await insertUsage(o.orgId, oldDay, LLM_METERS.costMicros, 5000)
      await insertUsage(o.orgId, oldDay, SEND_METERS.aiHandledConversations, 7)
      // Phase 6: the tenant's own spend rides its own meter, windowed the same way and returned
      // beside `costMicros` (which stays the MANAGED number) so the screen can show the total.
      await insertUsage(o.orgId, today, LLM_METERS.costMicrosByok, 250)
      await insertUsage(o.orgId, oldDay, LLM_METERS.costMicrosByok, 4000)

      return { sentUnchanged, sentEditedOld, tUnchanged, tEdited, dUnchanged, dEdited }
    }

    const seeded = await seedFullSet(org)
    await seedFullSet(other) // isolation control — must never move org's own counts below

    const week = await org.c.activity.summary.query({ days: 7 })
    expect(week).toMatchObject({
      days: 7, drafted: 1, approvedUnchanged: 1, approvedEdited: 2, rejected: 1, sent: 1, escalated: 1, autoSent: 0,
      costMicros: 1000, byokCostMicros: 250, aiHandledConversations: 3,
    })
    expect(week.recent).toHaveLength(2)
    expect(week.recent[0]).toMatchObject({
      ticketId: seeded.tUnchanged.id, draftId: seeded.dUnchanged.id, subject: 'Approved unchanged',
      customerEmail: 'unchanged@customer.test', agentAddress: org.address, decisionSource: 'app', editDistanceRatio: 0,
    })
    expect(week.recent[1]).toMatchObject({
      ticketId: seeded.tEdited.id, draftId: seeded.dEdited.id, subject: 'Approved edited',
      customerEmail: 'edited@customer.test', agentAddress: org.address, decisionSource: 'app', editDistanceRatio: 0.4,
    })
    expect(week.recent[0]!.sentAt).toBeInstanceOf(Date)
    expect(week.recent[0]!.sentAt!.getTime()).toBeGreaterThan(week.recent[1]!.sentAt!.getTime())

    // The wider window picks up everything the 7-day one excluded; `recent` is unchanged (it was never windowed).
    // `drafted` jumps to 8 (not 2): every OTHER draft above was deliberately created "long ago" too
    // (outOfWindow), so the 30-day window now counts all of them by createdAt, same as tDraftedOut.
    const month = await org.c.activity.summary.query({ days: 30 })
    expect(month).toMatchObject({
      days: 30, drafted: 8, approvedUnchanged: 2, approvedEdited: 2, rejected: 2, sent: 2, escalated: 2, autoSent: 0,
      costMicros: 6000, byokCostMicros: 4250, aiHandledConversations: 10,
    })
    expect(month.recent).toHaveLength(2)

    // The other org's identical seed never moves this org's numbers, and vice versa is exercised by
    // the fact `other`'s own set was seeded with the exact same shape as `org`'s.
    const otherWeek = await other.c.activity.summary.query({ days: 7 })
    expect(otherWeek).toMatchObject({ drafted: 1, sent: 1, escalated: 1, costMicros: 1000, byokCostMicros: 250, aiHandledConversations: 3 })
  })

  // Phase 5: `autoSent` was a hard-coded literal 0 until `auto` mode became reachable. The two
  // `autoSent: 0` expectations above are now real counts of a workspace that has never auto-sent.
  it('autoSent counts the replies the agent sent on its own inside the window, and nothing a human decided', async () => {
    const org = await seedOrg('activity-auto@example.com')
    const other = await seedOrg('activity-auto-other@example.com')

    const now = new Date()
    const inWindow = new Date(now.getTime() - 2 * DAY_MS)
    const outOfWindow = new Date(now.getTime() - 10 * DAY_MS)

    const autoSent = async (o: Awaited<ReturnType<typeof seedOrg>>, at: Date, overrides: Partial<typeof drafts.$inferInsert> = {}) => {
      const ticket = await insertTicket(t.api, o.orgId, { connectionId: o.connectionId, agentId: o.agentId, subject: 'Auto' })
      const draft = await insertDraft(o.orgId, ticket.id, o.agentId, {
        status: 'sent', decision: 'send', decisionSource: 'auto', decidedAt: at, autoDecidedAt: at, createdAt: at,
        finalBody: 'Sent by the agent.', ...overrides,
      })
      await insertSend(o.orgId, draft.id, ticket.id, o.connectionId, o.agentId, at)
      return draft
    }

    await autoSent(org, inWindow)
    await autoSent(org, outOfWindow)
    // Decided by the agent but never delivered (held, then held forever): not an auto-SEND.
    await autoSent(org, inWindow, { status: 'held' })
    // A human's own approval, however recent, is never an auto-send.
    const tHuman = await insertTicket(t.api, org.orgId, { connectionId: org.connectionId, agentId: org.agentId, subject: 'Human' })
    await insertDraft(org.orgId, tHuman.id, org.agentId, { status: 'sent', decisionSource: 'app', decidedAt: inWindow, createdAt: inWindow })
    // Another workspace's auto-sends are not this one's.
    await autoSent(other, inWindow)

    expect((await org.c.activity.summary.query({ days: 7 })).autoSent).toBe(1)
    expect((await org.c.activity.summary.query({ days: 30 })).autoSent).toBe(2)
    expect((await other.c.activity.summary.query({ days: 7 })).autoSent).toBe(1)

    const recent = await org.c.activity.summary.query({ days: 7 })
    expect(recent.recent.some((r) => r.decisionSource === 'auto')).toBe(true)
  })

  it('a fresh org with nothing seeded gets all-zero counts and an empty recent list', async () => {
    const org = await seedOrg('activity-empty@example.com')
    const res = await org.c.activity.summary.query({ days: 7 })
    expect(res).toEqual({
      days: 7, drafted: 0, approvedUnchanged: 0, approvedEdited: 0, rejected: 0, sent: 0, escalated: 0, autoSent: 0,
      costMicros: 0, byokCostMicros: 0, aiHandledConversations: 0, recent: [],
    })
  })

  it('days defaults to 7 when omitted from the input object', async () => {
    const org = await seedOrg('activity-default@example.com')
    const res = await org.c.activity.summary.query({})
    expect(res.days).toBe(7)
  })
})
