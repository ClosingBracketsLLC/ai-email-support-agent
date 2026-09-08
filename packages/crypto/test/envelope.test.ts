import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, generateDek, loadKekRing, rewrapDek, unwrapDek, wrapDek } from '../src/envelope.ts'

const env = {
  AESA_KEK_V1: randomBytes(32).toString('base64'),
  AESA_KEK_V2: randomBytes(32).toString('base64'),
  AESA_KEK_ACTIVE: '2',
}

const orgA = '11111111-1111-4111-8111-111111111111'
const orgB = '22222222-2222-4222-8222-222222222222'

describe('envelope encryption', () => {
  const ring = loadKekRing(env)

  it('wraps a DEK under the active KEK and unwraps it', () => {
    const dek = generateDek()
    const { kekVersion, wrapped } = wrapDek(dek, ring, orgA)
    expect(kekVersion).toBe(2)
    expect(unwrapDek(wrapped, kekVersion, ring, orgA).equals(dek)).toBe(true)
  })

  it('binds the wrapped DEK to its organization (AAD)', () => {
    const { kekVersion, wrapped } = wrapDek(generateDek(), ring, orgA)
    expect(() => unwrapDek(wrapped, kekVersion, ring, orgB)).toThrow()
  })

  it('refuses a blob too short to hold a version byte, nonce and tag', () => {
    const { wrapped } = wrapDek(generateDek(), ring, orgA)
    expect(() => unwrapDek(wrapped.subarray(0, 28), 2, ring, orgA)).toThrow(/too short/i)
    expect(() => unwrapDek(Buffer.alloc(0), 2, ring, orgA)).toThrow(/too short/i)
  })

  it('encrypts and decrypts with AAD binding', () => {
    const dek = generateDek()
    const ct = encrypt(dek, Buffer.from('refresh-token-value'), 'org-1:row-9')
    expect(decrypt(dek, ct, 'org-1:row-9').toString()).toBe('refresh-token-value')
    expect(() => decrypt(dek, ct, 'org-2:row-9')).toThrow()          // transplanted row
    const tampered = Buffer.from(ct)
    const lastIndex = tampered.length - 1
    tampered[lastIndex] = ((tampered[lastIndex] ?? 0) ^ 0x01) & 0xff
    expect(() => decrypt(dek, tampered, 'org-1:row-9')).toThrow()
  })

  it('re-wraps from a retired KEK version to the active one', () => {
    const dek = generateDek()
    const v1 = wrapDek(dek, loadKekRing({ ...env, AESA_KEK_ACTIVE: '1' }), orgA)
    const v2 = rewrapDek(v1.wrapped, v1.kekVersion, ring, orgA)
    expect(v2.kekVersion).toBe(2)
    expect(unwrapDek(v2.wrapped, 2, ring, orgA).equals(dek)).toBe(true)
    expect(() => unwrapDek(v2.wrapped, 1, ring, orgA)).toThrow()
  })

  it('rejects a malformed ring', () => {
    expect(() => loadKekRing({ AESA_KEK_V1: 'short', AESA_KEK_ACTIVE: '1' })).toThrow(/32 bytes/)
    expect(() => loadKekRing({ AESA_KEK_V1: env.AESA_KEK_V1, AESA_KEK_ACTIVE: '3' })).toThrow(/AESA_KEK_ACTIVE/)
  })
})
