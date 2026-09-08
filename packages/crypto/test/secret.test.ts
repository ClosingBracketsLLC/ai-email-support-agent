import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Secret } from '../src/secret.ts'

describe('Secret', () => {
  const s = new Secret('sk-live-abc123')
  it('exposes the value only through expose()', () => {
    expect(s.expose()).toBe('sk-live-abc123')
  })
  it('never leaks through string, JSON or inspect', () => {
    expect(String(s)).toBe('[redacted]')
    expect(`${s}`).toBe('[redacted]')
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}')
    expect(inspect(s)).toBe('Secret([redacted])')
    expect(Object.keys(s)).toEqual([])
  })
})
