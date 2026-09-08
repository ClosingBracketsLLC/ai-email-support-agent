import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('api config', () => {
  it('parses defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' })
    expect(c).toMatchObject({ databaseUrl: 'postgres://x', port: 3001, host: '0.0.0.0', logLevel: 'info' })
  })
  it('refuses key material — the api never holds the KEK', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', AESA_KEK_V1: 'abc' })).toThrow(/api must not/)
  })
  it('validates APP_BASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', APP_BASE_URL: 'nope' })).toThrow(/APP_BASE_URL/)
  })
})
