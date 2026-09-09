import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const DATABASE_URL = 'postgres://aesa:aesa@localhost:5434/aesa_dev'

describe('worker config', () => {
  it('reports no KEK for the blank .env.example shape instead of crashing at boot', () => {
    const config = loadConfig({ DATABASE_URL, AESA_KEK_V1: '', AESA_KEK_ACTIVE: '1' })
    expect(config.kekRing).toBeNull()
  })

  it('loads the ring once a KEK has a value', () => {
    const config = loadConfig({ DATABASE_URL, AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
    expect(config.kekRing?.active).toBe(1)
    expect(config.kekRing?.keys.get(1)?.length).toBe(32)
  })

  it('reports no ANTHROPIC_API_KEY when unset, so boot never crashes on it alone', () => {
    const config = loadConfig({ DATABASE_URL })
    expect(config.anthropicApiKey).toBeNull()
  })

  it('wraps a present ANTHROPIC_API_KEY in a Secret that never leaks the raw value', () => {
    const config = loadConfig({ DATABASE_URL, ANTHROPIC_API_KEY: 'sk-ant-test-key' })
    expect(config.anthropicApiKey).not.toBeNull()
    expect(config.anthropicApiKey?.expose()).toBe('sk-ant-test-key')
    expect(String(config.anthropicApiKey)).toBe('[redacted]')
  })
})
