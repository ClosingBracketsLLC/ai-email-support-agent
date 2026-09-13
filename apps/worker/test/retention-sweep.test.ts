/**
 * `retention.sweep` against real Postgres. Two things this file exists to prove, because the arms it
 * covers are IRREVERSIBLE: that a body is purged only once its OWN workspace's `retention_days` has
 * passed (org A at 180 and org B at 30 see different verdicts on the SAME ages), and that everything
 * the sweep is not aiming at — a subject, an attachment list, a `pending` draft, the other org —
 * comes through untouched. Styled after `sweeps-daily.test.ts`: seed the exact row shape one case
 * needs, run the pass, assert.
 */
import { randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog, drafts, llmCalls, mailboxConnections, messages, notifications, tickets, user, withOrg, withPlatform, workspaces } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import {
  AUDIT_RETENTION_DAYS, LLM_CALLS_RETENTION_DAYS, NOTIFICATION_RETENTION_DAYS, RETENTION_BATCH,
  runRetentionSweep, type RetentionSweepDeps,
} from '../src/jobs/retention-sweep.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-13T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000)

describe('retention.sweep', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let userId: string
  const connectionByOrg = new Map<string, string>()

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  function makeDeps(overrides: Partial<RetentionSweepDeps> = {}): RetentionSweepDeps {
    return { db: app.db, logger: pino({ level: 'silent' }), now: () => NOW, ...overrides }
  }

  async function newOrg(retentionDays: number): Promise<string> {
    const orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC', retentionDays }))
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id }))
    connectionByOrg.set(orgId, conn!.id)
    return orgId
  }

  async function seedTicket(orgId: string): Promise<string> {
    const connectionId = connectionByOrg.get(orgId)!
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'resolved' }).returning({ id: tickets.id }))
    return row!.id
  }

  async function seedMessage(orgId: string, ticketId: string, ageDays: number): Promise<string> {
    const connectionId = connectionByOrg.get(orgId)!
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(messages).values({
        orgId, ticketId, connectionId, providerMessageId: `m-${rand()}`, direction: 'inbound',
        subject: 'Where is my order?', bodyText: 'It has been three weeks.',
        attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', size: 1234 }],
        createdAt: daysAgo(ageDays),
      }).returning({ id: messages.id }))
    return row!.id
  }

  async function seedDraft(orgId: string, ticketId: string, status: string, ageDays: number): Promise<string> {
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(drafts).values({
        orgId, ticketId, body: 'Here is the answer.', finalBody: 'Here is the answer, edited.',
        rationale: 'Because the knowledge base says so.', decision: 'review', decisionReason: 'policy',
        status, threadSnapshotAt: daysAgo(ageDays), expiresAt: daysAgo(ageDays - 1), createdAt: daysAgo(ageDays),
      }).returning({ id: drafts.id }))
    return row!.id
  }

  const readMessage = (orgId: string, id: string) =>
    withOrg(app.db, orgId, async (tx) => (await tx.select().from(messages).where(eq(messages.id, id)))[0]!)
  const readDraft = (orgId: string, id: string) =>
    withOrg(app.db, orgId, async (tx) => (await tx.select().from(drafts).where(eq(drafts.id, id)))[0]!)

  async function armAudits(orgId: string, arm: string): Promise<{ count: number; detail: unknown }[]> {
    return withOrg(app.db, orgId, async (tx) => {
      const rows = await tx.select({ detail: auditLog.detail }).from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'retention.purged')))
      return rows
        .map((r) => r.detail as { arm?: string; count?: number })
        .filter((d) => d.arm === arm)
        .map((d) => ({ count: d.count ?? -1, detail: d }))
    })
  }

  it('purges message bodies past each workspace\'s OWN retention_days, leaves subjects, attachments and younger messages, and audits once per org per arm', async () => {
    const orgA = await newOrg(180)
    const orgB = await newOrg(30)
    const ticketA = await seedTicket(orgA)
    const ticketB = await seedTicket(orgB)
    const a200 = await seedMessage(orgA, ticketA, 200)
    const a100 = await seedMessage(orgA, ticketA, 100)
    const a10 = await seedMessage(orgA, ticketA, 10)
    const b200 = await seedMessage(orgB, ticketB, 200)
    const b100 = await seedMessage(orgB, ticketB, 100)
    const b10 = await seedMessage(orgB, ticketB, 10)
    const sentDraft = await seedDraft(orgA, ticketA, 'sent', 200)
    const rejectedDraft = await seedDraft(orgA, ticketA, 'rejected', 200)
    const pendingDraft = await seedDraft(orgA, ticketA, 'pending', 200)

    const result = await runRetentionSweep(makeDeps())

    // A (180 days): only the 200-day message is past retention.
    const purgedA = await readMessage(orgA, a200)
    expect(purgedA.bodyText).toBeNull()
    expect(purgedA.bodyPurgedAt).toEqual(NOW)
    expect(purgedA.subject).toBe('Where is my order?')
    expect(purgedA.attachments).toEqual([{ filename: 'receipt.pdf', mime: 'application/pdf', size: 1234 }])
    expect((await readMessage(orgA, a100)).bodyText).toBe('It has been three weeks.')
    expect((await readMessage(orgA, a10)).bodyText).toBe('It has been three weeks.')

    // B (30 days): both the 200- and the 100-day messages are past retention; the 10-day one is not.
    expect((await readMessage(orgB, b200)).bodyText).toBeNull()
    expect((await readMessage(orgB, b100)).bodyText).toBeNull()
    expect((await readMessage(orgB, b10)).bodyText).toBe('It has been three weeks.')

    // Terminal drafts lose their three text columns; a live one is untouched.
    for (const id of [sentDraft, rejectedDraft]) {
      const d = await readDraft(orgA, id)
      expect(d.body).toBe('')
      expect(d.finalBody).toBeNull()
      expect(d.rationale).toBeNull()
      expect(d.bodyPurgedAt).toEqual(NOW)
    }
    const pending = await readDraft(orgA, pendingDraft)
    expect(pending.body).toBe('Here is the answer.')
    expect(pending.finalBody).toBe('Here is the answer, edited.')
    expect(pending.rationale).toBe('Because the knowledge base says so.')
    expect(pending.bodyPurgedAt).toBeNull()

    // ONE audit row per org per arm, carrying that org's own count.
    expect(await armAudits(orgA, 'messages')).toEqual([{ count: 1, detail: { arm: 'messages', count: 1 } }])
    expect(await armAudits(orgB, 'messages')).toEqual([{ count: 2, detail: { arm: 'messages', count: 2 } }])
    expect(await armAudits(orgA, 'drafts')).toEqual([{ count: 2, detail: { arm: 'drafts', count: 2 } }])
    expect(await armAudits(orgB, 'drafts')).toEqual([])

    expect(result.messagesPurged).toBe(3)
    expect(result.draftsPurged).toBe(2)

    // A second run finds nothing left to do — the partial index predicate (`body_purged_at IS NULL`)
    // is what makes an already-purged row invisible to the work list — and writes no new audit row.
    const second = await runRetentionSweep(makeDeps())
    expect(second.messagesPurged).toBe(0)
    expect(second.draftsPurged).toBe(0)
    expect(await armAudits(orgA, 'messages')).toHaveLength(1)
    expect(await armAudits(orgA, 'drafts')).toHaveLength(1)
  })

  it('deletes llm_calls past 400 days, notifications past 90 and TENANT audit rows past 730, keeping everything younger', async () => {
    const orgId = await newOrg(180)

    const insertCall = async (ageDays: number): Promise<string> => {
      const [row] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(llmCalls).values({
          orgId, role: 'draft', provider: 'anthropic', model: 'claude', idempotencyKey: `idem-${rand()}`,
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1, costMicros: 1,
          latencyMs: 1, finish: 'stop', parseStrategy: 'native', createdAt: daysAgo(ageDays),
        }).returning({ id: llmCalls.id }))
      return row!.id
    }
    const insertNotification = async (ageDays: number): Promise<string> => {
      const [row] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(notifications).values({
          orgId, kind: 'escalation', title: 'Needs you', body: 'Have a look', dedupeKey: `dedupe-${rand()}`,
          createdAt: daysAgo(ageDays),
        }).returning({ id: notifications.id }))
      return row!.id
    }
    const insertAudit = async (ageDays: number): Promise<string> => {
      const [row] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(auditLog).values({
          orgId, actor: 'system:test', action: 'test.event', entityType: 'workspace', entityId: orgId,
          createdAt: daysAgo(ageDays),
        }).returning({ id: auditLog.id }))
      return String(row!.id)
    }

    const callOld = await insertCall(LLM_CALLS_RETENTION_DAYS + 1)
    const callYoung = await insertCall(LLM_CALLS_RETENTION_DAYS - 1)
    const noteOld = await insertNotification(NOTIFICATION_RETENTION_DAYS + 1)
    const noteYoung = await insertNotification(NOTIFICATION_RETENTION_DAYS - 1)
    const auditOld = await insertAudit(AUDIT_RETENTION_DAYS + 1)
    const auditYoung = await insertAudit(AUDIT_RETENTION_DAYS - 1)

    await runRetentionSweep(makeDeps())

    const exists = async (table: string, id: string): Promise<boolean> =>
      withPlatform(app.db, 'test:retention-verify', async (tx) => {
        const res = await tx.execute(sql`SELECT count(*)::int AS c FROM ${sql.identifier(table)} WHERE id = ${id}::text::${sql.raw(table === 'audit_log' ? 'bigint' : 'uuid')}`)
        return Number((res.rows[0] as { c: number }).c) === 1
      })

    expect(await exists('llm_calls', callOld)).toBe(false)
    expect(await exists('llm_calls', callYoung)).toBe(true)
    expect(await exists('notifications', noteOld)).toBe(false)
    expect(await exists('notifications', noteYoung)).toBe(true)
    expect(await exists('audit_log', auditOld)).toBe(false)
    expect(await exists('audit_log', auditYoung)).toBe(true)
  })

  it('purges more than one batch of messages in a single run', async () => {
    const orgId = await newOrg(30)
    const ticketId = await seedTicket(orgId)
    const connectionId = connectionByOrg.get(orgId)!
    const total = RETENTION_BATCH + 1_000

    await withOrg(app.db, orgId, (tx) => tx.execute(sql`
      INSERT INTO messages (org_id, ticket_id, connection_id, provider_message_id, direction, subject, body_text, created_at)
      SELECT ${orgId}::uuid, ${ticketId}::uuid, ${connectionId}::uuid, 'bulk-' || g::text, 'inbound', 'Subject', 'Body', ${daysAgo(200)}
      FROM generate_series(1, ${total}) g
    `))

    const result = await runRetentionSweep(makeDeps())

    expect(result.messagesPurged).toBe(total)
    const remaining = await withOrg(app.db, orgId, async (tx) => {
      const res = await tx.execute(sql`SELECT count(*)::int AS c FROM messages WHERE org_id = ${orgId} AND body_purged_at IS NULL`)
      return Number((res.rows[0] as { c: number }).c)
    })
    expect(remaining).toBe(0)
    expect(await armAudits(orgId, 'messages')).toEqual([{ count: total, detail: { arm: 'messages', count: total } }])
  })
})
