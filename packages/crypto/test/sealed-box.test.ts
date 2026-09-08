import { describe, expect, it } from 'vitest'
import { generateBoxKeypair, openSealed, sealTo } from '../src/sealed-box.ts'

describe('sealed box', () => {
  it('seals with only the public key and opens with the private key', async () => {
    const { publicKey, privateKey } = await generateBoxKeypair()
    const sealed = await sealTo(publicKey, Buffer.from('1//0g-refresh-token'))
    expect(sealed.equals(Buffer.from('1//0g-refresh-token'))).toBe(false)
    expect((await openSealed(sealed, publicKey, privateKey)).toString()).toBe('1//0g-refresh-token')
  })
  it('cannot be opened with another keypair', async () => {
    const a = await generateBoxKeypair(); const b = await generateBoxKeypair()
    const sealed = await sealTo(a.publicKey, Buffer.from('x'))
    await expect(openSealed(sealed, b.publicKey, b.privateKey)).rejects.toThrow()
  })
})
