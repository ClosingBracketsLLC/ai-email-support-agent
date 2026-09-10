import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { agentRuns, agents, auditLog, orgSettings, SANDBOX_METERS, usageCounters } from '@aesa/db'
import type { EnqueueFn } from '../src/deps.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertConnectedMailbox, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

describe('agents router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  /** A fresh owner, a fresh workspace, and one active (primary-address) agent. */
  async function setupOrgWithActiveAgent(ownerEmail: string, mailboxEmail: string) {
    const signed = await signInWithOtp(t.app, t.mail, ownerEmail, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, mailboxEmail)
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: mailboxEmail, replyFromConnection: false })
    return { orgId, client: c, connectionId, agentId: added.agentId, userId: signed.user.id }
  }

  it('agents.list returns the seeded agent with its full shape', async () => {
    const { client: c, connectionId, agentId } = await setupOrgWithActiveAgent('owner-list@example.com', 'support@agentslist.test')
    const res = await c.agents.list.query()
    expect(res.agents).toEqual([
      expect.objectContaining({
        id: agentId, connectionId, address: 'support@agentslist.test', domain: 'agentslist.test',
        replyFromAddress: null, connectionEmailAddress: 'support@agentslist.test', displayName: 'support', signature: '', personaPreset: 'support',
        personaText: '', guidanceExtra: '', priority: 0, status: 'active', autoSendDelayMin: 2,
      }),
    ])
  })

  it("agents.list returns connectionEmailAddress — the connection's own address, not necessarily the agent's own (review fix, Important 1: the app needs this to make the reply-from choice actually settable)", async () => {
    const { client: c, connectionId, agentId } = await setupOrgWithActiveAgent('owner-replyfrom@example.com', 'support@replyfrom.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'alias@replyfrom.test', replyFromConnection: true })

    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === agentId)).toMatchObject({ address: 'support@replyfrom.test', connectionEmailAddress: 'support@replyfrom.test' })
    expect(res.agents.find((a) => a.id === added.agentId)).toMatchObject({
      address: 'alias@replyfrom.test', connectionEmailAddress: 'support@replyfrom.test', replyFromAddress: 'support@replyfrom.test',
    })
  })

  it('agents.update changes persona and priority, auditing the new values', async () => {
    const { client: c, orgId, agentId } = await setupOrgWithActiveAgent('owner-update@example.com', 'support@agentsupdate.test')
    await c.agents.update.mutate({ agentId, personaPreset: 'billing', priority: 5 })

    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === agentId)).toMatchObject({ personaPreset: 'billing', priority: 5 })

    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, agentId), eq(auditLog.action, 'agent.updated'))))
    expect(rows[0]?.detail).toMatchObject({ personaPreset: 'billing', priority: 5 })
  })

  it('agents.update logs only a length for freeform persona text, never the body', async () => {
    const { client: c, orgId, agentId } = await setupOrgWithActiveAgent('owner-updatetext@example.com', 'support@agentsupdatetext.test')
    const text = 'Be extra warm and reply in two short paragraphs, never more.'
    await c.agents.update.mutate({ agentId, personaText: text })

    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, agentId), eq(auditLog.action, 'agent.updated'))))
    expect(rows[0]?.detail).toMatchObject({ personaText: { length: text.length } })
    expect(JSON.stringify(rows[0]?.detail)).not.toContain(text)
  })

  it('agents.update on a cross-org agentId is NOT_FOUND', async () => {
    const orgA = await setupOrgWithActiveAgent('owner-crossa@example.com', 'support@crossa.test')
    const orgB = await setupOrgWithActiveAgent('owner-crossb@example.com', 'support@crossb.test')
    await expect(orgB.client.agents.update.mutate({ agentId: orgA.agentId, priority: 9 })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('a pending_verification agent cannot be set active', async () => {
    const { client: c, connectionId } = await setupOrgWithActiveAgent('owner-pending@example.com', 'support@pending.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'alias@pending.test', replyFromConnection: false })
    expect(added.status).toBe('pending_verification')
    await expect(c.agents.update.mutate({ agentId: added.agentId, status: 'active' })).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('the two-hop resurrection is blocked: a pending_verification agent cannot be set disabled either (review fix, Critical)', async () => {
    const { client: c, connectionId } = await setupOrgWithActiveAgent('owner-tworhop@example.com', 'support@tworhop.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'alias@tworhop.test', replyFromConnection: false })
    expect(added.status).toBe('pending_verification')

    // The first hop of the old exploit — disabling a still-pending agent — is refused outright now,
    // so there is no window left for the second hop (disabled → active) to ever run.
    await expect(c.agents.update.mutate({ agentId: added.agentId, status: 'disabled' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })

    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === added.agentId)?.status).toBe('pending_verification')
  })

  it('a disabled agent can be set active again (but never resurrects from pending_verification)', async () => {
    const { client: c, agentId } = await setupOrgWithActiveAgent('owner-reactivate@example.com', 'support@reactivate.test')
    await c.agents.update.mutate({ agentId, status: 'disabled' })
    await c.agents.update.mutate({ agentId, status: 'active' })
    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === agentId)?.status).toBe('active')
  })

  it('agents.categories returns the 8 seeded policies, read-only', async () => {
    const { client: c, agentId } = await setupOrgWithActiveAgent('owner-categories@example.com', 'support@categories.test')
    const res = await c.agents.categories.query({ agentId })
    expect(res.categories).toHaveLength(8)
    expect(res.categories.every((cat) => cat.mode === 'review')).toBe(true)
    expect(res.categories.map((cat) => cat.key)).toContain('order_status')
  })
})

describe('agents router — sandbox', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let sent: { name: string; data: Record<string, unknown>; entityId: string }[]
  let enqueueResult: string | null = 'job-1'

  beforeAll(async () => {
    sent = []
    const enqueue: EnqueueFn = async (name, data, opts) => {
      sent.push({ name, data, entityId: opts.entityId })
      return enqueueResult
    }
    t = await createTestApi({}, { enqueue })
    base = await listen(t.app)
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => { sent.length = 0; enqueueResult = 'job-1' })

  async function setupActiveAgent(ownerEmail: string, mailboxEmail: string) {
    const signed = await signInWithOtp(t.app, t.mail, ownerEmail, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, mailboxEmail)
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: mailboxEmail, replyFromConnection: false })
    return { orgId, c, agentId: added.agentId, cookie: signed.cookie }
  }

  it('sandboxStart inserts a running run, bumps sandbox_runs, enqueues agent.sandbox with entityId runId, and audits agent.sandbox_started', async () => {
    const org = await setupActiveAgent('sandbox1@example.com', 'support@sandbox1.test')
    const question = 'Do you ship to Canada?'
    const res = await org.c.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question })
    expect(res.runId).toMatch(/^[0-9a-f-]{36}$/)

    const [run] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.id, res.runId)))
    expect(run).toMatchObject({ kind: 'sandbox', agentId: org.agentId, provider: 'anthropic', model: 'claude-opus-5', status: 'running' })
    expect(run!.input).toMatchObject({ subject: 'Q', question })

    const [counter] = await t.api.withOrg(org.orgId, (tx) =>
      tx.select().from(usageCounters).where(and(eq(usageCounters.orgId, org.orgId), eq(usageCounters.meter, SANDBOX_METERS.runs))))
    expect(counter?.value).toBe(1)

    expect(sent).toEqual([{ name: 'agent.sandbox', data: { orgId: org.orgId, runId: res.runId }, entityId: res.runId }])

    const auditRows = await t.api.withOrg(org.orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'agent.sandbox_started')))
    expect(auditRows[0]).toMatchObject({ detail: { runId: res.runId, questionLen: question.length } })
  })

  it('the cap: at sandbox.daily_cap, sandboxStart is TOO_MANY_REQUESTS and writes no run and bumps nothing further', async () => {
    const org = await setupActiveAgent('sandbox2@example.com', 'support@sandbox2.test')
    const today = new Date().toISOString().slice(0, 10)
    await t.api.withOrg(org.orgId, (tx) => tx.insert(usageCounters).values({ orgId: org.orgId, day: today, meter: SANDBOX_METERS.runs, value: 100 }))

    await expect(org.c.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question: 'Anything?' }))
      .rejects.toMatchObject({ data: { code: 'TOO_MANY_REQUESTS' } })

    const runs = await t.api.withOrg(org.orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.agentId, org.agentId)))
    expect(runs).toHaveLength(0)
    const [counter] = await t.api.withOrg(org.orgId, (tx) =>
      tx.select().from(usageCounters).where(and(eq(usageCounters.orgId, org.orgId), eq(usageCounters.meter, SANDBOX_METERS.runs))))
    expect(counter?.value).toBe(100)
  })

  // The race the advisory lock exists to stop: two callers for the same org against a cap of 1.
  // Unlocked, both read `sandbox_runs = 0` before either writes and BOTH proceed — one run over cap
  // (a real-money guard, since each run is a model call). Serialized, the loser reads the winner's
  // committed bump and is refused. Two SEPARATE client instances (not two calls on one client, which
  // tRPC's batch link could coalesce into a single HTTP request) so the requests genuinely overlap —
  // same shape as apps/worker/test/drafting-caps.test.ts's cap-race proof.
  it('serializes two concurrent sandboxStart calls against a cap of 1: exactly one proceeds', async () => {
    const org = await setupActiveAgent('sandbox8@example.com', 'support@sandbox8.test')
    await t.api.withOrg(org.orgId, (tx) => tx.insert(orgSettings).values({ orgId: org.orgId, key: 'sandbox.daily_cap', value: 1 }))

    const second = client(base, org.cookie)
    // Warm the second client first: an unwarmed one could let the first call finish before the
    // second even begins — no race to observe.
    await second.workspace.get.query()

    const results = await Promise.allSettled([
      org.c.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question: 'First?' }),
      second.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question: 'Second?' }),
    ])

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ runId: string }> => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ data: { code: 'TOO_MANY_REQUESTS' } })

    const [counter] = await t.api.withOrg(org.orgId, (tx) =>
      tx.select().from(usageCounters).where(and(eq(usageCounters.orgId, org.orgId), eq(usageCounters.meter, SANDBOX_METERS.runs))))
    expect(counter?.value).toBe(1)

    const runs = await t.api.withOrg(org.orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.agentId, org.agentId)))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.id).toBe(fulfilled[0]!.value.runId)
  })

  it('an inactive agent is PRECONDITION_FAILED', async () => {
    const org = await setupActiveAgent('sandbox3@example.com', 'support@sandbox3.test')
    await t.api.withOrg(org.orgId, (tx) => tx.update(agents).set({ status: 'disabled' }).where(eq(agents.id, org.agentId)))

    await expect(org.c.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question: 'Anything?' }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('a null enqueue marks the run failed with enqueue_failed, visible through sandboxGet', async () => {
    const org = await setupActiveAgent('sandbox4@example.com', 'support@sandbox4.test')
    enqueueResult = null
    const res = await org.c.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question: 'Anything?' })

    const got = await org.c.agents.sandboxGet.query({ runId: res.runId })
    expect(got).toMatchObject({ status: 'failed', errorCode: 'enqueue_failed', output: null })
  })

  it('sandboxGet returns the seeded output, and a cross-org run is NOT_FOUND', async () => {
    const org = await setupActiveAgent('sandbox5@example.com', 'support@sandbox5.test')
    const other = await setupActiveAgent('sandbox6@example.com', 'support@sandbox6.test')
    const res = await org.c.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question: 'Anything?' })

    const output = {
      outcome: 'reply' as const, body: 'Yes we do.', normalizedBody: 'Yes we do.', guardrail: { ok: true, findings: [] },
      confidence: 0.9, decision: 'send' as const, decisionReason: 'ok' as const, reason: null, rationale: 'r', unresolvedQuestions: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1, costMicros: 5 },
    }
    await t.api.withOrg(org.orgId, (tx) => tx.update(agentRuns).set({ status: 'succeeded', output, finishedAt: new Date() }).where(eq(agentRuns.id, res.runId)))

    const got = await org.c.agents.sandboxGet.query({ runId: res.runId })
    expect(got).toMatchObject({ status: 'succeeded', errorCode: null, output })
    expect(got.startedAt).toBeInstanceOf(Date)
    expect(got.finishedAt).toBeInstanceOf(Date)

    await expect(other.c.agents.sandboxGet.query({ runId: res.runId })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('an unparsable stored output never 500s — sandboxGet reports output: null', async () => {
    const org = await setupActiveAgent('sandbox7@example.com', 'support@sandbox7.test')
    const res = await org.c.agents.sandboxStart.mutate({ agentId: org.agentId, subject: 'Q', question: 'Anything?' })
    await t.api.withOrg(org.orgId, (tx) =>
      tx.update(agentRuns).set({ status: 'succeeded', output: { garbage: true }, finishedAt: new Date() }).where(eq(agentRuns.id, res.runId)))

    const got = await org.c.agents.sandboxGet.query({ runId: res.runId })
    expect(got).toMatchObject({ status: 'succeeded', output: null })
  })
})
