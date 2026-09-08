import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 0x01
const NONCE_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

export interface KekRing { readonly active: number; readonly keys: ReadonlyMap<number, Buffer> }

/** Reads AESA_KEK_V<n> (base64, 32 bytes each) and AESA_KEK_ACTIVE from the environment. Worker-only in production. */
export function loadKekRing(env: Record<string, string | undefined>): KekRing {
  const keys = new Map<number, Buffer>()
  for (const [name, value] of Object.entries(env)) {
    const m = /^AESA_KEK_V(\d+)$/.exec(name)
    if (!m || !value) continue
    const key = Buffer.from(value, 'base64')
    if (key.length !== KEY_LEN) throw new Error(`${name} must decode to 32 bytes`)
    keys.set(Number(m[1]), key)
  }
  const active = Number(env.AESA_KEK_ACTIVE)
  if (!Number.isInteger(active) || !keys.has(active)) throw new Error('AESA_KEK_ACTIVE must name a configured AESA_KEK_V<n>')
  return { active, keys }
}

export function generateDek(): Buffer { return randomBytes(KEY_LEN) }

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ct])
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  // Without the length check a truncated blob is verified against a short tag; authTagLength pins it to 16.
  if (blob.length < 1 + NONCE_LEN + TAG_LEN) throw new Error('ciphertext is too short to be an envelope')
  if (blob[0] !== VERSION) throw new Error('unsupported ciphertext version')
  const nonce = blob.subarray(1, 1 + NONCE_LEN)
  const tag = blob.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN)
  const ct = blob.subarray(1 + NONCE_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])   // throws on tag/AAD mismatch
}

/** The KEK AAD binds a wrapped DEK to one organization, so a row cannot be transplanted between orgs. */
const kekAad = (version: number, orgId: string) => `kek:v${version}:${orgId}`

export function wrapDek(dek: Buffer, ring: KekRing, orgId: string): { kekVersion: number; wrapped: Buffer } {
  const kek = ring.keys.get(ring.active)!
  return { kekVersion: ring.active, wrapped: seal(kek, dek, kekAad(ring.active, orgId)) }
}

export function unwrapDek(wrapped: Buffer, kekVersion: number, ring: KekRing, orgId: string): Buffer {
  const kek = ring.keys.get(kekVersion)
  if (!kek) throw new Error(`KEK version ${kekVersion} is not configured`)
  return open(kek, wrapped, kekAad(kekVersion, orgId))
}

export function rewrapDek(wrapped: Buffer, kekVersion: number, ring: KekRing, orgId: string): { kekVersion: number; wrapped: Buffer } {
  return wrapDek(unwrapDek(wrapped, kekVersion, ring, orgId), ring, orgId)
}

/** Row-level encryption under an org DEK. `aad` MUST be `${orgId}:${rowId}` so a ciphertext cannot be transplanted. */
export function encrypt(dek: Buffer, plaintext: Buffer, aad: string): Buffer { return seal(dek, plaintext, aad) }
export function decrypt(dek: Buffer, ciphertext: Buffer, aad: string): Buffer { return open(dek, ciphertext, aad) }
