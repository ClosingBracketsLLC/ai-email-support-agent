import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4')
// Note: '::ffff:0:0/96' is deliberately NOT registered here. Node's BlockList.check()
// normalizes IPv4 lookups against IPv4-mapped IPv6 subnets, so registering that subnet
// causes every IPv4 address checked with family 'ipv4' to report blocked (verified on
// Node v22.23.2) — it would make isBlockedAddress reject all of IPv4. v4-mapped
// addresses (e.g. '::ffff:127.0.0.1') are instead handled explicitly below by
// extracting the v4 form and recursing, so this subnet is unnecessary for that purpose.
// 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) embed an IPv4 address a translator would reach for us.
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
  blocked.addSubnet(addr, prefix, 'ipv6')

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved and v4-mapped addresses. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  if (family === 6 && ip.toLowerCase().startsWith('::ffff:')) {
    const v4 = ip.slice(7)
    return isIP(v4) === 4 ? isBlockedAddress(v4) : true
  }
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}
