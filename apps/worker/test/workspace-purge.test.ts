/**
 * `workspace.purge` + `workspace.purge-sweep` against real Postgres and a real (test) pg-boss. This
 * is the most destructive job in the codebase, so the file is built around three questions: does it
 * refuse every org it should refuse (grace period not up, stamp cleared, already purged), does it
 * delete EVERYTHING for the one org it accepts — tenant rows, auth rows and the objects in the
 * bucket — and does a SECOND org sitting right beside it come through with every row intact.
 *
 * The `workspaces`-row-present fixture is the point of the end-to-end case: `workspaces.org_id`
 * references `organization.id` with NO ACTION, so `purgeAuthRows` before (or without) `purgeWorkspace`
 * raises 23503. `packages/db/test/purge.test.ts` exercises the two functions separately on orgs that
 * have no `workspaces` row, so this job — their first real caller — is where that ordering is proven.
 */
import { randomBytes } from 'node:crypto'
import { getTableName, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agents, auditLog, categories, drafts, knowledgeChunks, knowledgeDocuments, knowledgeSources,
  mailboxConnections, messages, notifications, orgSettings, PURGE_ORDER, purgeAuthRows, purgeWorkspace,
  tickets, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createMemoryStore } from '@aesa/knowledge'
import { JOB_NAMES } from '@aesa/queue'
import { runWorkspacePurge, runWorkspacePurgeSweep, type WorkspacePurgeDeps } from '../src/jobs/workspace-purge.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-13T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000)

describe('workspace.purge', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let userId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startTestBoss()
    await boss.createQueue(JOB_NAMES.workspacePurge)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    await deleteJobsForOrgs(JOB_NAMES.workspacePurge, createdOrgIds)
    await boss.stop({ graceful: false, wait: true })
    await app.pool.end()
    await t.drop()
  })

  function makeStore() {
    return createMemoryStore()
  }
  function makeDeps(store: ReturnType<typeof createMemoryStore>, overrides: Partial<WorkspacePurgeDeps> = {}): WorkspacePurgeDeps {
    return { db: app.db, store, logger: pino({ level: 'silent' }), now: () => NOW, ...overrides }
  }

  /** One tenant with rows across the FK spine, its two uploaded objects in the store, an export
   *  object, and its Better Auth organization/member/invitation/session rows. */
  async function seedWorkspace(
    store: ReturnType<typeof createMemoryStore>,
    label: string,
    deletionRequestedAt: Date | null,
  ): Promise<{ orgId: string; storageKeys: string[]; exportKey: string }> {
    const orgId = await createTestOrganization(app, `Purge ${label}`)
    createdOrgIds.push(orgId)
    const exportKey = `orgs/${orgId}/exports/${rand()}.ndjson`
    const storageKeys = [`orgs/${orgId}/uploads/one/a.pdf`, `orgs/${orgId}/uploads/two/b.pdf`]

    await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({
        orgId, businessName: `Biz ${label}`, timezone: 'UTC',
        deletionRequestedAt, deletionRequestedBy: deletionRequestedAt ? userId : null,
        exportState: 'ready', exportKey, exportReadyAt: deletionRequestedAt,
      })
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${label}-${rand()}`, emailAddress: `s-${label}-${rand()}@acme.test`,
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      const connectionId = conn!.id
      await tx.insert(agents).values({ orgId, connectionId, address: `a-${label}-${rand()}@acme.test`, domain: 'acme.test', displayName: 'A' })
      await tx.insert(categories).values({ orgId, key: 'general', label: 'General' })
      const [ticket] = await tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}` }).returning({ id: tickets.id })
      await tx.insert(messages).values({ orgId, ticketId: ticket!.id, connectionId, providerMessageId: `m-${rand()}`, direction: 'inbound', bodyText: 'hello' })
      await tx.insert(drafts).values({
        orgId, ticketId: ticket!.id, body: 'Hi', decision: 'review', decisionReason: 'r',
        threadSnapshotAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
      await tx.insert(orgSettings).values({ orgId, key: 'knowledge.max_sources', value: 5 })
      await tx.insert(notifications).values({ orgId, kind: 'escalation', title: 't', body: 'b', dedupeKey: `dk-${rand()}` })
      await tx.insert(auditLog).values({ orgId, actor: 'system:test', action: 'test.seed', entityType: 'test', entityId: 'seed' })
      for (const key of storageKeys) {
        const [src] = await tx.insert(knowledgeSources).values({ orgId, kind: 'upload', title: key, storageKey: key, mime: 'application/pdf' })
          .returning({ id: knowledgeSources.id })
        const [doc] = await tx.insert(knowledgeDocuments).values({ orgId, sourceId: src!.id, uri: `upload:${key}`, contentHash: 'h' })
          .returning({ id: knowledgeDocuments.id })
        await tx.insert(knowledgeChunks).values({ orgId, documentId: doc!.id, ordinal: 0, content: 'chunk', tokenCount: 1 })
      }
    })

    await app.pool.query(`INSERT INTO member (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgId, userId])
    await app.pool.query(
      `INSERT INTO invitation (organization_id, email, status, expires_at, inviter_id) VALUES ($1, $2, 'pending', now() + interval '1 day', $3)`,
      [orgId, `invitee-${label}-${rand()}@example.com`, userId],
    )
    await app.pool.query(
      `INSERT INTO session (expires_at, token, user_id, active_organization_id) VALUES (now() + interval '1 day', $1, $2, $3)`,
      [`tok-${label}-${rand()}`, userId, orgId],
    )

    for (const key of storageKeys) await store.put(key, new Uint8Array([1, 2, 3]), 'application/pdf')
    await store.put(exportKey, new Uint8Array([4]), 'application/x-ndjson')

    return { orgId, storageKeys, exportKey }
  }

  const countRows = async (table: string, orgId: string): Promise<number> =>
    withPlatform(app.db, 'test:purge-verify', async (tx) => {
      const res = await tx.execute(sql`SELECT count(*)::int AS c FROM ${sql.identifier(table)} WHERE org_id = ${orgId}`)
      return Number((res.rows[0] as { c: number }).c)
    })

  const countAuth = async (table: 'member' | 'invitation' | 'organization', orgId: string): Promise<number> => {
    const column = table === 'organization' ? 'id' : 'organization_id'
    const { rows } = await app.pool.query<{ c: string }>(`SELECT count(*)::int AS c FROM ${table} WHERE ${column} = $1`, [orgId])
    return Number(rows[0]!.c)
  }

  it('the sweep enqueues only the org whose 30-day grace period has actually elapsed', async () => {
    const store = makeStore()
    const a = await seedWorkspace(store, 'sweep-a', daysAgo(31))
    const b = await seedWorkspace(store, 'sweep-b', daysAgo(29))
    const c = await seedWorkspace(store, 'sweep-c', null)

    const { enqueued } = await runWorkspacePurgeSweep(boss, { db: app.db, logger: pino({ level: 'silent' }), now: () => NOW })

    expect(enqueued).toBe(1)
    const jobs = (await queryJobs(JOB_NAMES.workspacePurge)).filter((j) => createdOrgIds.includes((j.data as { orgId: string }).orgId))
    expect(jobs.map((j) => (j.data as { orgId: string }).orgId)).toEqual([a.orgId])
    expect(jobs.map((j) => (j.data as { orgId: string }).orgId)).not.toContain(b.orgId)
    expect(jobs.map((j) => (j.data as { orgId: string }).orgId)).not.toContain(c.orgId)
  })

  it('purges every tenant table, the auth rows and the bucket objects for the due org, and leaves a second org untouched', async () => {
    const store = makeStore()
    const a = await seedWorkspace(store, 'run-a', daysAgo(31))
    const b = await seedWorkspace(store, 'run-b', null)

    const allTables = [...PURGE_ORDER, workspaces].map((table) => getTableName(table))
    const beforeB: Record<string, number> = {}
    for (const name of allTables) beforeB[name] = await countRows(name, b.orgId)
    expect(beforeB['messages']).toBe(1)
    expect(beforeB['workspaces']).toBe(1)

    const outcome = await runWorkspacePurge(makeDeps(store), { orgId: a.orgId }, AbortSignal.timeout(30_000))
    expect(outcome).toBe('purged')

    for (const name of allTables) {
      expect({ table: name, count: await countRows(name, a.orgId) }).toEqual({ table: name, count: 0 })
      expect({ table: name, count: await countRows(name, b.orgId) }).toEqual({ table: name, count: beforeB[name] })
    }

    // The auth half — which only works because it runs AFTER purgeWorkspace deleted the workspaces
    // row that references organization.id (NO ACTION): the reverse order raises 23503.
    expect(await countAuth('organization', a.orgId)).toBe(0)
    expect(await countAuth('member', a.orgId)).toBe(0)
    expect(await countAuth('invitation', a.orgId)).toBe(0)
    expect(await countAuth('organization', b.orgId)).toBe(1)
    expect(await countAuth('member', b.orgId)).toBe(1)
    expect(await countAuth('invitation', b.orgId)).toBe(1)

    const sessions = await app.pool.query<{ active_organization_id: string | null; n: string }>(
      `SELECT active_organization_id, count(*)::int AS n FROM session WHERE user_id = $1 GROUP BY 1`, [userId])
    const byOrg = new Map(sessions.rows.map((r) => [r.active_organization_id, Number(r.n)]))
    expect(byOrg.get(a.orgId)).toBeUndefined()
    expect(byOrg.get(b.orgId)).toBe(1)
    expect(byOrg.get(null)).toBeGreaterThanOrEqual(1)

    // Both uploads AND the export object are gone from the store; B's are all still there.
    for (const key of [...a.storageKeys, a.exportKey]) expect(await store.head(key)).toBeNull()
    for (const key of [...b.storageKeys, b.exportKey]) expect(await store.head(key)).not.toBeNull()

    // The platform keeps the fact even though the tenant trail is gone by design.
    const platformAudit = await withPlatform(app.db, 'test:purge-audit', async (tx) => {
      const res = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit_log
        WHERE org_id IS NULL AND action = 'workspace.purged' AND entity_id = ${a.orgId}`)
      return Number(res.rows[0]!.n)
    })
    expect(platformAudit).toBe(1)

    // A second run has no workspaces row to read, so it refuses rather than re-deleting nothing.
    expect(await runWorkspacePurge(makeDeps(store), { orgId: a.orgId }, AbortSignal.timeout(30_000))).toBe('skipped')
  })

  it('refuses an org whose deletion stamp was cleared between the enqueue and the run, and deletes nothing', async () => {
    const store = makeStore()
    const a = await seedWorkspace(store, 'cancel-a', daysAgo(31))
    await withOrg(app.db, a.orgId, (tx) =>
      tx.update(workspaces).set({ deletionRequestedAt: null, deletionRequestedBy: null }).where(sql`${workspaces.orgId} = ${a.orgId}`))

    expect(await runWorkspacePurge(makeDeps(store), { orgId: a.orgId }, AbortSignal.timeout(30_000))).toBe('skipped')

    expect(await countRows('messages', a.orgId)).toBe(1)
    expect(await countRows('workspaces', a.orgId)).toBe(1)
    expect(await countAuth('organization', a.orgId)).toBe(1)
    for (const key of [...a.storageKeys, a.exportKey]) expect(await store.head(key)).not.toBeNull()
  })

  it('proves the ordering the job depends on: purgeAuthRows BEFORE purgeWorkspace raises 23503 on an org that has a workspaces row', async () => {
    const store = makeStore()
    const a = await seedWorkspace(store, 'order-a', daysAgo(31))

    await expect(
      withPlatform(app.db, 'test:purge-wrong-order', async (tx) => {
        await purgeAuthRows(tx, a.orgId)
        await purgeWorkspace(tx, a.orgId)
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } })

    // The failed transaction rolled back: the workspace is exactly as it was.
    expect(await countRows('workspaces', a.orgId)).toBe(1)
    expect(await countAuth('organization', a.orgId)).toBe(1)

    // And the job, which takes them the other way round, succeeds on the very same org.
    expect(await runWorkspacePurge(makeDeps(store), { orgId: a.orgId }, AbortSignal.timeout(30_000))).toBe('purged')
    expect(await countRows('workspaces', a.orgId)).toBe(0)
    expect(await countAuth('organization', a.orgId)).toBe(0)
  })

  it('refuses an org still inside its 30-day grace period, and deletes nothing', async () => {
    const store = makeStore()
    const b = await seedWorkspace(store, 'early-b', daysAgo(29))

    expect(await runWorkspacePurge(makeDeps(store), { orgId: b.orgId }, AbortSignal.timeout(30_000))).toBe('skipped')

    expect(await countRows('messages', b.orgId)).toBe(1)
    expect(await countRows('workspaces', b.orgId)).toBe(1)
    for (const key of [...b.storageKeys, b.exportKey]) expect(await store.head(key)).not.toBeNull()
  })
})
