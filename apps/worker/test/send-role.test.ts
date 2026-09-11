import type PgBoss from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { loadKekRing, Secret, type KekRing } from '@aesa/crypto'
import type { Db } from '@aesa/db'
import { createMailLimiter } from '@aesa/mail'
import type { WorkerConfig } from '../src/config.ts'
import type { SendExecuteDeps } from '../src/jobs/send-execute.ts'
import { createWorkerLogger } from '../src/logging.ts'
import { maybeRegisterSendRole } from '../src/send-role.ts'

const fakeDb = {} as Db
const fakeBoss = {} as PgBoss
const ring: KekRing = loadKekRing({ AESA_KEK_V1: Buffer.alloc(32, 7).toString('base64'), AESA_KEK_ACTIVE: '1' })
const gmailPair = { clientId: 'gmail-client', clientSecret: new Secret('gmail-secret') }

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'development',
    databaseUrl: 'postgres://unused',
    roles: new Set(['send']),
    kekRing: ring,
    logLevel: 'info',
    anthropicApiKey: null,
    gmailOauth: gmailPair,
    msOauth: null,
    gmailPubsubTopic: null,
    webhookPublicUrl: null,
    mail: { transport: 'devsink', from: 'aesa <onboarding@resend.dev>' },
    appBaseUrl: null,
    appWebOrigin: null,
    platformSender: null,
    ...overrides,
  }
}

function testLogger(): { logger: ReturnType<typeof createWorkerLogger>; lines: string[] } {
  const lines: string[] = []
  return { logger: createWorkerLogger('info', { write: (s: string) => void lines.push(s) }), lines }
}

function callWith(config: WorkerConfig, register: (boss: PgBoss, deps: SendExecuteDeps) => Promise<void>, logger: ReturnType<typeof createWorkerLogger>) {
  return maybeRegisterSendRole(
    {
      boss: fakeBoss, db: fakeDb, config, limiter: createMailLimiter(), logger,
      enqueueNotify: async () => {}, enqueueDraft: async () => {},
    },
    register,
  )
}

describe('maybeRegisterSendRole', () => {
  it('does nothing when the send role is not active — not even a warning', async () => {
    const { logger, lines } = testLogger()
    let registered = false
    await callWith(baseConfig({ roles: new Set(['sync']) }), async () => { registered = true }, logger)
    expect(registered).toBe(false)
    expect(lines).toHaveLength(0)
  })

  it('registers send.execute with the ring, the config and the SHARED limiter once a KEK ring and one OAuth pair are present', async () => {
    const { logger } = testLogger()
    let seen: SendExecuteDeps | undefined
    const config = baseConfig({ env: 'production' })
    await maybeRegisterSendRole(
      {
        boss: fakeBoss, db: fakeDb, config, limiter: createMailLimiter(), logger,
        enqueueNotify: async () => {}, enqueueDraft: async () => {},
      },
      async (_boss, deps) => { seen = deps },
    )
    expect(seen?.db).toBe(fakeDb)
    expect(seen?.ring).toBe(ring)
    expect(seen?.config).toBe(config)
    expect(seen?.limiter).toBeDefined()
    expect(seen?.enqueueNotify).toBeDefined()
    expect(seen?.enqueueDraft).toBeDefined()
  })

  it('registers on the microsoft pair alone', async () => {
    const { logger } = testLogger()
    let registered = false
    await callWith(
      baseConfig({ env: 'production', gmailOauth: null, msOauth: { clientId: 'ms', clientSecret: new Secret('s') } }),
      async () => { registered = true },
      logger,
    )
    expect(registered).toBe(true)
  })

  it('refuses to start in production without the KEK ring', async () => {
    const { logger } = testLogger()
    let registered = false
    await expect(callWith(baseConfig({ env: 'production', kekRing: null }), async () => { registered = true }, logger))
      .rejects.toThrow(/AESA_KEK/)
    expect(registered).toBe(false)
  })

  it('refuses to start in production with no OAuth pair at all', async () => {
    const { logger } = testLogger()
    let registered = false
    await expect(callWith(baseConfig({ env: 'production', gmailOauth: null, msOauth: null }), async () => { registered = true }, logger))
      .rejects.toThrow(/OAUTH/)
    expect(registered).toBe(false)
  })

  it('logs a warning and skips registration in development when the KEK ring is missing', async () => {
    const { logger, lines } = testLogger()
    let registered = false
    await callWith(baseConfig({ kekRing: null }), async () => { registered = true }, logger)
    expect(registered).toBe(false)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toMatch(/AESA_KEK/)
  })

  it('logs a warning and skips registration in development when no OAuth pair is configured', async () => {
    const { logger, lines } = testLogger()
    let registered = false
    await callWith(baseConfig({ gmailOauth: null, msOauth: null }), async () => { registered = true }, logger)
    expect(registered).toBe(false)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toMatch(/OAUTH/)
  })
})
