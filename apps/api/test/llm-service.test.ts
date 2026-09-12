/**
 * The llm service (`src/llm/service.ts`) driven directly — the ONE implementation the `llm` router
 * calls. Every case here is about what the transaction writes and what rides the job payload, so it
 * asserts on rows and on the recorded enqueues, not on HTTP (`llm-router.test.ts` does that).
 *
 * Two things this file exists to hold, beyond the plain behaviour:
 *  - the owner's pasted key NEVER lands in a row, an audit detail, or anywhere but the sealed blob
 *    on the `llm.probe` payload — the api has no privilege on `llm_credential_secrets` at all;
 *  - a custom endpoint's URL is validated and RESOLVED before the transaction opens (CLAUDE.md,
 *    Transactions: a `withOrg` transaction never spans network I/O), so a private resolution is a
 *    soft `unsafe_url` with nothing written.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq, inArray } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LLM_MAX_CREDENTIALS, presetModel, type SetAgentModelInput } from '@aesa/contracts'
import { loadKekRing, type KekRing, type Resolver } from '@aesa/crypto'
import {
  agentCategoryPolicies, agentModelConfig, auditLog, categories, llmCalls, llmCredentialSecrets, llmCredentials,
  notifications, openSealedForOrg, provisionOrgKeys, withPlatform,
} from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import type { ApiFacade, EnqueueFn } from '../src/deps.ts'
import {
  addCredential, getAgentModel, listCredentials, probeCredential, removeCredential, setAgentModel,
  type LlmActor, type LlmServiceDeps,
} from '../src/llm/service.ts'
import { createAppLogger } from '../src/logging.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertAgent, insertConnectedMailbox, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

interface Recorded { name: string; data: Record<string, unknown>; opts: { entityId: string; startAfter?: Date; debounceSeconds?: number } }

/** Every `custom` add goes through this seam, so no suite here ever touches real DNS. */
function recordingResolver(address: string): { resolver: Resolver; hosts: string[] } {
  const hosts: string[] = []
  return { resolver: async (hostname) => { hosts.push(hostname); return [{ address, family: 4 }] }, hosts }
}
const PUBLIC_IP = '93.184.216.34'
const PRIVATE_IP = '10.1.2.3'

/** A resolver that must never be called: a preset's base URL is the platform's own, not the owner's. */
const forbiddenResolver: Resolver = async (hostname) => { throw new Error(`resolver must not be called (${hostname})`) }

/**
 * The real facade, with one seam the interleaving case needs: the transaction is held OPEN (every row
 * lock it took still held, nothing committed) once the service's body finishes, until the test
 * releases it — the same shape `drafts-service.test.ts` uses.
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

describe('llm service', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let deps: LlmServiceDeps
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

  /** A fresh org with a connected mailbox and one agent (its 8 category policies seeded at `review`). */
  async function seedOrg(opts: { keys?: boolean } = {}) {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `llm-svc-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    // The api's `keys.provision` job never runs in these suites (enqueue is a recorder), so the org
    // box keypair `addCredential` seals to is provisioned here directly.
    if (opts.keys !== false) await t.api.withOrg(orgId, (tx) => provisionOrgKeys(tx, ring))
    const address = `support${n}@llm.test`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address, replyFromConnection: false })
    const actor: LlmActor = { userId: signed.user.id, actor: `user:${signed.user.id}`, ip: '127.0.0.1', userAgent: 'vitest' }
    return { orgId, c, connectionId, agentId: added.agentId, userId: signed.user.id, actor, address, seq: n }
  }

  const credentialsOf = (orgId: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.orgId, orgId)))
  const configOf = (orgId: string, agentId: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(agentModelConfig).where(and(eq(agentModelConfig.orgId, orgId), eq(agentModelConfig.agentId, agentId))))
  const policiesOf = (orgId: string, agentId: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(agentCategoryPolicies).where(and(eq(agentCategoryPolicies.orgId, orgId), eq(agentCategoryPolicies.agentId, agentId))))
  const auditsOf = (orgId: string, action: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action))))
  const notificationsOf = (orgId: string, kind: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.kind, kind))))
  /** `llm_credential_secrets` is platform-role-only (0020 REVOKEs aesa_app), so a read needs the platform role. */
  const secretsOf = (orgId: string) =>
    withPlatform(t.handle.db, 'test:read-llm-secrets', (tx) => tx.select().from(llmCredentialSecrets).where(eq(llmCredentialSecrets.orgId, orgId)))

  /** Puts `n` of the agent's categories on `auto` so a demotion has something to take away. */
  async function makeAuto(orgId: string, agentId: string, n: number): Promise<string[]> {
    const rows = await t.api.withOrg(orgId, (tx) =>
      tx.select({ id: categories.id }).from(categories).where(eq(categories.orgId, orgId)).limit(n))
    const ids = rows.map((r) => r.id)
    await t.api.withOrg(orgId, (tx) => tx.update(agentCategoryPolicies).set({ mode: 'auto' })
      .where(and(eq(agentCategoryPolicies.orgId, orgId), eq(agentCategoryPolicies.agentId, agentId), inArray(agentCategoryPolicies.categoryId, ids))))
    return ids
  }

  const byok = (agentId: string, credentialId: string, over: Partial<SetAgentModelInput> = {}): SetAgentModelInput => ({
    agentId, mode: 'byok', credentialId, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false, ...over,
  })

  // -------------------------------------------------------------------------

  it('addCredential (preset): resolves nothing, seals the key to the org box, inserts the row with the fingerprint and health unknown, audits WITHOUT the key, and enqueues llm.probe with the sealed payload and reason connect', async () => {
    const org = await seedOrg()
    const KEY = 'sk-ant-api03-NEVERLOGTHIS-cdEF'

    const res = await addCredential({ ...deps, resolver: forbiddenResolver }, org.orgId,
      { provider: 'anthropic', label: 'Anthropic prod', apiKey: KEY }, org.actor)
    expect(res).toMatchObject({ ok: true })
    if (!res.ok) throw new Error('unreachable')

    const [row] = await credentialsOf(org.orgId)
    expect(row).toMatchObject({
      id: res.credentialId, provider: 'anthropic', label: 'Anthropic prod',
      baseUrl: null, healthStatus: 'unknown', consecutiveFailures: 0, lastProbe: null, lastProbedAt: null,
      transport: 'direct', probeModel: presetModel('anthropic', 'draft'), createdBy: `user:${org.userId}`,
    })
    expect(row!.keyFingerprint).toMatch(/^[0-9a-f]{8}…[A-Za-z0-9]{4}$/)
    expect(row!.keyFingerprint.endsWith('cdEF')).toBe(true)
    expect(JSON.stringify(row)).not.toContain(KEY)

    // The ONE path the plaintext takes out of this process: sealed, on the job payload.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.name).toBe(JOB_NAMES.llmProbe)
    expect(sent[0]!.opts.entityId).toBe(res.credentialId)
    expect(sent[0]!.data).toMatchObject({ orgId: org.orgId, credentialId: res.credentialId, reason: 'connect' })
    const sealed = sent[0]!.data.sealed as string
    expect(typeof sealed).toBe('string')
    expect(Buffer.from(sealed, 'base64').toString('base64')).toBe(sealed)
    const opened = await t.api.withOrg(org.orgId, (tx) => openSealedForOrg(tx, ring, Buffer.from(sealed, 'base64')))
    expect(JSON.parse(opened.toString('utf8'))).toEqual({ apiKey: KEY })

    const audits = await auditsOf(org.orgId, 'llm.credential_added')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor: `user:${org.userId}`, entityType: 'llm_credential', entityId: res.credentialId })
    expect(audits[0]!.detail).toMatchObject({ provider: 'anthropic', label: 'Anthropic prod', fingerprint: row!.keyFingerprint, baseUrlHost: null })
    expect(audits[0]!.detail).not.toHaveProperty('apiKey')
    expect(JSON.stringify(audits[0]!.detail)).not.toContain(KEY)

    // The api NEVER writes the secret table — the worker's llm.probe does, from the sealed payload.
    expect(await secretsOf(org.orgId)).toEqual([])
  })

  it('addCredential (custom): validates the base URL and resolves it publicly BEFORE the transaction — a private resolution is unsafe_url and nothing is inserted', async () => {
    const org = await seedOrg()

    const priv = recordingResolver(PRIVATE_IP)
    const blocked = await addCredential({ ...deps, resolver: priv.resolver }, org.orgId,
      { provider: 'custom', label: 'internal vllm', apiKey: 'k'.repeat(24), baseUrl: 'https://vllm.internal.test/v1', probeModel: 'qwen3-32b' }, org.actor)
    expect(blocked).toEqual({ ok: false, code: 'unsafe_url' })
    expect(priv.hosts).toEqual(['vllm.internal.test'])
    expect(await credentialsOf(org.orgId)).toEqual([])
    expect(sent).toEqual([])
    expect(await auditsOf(org.orgId, 'llm.credential_added')).toEqual([])

    // Not https: refused by the same guard, before any resolution at all.
    const insecure = recordingResolver(PUBLIC_IP)
    expect(await addCredential({ ...deps, resolver: insecure.resolver }, org.orgId,
      { provider: 'custom', label: 'plain http', apiKey: 'k'.repeat(24), baseUrl: 'http://llm.example.com/v1', probeModel: 'qwen3-32b' }, org.actor))
      .toEqual({ ok: false, code: 'unsafe_url' })
    expect(insecure.hosts).toEqual([])

    const ok = recordingResolver(PUBLIC_IP)
    const added = await addCredential({ ...deps, resolver: ok.resolver }, org.orgId,
      { provider: 'custom', label: 'hosted vllm', apiKey: 'k'.repeat(20) + 'ab12', baseUrl: 'https://llm.example.com/v1/', probeModel: 'qwen3-32b' }, org.actor)
    expect(added).toMatchObject({ ok: true })
    expect(ok.hosts).toEqual(['llm.example.com'])
    const [row] = await credentialsOf(org.orgId)
    expect(row).toMatchObject({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', probeModel: 'qwen3-32b' })
    expect((await auditsOf(org.orgId, 'llm.credential_added'))[0]!.detail).toMatchObject({ baseUrlHost: 'llm.example.com' })
  })

  it('addCredential: the 6th credential is cap_reached; an org with no box key is keys_not_provisioned', async () => {
    const org = await seedOrg()
    for (let i = 0; i < LLM_MAX_CREDENTIALS; i++) {
      const res = await addCredential(deps, org.orgId, { provider: 'openai', label: `key ${i}`, apiKey: `sk-openai-${i}-abcd` }, org.actor)
      expect(res).toMatchObject({ ok: true })
    }
    expect(await addCredential(deps, org.orgId, { provider: 'openai', label: 'one too many', apiKey: 'sk-openai-6-abcd' }, org.actor))
      .toEqual({ ok: false, code: 'cap_reached' })
    expect(await credentialsOf(org.orgId)).toHaveLength(LLM_MAX_CREDENTIALS)

    const bare = await seedOrg({ keys: false })
    expect(await addCredential(deps, bare.orgId, { provider: 'openai', label: 'no keys yet', apiKey: 'sk-openai-x-abcd' }, bare.actor))
      .toEqual({ ok: false, code: 'keys_not_provisioned' })
    expect(await credentialsOf(bare.orgId)).toEqual([])
    expect(sent.filter((s) => s.name === JOB_NAMES.llmProbe)).toHaveLength(LLM_MAX_CREDENTIALS)
  })

  it('probeCredential enqueues llm.probe reason manual with NO sealed payload; a foreign id is not_found', async () => {
    const org = await seedOrg()
    const added = await addCredential(deps, org.orgId, { provider: 'groq', label: 'Groq', apiKey: 'gsk_test_abcd' }, org.actor)
    if (!added.ok) throw new Error('unreachable')
    sent.length = 0

    expect(await probeCredential(deps, org.orgId, added.credentialId, org.actor)).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.name).toBe(JOB_NAMES.llmProbe)
    expect(sent[0]!.data).toEqual({ orgId: org.orgId, credentialId: added.credentialId, reason: 'manual' })
    expect(sent[0]!.data.sealed).toBeUndefined()
    expect(await auditsOf(org.orgId, 'llm.credential_probed')).toHaveLength(1)

    const other = await seedOrg()
    const theirs = await addCredential(deps, other.orgId, { provider: 'groq', label: 'Theirs', apiKey: 'gsk_other_abcd' }, other.actor)
    if (!theirs.ok) throw new Error('unreachable')
    sent.length = 0
    expect(await probeCredential(deps, org.orgId, theirs.credentialId, org.actor)).toEqual({ ok: false, code: 'not_found' })
    expect(sent).toEqual([])
  })

  it('removeCredential: agents on it go back to managed (both roles), their generation bumps, every auto category demotes with reason model_changed (ONE notification each), the row and its secret are gone, agentsReset counts them', async () => {
    const org = await seedOrg()
    const added = await addCredential(deps, org.orgId, { provider: 'openai', label: 'OpenAI', apiKey: 'sk-openai-rm-abcd' }, org.actor)
    if (!added.ok) throw new Error('unreachable')
    const credentialId = added.credentialId
    await setAgentModel(deps, org.orgId, byok(org.agentId, credentialId, { effort: 'medium', fallbackToManaged: true }), org.actor)
    await makeAuto(org.orgId, org.agentId, 2)

    // The worker would have written this from the sealed payload; the point is that DELETING the
    // parent cascades it away, and that the api never touches the child table itself.
    await withPlatform(t.handle.db, 'test:seed-llm-secret', (tx) => tx.insert(llmCredentialSecrets)
      .values({ credentialId, orgId: org.orgId, keyCiphertext: Buffer.from('ciphertext'), encryption: 'sealed' }))
    expect(await secretsOf(org.orgId)).toHaveLength(1)
    sent.length = 0

    const res = await removeCredential(deps, org.orgId, credentialId, org.actor)
    expect(res).toEqual({ ok: true, agentsReset: 1 })

    const cfg = await configOf(org.orgId, org.agentId)
    expect(cfg).toHaveLength(2)
    for (const row of cfg) {
      // `effort` and `fallbackToManaged` go back to their managed defaults too, so this path leaves
      // the same shape as `setAgentModel`'s explicit managed branch rather than keeping the departed
      // provider's knobs (they were set to 'medium'/true above).
      expect(row).toMatchObject({
        mode: 'managed', credentialId: null, model: null, effort: null, fallbackToManaged: false, modelGeneration: 2,
      })
    }

    const policies = await policiesOf(org.orgId, org.agentId)
    expect(policies.filter((p) => p.mode === 'auto')).toEqual([])
    const demoted = policies.filter((p) => p.demotedReason === 'model_changed')
    expect(demoted).toHaveLength(2)

    const notifs = await notificationsOf(org.orgId, 'demotion')
    expect(notifs).toHaveLength(2)
    const dispatched = sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)
    expect(dispatched.map((s) => s.data.notificationId).sort()).toEqual(notifs.map((n) => n.id).sort())

    expect(await credentialsOf(org.orgId)).toEqual([])
    expect(await secretsOf(org.orgId)).toEqual([])
    expect(await auditsOf(org.orgId, 'llm.credential_removed')).toHaveLength(1)

    expect(await removeCredential(deps, org.orgId, credentialId, org.actor)).toEqual({ ok: false, code: 'not_found' })
  })

  it("setAgentModel byok: writes draft + triage rows (models default to the preset's), bumps generation ONLY when the draft (mode, credential, model) changed, demotes auto categories on that bump and not on an effort-only change; a dead credential is credential_dead", async () => {
    const org = await seedOrg()
    const added = await addCredential(deps, org.orgId, { provider: 'openai', label: 'OpenAI', apiKey: 'sk-openai-set-abcd' }, org.actor)
    if (!added.ok) throw new Error('unreachable')
    const credentialId = added.credentialId
    await makeAuto(org.orgId, org.agentId, 1)
    sent.length = 0

    const first = await setAgentModel(deps, org.orgId, byok(org.agentId, credentialId), org.actor)
    expect(first).toEqual({ ok: true, generationBumped: true, demoted: 1 })
    const afterFirst = await configOf(org.orgId, org.agentId)
    expect(afterFirst.find((r) => r.role === 'draft')).toMatchObject({
      mode: 'byok', credentialId, model: presetModel('openai', 'draft'), effort: null, fallbackToManaged: false, modelGeneration: 1,
    })
    expect(afterFirst.find((r) => r.role === 'triage')).toMatchObject({
      mode: 'byok', credentialId, model: presetModel('openai', 'triage'), modelGeneration: 1,
    })
    expect(sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)).toHaveLength(1)
    expect(await auditsOf(org.orgId, 'agent.model_changed')).toHaveLength(1)

    // Effort alone is not a model change: no generation bump, and no demotion.
    await makeAuto(org.orgId, org.agentId, 2)
    sent.length = 0
    const effortOnly = await setAgentModel(deps, org.orgId, byok(org.agentId, credentialId, { effort: 'high' }), org.actor)
    expect(effortOnly).toEqual({ ok: true, generationBumped: false, demoted: 0 })
    const afterEffort = await configOf(org.orgId, org.agentId)
    expect(afterEffort.find((r) => r.role === 'draft')).toMatchObject({ effort: 'high', modelGeneration: 1 })
    expect(afterEffort.find((r) => r.role === 'triage')).toMatchObject({ effort: 'high', modelGeneration: 1 })
    expect((await policiesOf(org.orgId, org.agentId)).filter((p) => p.mode === 'auto')).toHaveLength(2)
    expect(sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)).toEqual([])

    // A different draft model IS one.
    sent.length = 0
    const modelChange = await setAgentModel(deps, org.orgId, byok(org.agentId, credentialId, { effort: 'high', draftModel: 'gpt-5-mini' }), org.actor)
    expect(modelChange).toEqual({ ok: true, generationBumped: true, demoted: 2 })
    const afterModel = await configOf(org.orgId, org.agentId)
    expect(afterModel.find((r) => r.role === 'draft')).toMatchObject({ model: 'gpt-5-mini', modelGeneration: 2 })
    expect(afterModel.find((r) => r.role === 'triage')).toMatchObject({ modelGeneration: 2 })
    expect((await policiesOf(org.orgId, org.agentId)).filter((p) => p.mode === 'auto')).toEqual([])

    // A credential the last probe found dead cannot be chosen at all.
    await t.api.withOrg(org.orgId, (tx) => tx.update(llmCredentials).set({ healthStatus: 'dead' }).where(eq(llmCredentials.id, credentialId)))
    expect(await setAgentModel(deps, org.orgId, byok(org.agentId, credentialId, { draftModel: 'gpt-5' }), org.actor))
      .toEqual({ ok: false, code: 'credential_dead' })
    expect(await setAgentModel(deps, org.orgId, byok(org.agentId, randomUUID()), org.actor))
      .toEqual({ ok: false, code: 'credential_not_found' })
    expect(await setAgentModel(deps, org.orgId, byok(randomUUID(), credentialId), org.actor))
      .toEqual({ ok: false, code: 'not_found' })
  })

  it('setAgentModel managed after byok: rows go managed with null model/credential, generation bumps, demotion runs', async () => {
    const org = await seedOrg()
    const added = await addCredential(deps, org.orgId, { provider: 'deepseek', label: 'DeepSeek', apiKey: 'sk-deepseek-abcd' }, org.actor)
    if (!added.ok) throw new Error('unreachable')
    await setAgentModel(deps, org.orgId, byok(org.agentId, added.credentialId), org.actor)
    await makeAuto(org.orgId, org.agentId, 3)
    sent.length = 0

    const res = await setAgentModel(deps, org.orgId, {
      agentId: org.agentId, mode: 'managed', credentialId: null, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false,
    }, org.actor)
    expect(res).toEqual({ ok: true, generationBumped: true, demoted: 3 })

    for (const row of await configOf(org.orgId, org.agentId)) {
      expect(row).toMatchObject({ mode: 'managed', credentialId: null, model: null, modelGeneration: 2 })
    }
    expect((await policiesOf(org.orgId, org.agentId)).filter((p) => p.mode === 'auto')).toEqual([])
    expect(sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)).toHaveLength(3)

    // And what the Model card reads back.
    const model = await getAgentModel(deps, org.orgId, org.agentId)
    expect(model!.draft).toMatchObject({ mode: 'managed', provider: 'anthropic', credentialId: null, tier: 'calibrated' })
    expect(model!.triage).toMatchObject({ mode: 'managed', provider: 'anthropic', credentialId: null })
    expect(await getAgentModel(deps, org.orgId, randomUUID())).toBeNull()
  })

  it('listCredentials: 30-day usage is summed from llm_calls by credential_id (calls, errors, cost, cost_unknown count, last error code) and agentsUsing counts DISTINCT agents', async () => {
    const org = await seedOrg()
    const a = await addCredential(deps, org.orgId, { provider: 'openai', label: 'Busy', apiKey: 'sk-openai-busy-abcd' }, org.actor)
    const b = await addCredential(deps, org.orgId, { provider: 'groq', label: 'Idle', apiKey: 'gsk_idle_abcd' }, org.actor)
    if (!a.ok || !b.ok) throw new Error('unreachable')
    await setAgentModel(deps, org.orgId, byok(org.agentId, a.credentialId), org.actor)

    const now = Date.now()
    const call = (over: Partial<typeof llmCalls.$inferInsert>): typeof llmCalls.$inferInsert => ({
      orgId: org.orgId, role: 'draft', provider: 'openai', model: 'gpt-5', idempotencyKey: randomUUID(),
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1,
      costMicros: 1_000, latencyMs: 500, finish: 'stop', parseStrategy: 'native', mode: 'byok', ...over,
    })
    await t.api.withOrg(org.orgId, (tx) => tx.insert(llmCalls).values([
      call({ credentialId: a.credentialId, costMicros: 1_500, createdAt: new Date(now - 2 * 86_400_000) }),
      call({ credentialId: a.credentialId, costMicros: 2_500, costUnknown: true, createdAt: new Date(now - 86_400_000) }),
      call({ credentialId: a.credentialId, costMicros: 0, errorCode: 'rate_limited', createdAt: new Date(now - 3_600_000) }),
      call({ credentialId: a.credentialId, costMicros: 0, errorCode: 'auth_failed', createdAt: new Date(now - 60_000) }),
      // Outside the window, and an un-credentialed (managed) call: neither counts.
      call({ credentialId: a.credentialId, costMicros: 9_999_999, errorCode: 'ancient', createdAt: new Date(now - 40 * 86_400_000) }),
      call({ credentialId: null, mode: 'managed', provider: 'anthropic', model: 'claude-opus-5', costMicros: 7_777 }),
    ]))

    const { credentials } = await listCredentials(deps, org.orgId)
    expect(credentials).toHaveLength(2)
    const busy = credentials.find((c) => c.id === a.credentialId)!
    expect(busy).toMatchObject({
      provider: 'openai', label: 'Busy', baseUrl: null, healthStatus: 'unknown', lastProbe: null, lastProbedAt: null, lastError: null,
      agentsUsing: 1,
    })
    // The unit is AGENTS, not config rows: this one agent owns two (draft and triage).
    expect(await configOf(org.orgId, org.agentId)).toHaveLength(2)
    expect(busy.keyFingerprint).toMatch(/^[0-9a-f]{8}…/)
    expect(busy.usage30d).toEqual({ calls: 4, errors: 2, costMicros: 4_000, costUnknownCalls: 1, lastErrorCode: 'auth_failed' })

    const idle = credentials.find((c) => c.id === b.credentialId)!
    expect(idle).toMatchObject({ provider: 'groq', label: 'Idle', agentsUsing: 0 })
    expect(idle.usage30d).toEqual({ calls: 0, errors: 0, costMicros: 0, costUnknownCalls: 0, lastErrorCode: null })

    // A SECOND agent on the same connection moves it to 2 — four config rows, two agents.
    const second = await insertAgent(t.api, org.orgId, org.connectionId, `alias-${org.seq}@llm.test`)
    await setAgentModel(deps, org.orgId, byok(second, a.credentialId), org.actor)
    const after = await listCredentials(deps, org.orgId)
    expect(after.credentials.find((c) => c.id === a.credentialId)!.agentsUsing).toBe(2)

    // Nothing key-shaped ever leaves the service.
    const json = JSON.stringify(credentials)
    expect(json).not.toContain('apiKey')
    expect(json).not.toContain('keyCiphertext')
    expect(json).not.toContain('sk-openai-busy-abcd')
  })

  /**
   * The one interleaving that matters here: an owner moving an agent onto a connection while another
   * manager disconnects it. `removeCredential` FOR UPDATEs the credential row and `setAgentModel`
   * FOR SHAREs it, so the second waits; when the disconnect wins, the move finds nothing rather than
   * stranding an agent on `byok` with a null credential, no generation bump and no demotion.
   */
  it('removeCredential and a concurrent setAgentModel onto the same credential serialize: the move loses cleanly with credential_not_found', async () => {
    const org = await seedOrg()
    const added = await addCredential(deps, org.orgId, { provider: 'openai', label: 'Contested', apiKey: 'sk-openai-race-ab12' }, org.actor)
    if (!added.ok) throw new Error('unreachable')

    let release = (): void => {}
    let reached = (): void => {}
    const gate = {
      reached: () => reached(),
      release: new Promise<void>((r) => { release = () => r() }),
      arrived: new Promise<void>((r) => { reached = () => r() }),
    }

    const removing = removeCredential({ ...deps, api: pausingApi(t.api, gate) }, org.orgId, added.credentialId, org.actor)
    await gate.arrived

    const moving = setAgentModel(deps, org.orgId, byok(org.agentId, added.credentialId), org.actor)
    await delay(150)          // let the move reach the FOR SHARE that must block on the disconnect
    release()

    const [removed, moved] = await Promise.all([removing, moving])
    expect(removed).toEqual({ ok: true, agentsReset: 0 })
    expect(moved).toEqual({ ok: false, code: 'credential_not_found' })
    expect(await configOf(org.orgId, org.agentId)).toEqual([])
    expect(await credentialsOf(org.orgId)).toEqual([])
  })

  /**
   * The other half of that race, and what the guarded write is for: `resetAgentsToManaged` reads its
   * agent list UNLOCKED, so an agent can be moved onto a DIFFERENT connection between that read and
   * the update. The update is guarded on `credential_id`, so it matches zero rows for that agent —
   * and the audit row, the demotion and the `agentsReset` count must all sit behind that outcome
   * rather than fire on an agent nothing actually changed about.
   */
  it('removeCredential skips an agent a concurrent setAgentModel moved to another connection: not counted, not audited, not demoted', async () => {
    const org = await seedOrg()
    const leaving = await addCredential(deps, org.orgId, { provider: 'openai', label: 'Leaving', apiKey: 'sk-openai-leave-ab12' }, org.actor)
    const staying = await addCredential(deps, org.orgId, { provider: 'groq', label: 'Staying', apiKey: 'gsk_stay_ab12' }, org.actor)
    if (!leaving.ok || !staying.ok) throw new Error('unreachable')

    // Two agents, both on the connection about to be removed. Only the first has Autopilot on, so a
    // demotion for the second would have to come from the agent list alone — which is the bug.
    const mover = await insertAgent(t.api, org.orgId, org.connectionId, `mover-${org.seq}@llm.test`)
    await setAgentModel(deps, org.orgId, byok(org.agentId, leaving.credentialId), org.actor)
    await setAgentModel(deps, org.orgId, byok(mover, leaving.credentialId), org.actor)
    await makeAuto(org.orgId, org.agentId, 1)

    let release = (): void => {}
    let reached = (): void => {}
    const gate = {
      reached: () => reached(),
      release: new Promise<void>((r) => { release = () => r() }),
      arrived: new Promise<void>((r) => { reached = () => r() }),
    }

    // The move commits LAST, but its row locks are already held when the disconnect reads the list.
    const moving = setAgentModel({ ...deps, api: pausingApi(t.api, gate) }, org.orgId, byok(mover, staying.credentialId), org.actor)
    await gate.arrived

    const removing = removeCredential(deps, org.orgId, leaving.credentialId, org.actor)
    await delay(150)          // let the disconnect read the agent list and block on the mover's rows
    release()

    const [moved, removed] = await Promise.all([moving, removing])
    expect(moved).toMatchObject({ ok: true })
    // Only the agent whose rows actually flipped is counted.
    expect(removed).toEqual({ ok: true, agentsReset: 1 })

    // The mover is untouched by the disconnect: still byok, on the OTHER connection.
    for (const row of await configOf(org.orgId, mover)) {
      expect(row).toMatchObject({ mode: 'byok', credentialId: staying.credentialId })
    }
    for (const row of await configOf(org.orgId, org.agentId)) {
      expect(row).toMatchObject({ mode: 'managed', credentialId: null })
    }

    // ...and the disconnect wrote no `credential_removed` trail for it.
    const changes = await auditsOf(org.orgId, 'agent.model_changed')
    const byRemoval = changes.filter((a) => (a.detail as { reason?: string }).reason === 'credential_removed')
    expect(byRemoval.map((a) => a.entityId)).toEqual([org.agentId])
  })
})
