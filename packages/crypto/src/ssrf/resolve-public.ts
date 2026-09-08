import { lookup } from 'node:dns/promises'
import { isBlockedAddress } from './ranges.ts'

export type Resolved = { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<Resolved[]>

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family as 4 | 6 }))

/** Resolves every A/AAAA answer and refuses the host if ANY answer is blocked — a rebinding host must not get a foothold. */
export async function resolvePublic(hostname: string, opts: { resolver?: Resolver } = {}): Promise<Resolved> {
  const answers = await (opts.resolver ?? defaultResolver)(hostname)
  if (answers.length === 0) throw new Error(`${hostname} did not resolve`)
  const bad = answers.find((a) => isBlockedAddress(a.address))
  if (bad) throw new Error(`${hostname} resolves to a blocked/private address (${bad.address})`)
  return answers[0]!
}
