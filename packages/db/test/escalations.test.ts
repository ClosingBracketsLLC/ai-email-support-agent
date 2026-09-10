/**
 * `escalateTicket` and its copy/dedupe helpers — the ONE way any process (worker jobs, the api's
 * draft service) moves a ticket INTO `needs_owner`. Against real Postgres: the guard, the redraft
 * clear, the notification dedupe and the audit row are all one transaction, so they are tested as one.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NEEDS_OWNER_REASONS } from '@aesa/contracts'
import {
  auditLog, escalateTicket, escalationCopy, escalationDedupeKey, mailboxConnections, notifications,
  tickets, user, withOrg, workspaces,
} from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-06-15T12:00:00Z')
const DAY = '2026-06-15'

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let orgId: string
let connectionId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
  orgId = await createTestOrganization(app)
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  await withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' })
    const [row] = await tx
      .insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: u!.id })
      .returning({ id: mailboxConnections.id })
    connectionId = row!.id
  })
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})

async function seedTicket(overrides: Partial<typeof tickets.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'triaged', ...overrides }).returning({ id: tickets.id }))
  return row!.id
}

async function getTicket(ticketId: string) {
  const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
  return row!
}

async function notificationsFor(dedupeKey: string) {
  return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey)))
}

async function auditRowsFor(ticketId: string, action: string) {
  return withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, ticketId), eq(auditLog.action, action))))
}

describe('escalationCopy / escalationDedupeKey', () => {
  it('carries owner-facing copy for every needs_owner reason', () => {
    for (const reason of NEEDS_OWNER_REASONS) {
      const { title, body } = escalationCopy(reason)
      expect(title.length, reason).toBeGreaterThan(0)
      expect(body.length, reason).toBeGreaterThan(0)
    }
  })

  it('keeps the Phase 2 titles the triage job already ships', () => {
    expect(escalationCopy('triage_flags').title).toBe('Ticket flagged for review')
    expect(escalationCopy('sentiment_angry').title).toBe('Angry customer')
    expect(escalationCopy('triage_failed').title).toBe('Triage failed twice')
    expect(escalationCopy('triage_cap').title).toBe('Daily triage limit reached')
  })

  it('scopes the dedupe key by UTC day, not by ticket lifetime', () => {
    expect(escalationDedupeKey('t1', DAY)).toBe(`escalation:t1:${DAY}`)
    expect(escalationDedupeKey('t1', '2026-06-16')).not.toBe(escalationDedupeKey('t1', DAY))
  })
})

describe('escalateTicket', () => {
  it('flips a triaged ticket, clears the notified stamp and the redraft cycle, notifies and audits', async () => {
    const ticketId = await seedTicket({ escalationNotifiedAt: NOW, ownerRedraftFeedback: 'try again', redraftCount: 2 })

    const result = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, {
        orgId, ticketId, fromStatus: 'triaged', reason: 'agent_escalated', day: DAY, now: NOW,
        actor: 'system:ticket.draft', auditAction: 'ticket.escalated', detail: { rationale: 'needs a human' },
      }))

    expect(result.escalated).toBe(true)
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_escalated')
    expect(ticket.escalationNotifiedAt).toBeNull()
    expect(ticket.ownerRedraftFeedback).toBeNull()
    expect(ticket.redraftCount).toBe(0)

    const rows = await notificationsFor(escalationDedupeKey(ticketId, DAY))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('escalation')
    expect(rows[0]!.title).toBe(escalationCopy('agent_escalated').title)
    expect(rows[0]!.payload).toEqual({ ticketId })
    expect(result.notificationId).toBe(rows[0]!.id)

    const audits = await auditRowsFor(ticketId, 'ticket.escalated')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toEqual({ reason: 'agent_escalated', rationale: 'needs a human' })
    expect(audits[0]!.actor).toBe('system:ticket.draft')
  })

  it('carries a draftId into the notification payload', async () => {
    const ticketId = await seedTicket({ status: 'awaiting_review' })
    const draftId = randomUUID()

    const result = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, {
        orgId, ticketId, fromStatus: 'awaiting_review', reason: 'guardrail_failed', day: DAY, now: NOW,
        draftId, actor: 'system:ticket.draft', auditAction: 'ticket.escalated',
      }))

    expect(result.escalated).toBe(true)
    const rows = await notificationsFor(escalationDedupeKey(ticketId, DAY))
    expect(rows[0]!.payload).toEqual({ ticketId, draftId })
  })

  it('quiet: pre-stamps escalation_notified_at and inserts NO notification (the owner caused it)', async () => {
    const ticketId = await seedTicket({ status: 'awaiting_review' })

    const result = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, {
        orgId, ticketId, fromStatus: 'awaiting_review', reason: 'owner_handling', day: DAY, now: NOW,
        quiet: true, actor: `user:${randomUUID()}`, auditAction: 'ticket.escalated',
      }))

    expect(result).toEqual({ escalated: true })
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('owner_handling')
    expect(ticket.escalationNotifiedAt).toEqual(NOW)
    expect(await notificationsFor(escalationDedupeKey(ticketId, DAY))).toHaveLength(0)
    expect(await auditRowsFor(ticketId, 'ticket.escalated')).toHaveLength(1)
  })

  it('inserts at most one notification per ticket per UTC day', async () => {
    const ticketId = await seedTicket()

    const first = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, { orgId, ticketId, fromStatus: 'triaged', reason: 'agent_failed', day: DAY, now: NOW, actor: 'system:ticket.draft', auditAction: 'ticket.escalated' }))
    // The owner sends it back round the loop the same day; it escalates again for a different reason.
    await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'triaged' }).where(eq(tickets.id, ticketId)))
    const second = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, { orgId, ticketId, fromStatus: 'triaged', reason: 'agent_run_cap', day: DAY, now: NOW, actor: 'system:ticket.draft', auditAction: 'ticket.escalated' }))

    expect(first.notificationId).toBeDefined()
    expect(second).toEqual({ escalated: true })   // flipped, but no second page
    expect(await notificationsFor(escalationDedupeKey(ticketId, DAY))).toHaveLength(1)
    expect((await getTicket(ticketId)).needsOwnerReason).toBe('agent_run_cap')
  })

  it('an explicit dedupeKey overrides the per-day default, so two different keys both page', async () => {
    const ticketId = await seedTicket()
    const capKey = `agent_run_cap:${ticketId}:${DAY}`
    const orphanKey = `orphaned:${ticketId}:${DAY}`

    const first = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, { orgId, ticketId, fromStatus: 'triaged', reason: 'agent_run_cap', day: DAY, dedupeKey: capKey, now: NOW, actor: 'system:ticket.draft', auditAction: 'ticket.escalated' }))
    await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'awaiting_review' }).where(eq(tickets.id, ticketId)))
    const second = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, { orgId, ticketId, fromStatus: 'awaiting_review', reason: 'orphaned', day: DAY, dedupeKey: orphanKey, now: NOW, actor: 'system:cron:ticket.backstop-sweep', auditAction: 'ticket.escalated' }))

    const capRows = await notificationsFor(capKey)
    const orphanRows = await notificationsFor(orphanKey)
    expect(capRows).toHaveLength(1)
    expect(orphanRows).toHaveLength(1)
    expect(first.notificationId).toBe(capRows[0]!.id)
    expect(second.notificationId).toBe(orphanRows[0]!.id)
    // The default key was never used — these two pages are keyed by their own reasons.
    expect(await notificationsFor(escalationDedupeKey(ticketId, DAY))).toHaveLength(0)
  })

  it('lost race: the ticket already left fromStatus — nothing is written', async () => {
    const ticketId = await seedTicket({ status: 'resolved' })

    const result = await withOrg(app.db, orgId, (tx) =>
      escalateTicket(tx, { orgId, ticketId, fromStatus: 'triaged', reason: 'agent_failed', day: DAY, now: NOW, actor: 'system:ticket.draft', auditAction: 'ticket.escalated' }))

    expect(result).toEqual({ escalated: false })
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('resolved')
    expect(ticket.needsOwnerReason).toBeNull()
    expect(await notificationsFor(escalationDedupeKey(ticketId, DAY))).toHaveLength(0)
    expect(await auditRowsFor(ticketId, 'ticket.escalated')).toHaveLength(0)
  })
})
