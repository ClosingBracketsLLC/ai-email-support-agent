/**
 * The drafting claim protocol against real Postgres: the CAS claim and its three-watermark
 * predicate, the stuck-recovery failure charge and its ceiling escalation, the unwind, the failure
 * row and the finish watermarks. Ported from doge-buddy's `apps/ops/test/support-agent-run.test.ts`
 * (the stuck-gate matrix A-F, the row-lock CAS test and the ceiling-atomicity poll), adapted to
 * this codebase's `withOrg` transactions and `needs_owner` naming.
 *
 * Two tests use a SECOND connection to produce genuine concurrency: `createDb(t.url)` again, so the
 * holder's `SELECT … FOR UPDATE` really blocks the claim on a different backend.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INVARIANTS } from '@aesa/core'
import { auditLog, escalationDedupeKey, mailboxConnections, notifications, tickets, user, withOrg, workspaces } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { claimTicket, recordFailure, stampFinished, unwindClaimStamp, type ClaimResult } from '../src/drafting/claim.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-06-15T12:00:00Z')
const DAY = '2026-06-15'
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

const claim = (ticketId: string, now = NOW): Promise<ClaimResult> =>
  withOrg(app.db, orgId, (tx) => claimTicket(tx, { orgId, ticketId, now }))

async function notificationsFor(dedupeKey: string) {
  return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey)))
}

async function auditRowsFor(ticketId: string, action: string) {
  return withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, ticketId), eq(auditLog.action, action))))
}

describe('claimTicket', () => {
  // The three watermarks: `last_agent_run_at` and `last_agent_finished_at` are wall-clock and
  // comparable; `last_agent_prompted_at` is MESSAGE-time and is not. Comparing the prompt watermark
  // against the claim stamp made every completed run look stuck 20 minutes later — a re-run of
  // settled tickets on a timer, at real cost. These rows pin the corrected gate (doge-buddy's A-F).
  interface GateCase {
    name: string
    seed: { agentFailureCount: number; lastAgentRunAt: Date | null; lastAgentFinishedAt: Date | null; lastAgentPromptedAt: Date | null; lastInboundAt: Date | null }
    /** false → the claim is refused with `watermark`, and the row is left exactly as seeded. */
    claims: boolean
    stuckClaim: boolean
    /** The count AFTER the claim: only a stuck-authorized claim charges one. */
    agentFailureCount: number
  }

  const MATRIX: GateCase[] = [
    {
      name: 'never run: a fresh triaged ticket claims with no failure charged',
      seed: { agentFailureCount: 0, lastAgentRunAt: null, lastAgentFinishedAt: null, lastAgentPromptedAt: null, lastInboundAt: minutesAgo(5) },
      claims: true, stuckClaim: false, agentFailureCount: 0,
    },
    {
      name: 'A: a run that finished 60 minutes ago claims on new inbound, with no failure charged',
      seed: { agentFailureCount: 0, lastAgentRunAt: minutesAgo(60), lastAgentFinishedAt: minutesAgo(59), lastAgentPromptedAt: minutesAgo(61), lastInboundAt: minutesAgo(2) },
      claims: true, stuckClaim: false, agentFailureCount: 0,
    },
    {
      name: 'B: the same ticket already carrying one failure still is not charged a second',
      seed: { agentFailureCount: 1, lastAgentRunAt: minutesAgo(60), lastAgentFinishedAt: minutesAgo(59), lastAgentPromptedAt: null, lastInboundAt: minutesAgo(2) },
      claims: true, stuckClaim: false, agentFailureCount: 1,
    },
    {
      name: 'C: a completed run with no new inbound is not claimable 25 minutes later',
      seed: { agentFailureCount: 0, lastAgentRunAt: minutesAgo(25), lastAgentFinishedAt: minutesAgo(24), lastAgentPromptedAt: minutesAgo(50), lastInboundAt: minutesAgo(50) },
      claims: false, stuckClaim: false, agentFailureCount: 0,
    },
    {
      name: 'D: a true hard-kill (claimed, never finished) re-claims and charges a failure',
      seed: { agentFailureCount: 0, lastAgentRunAt: minutesAgo(25), lastAgentFinishedAt: null, lastAgentPromptedAt: minutesAgo(40), lastInboundAt: minutesAgo(45) },
      claims: true, stuckClaim: true, agentFailureCount: 1,
    },
    {
      name: 'D2: a stale finish stamp from a PRIOR run also reads as a hard-kill',
      seed: { agentFailureCount: 0, lastAgentRunAt: minutesAgo(25), lastAgentFinishedAt: minutesAgo(40), lastAgentPromptedAt: null, lastInboundAt: minutesAgo(45) },
      claims: true, stuckClaim: true, agentFailureCount: 1,
    },
    {
      name: 'E: a stuck-aged claim that DID finish claims on new inbound without a failure',
      seed: { agentFailureCount: 0, lastAgentRunAt: minutesAgo(25), lastAgentFinishedAt: minutesAgo(24), lastAgentPromptedAt: null, lastInboundAt: minutesAgo(2) },
      claims: true, stuckClaim: false, agentFailureCount: 0,
    },
    {
      name: 'F: new inbound on a never-finished claim is a new-work claim, not a failure',
      seed: { agentFailureCount: 0, lastAgentRunAt: minutesAgo(25), lastAgentFinishedAt: null, lastAgentPromptedAt: null, lastInboundAt: minutesAgo(5) },
      claims: true, stuckClaim: false, agentFailureCount: 0,
    },
  ]

  it.each(MATRIX)('stuck gate — $name', async ({ seed, claims, stuckClaim, agentFailureCount }) => {
    const ticketId = await seedTicket(seed)

    const result = await claim(ticketId)
    const ticket = await getTicket(ticketId)

    if (claims) {
      expect(result.claimed).toBe(true)
      if (result.claimed) {
        expect(result.stuckClaim).toBe(stuckClaim)
        expect(result.threadSnapshotAt).toEqual(seed.lastInboundAt)   // the LOCKED row's inbound, never now()
        expect(result.priorLastAgentRunAt).toEqual(seed.lastAgentRunAt)
        expect(result.stampedLastAgentRunAt).toEqual(NOW)
        expect(result.ticket.lastAgentPromptedAt).toEqual(seed.lastAgentPromptedAt)
      }
      expect(ticket.lastAgentRunAt).toEqual(NOW)
      expect(ticket.status).toBe('triaged')
    } else {
      expect(result).toEqual({ claimed: false, reason: 'watermark' })
      expect(ticket.lastAgentRunAt).toEqual(seed.lastAgentRunAt)
    }
    expect(ticket.agentFailureCount).toBe(agentFailureCount)
  })

  it('refuses a ticket that does not exist', async () => {
    expect(await claim(randomUUID())).toEqual({ claimed: false, reason: 'ticket_missing' })
  })

  it('refuses a ticket that is not triaged, reporting the status it found', async () => {
    const ticketId = await seedTicket({ status: 'awaiting_review' })
    expect(await claim(ticketId)).toEqual({ claimed: false, reason: 'not_triaged', status: 'awaiting_review' })
  })

  it('refuses a ticket already at the failure ceiling', async () => {
    const ticketId = await seedTicket({ agentFailureCount: INVARIANTS.AGENT_FAILURE_ESCALATE_AT, lastInboundAt: minutesAgo(5) })
    expect(await claim(ticketId)).toEqual({ claimed: false, reason: 'failure_ceiling' })
  })

  it('escalates INSIDE the claim transaction when a stuck re-claim reaches the failure ceiling', async () => {
    const ticketId = await seedTicket({
      agentFailureCount: INVARIANTS.AGENT_FAILURE_ESCALATE_AT - 1,
      lastAgentRunAt: minutesAgo(25), lastAgentFinishedAt: null, lastInboundAt: minutesAgo(45),
      escalationNotifiedAt: NOW, ownerRedraftFeedback: 'shorter please', redraftCount: 1,
    })

    expect(await claim(ticketId)).toEqual({ claimed: false, reason: 'stuck_escalated' })

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_failed')
    expect(ticket.escalationNotifiedAt).toBeNull()
    expect(ticket.agentFailureCount).toBe(INVARIANTS.AGENT_FAILURE_ESCALATE_AT)
    expect(ticket.lastAgentRunAt).toEqual(NOW)
    expect(ticket.ownerRedraftFeedback).toBeNull()
    expect(ticket.redraftCount).toBe(0)
    expect(await notificationsFor(escalationDedupeKey(ticketId, DAY))).toHaveLength(1)
    expect(await auditRowsFor(ticketId, 'ticket.escalated')).toHaveLength(1)
  })

  // What makes the claim a true CAS rather than a check-then-act: the predicate is evaluated
  // against a row this transaction holds locked, so a claimer that arrives while another writer
  // holds it blocks and then reads that writer's committed state — never the stale pre-write row.
  it('evaluates the predicate under a row lock, so a concurrent status change wins', async () => {
    const ticketId = await seedTicket({ lastInboundAt: minutesAgo(5) })
    const other = createDb(t.url)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      const held = withOrg(other.db, orgId, async (tx) => {
        await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId)).for('update')
        await tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, ticketId))
        await gate
      })
      await sleep(100)                       // the holder now owns the row lock
      const claiming = claim(ticketId)       // blocks inside SELECT … FOR UPDATE
      await sleep(100)
      release()
      await held

      expect(await claiming).toEqual({ claimed: false, reason: 'not_triaged', status: 'resolved' })
      expect((await getTicket(ticketId)).lastAgentRunAt).toBeNull()
    } finally {
      await other.pool.end()
    }
  })

  // The stranding bug this pins: with the increment and the escalation in SEPARATE transactions, a
  // hard-kill in between leaves the ticket `triaged` at the ceiling count — below no selection
  // predicate, above the claim guard, never escalated, so never notified. Forever, with zero owner
  // signal. One commit means that state is never observable, not merely unlikely.
  it('commits the ceiling escalation and the increment together — (triaged, 2) is unobservable', async () => {
    const ticketId = await seedTicket({
      agentFailureCount: INVARIANTS.AGENT_FAILURE_ESCALATE_AT - 1,
      lastAgentRunAt: minutesAgo(25), lastAgentFinishedAt: null,
    })
    const holder = createDb(t.url)
    const poller = createDb(t.url)
    const observations: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      const held = withOrg(holder.db, orgId, async (tx) => {
        await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId)).for('update')
        await gate
      })
      await sleep(100)
      let settled = false
      const claiming = claim(ticketId).finally(() => { settled = true })
      await sleep(100)                       // the claim is now blocked on the holder's row lock
      const polling = (async () => {
        while (!settled) {
          const [row] = await withOrg(poller.db, orgId, (tx) =>
            tx.select({ status: tickets.status, agentFailureCount: tickets.agentFailureCount }).from(tickets).where(eq(tickets.id, ticketId)))
          observations.push(`${row!.status}:${row!.agentFailureCount}`)
        }
      })()
      release()
      await held
      expect(await claiming).toEqual({ claimed: false, reason: 'stuck_escalated' })
      await polling
    } finally {
      await holder.pool.end()
      await poller.pool.end()
    }

    expect(observations.length).toBeGreaterThan(0)
    expect(observations).not.toContain(`triaged:${INVARIANTS.AGENT_FAILURE_ESCALATE_AT}`)
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.agentFailureCount).toBe(INVARIANTS.AGENT_FAILURE_ESCALATE_AT)
  })
})

describe('unwindClaimStamp', () => {
  const unwind = (ticketId: string, stamped: Date, prior: Date | null) =>
    withOrg(app.db, orgId, (tx) => unwindClaimStamp(tx, ticketId, stamped, prior))

  it('restores the prior value when the current value matches exactly what this claim wrote', async () => {
    const ticketId = await seedTicket({ lastAgentRunAt: NOW })
    expect(await unwind(ticketId, NOW, minutesAgo(90))).toBe(true)
    expect((await getTicket(ticketId)).lastAgentRunAt).toEqual(minutesAgo(90))
  })

  it('restores a NULL prior value (a never-run ticket claimed for the first time)', async () => {
    const ticketId = await seedTicket({ lastAgentRunAt: NOW })
    expect(await unwind(ticketId, NOW, null)).toBe(true)
    expect((await getTicket(ticketId)).lastAgentRunAt).toBeNull()
  })

  it('no-ops when the current value does NOT match the expected stamped value', async () => {
    const ticketId = await seedTicket({ lastAgentRunAt: minutesAgo(5) })
    expect(await unwind(ticketId, NOW, minutesAgo(90))).toBe(false)
    expect((await getTicket(ticketId)).lastAgentRunAt).toEqual(minutesAgo(5))
  })

  it('no-ops when the ticket has already left triaged status', async () => {
    const ticketId = await seedTicket({ status: 'needs_owner', lastAgentRunAt: NOW })
    expect(await unwind(ticketId, NOW, minutesAgo(90))).toBe(false)
    expect((await getTicket(ticketId)).lastAgentRunAt).toEqual(NOW)
  })
})

describe('recordFailure', () => {
  const fail = (ticketId: string, runId: string | null = null) =>
    withOrg(app.db, orgId, (tx) => recordFailure(tx, { orgId, ticketId, code: 'model_error', detail: 'provider returned 500', now: NOW, runId }))

  it('below the ceiling: counts the attempt and clears the claim stamp so the retry can claim at once', async () => {
    const runId = randomUUID()
    const ticketId = await seedTicket({ lastAgentRunAt: NOW, lastAgentFinishedAt: minutesAgo(90) })

    expect(await fail(ticketId, runId)).toEqual({ escalated: false, agentFailureCount: 1 })

    const ticket = await getTicket(ticketId)
    expect(ticket.agentFailureCount).toBe(1)
    expect(ticket.lastAgentRunAt).toBeNull()
    // Deliberately untouched: a failed attempt must keep reading as "claimed but never finished".
    expect(ticket.lastAgentFinishedAt).toEqual(minutesAgo(90))
    expect(ticket.status).toBe('triaged')

    const audits = await auditRowsFor(ticketId, 'draft.run_failed')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toEqual({ code: 'model_error', detail: 'provider returned 500' })
    expect(audits[0]!.actor).toBe(`agent:${runId}`)
  })

  it('at the ceiling: escalates needs_owner/agent_failed with a notification, and never stamps finished', async () => {
    const ticketId = await seedTicket({
      agentFailureCount: INVARIANTS.AGENT_FAILURE_ESCALATE_AT - 1,
      lastAgentRunAt: NOW, ownerRedraftFeedback: 'again', redraftCount: 1,
    })

    const result = await fail(ticketId)

    expect(result.escalated).toBe(true)
    expect(result.agentFailureCount).toBe(INVARIANTS.AGENT_FAILURE_ESCALATE_AT)
    const rows = await notificationsFor(escalationDedupeKey(ticketId, DAY))
    expect(rows).toHaveLength(1)
    expect(result.notificationId).toBe(rows[0]!.id)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_failed')
    expect(ticket.escalationNotifiedAt).toBeNull()
    expect(ticket.lastAgentFinishedAt).toBeNull()
    expect(ticket.redraftCount).toBe(0)
    expect(await auditRowsFor(ticketId, 'draft.run_failed')).toHaveLength(1)
    expect(await auditRowsFor(ticketId, 'ticket.escalated')).toHaveLength(1)
  })

  it('at the ceiling on a ticket that already left triaged: counts, but escalates nothing', async () => {
    const ticketId = await seedTicket({ status: 'needs_owner', needsOwnerReason: 'tripwire', agentFailureCount: INVARIANTS.AGENT_FAILURE_ESCALATE_AT - 1 })

    const result = await fail(ticketId)

    expect(result).toEqual({ escalated: false, agentFailureCount: INVARIANTS.AGENT_FAILURE_ESCALATE_AT })
    const ticket = await getTicket(ticketId)
    expect(ticket.needsOwnerReason).toBe('tripwire')      // not overwritten by agent_failed
    expect(ticket.agentFailureCount).toBe(INVARIANTS.AGENT_FAILURE_ESCALATE_AT)
    expect(await notificationsFor(escalationDedupeKey(ticketId, DAY))).toHaveLength(0)
  })

  it('does nothing for a ticket that no longer exists', async () => {
    expect(await fail(randomUUID())).toEqual({ escalated: false, agentFailureCount: 0 })
  })
})

describe('stampFinished', () => {
  it('writes both watermarks, promoting the thread snapshot to the prompt watermark', async () => {
    const ticketId = await seedTicket({ lastAgentRunAt: NOW })
    const snapshot = minutesAgo(5)

    await withOrg(app.db, orgId, (tx) => stampFinished(tx, ticketId, snapshot, NOW))

    const ticket = await getTicket(ticketId)
    expect(ticket.lastAgentFinishedAt).toEqual(NOW)
    expect(ticket.lastAgentPromptedAt).toEqual(snapshot)
  })

  it('leaves the prompt watermark alone when the snapshot is NULL', async () => {
    const snapshot = minutesAgo(5)
    const ticketId = await seedTicket({ lastAgentPromptedAt: snapshot })
    const later = new Date(NOW.getTime() + 60_000)

    await withOrg(app.db, orgId, (tx) => stampFinished(tx, ticketId, null, later))

    const ticket = await getTicket(ticketId)
    expect(ticket.lastAgentFinishedAt).toEqual(later)
    expect(ticket.lastAgentPromptedAt).toEqual(snapshot)
  })

  it('is unguarded — a watermark, not a transition', async () => {
    const ticketId = await seedTicket({ status: 'needs_owner' })

    await withOrg(app.db, orgId, (tx) => stampFinished(tx, ticketId, null, NOW))

    expect((await getTicket(ticketId)).lastAgentFinishedAt).toEqual(NOW)
  })
})
