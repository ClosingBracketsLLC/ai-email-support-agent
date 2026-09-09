/**
 * The mailbox OAuth connect flow's `oauth_flows` lifecycle: `createFlow` (started by the authenticated
 * tRPC mutation, inside the caller's own `OrgTx`) and `consumeFlow` (run by the sessionless callback route,
 * which knows nothing but the `state` query param — hence the cross-org resolver). Both live here so
 * `connect/routes.ts` and `trpc/routers/mailboxes.ts` share one PKCE/nonce implementation.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { MailProvider } from '@aesa/contracts'
import { decrypt, encrypt, generateToken, hashToken, hashesEqual } from '@aesa/crypto'
import { getOrgBoxPublicKey, isUuid, oauthFlows, type OrgTx } from '@aesa/db'
import type { ApiFacade } from '../deps.ts'

/** Ten minutes: long enough for a real OAuth consent screen, short enough that a stale, unclaimed flow
 * isn't a standing cross-org probe. */
const FLOW_TTL_MS = 10 * 60 * 1000

const flowAad = (orgId: string, flowId: string) => `${orgId}:oauth_flows:${flowId}`

/** Returned to the caller only inside the redirect URL's opaque `state` — never stored or logged on its own. */
export interface FlowTokens { nonce: string }

export interface CreateFlowParams {
  userId: string
  provider: MailProvider
  platform: 'native' | 'web'
  flowKey: Buffer
}

/**
 * Inserts the pending `oauth_flows` row and returns the redirect `state` (`${flowId}.${nonce}`) plus the
 * PKCE `code_challenge` (S256 of a fresh random verifier). The verifier itself is never returned — it's
 * AES-GCM-encrypted under `flowKey` (aad `${orgId}:oauth_flows:${flowId}`) and stored as
 * `pkce_ciphertext`; only `consumeFlow` (the callback) ever decrypts it.
 */
export async function createFlow(tx: OrgTx, p: CreateFlowParams): Promise<{ flowId: string; state: string; codeChallenge: string }> {
  // Generated here, not left to the column's defaultRandom(), because the AAD binding the ciphertext to
  // this flow needs the id before the row can be written.
  const flowId = randomUUID()
  const { token: nonce, hash: nonceHash } = generateToken('oauth_nonce')
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const pkceCiphertext = encrypt(p.flowKey, Buffer.from(codeVerifier, 'utf8'), flowAad(tx.orgId, flowId))

  await tx.insert(oauthFlows).values({
    id: flowId,
    orgId: tx.orgId,
    userId: p.userId,
    provider: p.provider,
    platform: p.platform,
    nonceHash,
    pkceCiphertext,
    status: 'pending',
    expiresAt: new Date(Date.now() + FLOW_TTL_MS),
  })

  return { flowId, state: `${flowId}.${nonce}`, codeChallenge }
}

/** `${flowId}.${nonce}` — a bare split, not a format assumption: neither half can contain '.' (uuid /
 * base64url), so the FIRST '.' is always the real boundary. */
export function parseState(state: string): { flowId: string; nonce: string } | null {
  const dot = state.indexOf('.')
  if (dot <= 0) return null
  const flowId = state.slice(0, dot)
  const nonce = state.slice(dot + 1)
  if (!nonce || !isUuid(flowId)) return null
  return { flowId, nonce }
}

export interface ConsumedFlow {
  flowId: string
  orgId: string
  userId: string
  provider: MailProvider
  platform: 'native' | 'web'
  codeVerifier: string
}

/**
 * The callback's entry point. The request carries no session, so the org is unknown until
 * `deps.resolveOauthFlow` (migration 0009's SECURITY DEFINER function) resolves it; every check after that
 * runs inside `withOrg(orgId, …)`, RLS-scoped to that one org. Any failure (unknown flow, wrong org, bad
 * nonce, wrong status, expired, an undecryptable verifier) returns `null` — the route answers a generic
 * 400 either way, so none of these are distinguished on the wire.
 */
export async function consumeFlow(deps: ApiFacade, p: { state: string; flowKey: Buffer }): Promise<ConsumedFlow | null> {
  const parsed = parseState(p.state)
  if (!parsed) return null
  const resolved = await deps.resolveOauthFlow(parsed.flowId)
  if (!resolved) return null

  return deps.withOrg(resolved.orgId, async (tx) => {
    const [flow] = await tx.select().from(oauthFlows).where(eq(oauthFlows.id, parsed.flowId))
    if (!flow) return null
    if (flow.status !== 'pending') return null
    if (flow.expiresAt.getTime() <= Date.now()) return null
    if (!hashesEqual(hashToken('oauth_nonce', parsed.nonce), flow.nonceHash)) return null

    let codeVerifier: string
    try {
      codeVerifier = decrypt(p.flowKey, flow.pkceCiphertext, flowAad(resolved.orgId, parsed.flowId)).toString('utf8')
    } catch {
      return null
    }

    await tx.update(oauthFlows).set({ status: 'consumed' }).where(eq(oauthFlows.id, parsed.flowId))
    return {
      flowId: parsed.flowId,
      orgId: resolved.orgId,
      userId: flow.userId,
      provider: flow.provider as MailProvider,
      platform: flow.platform as 'native' | 'web',
      codeVerifier,
    }
  })
}

/**
 * The callback's error branches (the provider redirected back with `error=…`, before any code exchange):
 * marks a still-`pending` flow `failed` with `reason`. Same resolve-then-verify shape as `consumeFlow`
 * minus the decrypt (there is no verifier to recover here) — best-effort: an unknown flow, a tampered
 * nonce, or a flow that already left `pending` is a silent no-op, since there is nothing useful to tell
 * an adversary either way and the legitimate caller already saw the provider's own error page.
 */
export async function failPendingFlow(deps: ApiFacade, p: { state: string; reason: string }): Promise<void> {
  const parsed = parseState(p.state)
  if (!parsed) return
  const resolved = await deps.resolveOauthFlow(parsed.flowId)
  if (!resolved) return

  await deps.withOrg(resolved.orgId, async (tx) => {
    const [flow] = await tx.select().from(oauthFlows).where(eq(oauthFlows.id, parsed.flowId))
    if (!flow || flow.status !== 'pending') return
    if (!hashesEqual(hashToken('oauth_nonce', parsed.nonce), flow.nonceHash)) return
    await tx.update(oauthFlows).set({ status: 'failed', failureReason: p.reason }).where(eq(oauthFlows.id, parsed.flowId))
  })
}

/** `getOrgBoxPublicKey` throws when the org has no key yet (packages/db/src/keys.ts) — the same
 * "not provisioned" signal `apps/worker/src/jobs/keys-provision.ts` already treats a throw as. Both
 * `mailboxes.startConnect` and the callback route need the null-shaped version of that check. */
export async function tryGetOrgBoxPublicKey(tx: OrgTx): Promise<Buffer | null> {
  try {
    return await getOrgBoxPublicKey(tx)
  } catch {
    return null
  }
}
