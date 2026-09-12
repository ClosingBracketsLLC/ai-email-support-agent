/**
 * The `llm` router over real HTTP: the thin code-to-`TRPCError` layer on top of `src/llm/service.ts`
 * (`llm-service.test.ts` drives the service itself). Three things this file is here for:
 *  - the permission boundary — reading the connection list is every teammate's job, adding or
 *    removing one is workspace management, so a member gets FORBIDDEN;
 *  - the soft codes landing on the right tRPC codes;
 *  - and the promise the whole feature rests on: what comes BACK over the wire never contains the
 *    key the owner pasted, nor a field named `apiKey` or `keyCiphertext`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LLM_MAX_CREDENTIALS, MANAGED_MODELS, presetModel } from '@aesa/contracts'
import { loadKekRing, type KekRing } from '@aesa/crypto'
import { llmCredentials, provisionOrgKeys } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertConnectedMailbox, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

const PASTED_KEY = 'sk-ant-api03-DO-NOT-ECHO-THIS-9zQ4'

describe('llm router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let seq = 0

  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  async function setupOrg() {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `llm-rtr-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    await t.api.withOrg(orgId, (tx) => provisionOrgKeys(tx, ring))
    const address = `support${n}@llm-rtr.test`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address, replyFromConnection: false })
    return { orgId, c, connectionId, agentId: added.agentId, userId: signed.user.id, cookie: signed.cookie, address, seq: n }
  }

  it('add → list: the connection comes back with its fingerprint and empty usage, and NOTHING on the wire carries the pasted key', async () => {
    const org = await setupOrg()

    const added = await org.c.llm.add.mutate({ provider: 'anthropic', label: 'Anthropic prod', apiKey: PASTED_KEY })
    expect(added.credentialId).toBeTruthy()

    const list = await org.c.llm.list.query()
    expect(list.credentials).toHaveLength(1)
    expect(list.credentials[0]).toMatchObject({
      id: added.credentialId, provider: 'anthropic', label: 'Anthropic prod', baseUrl: null,
      healthStatus: 'unknown', lastProbe: null, lastProbedAt: null, lastError: null, agentsUsing: 0,
      usage30d: { calls: 0, errors: 0, costMicros: 0, costUnknownCalls: 0, lastErrorCode: null },
    })
    expect(list.credentials[0]!.keyFingerprint).toMatch(/^[0-9a-f]{8}…[A-Za-z0-9]{4}$/)

    const json = JSON.stringify(list)
    expect(json).not.toContain(PASTED_KEY)
    expect(json).not.toContain('apiKey')
    expect(json).not.toContain('keyCiphertext')

    expect(await org.c.llm.probe.mutate({ credentialId: added.credentialId })).toEqual({ ok: true })
  })

  it('agentModel on a fresh agent is managed for both roles; setAgentModel puts it on the connection and back', async () => {
    const org = await setupOrg()
    const fresh = await org.c.llm.agentModel.query({ agentId: org.agentId })
    expect(fresh.draft).toMatchObject({ mode: 'managed', provider: 'anthropic', model: MANAGED_MODELS.draft, credentialId: null, tier: 'calibrated' })
    expect(fresh.triage).toMatchObject({ mode: 'managed', provider: 'anthropic', model: MANAGED_MODELS.triage, credentialId: null })

    const { credentialId } = await org.c.llm.add.mutate({ provider: 'openai', label: 'OpenAI', apiKey: 'sk-openai-router-ab12' })
    const saved = await org.c.llm.setAgentModel.mutate({
      agentId: org.agentId, mode: 'byok', credentialId, draftModel: null, triageModel: null, effort: 'medium', fallbackToManaged: true,
    })
    expect(saved).toEqual({ ok: true, generationBumped: true, demoted: 0 })

    const byok = await org.c.llm.agentModel.query({ agentId: org.agentId })
    expect(byok.draft).toMatchObject({
      mode: 'byok', provider: 'openai', model: presetModel('openai', 'draft'), credentialId,
      effort: 'medium', fallbackToManaged: true, modelGeneration: 1,
    })
    expect(byok.draft.credential).toMatchObject({ label: 'OpenAI', baseUrl: null, healthStatus: 'unknown' })
    expect(JSON.stringify(byok)).not.toContain('apiKey')

    // `agents.list` renders the same choice on the agent card, one resolveModelConfig per agent.
    const agentList = await org.c.agents.list.query()
    expect(agentList.agents.find((a) => a.id === org.agentId)!.model)
      .toEqual({ mode: 'byok', provider: 'openai', model: presetModel('openai', 'draft'), credentialLabel: 'OpenAI' })

    // ONE agent is on it — it owns two config rows (draft and triage), and counts once.
    expect((await org.c.llm.list.query()).credentials.find((c) => c.id === credentialId)!.agentsUsing).toBe(1)

    expect(await org.c.llm.remove.mutate({ credentialId })).toEqual({ ok: true, agentsReset: 1 })
    const backToManaged = await org.c.llm.agentModel.query({ agentId: org.agentId })
    expect(backToManaged.draft).toMatchObject({ mode: 'managed', provider: 'anthropic', credentialId: null, modelGeneration: 2 })
    expect((await org.c.agents.list.query()).agents.find((a) => a.id === org.agentId)!.model)
      .toEqual({ mode: 'managed', provider: 'anthropic', model: MANAGED_MODELS.draft, credentialLabel: null })
  })

  it('maps every soft code: cap_reached/keys_not_provisioned → PRECONDITION_FAILED, unsafe_url → BAD_REQUEST, unknown ids → NOT_FOUND, a dead key → PRECONDITION_FAILED', async () => {
    const org = await setupOrg()

    for (let i = 0; i < LLM_MAX_CREDENTIALS; i++) {
      await org.c.llm.add.mutate({ provider: 'openai', label: `key ${i}`, apiKey: `sk-openai-cap-${i}-ab12` })
    }
    await expect(org.c.llm.add.mutate({ provider: 'openai', label: 'one too many', apiKey: 'sk-openai-cap-6-ab12' }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })

    // A custom endpoint that resolves to a private address (the router hits real DNS; `.invalid` is
    // reserved by RFC 2606 and never resolves, so the guard refuses it before anything is written).
    await expect(org.c.llm.add.mutate({
      provider: 'custom', label: 'internal', apiKey: 'k'.repeat(24), baseUrl: 'https://vllm.internal.invalid/v1', probeModel: 'qwen3-32b',
    })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })

    await expect(org.c.llm.probe.mutate({ credentialId: randomUUID() })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(org.c.llm.remove.mutate({ credentialId: randomUUID() })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(org.c.llm.agentModel.query({ agentId: randomUUID() })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })

    const base3 = { agentId: org.agentId, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false } as const
    await expect(org.c.llm.setAgentModel.mutate({ ...base3, agentId: randomUUID(), mode: 'byok', credentialId: randomUUID() }))
      .rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(org.c.llm.setAgentModel.mutate({ ...base3, mode: 'byok', credentialId: randomUUID() }))
      .rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })

    const [live] = await t.api.withOrg(org.orgId, (tx) => tx.select({ id: llmCredentials.id }).from(llmCredentials).limit(1))
    await t.api.withOrg(org.orgId, (tx) => tx.update(llmCredentials).set({ healthStatus: 'dead' })
      .where(and(eq(llmCredentials.orgId, org.orgId), eq(llmCredentials.id, live!.id))))
    await expect(org.c.llm.setAgentModel.mutate({ ...base3, mode: 'byok', credentialId: live!.id }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })

    // An org whose keys were never provisioned cannot seal anything yet.
    const signed = await signInWithOtp(t.app, t.mail, `llm-nokeys-${org.seq}@example.com`, 'Owner')
    const bare = client(base, signed.cookie)
    await bare.workspace.create.mutate({ businessName: 'Bare', timezone: 'UTC' })
    await expect(bare.llm.add.mutate({ provider: 'openai', label: 'too early', apiKey: 'sk-openai-early-ab12' }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('members can read the connections; only managers can add, probe, remove or change a model', async () => {
    const org = await setupOrg()
    const { credentialId } = await org.c.llm.add.mutate({ provider: 'groq', label: 'Groq', apiKey: 'gsk_member_ab12' })

    const memberEmail = `llm-member-${org.seq}@example.com`
    const memberSignIn = await signInWithOtp(t.app, t.mail, memberEmail, 'Bob')
    const { invitationId } = await org.c.team.invite.mutate({ email: memberEmail, role: 'member' })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/accept-invitation',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { invitationId },
    })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/set-active',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { organizationId: org.orgId },
    })
    const asMember = client(base, memberSignIn.cookie)

    expect((await asMember.llm.list.query()).credentials).toHaveLength(1)
    expect((await asMember.llm.agentModel.query({ agentId: org.agentId })).draft.mode).toBe('managed')

    for (const call of [
      asMember.llm.add.mutate({ provider: 'openai', label: 'nope', apiKey: 'sk-openai-member-ab12' }),
      asMember.llm.probe.mutate({ credentialId }),
      asMember.llm.remove.mutate({ credentialId }),
      asMember.llm.setAgentModel.mutate({ agentId: org.agentId, mode: 'managed', credentialId: null, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false }),
    ]) {
      await expect(call).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
    }
    expect((await org.c.llm.list.query()).credentials).toHaveLength(1)
  })
})
