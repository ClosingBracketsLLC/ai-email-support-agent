/**
 * The mailbox OAuth connect flow's `oauth_flows` lifecycle: `createFlow` (started by the authenticated
 * tRPC mutation, inside the caller's own `OrgTx`), `prepareAuthorization` (the sessionless GET
 * /connect/:provider/start hop — verifies but does NOT consume) and `consumeFlow` (the sessionless
 * callback — verifies AND consumes). None of these know anything but the `state` query param on the
 * sessionless paths, hence the cross-org resolver. All three live here so `connect/routes.ts` and
 * `trpc/routers/mailboxes.ts` share one PKCE/nonce implementation.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { MailProvider } from '@aesa/contracts'
import { decrypt, encrypt, generateToken, hashToken, hashesEqual } from '@aesa/crypto'
import { isUuid, oauthFlows, type OrgTx } from '@aesa/db'
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
 * PKCE `code_challenge` (S256 of a fresh random verifier) — returned here only for observability/tests;
 * neither the `/start` route nor the callback trusts a caller-supplied challenge (see
 * `prepareAuthorization` below). The verifier itself is never returned — it's AES-GCM-encrypted under
 * `flowKey` (aad `${orgId}:oauth_flows:${flowId}`) and stored as `pkce_ciphertext`.
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

type FlowRow = typeof oauthFlows.$inferSelect

/**
 * The checks every sessionless path shares: the flow exists, is still `pending`, hasn't expired, the
 * nonce hash matches (proves the caller holds the exact `state` this org minted — the resolver only
 * proves a flow with this id exists, not that the presented nonce is the right one), and the PKCE
 * verifier decrypts. Does NOT mutate anything — `consumeFlow` and `prepareAuthorization` each decide for
 * themselves what a successful verify means to write, if anything.
 */
async function verifyPendingFlow(
  tx: OrgTx,
  orgId: string,
  flowId: string,
  nonce: string,
  flowKey: Buffer,
): Promise<{ flow: FlowRow; codeVerifier: string } | null> {
  const [flow] = await tx.select().from(oauthFlows).where(eq(oauthFlows.id, flowId))
  if (!flow) return null
  if (flow.status !== 'pending') return null
  if (flow.expiresAt.getTime() <= Date.now()) return null
  if (!hashesEqual(hashToken('oauth_nonce', nonce), flow.nonceHash)) return null

  try {
    const codeVerifier = decrypt(flowKey, flow.pkceCiphertext, flowAad(orgId, flowId)).toString('utf8')
    return { flow, codeVerifier }
  } catch {
    return null
  }
}

export interface PreparedAuthorization {
  provider: MailProvider
  codeChallenge: string
}

/**
 * GET /connect/:provider/start's only path to a `code_challenge`: it MUST be derived server-side from
 * the stored, encrypted verifier, never accepted from the caller (Task 17 review, Important 1) — an
 * unauthenticated caller-supplied challenge would let anyone bounce an arbitrary `state` on to the real
 * provider with a challenge that no longer provably matches the verifier this flow will decrypt at the
 * callback. Verifies but does not consume — the flow is still `pending` (and still usable) after this
 * call; only the callback's `consumeFlow` marks it `consumed`.
 */
export async function prepareAuthorization(deps: ApiFacade, p: { state: string; flowKey: Buffer }): Promise<PreparedAuthorization | null> {
  const parsed = parseState(p.state)
  if (!parsed) return null
  const resolved = await deps.resolveOauthFlow(parsed.flowId)
  if (!resolved) return null

  return deps.withOrg(resolved.orgId, async (tx) => {
    const verified = await verifyPendingFlow(tx, resolved.orgId, parsed.flowId, parsed.nonce, p.flowKey)
    if (!verified) return null
    const codeChallenge = createHash('sha256').update(verified.codeVerifier).digest('base64url')
    return { provider: verified.flow.provider as MailProvider, codeChallenge }
  })
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
 * nonce, wrong status — including a replay of an already-`consumed` flow, expired, an undecryptable
 * verifier) returns `null` — the route answers a generic 400 either way, so none of these are
 * distinguished on the wire.
 */
export async function consumeFlow(deps: ApiFacade, p: { state: string; flowKey: Buffer }): Promise<ConsumedFlow | null> {
  const parsed = parseState(p.state)
  if (!parsed) return null
  const resolved = await deps.resolveOauthFlow(parsed.flowId)
  if (!resolved) return null

  return deps.withOrg(resolved.orgId, async (tx) => {
    const verified = await verifyPendingFlow(tx, resolved.orgId, parsed.flowId, parsed.nonce, p.flowKey)
    if (!verified) return null

    await tx.update(oauthFlows).set({ status: 'consumed' }).where(eq(oauthFlows.id, parsed.flowId))
    return {
      flowId: parsed.flowId,
      orgId: resolved.orgId,
      userId: verified.flow.userId,
      provider: verified.flow.provider as MailProvider,
      platform: verified.flow.platform as 'native' | 'web',
      codeVerifier: verified.codeVerifier,
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
