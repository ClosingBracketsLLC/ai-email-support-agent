import { describe, expect, it } from 'vitest'
import { generateToken, hashToken, hashesEqual } from '../src/tokens.ts'

describe('tokens', () => {
  it('generates a 32-byte base64url token and its hash', () => {
    const { token, hash } = generateToken('action')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('action', token)).toBe(hash)
  })
  it('domain-separates kinds so one token can never satisfy another lookup', () => {
    const { token } = generateToken('login')
    expect(hashToken('login', token)).not.toBe(hashToken('session', token))
  })
  it('compares hashes in constant time and rejects length mismatches', () => {
    const { hash } = generateToken('session')
    expect(hashesEqual(hash, hash)).toBe(true)
    const flipped = hash.slice(0, 63) + (hash.endsWith('0') ? '1' : '0')
    expect(hashesEqual(hash, flipped)).toBe(false)
    expect(hashesEqual(hash, 'short')).toBe(false)
  })
})
