import { describe, expect, it } from 'vitest'
import { isBlockedAddress } from '../src/ssrf/ranges.ts'
import { resolvePublic } from '../src/ssrf/resolve-public.ts'
import { buildPinnedDispatcher, pinnedFetch, validateOutboundUrl } from '../src/ssrf/pinned-fetch.ts'

describe('ssrf ranges', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))
  it.each(['8.8.8.8', '104.18.0.1', '2606:4700::1111'])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false))
})

describe('resolvePublic', () => {
  it('rejects a host with ANY private answer (DNS rebinding defence)', async () => {
    const resolver = async () => [{ address: '104.18.0.1', family: 4 as const }, { address: '10.0.0.1', family: 4 as const }]
    await expect(resolvePublic('evil.example', { resolver })).rejects.toThrow(/private|blocked/i)
  })
  it('returns the first public answer', async () => {
    const resolver = async () => [{ address: '104.18.0.1', family: 4 as const }]
    await expect(resolvePublic('api.example', { resolver })).resolves.toEqual({ address: '104.18.0.1', family: 4 })
  })
})

describe('validateOutboundUrl / pinnedFetch', () => {
  it('requires https, a hostname (no IP literal) and port 443', () => {
    expect(() => validateOutboundUrl('http://api.example/v1')).toThrow(/https/)
    expect(() => validateOutboundUrl('https://104.18.0.1/v1')).toThrow(/hostname/)
    expect(() => validateOutboundUrl('https://api.example:8443/v1')).toThrow(/port/)
    expect(validateOutboundUrl('https://api.example:8443/v1', { allowNonstandardPort: true }).port).toBe('8443')
  })
  it('pins the vetted IP in the dispatcher lookup', async () => {
    const dispatcher = buildPinnedDispatcher('104.18.0.1', 4)
    const lookup = (dispatcher as unknown as { pinnedLookup: (h: string, o: unknown, cb: (e: null, a: string, f: number) => void) => void }).pinnedLookup
    await new Promise<void>((resolve) => lookup('api.example', {}, (err, address, family) => { expect(err).toBeNull(); expect(address).toBe('104.18.0.1'); expect(family).toBe(4); resolve() }))
  })
  it('refuses a private target before any connection is made', async () => {
    const resolver = async () => [{ address: '169.254.169.254', family: 4 as const }]
    await expect(pinnedFetch('https://metadata.example/latest', { resolver })).rejects.toThrow(/blocked/i)
  })
})
