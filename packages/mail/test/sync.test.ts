/**
 * The provider-agnostic sync walk, end to end against Postgres + `MockMailbox`.
 *
 * One `createTestDatabase()` for the whole file; every scenario gets its OWN mailbox connection,
 * its own agent addresses and its own mock mailbox (`makeFixture`), so nothing a scenario writes
 * can be seen by another through the connection-scoped lookups. The two org-wide lookups —
 * `findFloodFoldTarget` (by `customer_email`) and the tripwire — are kept apart by giving every
 * scenario randomized sender addresses.
 *
 * Scenario numbering follows the task brief's list; each `it(...)` names its number.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken } from '@aesa/crypto'
import { agents, auditLog, mailboxConnections, messages, tickets, user, withOrg } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { CursorExpiredError } from '../src/errors.ts'
import { createMockMailbox, type MockMailbox } from '../src/mock.ts'
import { runSync, type SyncDeps } from '../src/sync.ts'
import { MARKER_HEADER, type MailboxClient } from '../src/types.ts'

const PLATFORM_SENDER = 'no-reply@aesa.test'
const rand = () => randomBytes(4).toString('hex')

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let orgId: string
let userId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
  orgId = await createTestOrganization(app)
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  userId = u!.id
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})

interface AgentSpec {
  address?: string
  priority?: number
  status?: 'active' | 'pending_verification' | 'disabled'
  codeHash?: string | null
  /** Non-null simulates an agent still gated on the connecting user's consent (api-side
   * `mailboxes.addAddress`/`consentAddress`) — a real `user.id` FK, not an arbitrary string. */
  consentRequiredFromUserId?: string | null
}

interface Fixture {
  connectionId: string
  selfAddress: string
  mailbox: MockMailbox
  agentIds: string[]
  addresses: string[]
  deps: SyncDeps
  /** Ticket ids handed to `onNewInboundTicket`, in call order (the worker's triage enqueue). */
  newInbound: string[]
  /** Ticket ids handed to `onTripwire`, in call order (the worker's escalation notification). */
  tripwired: string[]
}

async function makeFixture(
  opts: {
    mode?: 'gmail' | 'graph'
    agents?: AgentSpec[]
    tripwireExtras?: string[]
    now?: () => Date
  } = {},
): Promise<Fixture> {
  const mode = opts.mode ?? 'gmail'
  const selfAddress = `support-${rand()}@acme.test`
  const mailbox = createMockMailbox({ mode, selfAddress })

  const connectionId = await withOrg(app.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(mailboxConnections)
      .values({
        orgId,
        provider: mode === 'gmail' ? 'gmail' : 'microsoft',
        providerAccountId: `acct-${rand()}`,
        emailAddress: selfAddress,
        status: 'connected',
        connectedByUserId: userId,
      })
      .returning({ id: mailboxConnections.id })
    return row!.id
  })

  const specs: AgentSpec[] = opts.agents ?? [{ address: selfAddress }]
  const rows = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(agents)
      .values(
        specs.map((s) => {
          const address = s.address ?? selfAddress
          return {
            orgId,
            connectionId,
            address,
            domain: address.split('@')[1]!,
            displayName: 'Support',
            priority: s.priority ?? 0,
            status: s.status ?? 'active',
            verificationCodeHash: s.codeHash ?? null,
            consentRequiredFromUserId: s.consentRequiredFromUserId ?? null,
          }
        }),
      )
      .returning({ id: agents.id, address: agents.address }),
  )

  const newInbound: string[] = []
  const tripwired: string[] = []
  const deps: SyncDeps = {
    db: app.db,
    client: mailbox,
    orgId,
    connectionId,
    provider: mode === 'gmail' ? 'gmail' : 'microsoft',
    selfAddress,
    platformSender: PLATFORM_SENDER,
    tripwireExtras: opts.tripwireExtras ?? [],
    onNewInboundTicket: (id) => newInbound.push(id),
    onTripwire: (id) => tripwired.push(id),
    now: opts.now,
  }

  return {
    connectionId,
    selfAddress,
    mailbox,
    agentIds: rows.map((r) => r.id),
    addresses: rows.map((r) => r.address),
    deps,
    newInbound,
    tripwired,
  }
}

/** Wraps a mock so a test can prove which FETCH FORMATS the walk asked for (privacy rule). */
function spyClient(m: MockMailbox): { client: MailboxClient; calls: { id: string; format: string }[] } {
  const calls: { id: string; format: string }[] = []
  const client: MailboxClient = {
    ...m,
    getMessage: async (id, opts) => {
      calls.push({ id, format: opts.format })
      return m.getMessage(id, opts)
    },
  }
  return { client, calls }
}

const ticketsFor = (connectionId: string) =>
  withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.connectionId, connectionId)).orderBy(tickets.createdAt))

const messagesFor = (connectionId: string) =>
  withOrg(app.db, orgId, (tx) => tx.select().from(messages).where(eq(messages.connectionId, connectionId)).orderBy(messages.sentAt))

const connectionCursor = async (connectionId: string): Promise<unknown> => {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.select({ cursor: mailboxConnections.cursor }).from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)),
  )
  return row!.cursor
}

const setCursor = (connectionId: string, cursor: unknown) =>
  withOrg(app.db, orgId, (tx) => tx.update(mailboxConnections).set({ cursor }).where(eq(mailboxConnections.id, connectionId)))

const patchTicket = (ticketId: string, patch: Partial<typeof tickets.$inferInsert>) =>
  withOrg(app.db, orgId, (tx) => tx.update(tickets).set(patch).where(eq(tickets.id, ticketId)))

/** Today's UTC midnight — the flood bound's window boundary; seeds are anchored to it so the
 * fixture cannot fall into "yesterday" when the suite happens to run just after midnight. */
const utcMidnight = () => {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

/** Seeds a ticket directly (flood-fold fixtures) — `createdAt` is explicit so "newest" is total. */
const seedTicket = async (connectionId: string, values: Partial<typeof tickets.$inferInsert> & { providerThreadId: string }) => {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(tickets)
      .values({ orgId, connectionId, ...values })
      .returning({ id: tickets.id }),
  )
  return row!.id
}

describe('runSync — the provider-agnostic walk (gmail mode)', () => {
  it('1. inbound to an agent address creates a new ticket, inserts the message and fires onNewInboundTicket', async () => {
    const f = await makeFixture()
    await runSync(f.deps) // seed-on-null: a fresh mailbox only remembers where to start

    f.mailbox.receiveInbound({
      from: 'jane@example.com',
      to: [f.addresses[0]!],
      subject: 'Where is my order?',
      bodyText: 'It has been a week.',
    })

    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(1)
    expect(result.resynced).toBe(false)

    const rows = await ticketsFor(f.connectionId)
    expect(rows).toHaveLength(1)
    const ticket = rows[0]!
    expect(ticket.status).toBe('new')
    expect(ticket.customerEmail).toBe('jane@example.com')
    expect(ticket.subject).toBe('Where is my order?')
    expect(ticket.inboundCount).toBe(1)
    expect(ticket.lastInboundAt).not.toBeNull()
    expect(ticket.agentId).toBe(f.agentIds[0])
    expect(ticket.spamFlagged).toBe(false)

    const msgs = await messagesFor(f.connectionId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.direction).toBe('inbound')
    expect(msgs[0]!.dmarcPass).toBe(true)
    expect(msgs[0]!.fromAddress).toBe('jane@example.com')
    expect(msgs[0]!.bodyText).toBe('It has been a week.')

    expect(f.newInbound).toEqual([ticket.id])
    expect(result.newInboundTicketIds).toEqual([ticket.id])
    expect(f.tripwired).toEqual([])
  })

  it('1b. seed-on-null ingests nothing: a fresh mailbox only remembers where to start', async () => {
    const f = await makeFixture()

    // Mail that was already sitting in the mailbox when the owner connected it. Connecting a
    // decade-old inbox must not import a decade of mail.
    f.mailbox.receiveInbound({
      from: `old-${rand()}@example.com`,
      to: [f.addresses[0]!],
      subject: 'Before we connected',
      bodyText: 'ancient history',
    })

    const seed = await runSync(f.deps)
    expect(seed.insertedMessages).toBe(0)
    expect(await ticketsFor(f.connectionId)).toHaveLength(0)
    expect(await connectionCursor(f.connectionId)).toEqual({ historyId: '1' })

    // ...and the next poll starts from there rather than retroactively sweeping it up.
    f.mailbox.receiveInbound({ from: `new-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'After we connected', bodyText: 'hi' })
    const next = await runSync(f.deps)

    expect(next.insertedMessages).toBe(1)
    const rows = await ticketsFor(f.connectionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.subject).toBe('After we connected')
  })

  it('2. replaying the same change feed has zero side effects and lands on the same cursor', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const seeded = await connectionCursor(f.connectionId)

    f.mailbox.receiveInbound({ from: `jane-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)
    const advanced = await connectionCursor(f.connectionId)
    expect(advanced).not.toEqual(seeded)

    // Rewind to the pre-ingest cursor: the SAME history is walked again, and the insert gate must
    // make every downstream effect a no-op.
    await setCursor(f.connectionId, seeded)
    const replay = await runSync(f.deps)

    expect(replay.insertedMessages).toBe(0)
    expect(replay.newInboundTicketIds).toEqual([])
    expect(f.newInbound).toHaveLength(1)
    expect(await messagesFor(f.connectionId)).toHaveLength(1)
    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.inboundCount).toBe(1)
    expect(await connectionCursor(f.connectionId)).toEqual(advanced)
  })

  it('3. mail to an unrouted address is never fetched in full and creates nothing', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    f.mailbox.receiveInbound({
      from: `jane-${rand()}@example.com`,
      to: [`stranger-${rand()}@acme.test`],
      subject: 'Not for us',
      bodyText: 'private',
    })

    const spy = spyClient(f.mailbox)
    const result = await runSync({ ...f.deps, client: spy.client })

    expect(result.insertedMessages).toBe(0)
    expect(spy.calls.filter((c) => c.format === 'metadata')).toHaveLength(1)
    expect(spy.calls.filter((c) => c.format === 'full')).toHaveLength(0)
    expect(await ticketsFor(f.connectionId)).toHaveLength(0)
  })

  it('4. an outbound SENT message on a known thread is recorded without reopening or re-triaging', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    await patchTicket(ticketId, { status: 'resolved' })
    f.newInbound.length = 0

    f.mailbox.receiveOutbound({ to: [customer], subject: 'Re: Hi', bodyText: 'All sorted.', threadId })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(1)
    const msgs = await messagesFor(f.connectionId)
    expect(msgs).toHaveLength(2)
    expect(msgs[1]!.direction).toBe('outbound')

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.status).toBe('resolved') // outbound never reopens
    expect(ticket.inboundCount).toBe(1)
    expect(f.newInbound).toEqual([])
    expect(result.newInboundTicketIds).toEqual([])
  })

  it('5. a DMARC-pass reply reopens a resolved ticket and resets its budgets', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    await patchTicket(ticketId, {
      status: 'resolved',
      triageFailureCount: 3,
      agentFailureCount: 2,
      ownerRedraftFeedback: 'be warmer',
      redraftCount: 4,
    })
    f.newInbound.length = 0

    f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Re: Hi', bodyText: 'One more thing', threadId })
    const result = await runSync(f.deps)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.status).toBe('new')
    expect(ticket.triageFailureCount).toBe(0)
    expect(ticket.agentFailureCount).toBe(0)
    expect(ticket.ownerRedraftFeedback).toBeNull()
    expect(ticket.redraftCount).toBe(0)
    expect(ticket.inboundCount).toBe(2)
    expect(f.newInbound).toEqual([ticketId])
    expect(result.newInboundTicketIds).toEqual([ticketId])
  })

  it('5b. the reopen runs BEFORE the tripwire, so a reopened ticket with escalation content still escalates', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    await patchTicket(ticketId, { status: 'resolved', triageFailureCount: 3, escalationNotifiedAt: new Date() })

    f.mailbox.receiveInbound({
      from: customer,
      to: [f.addresses[0]!],
      subject: 'Re: Hi',
      bodyText: 'My attorney will be in touch.',
      threadId,
    })
    await runSync(f.deps)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('tripwire')
    // Proof the reopen ran first: had the tripwire gone first, the ticket would already have been
    // `needs_owner` and the reopen's WHERE would have missed, leaving the budget at 3.
    expect(ticket.triageFailureCount).toBe(0)
    expect(ticket.escalationNotifiedAt).toBeNull()
    expect(f.tripwired).toEqual([ticketId])
  })

  it('6. a DMARC-fail reply is recorded but never reopens', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    await patchTicket(ticketId, { status: 'resolved', triageFailureCount: 3 })
    f.newInbound.length = 0

    f.mailbox.receiveInbound({
      from: customer,
      to: [f.addresses[0]!],
      subject: 'Re: Hi',
      bodyText: 'spoofed follow-up',
      threadId,
      authenticationResults: 'mx.mock; spf=fail; dmarc=fail (p=NONE)',
    })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(1)
    const msgs = await messagesFor(f.connectionId)
    expect(msgs).toHaveLength(2)
    expect(msgs[1]!.dmarcPass).toBe(false)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.status).toBe('resolved')
    expect(ticket.triageFailureCount).toBe(3) // no reopen ⇒ no budget reset
    expect(ticket.inboundCount).toBe(2) // the message itself is still recorded
    expect(f.newInbound).toEqual([])
  })

  it("7. a needs_owner ticket is never auto-reopened by a reply", async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    await patchTicket(ticketId, { status: 'needs_owner', needsOwnerReason: 'triage_flags' })
    f.newInbound.length = 0

    f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Re: Hi', bodyText: 'any update?', threadId })
    await runSync(f.deps)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('triage_flags')
    expect(ticket.inboundCount).toBe(2)
    expect(f.newInbound).toEqual([])
  })

  it('8. the tripwire escalates on word boundaries only ("velvet" never trips "vet")', async () => {
    const f = await makeFixture({ tripwireExtras: ['vet'] })
    await runSync(f.deps)

    f.mailbox.receiveInbound({
      from: `benign-${rand()}@example.com`,
      to: [f.addresses[0]!],
      subject: 'Velvet cushion',
      bodyText: 'The velvet cushion arrived and it is lovely.',
    })
    f.mailbox.receiveInbound({
      from: `angry-${rand()}@example.com`,
      to: [f.addresses[0]!],
      subject: 'My dog is sick',
      bodyText: 'I had to take him to the vet after using this.',
    })

    const result = await runSync(f.deps)

    const rows = await ticketsFor(f.connectionId)
    expect(rows).toHaveLength(2)
    const benign = rows.find((r) => r.subject === 'Velvet cushion')!
    const tripped = rows.find((r) => r.subject === 'My dog is sick')!

    expect(benign.status).toBe('new')
    expect(benign.needsOwnerReason).toBeNull()

    expect(tripped.status).toBe('needs_owner')
    expect(tripped.needsOwnerReason).toBe('tripwire')
    expect(tripped.escalationNotifiedAt).toBeNull()

    expect(result.tripwiredTicketIds).toEqual([tripped.id])
    expect(f.tripwired).toEqual([tripped.id])
  })

  it('9. a tripwire on the second message escalates exactly once and never re-fires on a re-poll', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const seeded = await connectionCursor(f.connectionId)
    const customer = `jane-${rand()}@example.com`

    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Order', bodyText: 'where is it' })
    await runSync(f.deps)
    expect((await ticketsFor(f.connectionId))[0]!.status).toBe('new')

    f.mailbox.receiveInbound({
      from: customer,
      to: [f.addresses[0]!],
      subject: 'Re: Order',
      bodyText: 'I am filing a chargeback with my bank.',
      threadId,
    })
    const escalating = await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    expect(escalating.tripwiredTicketIds).toEqual([ticketId])
    expect(f.tripwired).toEqual([ticketId])

    // Re-walk the whole feed: the insert gate stops the tripwire from firing a second time.
    await setCursor(f.connectionId, seeded)
    const replay = await runSync(f.deps)
    expect(replay.tripwiredTicketIds).toEqual([])
    expect(f.tripwired).toEqual([ticketId])
    expect((await ticketsFor(f.connectionId))[0]!.status).toBe('needs_owner')
  })

  it('10. the 6th ticket in a UTC day from one sender folds onto their newest ticket; DMARC-fail never folds', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const flooder = `flood-${rand()}@example.com`

    const seededIds: string[] = []
    for (let i = 0; i < 5; i += 1) {
      seededIds.push(
        await seedTicket(f.connectionId, {
          providerThreadId: `seed-thread-${rand()}`,
          customerEmail: flooder,
          subject: `Seeded ${i}`,
          createdAt: new Date(utcMidnight() + (i + 1) * 60_000),
        }),
      )
    }
    const newest = seededIds[4]!

    f.mailbox.receiveInbound({ from: flooder, to: [f.addresses[0]!], subject: 'Yet another', bodyText: 'again' })
    await runSync(f.deps)

    expect(await ticketsFor(f.connectionId)).toHaveLength(5) // no 6th ticket
    const folded = await messagesFor(f.connectionId)
    expect(folded).toHaveLength(1)
    expect(folded[0]!.ticketId).toBe(newest)

    // A DMARC-fail sender is outside the fold rule entirely: it opens a ticket like any other.
    const spoofer = `spoof-${rand()}@example.com`
    for (let i = 0; i < 5; i += 1) {
      await seedTicket(f.connectionId, {
        providerThreadId: `spoof-thread-${rand()}`,
        customerEmail: spoofer,
        createdAt: new Date(utcMidnight() + (i + 1) * 60_000),
      })
    }
    f.mailbox.receiveInbound({
      from: spoofer,
      to: [f.addresses[0]!],
      subject: 'Unauthenticated',
      bodyText: 'hello',
      authenticationResults: 'mx.mock; dmarc=fail',
    })
    await runSync(f.deps)

    const after = await ticketsFor(f.connectionId)
    expect(after).toHaveLength(11) // 5 + 5 seeded, plus one brand-new ticket
    expect(after.some((r) => r.subject === 'Unauthenticated')).toBe(true)
  })

  /**
   * Ruling I2: the flood COUNT is organization-wide, but the fold TARGET must live on the
   * connection the message arrived on. A ticket's thread belongs to its own mailbox, so folding a
   * message from connection B onto a ticket on connection A would leave the agent holding a message
   * it cannot reply into.
   */
  it('10b. a sender at the cap on another connection opens a normal ticket here, then folds within it', async () => {
    const a = await makeFixture()
    const b = await makeFixture()
    await runSync(a.deps)
    await runSync(b.deps)

    const flooder = `cross-${rand()}@example.com`
    for (let i = 0; i < 5; i += 1) {
      await seedTicket(a.connectionId, {
        providerThreadId: `cross-thread-${rand()}`,
        customerEmail: flooder,
        createdAt: new Date(utcMidnight() + (i + 1) * 60_000),
      })
    }

    // Org-wide the sender is already at the cap, but their newest ticket is on connection A.
    b.mailbox.receiveInbound({ from: flooder, to: [b.addresses[0]!], subject: 'First on B', bodyText: 'hi' })
    await runSync(b.deps)

    expect(await ticketsFor(a.connectionId)).toHaveLength(5) // A is untouched
    const onB = await ticketsFor(b.connectionId)
    expect(onB).toHaveLength(1)
    expect((await messagesFor(b.connectionId))[0]!.ticketId).toBe(onB[0]!.id)

    // ...and the bound still holds here: every further NEW thread from that sender on this
    // connection now folds onto the ticket it just opened.
    b.mailbox.receiveInbound({ from: flooder, to: [b.addresses[0]!], subject: 'Second on B', bodyText: 'again' })
    await runSync(b.deps)

    expect(await ticketsFor(b.connectionId)).toHaveLength(1)
    const msgs = await messagesFor(b.connectionId)
    expect(msgs).toHaveLength(2)
    expect(msgs.every((m) => m.ticketId === onB[0]!.id)).toBe(true)
  })

  it('11. a spoofed From claiming the self address with no SENT label is inbound', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    f.mailbox.receiveInbound({
      from: f.selfAddress, // forged
      to: [f.addresses[0]!],
      subject: 'Internal notice',
      bodyText: 'click here',
      authenticationResults: 'mx.mock; spf=fail; dmarc=fail (p=NONE)',
    })
    await runSync(f.deps)

    const msgs = await messagesFor(f.connectionId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.direction).toBe('inbound')
    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.customerEmail).toBe(f.selfAddress)
    expect(ticket.inboundCount).toBe(1)
  })

  it('12. a message that vanished mid-batch is skipped, the rest of the batch lands, the cursor advances', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    const first = f.mailbox.receiveInbound({ from: `a-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'One', bodyText: 'x' })
    const second = f.mailbox.receiveInbound({ from: `b-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Two', bodyText: 'y' })
    const third = f.mailbox.receiveInbound({ from: `c-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Three', bodyText: 'z' })
    f.mailbox.deleteMessage(second.id)

    const expected = (await f.mailbox.profile()).cursor
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(2)
    const msgs = await messagesFor(f.connectionId)
    expect(msgs.map((m) => m.providerMessageId).sort()).toEqual([first.id, third.id].sort())
    expect(await ticketsFor(f.connectionId)).toHaveLength(2)
    expect(await connectionCursor(f.connectionId)).toEqual(expected)
  })

  it('12b. the cursor advances to the NUMERIC max change id across a paginated feed', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    // Eleven records, so the ids span the 9 → 10 boundary where a lexicographic max ('9') would
    // silently rewind the cursor, and four pages, so the drain loop is real.
    for (let i = 0; i < 11; i += 1) {
      f.mailbox.receiveInbound({ from: `bulk-${i}-${rand()}@example.com`, to: [f.addresses[0]!], subject: `Bulk ${i}`, bodyText: 'x' })
    }
    const expected = (await f.mailbox.profile()).cursor
    expect(expected).toEqual({ historyId: '11' })

    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(11)
    expect(await ticketsFor(f.connectionId)).toHaveLength(11)
    expect(await connectionCursor(f.connectionId)).toEqual(expected)
  })

  it('13. an expired cursor triggers a bounded resync: fresh cursor first, exactly-once ingest, no reopen storm', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    const customerA = `a-${rand()}@example.com`
    const customerB = `b-${rand()}@example.com`
    const t1 = f.mailbox.receiveInbound({ from: customerA, to: [f.addresses[0]!], subject: 'Quiet thread', bodyText: 'hi' })
    const t2 = f.mailbox.receiveInbound({ from: customerB, to: [f.addresses[0]!], subject: 'Busy thread', bodyText: 'hi' })
    await runSync(f.deps)

    const before = await ticketsFor(f.connectionId)
    const quiet = before.find((r) => r.subject === 'Quiet thread')!
    const busy = before.find((r) => r.subject === 'Busy thread')!
    await patchTicket(quiet.id, { status: 'resolved' })
    await patchTicket(busy.id, { status: 'resolved' })
    f.newInbound.length = 0

    // A follow-up that dropped every agent address from its headers — invisible to the address
    // window, reachable only through the known-ticket thread re-walk.
    f.mailbox.receiveInbound({
      from: customerB,
      to: [`someone-else-${rand()}@acme.test`],
      subject: 'Re: Busy thread',
      bodyText: 'still waiting',
      threadId: t2.threadId,
    })
    // And a brand-new conversation the address window must sweep up.
    f.mailbox.receiveInbound({ from: `c-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Fresh', bodyText: 'hello' })

    const preCaptured = (await f.mailbox.profile()).cursor
    f.mailbox.expireCursor()
    const result = await runSync(f.deps)

    expect(result.resynced).toBe(true)
    expect(result.insertedMessages).toBe(2) // only the two genuinely-new messages

    const after = await ticketsFor(f.connectionId)
    expect(after).toHaveLength(3)
    const quietAfter = after.find((r) => r.id === quiet.id)!
    const busyAfter = after.find((r) => r.id === busy.id)!
    const fresh = after.find((r) => r.subject === 'Fresh')!

    expect(quietAfter.status).toBe('resolved') // nothing new on this thread ⇒ no reopen storm
    expect(quietAfter.inboundCount).toBe(1)
    expect(busyAfter.status).toBe('new') // a genuinely new inbound DOES reopen
    expect(busyAfter.inboundCount).toBe(2)
    expect(fresh.status).toBe('new')

    const msgs = await messagesFor(f.connectionId)
    expect(msgs).toHaveLength(4)
    expect(new Set(msgs.map((m) => m.providerMessageId)).size).toBe(4)
    expect(msgs.some((m) => m.providerMessageId === t1.id)).toBe(true)

    expect(await connectionCursor(f.connectionId)).toEqual(preCaptured)
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx.select({ resyncState: mailboxConnections.resyncState }).from(mailboxConnections).where(eq(mailboxConnections.id, f.connectionId)),
    )
    expect(conn!.resyncState).toBeNull() // cleared once the resync completed
  })

  it('13b. a cursor expiry on page three leaves no half-applied batch', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    for (let i = 0; i < 7; i += 1) {
      f.mailbox.receiveInbound({ from: `p-${i}-${rand()}@example.com`, to: [f.addresses[0]!], subject: `Paged ${i}`, bodyText: 'x' })
    }

    // Pages of 3, 3, 1 — the third call expires, after two pages have already been fetched.
    let calls = 0
    const client = {
      ...f.mailbox,
      listChanges: async (cursor: unknown, pageToken?: string) => {
        calls += 1
        if (calls === 3) throw new CursorExpiredError()
        return f.mailbox.listChanges(cursor, pageToken)
      },
    }
    const preCaptured = (await f.mailbox.profile()).cursor
    const result = await runSync({ ...f.deps, client })

    expect(calls).toBe(3)
    expect(result.resynced).toBe(true)
    expect(result.insertedMessages).toBe(7) // exactly once each, no page redone into a duplicate
    expect(await messagesFor(f.connectionId)).toHaveLength(7)
    expect(await ticketsFor(f.connectionId)).toHaveLength(7)
    expect(await connectionCursor(f.connectionId)).toEqual(preCaptured)
  })

  it('14. a message addressed to two agents routes to the lower priority number', async () => {
    const primary = `primary-${rand()}@acme.test`
    const secondary = `secondary-${rand()}@acme.test`
    const f = await makeFixture({
      agents: [
        { address: secondary, priority: 5 },
        { address: primary, priority: 0 },
      ],
    })
    await runSync(f.deps)
    const primaryAgentId = f.agentIds[f.addresses.indexOf(primary)]!

    f.mailbox.receiveInbound({
      from: `jane-${rand()}@example.com`,
      to: [secondary, primary], // secondary listed FIRST — header order must not decide
      subject: 'Both',
      bodyText: 'hello',
    })
    await runSync(f.deps)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.agentId).toBe(primaryAgentId)
  })

  it('15. verification mail from the platform sender activates a pending agent and is never stored', async () => {
    const address = `alias-${rand()}@acme.test`
    const f = await makeFixture({ agents: [{ address, status: 'pending_verification', codeHash: hashToken('action', '482913') }] })
    await runSync(f.deps)
    const agentId = f.agentIds[0]!

    f.mailbox.receiveInbound({
      from: PLATFORM_SENDER,
      to: [address],
      subject: 'Verify this address',
      bodyText: 'Your code is 482913 — it expires in 30 minutes.',
    })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(0)
    expect(await ticketsFor(f.connectionId)).toHaveLength(0)
    expect(await messagesFor(f.connectionId)).toHaveLength(0)

    const [agent] = await withOrg(app.db, orgId, (tx) => tx.select().from(agents).where(eq(agents.id, agentId)))
    expect(agent!.status).toBe('active')
    expect(agent!.verificationCodeHash).toBeNull()

    const audits = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityId, agentId), eq(auditLog.action, 'agent.address_verified'))),
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toBe('system:mailbox.sync')
    expect(audits[0]!.entityType).toBe('agent')
  })

  /**
   * DO NOT "fix" this back to the brief. The brief's scenario 15 says a wrong code is "routed
   * normally (ticket created)"; that wording is SUPERSEDED by the controller ruling on task-11
   * review finding C1: platform mail is never customer mail, so ANY inbound whose From is the
   * platform sender is dropped outright — no ticket, no message row — whatever it contained.
   * Ticketing it would put our own sign-in codes and verification mail (and any forgery of them)
   * into the owner's support queue for the agent to answer.
   */
  it('15b. verification mail carrying the WRONG code is dropped, not ticketed (ruling C1)', async () => {
    const address = `alias-${rand()}@acme.test`
    const f = await makeFixture({ agents: [{ address, status: 'pending_verification', codeHash: hashToken('action', '482913') }] })
    await runSync(f.deps)
    const agentId = f.agentIds[0]!

    f.mailbox.receiveInbound({
      from: PLATFORM_SENDER,
      to: [address],
      subject: 'Verify this address',
      bodyText: 'Your code is 111111 — it expires in 30 minutes.',
    })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(0)
    expect(await ticketsFor(f.connectionId)).toHaveLength(0)
    expect(await messagesFor(f.connectionId)).toHaveLength(0)

    // The agent is untouched: a wrong code neither activates it nor spends its hash.
    const [agent] = await withOrg(app.db, orgId, (tx) => tx.select().from(agents).where(eq(agents.id, agentId)))
    expect(agent!.status).toBe('pending_verification')
    expect(agent!.verificationCodeHash).toBe(hashToken('action', '482913'))
  })

  it('15c. platform mail re-walked after the agent went active is dropped too (ruling C1)', async () => {
    const address = `alias-${rand()}@acme.test`
    const f = await makeFixture({ agents: [{ address, status: 'pending_verification', codeHash: hashToken('action', '482913') }] })
    await runSync(f.deps)
    const seeded = await connectionCursor(f.connectionId)

    f.mailbox.receiveInbound({
      from: PLATFORM_SENDER,
      to: [address],
      subject: 'Verify this address',
      bodyText: 'Your code is 482913.',
    })
    await runSync(f.deps)
    expect((await withOrg(app.db, orgId, (tx) => tx.select().from(agents).where(eq(agents.id, f.agentIds[0]!))))[0]!.status).toBe('active')

    // The verification mail is never inserted, so a rewind (or a resync) re-walks it against an
    // agent that is now active and whose hash is spent — the interception declines, and C1 is the
    // only thing standing between that mail and a "Verify this address" support ticket.
    await setCursor(f.connectionId, seeded)
    const replay = await runSync(f.deps)

    expect(replay.insertedMessages).toBe(0)
    expect(await ticketsFor(f.connectionId)).toHaveLength(0)
    expect(await messagesFor(f.connectionId)).toHaveLength(0)
  })

  /**
   * Defense in depth (api review, Task 19 fix wave): the api never issues a code to a consent-gated
   * agent, so this hash+gate combination shouldn't arise from `mailboxes.addAddress`/`consentAddress`
   * in practice — but `interceptVerification` must refuse to activate a gated agent by mail alone
   * even if it somehow holds a matching hash. A code is proof of mailbox control, not a substitute
   * for the connecting user's separate, required consent.
   */
  it('15d. a consent-gated pending agent is NOT verified by a matching code (defense in depth)', async () => {
    const address = `alias-${rand()}@acme.test`
    const f = await makeFixture({
      agents: [{ address, status: 'pending_verification', codeHash: hashToken('action', '482913'), consentRequiredFromUserId: userId }],
    })
    await runSync(f.deps)
    const agentId = f.agentIds[0]!

    f.mailbox.receiveInbound({
      from: PLATFORM_SENDER,
      to: [address],
      subject: 'Verify this address',
      bodyText: 'Your code is 482913 — it expires in 30 minutes.',
    })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(0)
    expect(await ticketsFor(f.connectionId)).toHaveLength(0)
    expect(await messagesFor(f.connectionId)).toHaveLength(0)

    // Untouched: neither activated, nor the hash spent, nor the consent gate cleared.
    const [agent] = await withOrg(app.db, orgId, (tx) => tx.select().from(agents).where(eq(agents.id, agentId)))
    expect(agent).toMatchObject({ status: 'pending_verification', verificationCodeHash: hashToken('action', '482913'), consentRequiredFromUserId: userId })

    const audits = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityId, agentId), eq(auditLog.action, 'agent.address_verified'))),
    )
    expect(audits).toHaveLength(0)
  })

  it('17. a junk-foldered inbound flags the ticket as provider spam', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    f.mailbox.receiveInbound({
      from: `spammer-${rand()}@example.com`,
      to: [f.addresses[0]!],
      subject: 'You won',
      bodyText: 'claim now',
      labelIds: ['JUNK'],
    })
    await runSync(f.deps)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.spamFlagged).toBe(true)
    expect(ticket.isSpam).toBeNull() // triage's verdict, not ingest's
  })

  it('18. attachment metadata is recorded and card numbers never reach the message body', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    f.mailbox.receiveInbound({
      from: `jane-${rand()}@example.com`,
      to: [f.addresses[0]!],
      subject: 'Receipt attached',
      bodyText: 'My card 4242 4242 4242 4242 was charged twice.',
      attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', size: 2048 }],
    })
    await runSync(f.deps)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.hasAttachments).toBe(true)

    const msg = (await messagesFor(f.connectionId))[0]!
    expect(msg.attachments).toEqual([{ filename: 'receipt.pdf', mime: 'application/pdf', size: 2048 }])
    expect(msg.bodyText).toBe('My card [card removed] was charged twice.')
    expect(msg.bodyText).not.toContain('4242')
  })

  /**
   * Ruling I1: the pre-fetch ticket lookup is only the "may we read this body?" gate. A network
   * round trip sits between it and the write, and a concurrent triage run can move the ticket
   * new → triaged across it — so ticket identity, `priorStatus` and the flood-fold decision are all
   * re-derived inside the write transaction.
   */
  it('20. a ticket flipped to triaged during the full fetch still gets its re-triage enqueue', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    f.newInbound.length = 0

    f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Re: Hi', bodyText: 'one more thing', threadId })

    // Triage lands between the metadata fetch (which saw `new`) and the write transaction.
    let flipped = false
    const client = {
      ...f.mailbox,
      getMessage: async (id: string, opts: { format: 'metadata' | 'full' }) => {
        if (opts.format === 'full' && !flipped) {
          flipped = true
          await patchTicket(ticketId, { status: 'triaged', lastTriagedAt: new Date() })
        }
        return f.mailbox.getMessage(id, opts)
      },
    }
    const result = await runSync({ ...f.deps, client })

    expect(flipped).toBe(true)
    expect(result.insertedMessages).toBe(1)
    // Read from the IN-TRANSACTION lookup, not the stale pre-fetch row: the customer said something
    // new after the last verdict, so the ticket must be re-triaged.
    expect(f.newInbound).toEqual([ticketId])
    expect(result.newInboundTicketIds).toEqual([ticketId])

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.status).toBe('triaged') // 'triaged' is not reopen-eligible, so the status stands
    expect(ticket.inboundCount).toBe(2)
  })

  /**
   * Ruling I3: the callbacks are the sole delivery mechanism, and they run post-commit — so a
   * throwing one has nothing to roll back and must never abort the walk. Letting it propagate would
   * turn one failed enqueue into a batch-wide outage for every later message.
   */
  it('21. a throwing post-commit callback is logged and never costs later messages their effects', async () => {
    const f = await makeFixture()
    await runSync(f.deps)
    for (let i = 0; i < 3; i += 1) {
      f.mailbox.receiveInbound({ from: `cb-${i}-${rand()}@example.com`, to: [f.addresses[0]!], subject: `Callback ${i}`, bodyText: 'x' })
    }

    const logs: { level: string; msg: string; ctx?: Record<string, unknown> }[] = []
    const delivered: string[] = []
    let calls = 0
    const result = await runSync({
      ...f.deps,
      onNewInboundTicket: (id) => {
        calls += 1
        if (calls === 1) throw new Error('queue unavailable')
        delivered.push(id)
      },
      log: (level, msg, ctx) => logs.push({ level, msg, ctx }),
    })

    expect(calls).toBe(3)
    expect(delivered).toHaveLength(2)
    expect(result.insertedMessages).toBe(3)
    expect(await ticketsFor(f.connectionId)).toHaveLength(3)
    expect(await messagesFor(f.connectionId)).toHaveLength(3)
    // Reporting-only: the arrays record what the walk decided, including the delivery that failed.
    expect(result.newInboundTicketIds).toHaveLength(3)

    const warned = logs.filter((l) => l.level === 'warn' && l.msg === 'mailbox.sync_callback_failed')
    expect(warned).toHaveLength(1)
    expect(warned[0]!.ctx).toMatchObject({ hook: 'onNewInboundTicket', error: 'queue unavailable' })
  })

  it('19. automated-mail headers mark the ticket is_automated without a triage pass', async () => {
    const f = await makeFixture()
    await runSync(f.deps)

    f.mailbox.receiveInbound({
      from: `noreply-${rand()}@example.com`,
      to: [f.addresses[0]!],
      subject: 'Your weekly digest',
      bodyText: 'here it is',
      listId: '<digest.example.com>',
    })
    await runSync(f.deps)

    const ticket = (await ticketsFor(f.connectionId))[0]!
    expect(ticket.isAutomated).toBe(true)
  })

  it('22. a DRAFT-labelled message produces zero tickets and zero messages (spec verify item: draft churn zero rows)', async () => {
    const f = await makeFixture()
    await runSync(f.deps) // seed-on-null

    f.mailbox.receiveInbound({
      from: `jane-${rand()}@example.com`,
      to: [f.addresses[0]!],
      subject: 'Draft revision',
      bodyText: 'autosaved',
      labelIds: ['DRAFT'],
    })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(0)
    expect(await ticketsFor(f.connectionId)).toHaveLength(0)
    expect(await messagesFor(f.connectionId)).toHaveLength(0)
  })

  // Task 12: the sync walk stamps `draft_id` on an ingested outbound (sent) copy from its
  // `X-Aesa-Draft` marker — but only when the marker is a syntactically valid uuid, since
  // `messages.draft_id` is a `uuid` column and a malformed marker must not fail the whole walk.

  it('23. an outbound sent message with a valid marker is stamped draft_id on the row', async () => {
    const f = await makeFixture()
    await runSync(f.deps) // seed-on-null
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)

    const draftId = randomUUID()
    await f.mailbox.sendReply({
      threadId,
      to: customer,
      subject: 'Re: Hi',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'All sorted.',
      extraHeaders: { [MARKER_HEADER]: draftId },
    })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(1)
    const msgs = await messagesFor(f.connectionId)
    expect(msgs).toHaveLength(2)
    expect(msgs[1]!.direction).toBe('outbound')
    expect(msgs[1]!.draftId).toBe(draftId)
  })

  it('24. an outbound sent message with a malformed marker ingests with draft_id NULL and the walk completes', async () => {
    const f = await makeFixture()
    await runSync(f.deps) // seed-on-null
    const customer = `jane-${rand()}@example.com`
    const { threadId } = f.mailbox.receiveInbound({ from: customer, to: [f.addresses[0]!], subject: 'Hi', bodyText: 'hello' })
    await runSync(f.deps)

    await f.mailbox.sendReply({
      threadId,
      to: customer,
      subject: 'Re: Hi',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'All sorted.',
      extraHeaders: { [MARKER_HEADER]: 'not-a-uuid' },
    })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(1)
    const msgs = await messagesFor(f.connectionId)
    expect(msgs).toHaveLength(2)
    expect(msgs[1]!.direction).toBe('outbound')
    expect(msgs[1]!.draftId).toBeNull()
  })
})

describe('16. runSync — graph mode smoke', () => {
  it('16a. inbound to an agent address creates a ticket (case 1)', async () => {
    const f = await makeFixture({ mode: 'graph' })
    await runSync(f.deps)

    f.mailbox.receiveInbound({ from: `jane-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Graph hello', bodyText: 'hi' })
    const result = await runSync(f.deps)

    expect(result.insertedMessages).toBe(1)
    const rows = await ticketsFor(f.connectionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('new')
    expect(f.newInbound).toEqual([rows[0]!.id])
    expect(await connectionCursor(f.connectionId)).toEqual((await f.mailbox.profile()).cursor)
  })

  it('16b. replaying the delta feed has zero side effects (case 2)', async () => {
    const f = await makeFixture({ mode: 'graph' })
    await runSync(f.deps)
    const seeded = await connectionCursor(f.connectionId)

    f.mailbox.receiveInbound({ from: `jane-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Graph hello', bodyText: 'hi' })
    await runSync(f.deps)
    const advanced = await connectionCursor(f.connectionId)

    await setCursor(f.connectionId, seeded)
    const replay = await runSync(f.deps)

    expect(replay.insertedMessages).toBe(0)
    expect(await messagesFor(f.connectionId)).toHaveLength(1)
    expect(f.newInbound).toHaveLength(1)
    expect(await connectionCursor(f.connectionId)).toEqual(advanced)
  })

  it('16c. an expired delta token resyncs and stores the pre-captured delta cursor (case 13)', async () => {
    const f = await makeFixture({ mode: 'graph' })
    await runSync(f.deps)

    f.mailbox.receiveInbound({ from: `jane-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Graph one', bodyText: 'hi' })
    await runSync(f.deps)
    const ticketId = (await ticketsFor(f.connectionId))[0]!.id
    await patchTicket(ticketId, { status: 'resolved' })

    f.mailbox.receiveInbound({ from: `bob-${rand()}@example.com`, to: [f.addresses[0]!], subject: 'Graph two', bodyText: 'hi' })
    const preCaptured = (await f.mailbox.profile()).cursor
    f.mailbox.expireCursor()
    const result = await runSync(f.deps)

    expect(result.resynced).toBe(true)
    expect(result.insertedMessages).toBe(1)
    expect(await ticketsFor(f.connectionId)).toHaveLength(2)
    expect((await ticketsFor(f.connectionId)).find((r) => r.id === ticketId)!.status).toBe('resolved')
    expect(await connectionCursor(f.connectionId)).toEqual(preCaptured)
  })
})
