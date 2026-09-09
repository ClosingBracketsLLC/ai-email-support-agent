import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Every stored hash is domain-separated by kind ('action:' + token, …) so kinds can never satisfy each other's lookups. */
export type TokenKind = 'action' | 'login' | 'session' | 'oauth_nonce' | 'refresh'

export function hashToken(kind: TokenKind, token: string): string {
  return createHash('sha256').update(`${kind}:${token}`).digest('hex')
}

export function generateToken(kind: TokenKind): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(kind, token) }
}

export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
