/**
 * The resolver is asserted on WHICH provider comes back and how it is keyed — never on a model
 * reply, because nothing here is supposed to reach a network. The one exception is the base-URL
 * case, which drives ONE `chat()` through a capturing fetch stub purely to read back the URL the
 * adapter was built on.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProbeResultView } from '@aesa/contracts'
import { encrypt, loadKekRing, sealTo, type KekRing } from '@aesa/crypto'
import {
  agentModelConfig, agents, auditLog, getOrgBoxPublicKey, llmCredentials, llmCredentialSecrets, loadOrgDek,
  mailboxConnections, provisionOrgKeys, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createFakeProvider, noopMeterSink, type LlmProvider } from '@aesa/llm'
import { createWorkerLogger } from '../src/logging.ts'
import {
  createProviderResolver, markCredentialDead, secretAad, staticRefusal, staticResolver, type ProviderResolverDeps,
} from '../src/provider-resolver.ts'

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
const rand = () => randomBytes(4).toString('hex')

/** Records the URL of every request; answers a one-line chat completion. */
function capturingFetch(): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', model: 'm',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok', refusal: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { fetchFn, urls }
}

function testLogger(): { logger: ReturnType<typeof createWorkerLogger>; lines: string[] } {
  const lines: string[] = []
  return { logger: createWorkerLogger('info', { write: (s: string) => void lines.push(s) }), lines }
}

describe('createProviderResolver', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  let managed: LlmProvider
  let boxPublicKey: Buffer

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    managed = createFakeProvider([{ text: 'managed' }], { kind: 'anthropic' })
    await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' })
      await provisionOrgKeys(tx, ring)
    })
    boxPublicKey = await withOrg(app.db, orgId, (tx) => getOrgBoxPublicKey(tx))
  }, 60_000)

  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  /** One agent per case, so no two cases share an `agent_model_config` row. */
  async function createAgent(): Promise<string> {
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
      return agent!.id
    })
  }

  async function createCredential(over: Partial<typeof llmCredentials.$inferInsert> = {}): Promise<string> {
    return withOrg(app.db, orgId, async (tx) => {
      const [row] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: 'OpenAI key', keyFingerprint: 'abcd1234…7890',
        probeModel: 'gpt-5', createdBy: 'user:test', ...over,
      }).returning({ id: llmCredentials.id })
      return row!.id
    })
  }

  /** The shape `llm.probe` leaves behind once it has re-wrapped: the key under the org DEK. */
  async function seedDekSecret(credentialId: string, apiKey = 'sk-test'): Promise<void> {
    const { version, dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const ciphertext = encrypt(dek, Buffer.from(JSON.stringify({ apiKey }), 'utf8'), secretAad(orgId, credentialId))
    await withPlatform(app.db, 'test:seed-secret', (tx) =>
      tx.insert(llmCredentialSecrets).values({ credentialId, orgId, keyCiphertext: ciphertext, encryption: 'dek', dataKeyVersion: version }))
  }

  /** The shape the api leaves behind before the probe has run: sealed to the org's box public key. */
  async function seedSealedSecret(credentialId: string, apiKey = 'sk-sealed'): Promise<void> {
    const sealed = await sealTo(boxPublicKey, Buffer.from(JSON.stringify({ apiKey }), 'utf8'))
    await withPlatform(app.db, 'test:seed-secret', (tx) =>
      tx.insert(llmCredentialSecrets).values({ credentialId, orgId, keyCiphertext: sealed, encryption: 'sealed' }))
  }

  async function seedConfig(agentId: string, over: Partial<typeof agentModelConfig.$inferInsert> = {}): Promise<void> {
    await withOrg(app.db, orgId, (tx) => tx.insert(agentModelConfig).values({ orgId, agentId, role: 'draft', mode: 'byok', ...over }))
  }

  function makeResolver(over: Partial<ProviderResolverDeps> = {}) {
    const { logger, lines } = testLogger()
    const resolver = createProviderResolver({ db: app.db, ring, managed, sink: noopMeterSink, logger, ...over })
    return { resolver, lines }
  }

  it('managed config → the managed provider, no fallback, config.mode managed', async () => {
    const agentId = await createAgent()
    const { resolver } = makeResolver()

    const r = await resolver.resolve(orgId, agentId, 'draft')

    expect(r.ok).toBe(true)
    expect(r.config.mode).toBe('managed')
    expect(r.ok && r.provider).toBe(managed)
    expect(r.ok && r.fallback).toBeNull()
  })

  it('managed config with no managed key at all → { ok: false, reason: no_managed_key }', async () => {
    const agentId = await createAgent()
    const { resolver } = makeResolver({ managed: null })

    const r = await resolver.resolve(orgId, agentId, 'draft')

    expect(r).toMatchObject({ ok: false, reason: 'no_managed_key' })
  })

  it('byok config with a dek-wrapped secret → a provider of the credential\'s kind, CACHED per credential, dropped by invalidate()', async () => {
    const agentId = await createAgent()
    const credentialId = await createCredential({ healthStatus: 'healthy' })
    await seedDekSecret(credentialId)
    await seedConfig(agentId, { credentialId, model: 'gpt-5' })
    const { resolver } = makeResolver()

    const first = await resolver.resolve(orgId, agentId, 'draft')
    expect(first).toMatchObject({ ok: true })
    expect(first.ok && first.provider.kind).toBe('openai')
    expect(first.config).toMatchObject({ mode: 'byok', credentialId, provider: 'openai', model: 'gpt-5' })

    // A key is decrypted once per process, not once per draft.
    const second = await resolver.resolve(orgId, agentId, 'draft')
    expect(second.ok && second.provider).toBe(first.ok && first.provider)

    resolver.invalidate(credentialId)
    const third = await resolver.resolve(orgId, agentId, 'draft')
    expect(third.ok && third.provider).not.toBe(first.ok && first.provider)
    expect(third.ok && third.provider.kind).toBe('openai')
  })

  it('byok config with a SEALED secret (the probe has not re-wrapped it yet) → opens the sealed box, and leaves the row sealed', async () => {
    const agentId = await createAgent()
    const credentialId = await createCredential({ healthStatus: 'unknown' })
    await seedSealedSecret(credentialId)
    await seedConfig(agentId, { credentialId, model: 'gpt-5' })
    const { resolver } = makeResolver()

    const r = await resolver.resolve(orgId, agentId, 'draft')

    expect(r.ok).toBe(true)
    expect(r.ok && r.provider.kind).toBe('openai')
    // The re-wrap belongs to `llm.probe` alone — resolving never writes.
    const [row] = await withPlatform(app.db, 'test:read', (tx) =>
      tx.select().from(llmCredentialSecrets).where(eq(llmCredentialSecrets.credentialId, credentialId)))
    expect(row?.encryption).toBe('sealed')
  })

  it('byok config whose credential is dead → { ok: false, reason: credential_dead }, and the secret table is never read', async () => {
    const agentId = await createAgent()
    // NO secret row at all: if the dead check ran after the secret read this would say `no_secret`.
    const credentialId = await createCredential({ healthStatus: 'dead' })
    await seedConfig(agentId, { credentialId, model: 'gpt-5' })
    const { resolver } = makeResolver()

    expect(await resolver.resolve(orgId, agentId, 'draft')).toMatchObject({ ok: false, reason: 'credential_dead' })
  })

  it('byok config with no ring → { ok: false, reason: no_kek }', async () => {
    const agentId = await createAgent()
    const credentialId = await createCredential({ healthStatus: 'healthy' })
    await seedDekSecret(credentialId)
    await seedConfig(agentId, { credentialId, model: 'gpt-5' })
    const { resolver } = makeResolver({ ring: null })

    expect(await resolver.resolve(orgId, agentId, 'draft')).toMatchObject({ ok: false, reason: 'no_kek' })
  })

  it('a secret row whose plaintext is not the expected JSON fails WITHOUT echoing the key', async () => {
    const agentId = await createAgent()
    const credentialId = await createCredential({ healthStatus: 'healthy' })
    // A bare key rather than `{"apiKey": …}` — `JSON.parse`'s own SyntaxError would quote the first
    // characters of its input, i.e. the key, straight into the job failure and the worker log.
    const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    await withPlatform(app.db, 'test:seed-secret', (tx) =>
      tx.insert(llmCredentialSecrets).values({
        credentialId, orgId, encryption: 'dek', dataKeyVersion: 1,
        keyCiphertext: encrypt(dek, Buffer.from('sk-live-abcdefghijklmnop', 'utf8'), secretAad(orgId, credentialId)),
      }))
    await seedConfig(agentId, { credentialId, model: 'gpt-5' })
    const { resolver } = makeResolver()

    await expect(resolver.resolve(orgId, agentId, 'draft')).rejects.toThrow('llm credential secret is not readable')
    await expect(resolver.resolve(orgId, agentId, 'draft')).rejects.not.toThrow(/sk-/)
  })

  it('byok config with no secret row → { ok: false, reason: no_secret }', async () => {
    const agentId = await createAgent()
    const credentialId = await createCredential({ healthStatus: 'healthy' })
    await seedConfig(agentId, { credentialId, model: 'gpt-5' })
    const { resolver } = makeResolver()

    expect(await resolver.resolve(orgId, agentId, 'draft')).toMatchObject({ ok: false, reason: 'no_secret' })
  })

  it('fallbackToManaged decides the second provider: true → managed, false → null, true with no managed key → null and ONE warn', async () => {
    const credentialId = await createCredential({ healthStatus: 'healthy' })
    await seedDekSecret(credentialId)

    const onAgent = await createAgent()
    await seedConfig(onAgent, { credentialId, model: 'gpt-5', fallbackToManaged: true })
    const offAgent = await createAgent()
    await seedConfig(offAgent, { credentialId, model: 'gpt-5', fallbackToManaged: false })

    const { resolver } = makeResolver()
    const on = await resolver.resolve(orgId, onAgent, 'draft')
    expect(on.ok && on.fallback).toBe(managed)
    const off = await resolver.resolve(orgId, offAgent, 'draft')
    expect(off.ok && off.fallback).toBeNull()

    const { resolver: keyless, lines } = makeResolver({ managed: null })
    const first = await keyless.resolve(orgId, onAgent, 'draft')
    expect(first.ok && first.fallback).toBeNull()
    await keyless.resolve(orgId, onAgent, 'draft')
    // Once per process, not once per draft — this line is about the platform's own configuration.
    expect(lines.map((l) => JSON.parse(l).msg as string).filter((m) => m.includes('fallbackToManaged'))).toHaveLength(1)
  })

  it('a stored probe verdict of `none` narrows the adapter\'s capabilities — the probe may narrow, never widen', async () => {
    const agentId = await createAgent()
    const lastProbe: ProbeResultView = {
      ok: true, probedAt: new Date().toISOString(), models: ['gpt-5'], chat: 'ok', structured: 'none', latencyMs: 12, error: null,
    }
    const credentialId = await createCredential({ healthStatus: 'healthy', lastProbe })
    await seedDekSecret(credentialId)
    await seedConfig(agentId, { credentialId, model: 'gpt-5' })
    const { resolver } = makeResolver()

    const r = await resolver.resolve(orgId, agentId, 'draft')

    expect(r.ok && r.provider.capabilities('gpt-5').structuredOutput).toBe('none')
    // `resolveModelConfig` downgrades the catalog tier for the same reason.
    expect(r.config.tier).toBe('limited')
  })

  it('a custom credential builds the adapter on its STORED base URL; a preset one on the preset\'s', async () => {
    const customAgent = await createAgent()
    const customCred = await createCredential({ provider: 'custom', baseUrl: 'https://llm.acme.test/v1', healthStatus: 'healthy', probeModel: 'local-7b' })
    await seedDekSecret(customCred)
    await seedConfig(customAgent, { credentialId: customCred, model: 'local-7b' })

    const presetAgent = await createAgent()
    const presetCred = await createCredential({ provider: 'openai', healthStatus: 'healthy' })
    await seedDekSecret(presetCred)
    await seedConfig(presetAgent, { credentialId: presetCred, model: 'gpt-5' })

    const { fetchFn, urls } = capturingFetch()
    const { resolver } = makeResolver({ fetchFn })

    const custom = await resolver.resolve(orgId, customAgent, 'draft')
    expect(custom.ok).toBe(true)
    if (custom.ok) {
      await custom.provider.chat({
        model: 'local-7b', system: [], messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16,
        meta: { orgId, role: 'draft', idempotencyKey: `k-${rand()}` },
      })
    }
    const preset = await resolver.resolve(orgId, presetAgent, 'draft')
    expect(preset.ok).toBe(true)
    if (preset.ok) {
      await preset.provider.chat({
        model: 'gpt-5', system: [], messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16,
        meta: { orgId, role: 'draft', idempotencyKey: `k-${rand()}` },
      })
    }

    expect(urls[0]).toBe('https://llm.acme.test/v1/chat/completions')
    expect(urls[1]).toBe('https://api.openai.com/v1/chat/completions')
  })
})

describe('markCredentialDead', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
  }, 60_000)
  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  it('flips health to dead once, scrubs and truncates the error, bumps the failure count, and audits — a second call is a no-op', async () => {
    const credentialId = await withOrg(app.db, orgId, async (tx) => {
      const [row] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: 'OpenAI key', keyFingerprint: 'abcd1234…7890', createdBy: 'user:test', healthStatus: 'healthy',
      }).returning({ id: llmCredentials.id })
      return row!.id
    })

    const first = await withOrg(app.db, orgId, (tx) =>
      markCredentialDead(tx, orgId, credentialId, `401 for api-key sk-abcdefghijklmnop ${'x'.repeat(300)}`, 'system:llm.probe'))
    expect(first).toBe(true)

    const [after] = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId)))
    expect(after?.healthStatus).toBe('dead')
    expect(after?.consecutiveFailures).toBe(1)
    expect(after?.lastError?.length).toBeLessThanOrEqual(200)
    expect(after?.lastError).not.toContain('sk-abcdefghijklmnop')
    const audits = await withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, credentialId)))
    expect(audits.map((a) => a.action)).toEqual(['llm.credential_dead'])

    // Guarded on `health_status <> 'dead'`: the second call changes nothing and writes no audit row.
    const second = await withOrg(app.db, orgId, (tx) => markCredentialDead(tx, orgId, credentialId, 'again', 'system:llm.probe'))
    expect(second).toBe(false)
    const [twice] = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId)))
    expect(twice?.consecutiveFailures).toBe(1)
    expect(await withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, credentialId)))).toHaveLength(1)
  })
})

describe('staticResolver', () => {
  it('always answers with the one provider it was handed, and invalidate is a no-op', async () => {
    const provider = createFakeProvider([{ text: 'x' }], { kind: 'fake' })
    const resolver = staticResolver(provider)

    const r = await resolver.resolve('org_1', null, 'draft')

    expect(r).toMatchObject({ ok: true, fallback: null })
    expect(r.ok && r.provider).toBe(provider)
    expect(r.config.mode).toBe('managed')
    resolver.invalidate('cred_1')
    expect((await resolver.resolve('org_1', null, 'draft')).ok).toBe(true)
  })

  it('takes a fallback provider as its third argument', async () => {
    const provider = createFakeProvider([{ text: 'x' }], { kind: 'byok' })
    const fallback = createFakeProvider([{ text: 'y' }], { kind: 'managed' })

    const r = await staticResolver(provider, { mode: 'byok' }, fallback).resolve('org_1', null, 'draft')

    expect(r.ok && r.provider).toBe(provider)
    expect(r.ok && r.fallback).toBe(fallback)
  })

  it('takes a config patch, so a test can pretend it is a byok credential', async () => {
    const provider = createFakeProvider([{ text: 'x' }], { kind: 'fake' })
    const resolver = staticResolver(provider, { mode: 'byok', credentialId: 'cred_1', provider: 'openai', model: 'gpt-5' })

    const r = await resolver.resolve('org_1', null, 'draft')

    expect(r.config).toMatchObject({ mode: 'byok', credentialId: 'cred_1', provider: 'openai', model: 'gpt-5' })
  })
})

describe('staticRefusal', () => {
  it('refuses every call with the reason it was built for, carrying the config patch', async () => {
    const resolver = staticRefusal('credential_dead', { mode: 'byok', credentialId: 'cred_1', provider: 'openai' })

    const r = await resolver.resolve('org_1', 'agent_1', 'draft')

    expect(r).toMatchObject({ ok: false, reason: 'credential_dead' })
    expect(r.config).toMatchObject({ mode: 'byok', credentialId: 'cred_1', provider: 'openai' })
    resolver.invalidate('cred_1')
    expect((await resolver.resolve('org_1', 'agent_1', 'triage')).ok).toBe(false)
  })
})

describe('secretAad', () => {
  it('binds a wrapped key to one org AND one credential', () => {
    expect(secretAad('org_1', 'cred_1')).toBe('org_1:llm_credential_secrets:cred_1')
  })
})
