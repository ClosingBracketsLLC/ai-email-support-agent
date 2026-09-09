import type PgBoss from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { Secret } from '@aesa/crypto'
import type { Db } from '@aesa/db'
import { maybeRegisterAgentRole } from '../src/agent-role.ts'
import type { WorkerConfig } from '../src/config.ts'
import { createWorkerLogger } from '../src/logging.ts'
import type { TicketTriageDeps } from '../src/jobs/ticket-triage.ts'

const fakeDb = {} as Db
const fakeBoss = {} as PgBoss

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'development',
    databaseUrl: 'postgres://unused',
    roles: new Set(['agent']),
    kekRing: null,
    logLevel: 'info',
    anthropicApiKey: null,
    ...overrides,
  }
}

function testLogger(): { logger: ReturnType<typeof createWorkerLogger>; lines: string[] } {
  const lines: string[] = []
  return { logger: createWorkerLogger('info', { write: (s: string) => void lines.push(s) }), lines }
}

describe('maybeRegisterAgentRole', () => {
  it('does nothing when the agent role is not active — not even a warning', async () => {
    const { logger, lines } = testLogger()
    let registered = false
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ roles: new Set(['sync']) }), enqueueNotify: async () => {} },
      async () => { registered = true },
    )
    expect(registered).toBe(false)
    expect(lines).toHaveLength(0)
  })

  it('refuses to start in production when the agent role is active but ANTHROPIC_API_KEY is missing', async () => {
    const { logger } = testLogger()
    let registered = false
    await expect(
      maybeRegisterAgentRole(
        { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'production' }), enqueueNotify: async () => {} },
        async () => { registered = true },
      ),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/)
    expect(registered).toBe(false)
  })

  it('logs a warning and skips registration in development when ANTHROPIC_API_KEY is missing', async () => {
    const { logger, lines } = testLogger()
    let registered = false
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'development' }), enqueueNotify: async () => {} },
      async () => { registered = true },
    )
    expect(registered).toBe(false)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('same in test env — boots without the key rather than crashing', async () => {
    const { logger } = testLogger()
    let registered = false
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'test' }), enqueueNotify: async () => {} },
      async () => { registered = true },
    )
    expect(registered).toBe(false)
  })

  it('registers ticket.triage (with a real provider) once the key is present, in any env', async () => {
    const { logger } = testLogger()
    let capturedDeps: TicketTriageDeps | undefined
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        config: baseConfig({ env: 'production', anthropicApiKey: new Secret('sk-ant-test') }),
        enqueueNotify: async () => {},
      },
      async (_boss, jobDeps) => { capturedDeps = jobDeps },
    )
    expect(capturedDeps?.db).toBe(fakeDb)
    expect(capturedDeps?.provider.kind).toBe('anthropic')
    expect(capturedDeps?.logger).toBe(logger)
  })
})
