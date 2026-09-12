/**
 * `runDigestEmailForOrg` against Postgres, with a devsink transport reading the emails back.
 * Every test gets its own org (and its own workspace), so the once-per-local-day lock — a
 * `notifications` row keyed `digest_email:<orgId>:<localDay>` — never leaks between tests.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken } from '@aesa/crypto'
import { createDevSink, DIGEST_MAX_ITEMS, type DevSink } from '@aesa/platform-mail'
import {
  categories, draftActionTokens, drafts, mailboxConnections, member, notifications, orgSettings, tickets, user, withOrg, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { ACTION_TOKEN_TTL_DAYS, localHourAndDay, runDigestEmailForOrg, type DigestEmailDeps } from '../src/digest-email.ts'

const rand = () => randomBytes(4).toString('hex')
/** 12:00 UTC is 08:00 in America/New_York — the catalog default `notifications.digest_email_hour`. */
const NOW = new Date('2026-09-09T12:00:00Z')
const APP_BASE_URL = 'https://api.test'
const APP_WEB_ORIGIN = 'https://app.test'

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})

function makeDeps(mail: DevSink): DigestEmailDeps {
  return { db: app.db, mail, appBaseUrl: APP_BASE_URL, appWebOrigin: APP_WEB_ORIGIN, logger: pino({ level: 'silent' }), now: () => NOW }
}

async function newOrgWithWorkspace(overrides: Partial<typeof workspaces.$inferInsert> = {}): Promise<string> {
  const orgId = await createTestOrganization(app)
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(workspaces).values({ orgId, businessName: 'Acme Widgets', timezone: 'America/New_York', ...overrides }))
  return orgId
}

async function addMember(orgId: string, role: string): Promise<{ userId: string; email: string }> {
  const email = `${role}-${rand()}@example.com`
  const [u] = await app.db.insert(user).values({ name: role, email }).returning({ id: user.id })
  await app.db.insert(member).values({ organizationId: orgId, userId: u!.id, role })
  return { userId: u!.id, email }
}

async function seedConnection(orgId: string, userId: string): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: userId })
      .returning({ id: mailboxConnections.id }))
  return row!.id
}

async function seedTicket(orgId: string, connectionId: string, overrides: Partial<typeof tickets.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(tickets)
      .values({
        orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'awaiting_review',
        subject: 'Where is my order?', customerEmail: 'buyer@x.test', customerName: 'Bea Buyer', ...overrides,
      })
      .returning({ id: tickets.id }))
  return row!.id
}

async function seedPendingDraft(orgId: string, ticketId: string, overrides: Partial<typeof drafts.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(drafts)
      .values({
        orgId, ticketId, body: 'Your order shipped yesterday and should arrive on Friday.', decision: 'review', decisionReason: 'confidence',
        confidence: 0.86, status: 'pending', threadSnapshotAt: NOW, expiresAt: new Date(NOW.getTime() + 7 * 86_400_000), ...overrides,
      })
      .returning({ id: drafts.id }))
  return row!.id
}

async function setSetting(orgId: string, key: 'notifications.digest_email' | 'notifications.digest_email_hour', value: unknown): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(orgSettings).values({ orgId, key, value }).onConflictDoUpdate({ target: [orgSettings.orgId, orgSettings.key], set: { value } }))
}

async function readTokens(orgId: string) {
  return withOrg(app.db, orgId, (tx) => tx.select().from(draftActionTokens))
}

async function readLock(orgId: string, day = '2026-09-09') {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.dedupeKey, `digest_email:${orgId}:${day}`))))
  return row
}

describe('localHourAndDay', () => {
  it('converts to the workspace timezone', () => {
    expect(localHourAndDay(NOW, 'America/New_York')).toEqual({ hour: 8, day: '2026-09-09' })
    expect(localHourAndDay(NOW, 'UTC')).toEqual({ hour: 12, day: '2026-09-09' })
  })

  it('falls back to UTC for an invalid zone instead of throwing', () => {
    expect(localHourAndDay(NOW, 'Nowhere/Invalid')).toEqual({ hour: 12, day: '2026-09-09' })
  })

  it('reports the LOCAL day, not the UTC one', () => {
    // 02:00 UTC on the 10th is still 22:00 on the 9th in New York.
    expect(localHourAndDay(new Date('2026-09-10T02:00:00Z'), 'America/New_York')).toEqual({ hour: 22, day: '2026-09-09' })
  })
})

describe('runDigestEmailForOrg', () => {
  it('emails every owner and admin (never a plain member) with one action token per recipient per draft', async () => {
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const admin = await addMember(orgId, 'admin')
    const plain = await addMember(orgId, 'member')
    const connectionId = await seedConnection(orgId, owner.userId)
    const [catId] = await withOrg(app.db, orgId, async (tx) => {
      const [c] = await tx.insert(categories).values({ orgId, key: `shipping-${rand()}`, label: 'Shipping' }).returning({ id: categories.id })
      return [c!.id]
    })
    const ticketA = await seedTicket(orgId, connectionId, { categoryId: catId })
    const ticketB = await seedTicket(orgId, connectionId, { subject: 'Refund please' })
    const draftA = await seedPendingDraft(orgId, ticketA)
    const draftB = await seedPendingDraft(orgId, ticketB)
    const escalated = await seedTicket(orgId, connectionId, { status: 'needs_owner', needsOwnerReason: 'tripwire', subject: 'Legal threat' })
    const mail = createDevSink()

    const result = await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)

    expect(result).toBe('sent')
    const sent = mail.all()
    expect(sent.map((m) => m.to).sort()).toEqual([admin.email, owner.email].sort())
    expect(sent.every((m) => m.subject === '2 drafts waiting for review · Acme Widgets')).toBe(true)
    expect(mail.latestTo(plain.email)).toBeUndefined()

    // 2 recipients × 2 drafts.
    const tokenRows = await readTokens(orgId)
    expect(tokenRows).toHaveLength(4)
    expect(new Set(tokenRows.map((r) => r.userId))).toEqual(new Set([owner.userId, admin.userId]))
    expect(new Set(tokenRows.map((r) => r.draftId))).toEqual(new Set([draftA, draftB]))
    expect(tokenRows[0]!.expiresAt.getTime()).toBe(NOW.getTime() + ACTION_TOKEN_TTL_DAYS * 86_400_000)
    expect(tokenRows.every((r) => r.consumedAt === null)).toBe(true)

    // Every raw token in the emails' URLs hashes to a stored row, and the URL shape is the review page's.
    const ownerMail = mail.latestTo(owner.email)!
    const urls = [...ownerMail.text.matchAll(/^Approve: (\S+)$/gm)].map((m) => m[1]!)
    expect(urls).toHaveLength(2)
    for (const url of urls) {
      const parsed = new URL(url)
      expect(parsed.origin).toBe(APP_BASE_URL)
      expect(parsed.pathname).toMatch(/^\/a\/[0-9a-f-]{36}$/)
      const raw = parsed.searchParams.get('t')!
      expect(raw).toHaveLength(43)
      const row = tokenRows.find((r) => r.tokenHash === hashToken('action', raw))
      expect(row).toBeDefined()
      expect(row!.userId).toBe(owner.userId)
      expect(parsed.pathname).toBe(`/a/${row!.draftId}`)
    }
    expect(ownerMail.text).toContain(`${APP_WEB_ORIGIN}/ticket/${ticketA}`)
    expect(ownerMail.text).toContain('Shipping · 86% confidence')
    // The needs_owner ticket rides along as an escalation item.
    expect(ownerMail.text).toContain('Legal threat · Bea Buyer · tripwire')
    expect(ownerMail.text).toContain(`${APP_WEB_ORIGIN}/ticket/${escalated}`)

    const lock = await readLock(orgId)
    expect(lock).toMatchObject({ kind: 'digest', title: 'Daily digest email', body: '', status: 'sent', payload: { channel: 'email' } })
    expect(lock!.sentAt?.getTime()).toBe(NOW.getTime())
  })

  it('folds the last 24 hours of auto-sent replies into one line — omitted at zero, singular at one', async () => {
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const connectionId = await seedConnection(orgId, owner.userId)
    const ticketId = await seedTicket(orgId, connectionId)
    await seedPendingDraft(orgId, ticketId)

    // Zero first: nothing auto-sent, no line at all.
    const quiet = createDevSink()
    expect(await runDigestEmailForOrg(makeDeps(quiet), orgId, NOW)).toBe('sent')
    expect(quiet.latestTo(owner.email)!.text).not.toContain('went out on')

    // One auto-send inside the window (and three rows that must NOT count: an auto-send 25 hours
    // old, a reply the owner approved, and an auto draft that never left `approved`).
    const second = await newOrgWithWorkspace()
    const owner2 = await addMember(second, 'owner')
    const conn2 = await seedConnection(second, owner2.userId)
    const t2 = await seedTicket(second, conn2)
    await seedPendingDraft(second, t2)
    const autoSent = (orgId2: string, ticket: string, over: Partial<typeof drafts.$inferInsert>) =>
      seedPendingDraft(orgId2, ticket, { status: 'sent', decisionSource: 'auto', autoDecidedAt: new Date(NOW.getTime() - 3_600_000), ...over })
    await autoSent(second, t2, {})
    await autoSent(second, t2, { autoDecidedAt: new Date(NOW.getTime() - 25 * 3_600_000) })
    await autoSent(second, t2, { decisionSource: 'app' })
    // `approved` is a LIVE status (one per ticket, by the partial unique), so it needs its own ticket.
    await autoSent(second, await seedTicket(second, conn2, { status: 'auto_sending' }), { status: 'approved' })

    const one = createDevSink()
    expect(await runDigestEmailForOrg(makeDeps(one), second, NOW)).toBe('sent')
    expect(one.latestTo(owner2.email)!.text).toContain('1 reply went out on its own in the last 24 hours.')

    // Three of them: the plural, and the draft headline untouched by any of it.
    const third = await newOrgWithWorkspace()
    const owner3 = await addMember(third, 'owner')
    const conn3 = await seedConnection(third, owner3.userId)
    const t3 = await seedTicket(third, conn3)
    await seedPendingDraft(third, t3)
    for (let i = 0; i < 3; i++) await autoSent(third, t3, {})

    const many = createDevSink()
    expect(await runDigestEmailForOrg(makeDeps(many), third, NOW)).toBe('sent')
    expect(many.latestTo(owner3.email)!.text).toContain('3 replies went out on their own in the last 24 hours.')
    // It is news, not a section: the subject still counts only what needs a decision.
    expect(many.latestTo(owner3.email)!.subject).toBe('1 draft waiting for review · Acme Widgets')
  })

  it("renders the DRAFT's own category label, falling back to the ticket's when the draft has none", async () => {
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const connectionId = await seedConnection(orgId, owner.userId)
    const [ticketCat, draftCat] = await withOrg(app.db, orgId, async (tx) => {
      const rows = await tx
        .insert(categories)
        .values([{ orgId, key: `tkt-${rand()}`, label: 'Ticket Category' }, { orgId, key: `drf-${rand()}`, label: 'Draft Category' }])
        .returning({ id: categories.id })
      return [rows[0]!.id, rows[1]!.id]
    })
    // Same ticket category on both tickets; only the first draft carries its own, differing category.
    const withOwn = await seedTicket(orgId, connectionId, { categoryId: ticketCat, subject: 'Model decided' })
    const withoutOwn = await seedTicket(orgId, connectionId, { categoryId: ticketCat, subject: 'Model undecided' })
    await seedPendingDraft(orgId, withOwn, { categoryId: draftCat })
    await seedPendingDraft(orgId, withoutOwn)
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('sent')

    const text = mail.latestTo(owner.email)!.text
    expect(text).toContain('Model decided · Bea Buyer · Draft Category ·')
    expect(text).toContain('Model undecided · Bea Buyer · Ticket Category ·')
  })

  it('mints a token only for the drafts it RENDERS, and still counts the rest in the overflow line', async () => {
    // final-A2 M-2: one `draft_action_tokens` row per PENDING draft per recipient per day, of which
    // only the first DIGEST_MAX_ITEMS are ever reachable — an org with a backlog and three admins
    // wrote thousands of dead rows a day.
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const connectionId = await seedConnection(orgId, owner.userId)
    const total = DIGEST_MAX_ITEMS + 3
    for (let i = 0; i < total; i++) {
      const ticketId = await seedTicket(orgId, connectionId, { subject: `Question ${i}` })
      await seedPendingDraft(orgId, ticketId)
    }
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('sent')

    expect(await readTokens(orgId)).toHaveLength(DIGEST_MAX_ITEMS)
    const text = mail.latestTo(owner.email)!.text
    expect([...text.matchAll(/^Approve: (\S+)$/gm)]).toHaveLength(DIGEST_MAX_ITEMS)
    // The headline and the overflow line still speak for the WHOLE backlog.
    expect(mail.latestTo(owner.email)!.subject).toBe(`${total} drafts waiting for review · Acme Widgets`)
    expect(text).toContain(`…and ${total - DIGEST_MAX_ITEMS} more`)
  })

  it('runs once per local day: a second run the same day sends nothing and mints no new tokens', async () => {
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const connectionId = await seedConnection(orgId, owner.userId)
    await seedPendingDraft(orgId, await seedTicket(orgId, connectionId))
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('sent')
    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('skipped')

    expect(mail.all()).toHaveLength(1)
    expect(await readTokens(orgId)).toHaveLength(1)
  })

  it('skips (and takes no lock) when the local hour is not the configured send hour', async () => {
    const orgId = await newOrgWithWorkspace()
    await addMember(orgId, 'owner')
    await setSetting(orgId, 'notifications.digest_email_hour', 9)
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('skipped')

    expect(mail.all()).toHaveLength(0)
    expect(await readLock(orgId)).toBeUndefined()
  })

  it('skips when notifications.digest_email is false', async () => {
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const connectionId = await seedConnection(orgId, owner.userId)
    await seedPendingDraft(orgId, await seedTicket(orgId, connectionId))
    await setSetting(orgId, 'notifications.digest_email', false)
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('skipped')

    expect(mail.all()).toHaveLength(0)
    expect(await readLock(orgId)).toBeUndefined()
  })

  it('nothing pending still counts as today’s run: the lock row is written and no email is sent', async () => {
    const orgId = await newOrgWithWorkspace()
    await addMember(orgId, 'owner')
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('skipped')

    expect(mail.all()).toHaveLength(0)
    expect(await readLock(orgId)).toBeDefined()
  })

  it('logs digest_email_failed and keeps the minted tokens when a send throws', async () => {
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const connectionId = await seedConnection(orgId, owner.userId)
    await seedPendingDraft(orgId, await seedTicket(orgId, connectionId))
    const lines: string[] = []
    const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) })
    const throwing = { ...createDevSink(), send: async () => { throw new Error('resend: rate_limited') } }

    const result = await runDigestEmailForOrg(
      { db: app.db, mail: throwing, appBaseUrl: APP_BASE_URL, appWebOrigin: APP_WEB_ORIGIN, logger, now: () => NOW },
      orgId,
      NOW,
    )

    expect(result).toBe('sent')
    expect(lines.some((l) => JSON.parse(l).msg === 'digest_email_failed')).toBe(true)
    expect(await readTokens(orgId)).toHaveLength(1)
  })

  it('sends an escalation-only digest (no pending drafts) without minting any tokens', async () => {
    const orgId = await newOrgWithWorkspace()
    const owner = await addMember(orgId, 'owner')
    const connectionId = await seedConnection(orgId, owner.userId)
    const escalated = await seedTicket(orgId, connectionId, { status: 'needs_owner', needsOwnerReason: 'tripwire', subject: 'Legal threat' })
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('sent')

    const sent = mail.latestTo(owner.email)
    expect(sent?.subject).toBe('1 ticket needs you')
    expect(sent?.text).toContain(`${APP_WEB_ORIGIN}/ticket/${escalated}`)
    expect(await readTokens(orgId)).toHaveLength(0)
  })

  it('skips an org with no workspace row at all', async () => {
    const orgId = await createTestOrganization(app)
    const mail = createDevSink()
    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('skipped')
    expect(mail.all()).toHaveLength(0)
  })

  it('skips when the org has drafts but no owner or admin to email', async () => {
    const orgId = await newOrgWithWorkspace()
    const plain = await addMember(orgId, 'member')
    const connectionId = await seedConnection(orgId, plain.userId)
    await seedPendingDraft(orgId, await seedTicket(orgId, connectionId))
    const mail = createDevSink()

    expect(await runDigestEmailForOrg(makeDeps(mail), orgId, NOW)).toBe('skipped')

    expect(mail.all()).toHaveLength(0)
    expect(await readTokens(orgId)).toHaveLength(0)
  })
})
