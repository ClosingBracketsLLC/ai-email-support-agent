/**
 * `llm.probe` end to end against a real database and a fetch stub — the probe's own composition
 * (`createByokProvider({ raw: true })` → `probeProvider`) is the one under test, so the stub answers
 * the OpenAI wire shapes (`/models`, `/chat/completions`) and nothing is mocked above it.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProbeResultView } from '@aesa/contracts'
import { encrypt, loadKekRing, sealTo, type KekRing } from '@aesa/crypto'
import {
  auditLog, createMeterSink, getOrgBoxPublicKey, llmCalls, llmCredentials, llmCredentialSecrets, loadOrgDek,
  notifications, provisionOrgKeys, resolveModelConfig, agentModelConfig, agents, mailboxConnections, user, withOrg,
  withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createFakeProvider, noopMeterSink } from '@aesa/llm'
import { runLlmProbe, DEGRADED_AFTER_FAILURES, type LlmProbeDeps } from '../src/jobs/llm-probe.ts'
import { createWorkerLogger } from '../src/logging.ts'
import { createProviderResolver, secretAad, type ProviderResolver } from '../src/provider-resolver.ts'

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
const rand = () => randomBytes(4).toString('hex')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const completion = (content: string) => ({
  id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-5',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
})

interface StubOptions {
  /** Which structured rung the endpoint honours; every other rung answers 400. */
  structured?: 'native' | 'json_mode' | 'none'
  /** Non-2xx status (plus body) for the PLAIN chat step — what makes `ok: false`. */
  chatError?: { status: number; message: string }
}

/** Answers `/models` and `/chat/completions` in the OpenAI wire shape; records every URL it saw. */
function probeFetch(opts: StubOptions = {}): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    if (url.endsWith('/models')) return json({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }, { id: 'gpt-5-mini', object: 'model' }] })
    const body = init?.body == null ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>)
    const responseFormat = body.response_format as { type?: string } | undefined
    if (!responseFormat) {
      if (opts.chatError) return json({ error: { message: opts.chatError.message, type: 'invalid_request_error' } }, opts.chatError.status)
      return json(completion('OK'))
    }
    const rung = responseFormat.type === 'json_schema' ? 'native' : 'json_mode'
    if ((opts.structured ?? 'native') === rung) return json(completion('{"decision":{"answer":"yes","n":7}}'))
    return json({ error: { message: 'response_format is not supported' } }, 400)
  }) as unknown as typeof fetch
  return { fetchFn, urls }
}

describe('llm.probe', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  let boxPublicKey: Buffer
  let logger: ReturnType<typeof createWorkerLogger>
  let lines: string[]

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' })
      await provisionOrgKeys(tx, ring)
    })
    boxPublicKey = await withOrg(app.db, orgId, (tx) => getOrgBoxPublicKey(tx))
    lines = []
    logger = createWorkerLogger('info', { write: (s: string) => void lines.push(s) })
  }, 60_000)

  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  async function createCredential(over: Partial<typeof llmCredentials.$inferInsert> = {}): Promise<string> {
    return withOrg(app.db, orgId, async (tx) => {
      const [row] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: 'OpenAI key', keyFingerprint: 'abcd1234…7890',
        probeModel: 'gpt-5', createdBy: 'user:test', ...over,
      }).returning({ id: llmCredentials.id })
      return row!.id
    })
  }

  async function seedDekSecret(credentialId: string, apiKey = 'sk-dek-secret-1234'): Promise<void> {
    const { version, dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    await withPlatform(app.db, 'test:seed', (tx) =>
      tx.insert(llmCredentialSecrets).values({
        credentialId, orgId, encryption: 'dek', dataKeyVersion: version,
        keyCiphertext: encrypt(dek, Buffer.from(JSON.stringify({ apiKey }), 'utf8'), secretAad(orgId, credentialId)),
      }))
  }

  const sealedFor = async (apiKey: string) => (await sealTo(boxPublicKey, Buffer.from(JSON.stringify({ apiKey }), 'utf8'))).toString('base64')

  function makeDeps(over: Partial<LlmProbeDeps> = {}): { deps: LlmProbeDeps; invalidated: string[]; resolver: ProviderResolver } {
    const invalidated: string[] = []
    const real = createProviderResolver({
      db: app.db, ring, managed: createFakeProvider([{ text: 'managed' }], { kind: 'anthropic' }), sink: noopMeterSink, logger,
    })
    const resolver: ProviderResolver = {
      resolve: (o, a, r) => real.resolve(o, a, r),
      invalidate: (id) => { invalidated.push(id); real.invalidate(id) },
    }
    const deps: LlmProbeDeps = {
      db: app.db, ring, sink: createMeterSink(app.db), logger, enqueueNotify: async () => {}, resolver,
      fetchFn: probeFetch().fetchFn, ...over,
    }
    return { deps, invalidated, resolver }
  }

  const readCredential = async (credentialId: string) =>
    (await withOrg(app.db, orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId))))[0]

  const readSecret = async (credentialId: string) =>
    (await withPlatform(app.db, 'test:read', (tx) =>
      tx.select().from(llmCredentialSecrets).where(eq(llmCredentialSecrets.credentialId, credentialId))))[0]

  const auditsFor = async (credentialId: string) =>
    withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, credentialId)))

  it('connect: stores the sealed key, probes, lands healthy with last_probe + models, RE-WRAPS under the DEK, invalidates the cache, audits', async () => {
    const credentialId = await createCredential()
    const { deps, invalidated } = makeDeps()

    const health = await runLlmProbe(deps, { orgId, credentialId, sealed: await sealedFor('sk-connect-key-1234'), reason: 'connect' }, AbortSignal.timeout(30_000))

    expect(health).toBe('healthy')
    const cred = await readCredential(credentialId)
    expect(cred?.healthStatus).toBe('healthy')
    expect(cred?.consecutiveFailures).toBe(0)
    expect(cred?.lastError).toBeNull()
    expect(cred?.lastProbedAt).not.toBeNull()
    const probe = cred?.lastProbe as ProbeResultView
    expect(probe).toMatchObject({ ok: true, chat: 'ok', structured: 'native' })
    expect(probe.models).toEqual(['gpt-5', 'gpt-5-mini'])

    // The sealed blob the api wrote is gone: the row now carries the key under the org DEK.
    const secret = await readSecret(credentialId)
    expect(secret?.encryption).toBe('dek')
    expect(secret?.dataKeyVersion).toBe(1)

    // Once after the store, once after the re-wrap — anything cached against the old shape is dropped.
    expect(invalidated).toContain(credentialId)
    const audits = await auditsFor(credentialId)
    expect(audits.map((a) => a.action)).toEqual(['llm.credential_probed'])
    expect(audits[0]?.detail).toMatchObject({ reason: 'connect', ok: true, structured: 'native', health: 'healthy' })
    expect(audits[0]?.actor).toBe('system:llm.probe')
  })

  it('the re-wrapped key is the SAME key: the resolver opens it and the adapter sends it', async () => {
    const credentialId = await createCredential()
    const { deps, resolver } = makeDeps()
    await runLlmProbe(deps, { orgId, credentialId, sealed: await sealedFor('sk-roundtrip-key-99'), reason: 'connect' }, AbortSignal.timeout(30_000))

    // Straight through `openCredentialKey`'s DEK branch — a wrong AAD or a wrong version would throw.
    const agentId = await createAgentWithConfig(credentialId)
    const r = await resolver.resolve(orgId, agentId, 'draft')
    expect(r.ok).toBe(true)
  })

  it('manual re-probe with no sealed payload: reads the dek secret, probes, healthy again, consecutive_failures 0, cache dropped', async () => {
    const credentialId = await createCredential({ healthStatus: 'degraded', consecutiveFailures: 3, lastError: 'old failure' })
    await seedDekSecret(credentialId)
    const { deps, resolver } = makeDeps()
    const agentId = await createAgentWithConfig(credentialId)
    const before = await resolver.resolve(orgId, agentId, 'draft')
    expect(before.ok).toBe(true)

    const health = await runLlmProbe(deps, { orgId, credentialId, reason: 'manual' }, AbortSignal.timeout(30_000))

    expect(health).toBe('healthy')
    const cred = await readCredential(credentialId)
    expect(cred?.healthStatus).toBe('healthy')
    expect(cred?.consecutiveFailures).toBe(0)
    expect(cred?.lastError).toBeNull()
    // Already `dek`, so nothing to re-wrap — the row is left alone.
    expect((await readSecret(credentialId))?.encryption).toBe('dek')
    // The stored verdict changed, so the cached provider (built on the OLD verdict) must be gone.
    const after = await resolver.resolve(orgId, agentId, 'draft')
    expect(after.ok && after.provider).not.toBe(before.ok && before.provider)
  })

  it('a 401 on the chat step: health dead, last_error scrubbed, ONE provider_health notification, audit llm.credential_dead', async () => {
    const credentialId = await createCredential({ healthStatus: 'healthy' })
    await seedDekSecret(credentialId)
    const notified: string[] = []
    const { deps } = makeDeps({
      fetchFn: probeFetch({ chatError: { status: 401, message: 'Incorrect API key provided: sk-abcdefghijklmnop.' } }).fetchFn,
      enqueueNotify: async (_org, id) => void notified.push(id),
    })

    const health = await runLlmProbe(deps, { orgId, credentialId, reason: 'manual' }, AbortSignal.timeout(30_000))

    expect(health).toBe('dead')
    const cred = await readCredential(credentialId)
    expect(cred?.healthStatus).toBe('dead')
    expect(cred?.consecutiveFailures).toBe(1)
    expect(cred?.lastError).toContain('[redacted]')
    expect(cred?.lastError).not.toContain('sk-abcdefghijklmnop')
    expect((cred?.lastProbe as ProbeResultView).chat).toBe('failed')

    const rows = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.kind, 'provider_health'))))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('AI provider needs attention')
    expect(rows[0]?.body).toContain('OpenAI key was rejected by OpenAI.')
    expect(rows[0]?.payload).toMatchObject({ credentialId })
    expect(notified).toEqual([rows[0]!.id])
    expect((await auditsFor(credentialId)).map((a) => a.action).sort()).toEqual(['llm.credential_dead', 'llm.credential_probed'])

    // A second run of the same failing probe pages nobody again.
    await runLlmProbe(deps, { orgId, credentialId, reason: 'scheduled' }, AbortSignal.timeout(30_000))
    const again = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.kind, 'provider_health'))))
    expect(again).toHaveLength(1)
    expect(notified).toHaveLength(1)
  })

  it('a 500 on the chat step: one failure keeps the previous health; DEGRADED_AFTER_FAILURES of them → degraded', async () => {
    const credentialId = await createCredential({ healthStatus: 'healthy' })
    await seedDekSecret(credentialId)
    const { deps } = makeDeps({ fetchFn: probeFetch({ chatError: { status: 500, message: 'upstream is on fire' } }).fetchFn })

    const first = await runLlmProbe(deps, { orgId, credentialId, reason: 'scheduled' }, AbortSignal.timeout(30_000))
    expect(first).toBe('healthy')
    const once = await readCredential(credentialId)
    expect(once?.consecutiveFailures).toBe(1)
    expect(once?.healthStatus).toBe('healthy')
    expect(once?.lastError).toContain('upstream is on fire')

    const second = await runLlmProbe(deps, { orgId, credentialId, reason: 'scheduled' }, AbortSignal.timeout(30_000))
    expect(second).toBe('degraded')
    const twice = await readCredential(credentialId)
    expect(twice?.consecutiveFailures).toBe(DEGRADED_AFTER_FAILURES)
    expect(twice?.healthStatus).toBe('degraded')
    // A transient outage is not an auth failure: nobody is paged, and nothing is marked dead.
    expect((await auditsFor(credentialId)).map((a) => a.action)).toEqual(['llm.credential_probed', 'llm.credential_probed'])
  })

  it('an endpoint that honours only json_mode stores json_mode', async () => {
    const credentialId = await createCredential()
    await seedDekSecret(credentialId)
    const { deps } = makeDeps({ fetchFn: probeFetch({ structured: 'json_mode' }).fetchFn })

    expect(await runLlmProbe(deps, { orgId, credentialId, reason: 'manual' }, AbortSignal.timeout(30_000))).toBe('healthy')
    expect((await readCredential(credentialId))?.lastProbe).toMatchObject({ ok: true, structured: 'json_mode' })
  })

  it('an endpoint that honours NO structured rung stores none, and resolveModelConfig then reports tier limited', async () => {
    const credentialId = await createCredential()
    await seedDekSecret(credentialId)
    const agentId = await createAgentWithConfig(credentialId)
    const { deps } = makeDeps({ fetchFn: probeFetch({ structured: 'none' }).fetchFn })

    expect(await runLlmProbe(deps, { orgId, credentialId, reason: 'manual' }, AbortSignal.timeout(30_000))).toBe('healthy')
    expect((await readCredential(credentialId))?.lastProbe).toMatchObject({ ok: true, structured: 'none' })
    const config = await withOrg(app.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(config.tier).toBe('limited')
  })

  it('a credential deleted mid-flight returns skipped without throwing, and stores nothing', async () => {
    const credentialId = crypto.randomUUID()
    const { deps } = makeDeps()

    expect(await runLlmProbe(deps, { orgId, credentialId, reason: 'scheduled' }, AbortSignal.timeout(30_000))).toBe('skipped')
    expect(await readSecret(credentialId)).toBeUndefined()
  })

  it('a credential whose secret row never arrived returns skipped with a warn', async () => {
    const credentialId = await createCredential()
    const { deps } = makeDeps()

    expect(await runLlmProbe(deps, { orgId, credentialId, reason: 'scheduled' }, AbortSignal.timeout(30_000))).toBe('skipped')
    expect(lines.map((l) => JSON.parse(l).msg as string)).toContain('llm.probe: no secret row')
  })

  it('a credential with no probe model and no preset suggestion returns skipped with a warn', async () => {
    const credentialId = await createCredential({ provider: 'custom', baseUrl: 'https://llm.acme.test/v1', probeModel: null })
    await seedDekSecret(credentialId)
    const { deps } = makeDeps()

    expect(await runLlmProbe(deps, { orgId, credentialId, reason: 'manual' }, AbortSignal.timeout(30_000))).toBe('skipped')
    expect(lines.map((l) => JSON.parse(l).msg as string)).toContain('llm.probe: no probe model')
  })

  it('a custom credential with no base URL returns skipped with a warn — never the SDK\'s default host', async () => {
    const credentialId = await createCredential({ provider: 'custom', baseUrl: null, probeModel: 'local-7b' })
    await seedDekSecret(credentialId)
    const { fetchFn, urls } = probeFetch()
    const { deps } = makeDeps({ fetchFn })

    expect(await runLlmProbe(deps, { orgId, credentialId, reason: 'manual' }, AbortSignal.timeout(30_000))).toBe('skipped')
    expect(lines.map((l) => JSON.parse(l).msg as string)).toContain('llm.probe: no base URL')
    expect(urls).toHaveLength(0)
  })

  it('every probe call is metered: llm_calls rows with role probe, mode byok and the credential id', async () => {
    const credentialId = await createCredential()
    await seedDekSecret(credentialId)
    const { deps } = makeDeps()

    await runLlmProbe(deps, { orgId, credentialId, reason: 'manual' }, AbortSignal.timeout(30_000))

    const calls = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.credentialId, credentialId)))
    expect(calls.length).toBeGreaterThanOrEqual(2)   // the plain chat step + the native structured rung
    for (const c of calls) {
      expect(c.role).toBe('probe')
      expect(c.mode).toBe('byok')
      expect(c.provider).toBe('openai')
    }
  })

  /** A byok draft config pointing at `credentialId`, so the resolver has something to resolve. */
  async function createAgentWithConfig(credentialId: string): Promise<string> {
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning({ id: user.id })
    return withOrg(app.db, orgId, async (tx) => {
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
        status: 'connected', connectedByUserId: u!.id,
      }).returning({ id: mailboxConnections.id })
      const [agent] = await tx.insert(agents).values({
        orgId, connectionId: conn!.id, address: `support-${rand()}@acme.test`, domain: 'acme.test',
        displayName: 'Acme Support', status: 'active',
      }).returning({ id: agents.id })
      await tx.insert(agentModelConfig).values({ orgId, agentId: agent!.id, role: 'draft', mode: 'byok', credentialId, model: 'gpt-5' })
      return agent!.id
    })
  }
})
