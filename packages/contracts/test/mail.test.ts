import { describe, expect, it } from 'vitest'
import { AddAddressInput, StartConnectInput, emailDomain } from '../src/index.ts'

describe('mail contracts', () => {
  it('lowercases the address and extracts the domain', () => {
    const parsed = AddAddressInput.parse({ connectionId: '018f6d67-1111-7aaa-8aaa-aaaaaaaaaaaa', address: 'Sales@Acme.COM', replyFromConnection: false })
    expect(parsed.address).toBe('sales@acme.com')
    expect(emailDomain(parsed.address)).toBe('acme.com')
    expect(() => emailDomain('nodomain')).toThrow(TypeError)
  })
  it('rejects unknown providers', () => {
    expect(StartConnectInput.safeParse({ provider: 'yahoo', platform: 'web' }).success).toBe(false)
  })
  it('lowercases domain in emailDomain directly', () => {
    expect(emailDomain('x@Acme.COM')).toBe('acme.com')
  })
})
