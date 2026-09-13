/**
 * `workspace.export` against real Postgres and an in-memory object store. The bundle is the one
 * artefact of this system that leaves it in bulk, so the assertions are in two halves: everything
 * the owner is owed is IN it (a row from every table it lists, with the message bodies and the
 * learned answers spelled out), and nothing the platform holds on their behalf is — the whole
 * produced bundle is grepped for every ciphertext/salt column name in the schema AND for the actual
 * secret bytes seeded beside them. Column allowlists are built by NAMING what goes in, so a column
 * added to a table later cannot leak by default; this test is what fails if that ever inverts.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentCategoryPolicies, agentModelConfig, agents, auditLog, billingSubscriptions, categories,
  categoryStatsDaily, drafts, guidanceSuggestions, knowledgeSources, llmCredentials, llmCredentialSecrets,
  mailboxConnections, mailboxCredentials, messages, notifications, oauthFlows, orgSettings, provisionOrgKeys,
  resolvedAnswers, tickets, usageCounters, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { loadKekRing } from '@aesa/crypto'
import { createMemoryStore } from '@aesa/knowledge'
import {
  EXPORT_MAX_BYTES, EXPORT_TABLE_NAMES, exportObjectKey, runWorkspaceExport, type WorkspaceExportDeps,
} from '../src/jobs/workspace-export.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-13T12:00:00Z')
const ring = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

/** Column names that must never appear as a key anywhere in a bundle, in BOTH spellings — the
 *  drizzle rows are camelCased, the schema is snake_cased, and a future change of shape must not
 *  quietly make this grep vacuous. */
const FORBIDDEN_KEYS = [
  'key_ciphertext', 'keyCiphertext',
  'refresh_token_ciphertext', 'refreshTokenCiphertext',
  'access_token_ciphertext', 'accessTokenCiphertext',
  'wrapped_dek', 'wrappedDek',
  'box_private_key_ciphertext', 'boxPrivateKeyCiphertext',
  'box_public_key', 'boxPublicKey',
  'customer_hash_salt', 'customerHashSalt',
  'pkce_ciphertext', 'pkceCiphertext',
  'verification_code_hash', 'verificationCodeHash',
  'source_customer_hash', 'sourceCustomerHash',
  'storage_key', 'storageKey',
  'consent_required_from_user_id', 'consentRequiredFromUserId',
]

const MAILBOX_SECRET_BYTES = 'SUPERSECRETREFRESHTOKEN'
const PROVIDER_SECRET_BYTES = 'SUPERSECRETPROVIDERKEY'

interface Line { kind: string; row?: Record<string, unknown>; orgId?: string; exportedAt?: string; tables?: string[] }

describe('workspace.export', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let userId: string
  const notified: { orgId: string; notificationId: string }[] = []

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

  function makeDeps(store: ReturnType<typeof createMemoryStore>, overrides: Partial<WorkspaceExportDeps> = {}): WorkspaceExportDeps {
    return {
      db: app.db, store, logger: pino({ level: 'silent' }), now: () => NOW,
      enqueueNotify: async (orgId, notificationId) => { notified.push({ orgId, notificationId }) },
      ...overrides,
    }
  }

  /** An org with one row in every table the bundle lists, plus the two platform-only secret tables
   *  and an `oauth_flows` row — none of which the bundle may ever reach. */
  async function seedOrg(exportId: string): Promise<{ orgId: string; email: string }> {
    const orgId = await createTestOrganization(app, 'Export Co')
    // `mailbox_connections_provider_email_uidx` is GLOBAL, not per-org: every seeded workspace in
    // this file needs its own address.
    const email = `support-${rand()}@export.test`
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({
      orgId, businessName: 'Export Co', timezone: 'UTC', websiteUrl: 'https://export.test',
      operatingGuidance: 'Always mention the 30-day return window.', retentionDays: 180,
      exportState: 'queued', exportKey: exportObjectKey(orgId, exportId), exportRequestedAt: NOW,
    }))
    await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))

    const { connectionId, credentialId } = await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(billingSubscriptions).values({ orgId, plan: 'standard', status: 'active', stripeCustomerId: `cus_${rand()}` })
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: email,
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      const [agent] = await tx.insert(agents).values({
        orgId, connectionId: conn!.id, address: email, domain: 'export.test', displayName: 'Support',
        consentRequiredFromUserId: userId, verificationCodeHash: 'HASHEDCODE',
      }).returning({ id: agents.id })
      const [category] = await tx.insert(categories).values({ orgId, key: 'general', label: 'General' }).returning({ id: categories.id })
      await tx.insert(agentCategoryPolicies).values({ orgId, agentId: agent!.id, categoryId: category!.id, mode: 'review' })
      const [cred] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: 'Prod key', keyFingerprint: 'abcd1234…7890', createdBy: `user:${userId}`,
      }).returning({ id: llmCredentials.id })
      await tx.insert(agentModelConfig).values({ orgId, agentId: agent!.id, role: 'draft', mode: 'byok', credentialId: cred!.id })
      const [ticket] = await tx.insert(tickets).values({
        orgId, connectionId: conn!.id, agentId: agent!.id, providerThreadId: `thread-${rand()}`,
        customerEmail: 'buyer@example.com', subject: 'Where is my order?', status: 'resolved',
      }).returning({ id: tickets.id })
      await tx.insert(messages).values({
        orgId, ticketId: ticket!.id, connectionId: conn!.id, providerMessageId: `m-${rand()}`, direction: 'inbound',
        subject: 'Where is my order?', bodyText: 'It has been three weeks.',
        attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', size: 12 }],
      })
      const [decided] = await tx.insert(drafts).values({
        orgId, ticketId: ticket!.id, agentId: agent!.id, categoryId: category!.id, body: 'It shipped Monday.',
        finalBody: 'It shipped on Monday — tracking below.', decision: 'review', decisionReason: 'policy',
        status: 'sent', decidedAt: NOW, decidedBy: userId, decisionSource: 'app',
        threadSnapshotAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000),
      }).returning({ id: drafts.id })
      // An UNDECIDED draft: the bundle carries decided ones only.
      await tx.insert(drafts).values({
        orgId, ticketId: ticket!.id, agentId: agent!.id, categoryId: category!.id, body: 'UNDECIDED DRAFT BODY',
        decision: 'review', decisionReason: 'policy', status: 'pending',
        threadSnapshotAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
      await tx.insert(resolvedAnswers).values({
        orgId, agentId: agent!.id, categoryId: category!.id,
        questionText: 'When will my order ship?', answerBody: 'Orders ship within two business days.',
        sourceCustomerHash: 'HASHEDCUSTOMER', expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
      await tx.insert(guidanceSuggestions).values({
        orgId, agentId: agent!.id, categoryId: category!.id, sourceDraftId: decided!.id, text: 'Mention tracking links.',
      })
      await tx.insert(knowledgeSources).values({
        orgId, kind: 'paste', status: 'ready', title: 'Returns policy', pastedText: 'Returns within 30 days.',
        storageKey: 'orgs/secret/uploads/never.pdf',
      })
      await tx.insert(categoryStatsDaily).values({ orgId, agentId: agent!.id, categoryId: category!.id, day: '2026-09-01', drafted: 3 })
      await tx.insert(usageCounters).values({ orgId, day: '2026-09-01', meter: 'review_sends', value: 7 })
      await tx.insert(orgSettings).values({ orgId, key: 'knowledge.max_sources', value: 5 })
      await tx.insert(auditLog).values({ orgId, actor: `user:${userId}`, action: 'draft.approved', entityType: 'draft', entityId: decided!.id })
      await tx.insert(oauthFlows).values({
        orgId, userId, provider: 'gmail', nonceHash: `nonce-${rand()}`, pkceCiphertext: Buffer.from('PKCEBYTES'),
        platform: 'web', expiresAt: new Date(NOW.getTime() + 600_000),
      })
      return { connectionId: conn!.id, credentialId: cred!.id }
    })

    await withPlatform(app.db, 'test:seed-secrets', async (tx) => {
      await tx.insert(mailboxCredentials).values({
        connectionId, orgId, encryption: 'dek', refreshTokenCiphertext: Buffer.from(MAILBOX_SECRET_BYTES),
      })
      await tx.insert(llmCredentialSecrets).values({
        credentialId, orgId, encryption: 'dek', keyCiphertext: Buffer.from(PROVIDER_SECRET_BYTES),
      })
    })

    return { orgId, email }
  }

  const readWorkspace = (orgId: string) =>
    withOrg(app.db, orgId, async (tx) => (await tx.select().from(workspaces).where(eq(workspaces.orgId, orgId)))[0]!)
  const readNotifications = (orgId: string) =>
    withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, orgId)))

  it('writes an NDJSON bundle with a manifest, every listed table, and not one secret; lands ready and pages the owner', async () => {
    const store = createMemoryStore()
    const exportId = randomUUID()
    const { orgId, email } = await seedOrg(exportId)
    const key = exportObjectKey(orgId, exportId)

    const outcome = await runWorkspaceExport(makeDeps(store), { orgId, exportId }, AbortSignal.timeout(60_000))
    expect(outcome).toBe('ready')

    const object = store.objects.get(key)
    expect(object).toBeDefined()
    expect(object!.contentType).toBe('application/x-ndjson')
    const text = new TextDecoder().decode(object!.bytes)
    const lines: Line[] = text.trimEnd().split('\n').map((l) => JSON.parse(l) as Line)

    // The manifest is the first line and names the tables in the bundle's own order.
    expect(lines[0]).toEqual({ kind: 'manifest', orgId, exportedAt: NOW.toISOString(), tables: [...EXPORT_TABLE_NAMES] })

    // Every table the manifest lists actually produced at least one row.
    const byKind = new Map<string, Record<string, unknown>[]>()
    for (const line of lines.slice(1)) {
      expect(line.row).toBeDefined()
      const bucket = byKind.get(line.kind) ?? []
      bucket.push(line.row!)
      byKind.set(line.kind, bucket)
    }
    for (const name of EXPORT_TABLE_NAMES) {
      expect({ table: name, rows: byKind.get(name)?.length ?? 0 }).toEqual({ table: name, rows: expect.any(Number) })
      expect(byKind.get(name)?.length ?? 0).toBeGreaterThanOrEqual(1)
    }

    // The content the owner actually came for.
    expect(byKind.get('messages')![0]!.bodyText).toBe('It has been three weeks.')
    expect(byKind.get('messages')![0]!.subject).toBe('Where is my order?')
    expect(byKind.get('resolved_answers')![0]!.questionText).toBe('When will my order ship?')
    expect(byKind.get('resolved_answers')![0]!.answerBody).toBe('Orders ship within two business days.')
    expect(byKind.get('workspaces')![0]!.operatingGuidance).toBe('Always mention the 30-day return window.')
    expect(byKind.get('mailbox_connections')![0]).toEqual({ provider: 'gmail', emailAddress: email, status: 'connected' })

    // Only DECIDED drafts.
    expect(byKind.get('drafts')).toHaveLength(1)
    expect(byKind.get('drafts')![0]!.finalBody).toBe('It shipped on Monday — tracking below.')
    expect(text).not.toContain('UNDECIDED DRAFT BODY')

    // Nothing the platform holds on the owner's behalf: no ciphertext/salt COLUMN, in either
    // spelling, and none of the actual secret bytes seeded beside them.
    for (const forbidden of FORBIDDEN_KEYS) expect({ forbidden, present: text.includes(forbidden) }).toEqual({ forbidden, present: false })
    for (const secret of [MAILBOX_SECRET_BYTES, PROVIDER_SECRET_BYTES, 'PKCEBYTES', 'HASHEDCODE', 'HASHEDCUSTOMER']) {
      expect({ secret, present: text.includes(secret) }).toEqual({ secret, present: false })
    }
    // The two platform-only tables and oauth_flows are not in the bundle at all.
    for (const table of ['llm_credential_secrets', 'mailbox_credentials', 'oauth_flows', 'knowledge_chunks', 'llm_calls']) {
      expect({ table, present: byKind.has(table) }).toEqual({ table, present: false })
    }

    const ws = await readWorkspace(orgId)
    expect(ws.exportState).toBe('ready')
    expect(ws.exportKey).toBe(key)
    expect(ws.exportReadyAt).toEqual(NOW)

    const notes = await readNotifications(orgId)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'workspace', title: 'Your export is ready', dedupeKey: `workspace:export:${exportId}` })
    expect(notes[0]!.payload).toEqual({ kind: 'export_ready' })
    expect(notified.filter((n) => n.orgId === orgId).map((n) => n.notificationId)).toEqual([notes[0]!.id])

    // One audit row saying what left.
    const audits = await withOrg(app.db, orgId, (tx) =>
      tx.select({ detail: auditLog.detail }).from(auditLog).where(eq(auditLog.action, 'workspace.exported')))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ bytes: object!.bytes.byteLength })

    // A second run of the SAME export id no longer finds `queued` — it refuses rather than rebuilding.
    expect(await runWorkspaceExport(makeDeps(store), { orgId, exportId }, AbortSignal.timeout(60_000))).toBe('skipped')
  })

  it('refuses when the workspace row names a DIFFERENT export id than the payload', async () => {
    const store = createMemoryStore()
    const exportId = randomUUID()
    const { orgId } = await seedOrg(exportId)

    const outcome = await runWorkspaceExport(makeDeps(store), { orgId, exportId: randomUUID() }, AbortSignal.timeout(60_000))

    expect(outcome).toBe('skipped')
    expect(store.objects.size).toBe(0)
    expect((await readWorkspace(orgId)).exportState).toBe('queued')
  })

  it('fails a bundle past EXPORT_MAX_BYTES: no object left behind, export_state failed, the owner paged', async () => {
    const store = createMemoryStore()
    const exportId = randomUUID()
    const { orgId } = await seedOrg(exportId)
    const key = exportObjectKey(orgId, exportId)

    const ticketId = await withOrg(app.db, orgId, async (tx) =>
      (await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.orgId, orgId)))[0]!.id)
    const connectionId = await withOrg(app.db, orgId, async (tx) =>
      (await tx.select({ id: mailboxConnections.id }).from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId)))[0]!.id)
    // 80 × 3 MB comfortably clears the 200 MB ceiling.
    await withOrg(app.db, orgId, (tx) => tx.execute(sql`
      INSERT INTO messages (org_id, ticket_id, connection_id, provider_message_id, direction, subject, body_text)
      SELECT ${orgId}::uuid, ${ticketId}::uuid, ${connectionId}::uuid, 'big-' || g::text, 'inbound', 'Big', repeat('x', 3000000)
      FROM generate_series(1, 80) g
    `))

    const outcome = await runWorkspaceExport(makeDeps(store), { orgId, exportId }, AbortSignal.timeout(120_000))

    expect(outcome).toBe('failed')
    expect(store.objects.get(key)).toBeUndefined()
    const ws = await readWorkspace(orgId)
    expect(ws.exportState).toBe('failed')
    expect(ws.exportReadyAt).toBeNull()

    const notes = await readNotifications(orgId)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'workspace', dedupeKey: `workspace:export:${exportId}` })
    expect(notes[0]!.payload).toEqual({ kind: 'export_failed' })
    expect(EXPORT_MAX_BYTES).toBe(200 * 1024 * 1024)

    // It failed for the RIGHT reason — the size ceiling, not some other throw on the way.
    const audits = await withOrg(app.db, orgId, (tx) =>
      tx.select({ detail: auditLog.detail }).from(auditLog).where(eq(auditLog.action, 'workspace.export_failed')))
    expect(audits).toHaveLength(1)
    expect((audits[0]!.detail as { error: string }).error).toMatch(/exceeded 209715200 bytes/)
  }, 180_000)
})
