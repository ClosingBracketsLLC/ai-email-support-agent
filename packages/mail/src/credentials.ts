/**
 * The worker's credential path for a mailbox connection: sealed → DEK re-wrap on first open, then
 * lease-guarded refresh. The api never reaches this file — `mailbox_credentials` REVOKEs it entirely
 * (Task 3); every touch below runs as the platform role via `withPlatform`, or as the org-scoped app
 * role via `withOrg` for the two DEK primitives that require it (`loadOrgDek`/`openSealedForOrg` take
 * an `OrgTx` because they rely on RLS to scope `orgDataKeys`/`workspaces` to one org — there is no
 * `WHERE org_id = …` in their queries, so calling them under `withPlatform` would silently return an
 * ARBITRARY org's key). Every DB touch here is its own short transaction; `provider.refresh()` — the
 * only network call in this file — always runs between transactions, never inside one.
 *
 * Every `mailbox_credentials`/`mailbox_connections` query also carries an explicit `org_id` predicate
 * (defense in depth on top of `withOrg`'s RLS/`withPlatform`'s audit trail): a bad (orgId, connectionId)
 * pair should yield zero rows, not fall through to the AES-GCM AAD mismatch to fail closed.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import {
  decrypt,
  encrypt,
  hashToken,
  hashesEqual,
  sealTo,
  type KekRing,
} from '@aesa/crypto'
import {
  loadOrgDek,
  mailboxConnections,
  mailboxCredentials,
  openSealedForOrg,
  withOrg,
  withPlatform,
  type Db,
} from '@aesa/db'
import { ProviderAuthError } from './errors.ts'
import type { MailboxProvider, TokenSet } from './types.ts'

/** "Fresh" means more than this far from expiry — a job that just barely clears this bar still has
 *  headroom to finish its work before the token expires mid-request. */
const FRESHNESS_WINDOW_MS = 5 * 60 * 1000
/** How long a caller that loses the refresh race waits before re-reading the winner's row. */
const CONTENTION_WAIT_MS = 2000
/** Bounds provider.refresh() comfortably under the 60s lease, so a slow/hung call can't hold the
 *  lease past its own TTL and create a second live holder. */
const REFRESH_TIMEOUT_MS = 30_000
/** A stale-hash failure (someone else rotated the token mid-flight) retries once; a second
 *  consecutive stale-hash failure gives up rather than looping indefinitely. */
const MAX_STALE_HASH_RETRIES = 1

const credentialAad = (orgId: string, connectionId: string) => `${orgId}:mailbox_credentials:${connectionId}`

/** Pure: seal a token set to the org's box public key. The api calls this; it cannot reverse it. */
export async function sealTokens(boxPublicKey: Buffer, tokens: TokenSet): Promise<Buffer> {
  const payload: { refreshToken: string; accessToken: string | null; accessTokenExpiresAt: string | null } = {
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt ? tokens.accessTokenExpiresAt.toISOString() : null,
  }
  return sealTo(boxPublicKey, Buffer.from(JSON.stringify(payload), 'utf8'))
}

export interface CredentialAccess {
  accessToken: string
  selfAddress: string
}

export interface GetAccessTokenDeps {
  db: Db
  ring: KekRing
  provider: Pick<MailboxProvider, 'refresh'>
  clientId: string
  clientSecret: string
  now?: () => Date
  /** Injectable so the lease-contention test doesn't have to burn a real 2 seconds. Defaults to a real wait. */
  sleep?: (ms: number) => Promise<void>
  /** Test-only seam: awaited immediately before the lease-claim UPDATE, so a test can model another
   *  worker completing a full refresh cycle in the gap between this call's initial read and its own
   *  claim attempt (the race fix #1 exists for). No production caller needs this — nothing here calls it. */
  beforeLeaseClaim?: () => Promise<void>
}

/** In-memory shape once a row has been decrypted (and migrated to 'dek' if it was still 'sealed'). */
interface DecryptedCredential {
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: Date | null
  dek: Buffer
  dekVersion: number
}

type CredentialRow = typeof mailboxCredentials.$inferSelect

function isFresh(accessToken: string | null, expiresAt: Date | null, now: Date): accessToken is string {
  return accessToken !== null && expiresAt !== null && expiresAt.getTime() - now.getTime() > FRESHNESS_WINDOW_MS
}

async function readRow(db: Db, jobName: string, orgId: string, connectionId: string): Promise<CredentialRow> {
  const rows = await withPlatform(db, `job:${jobName}:credentials`, (tx) =>
    tx
      .select()
      .from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId))),
  )
  const row = rows[0]
  if (!row) throw new Error(`mailbox_credentials: no row for connection ${connectionId} in org ${orgId}`)
  return row
}

function decryptRow(row: CredentialRow, dek: Buffer, dekVersion: number, aad: string): DecryptedCredential {
  return {
    refreshToken: decrypt(dek, row.refreshTokenCiphertext, aad).toString('utf8'),
    accessToken: row.accessTokenCiphertext ? decrypt(dek, row.accessTokenCiphertext, aad).toString('utf8') : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    dek,
    dekVersion,
  }
}

/**
 * Reads the row and, if it is still `encryption='sealed'` (the api's write), opens it with the org's
 * box private key and re-wraps both tokens under the org DEK — contract step 1. A concurrent worker
 * racing the same first-open is expected: the migrating UPDATE is guarded on `encryption='sealed'`,
 * and losing that race just means re-reading and decrypting the winner's row instead.
 */
async function materialize(deps: GetAccessTokenDeps, orgId: string, connectionId: string, jobName: string): Promise<DecryptedCredential> {
  const row = await readRow(deps.db, jobName, orgId, connectionId)
  const aad = credentialAad(orgId, connectionId)

  if (row.encryption !== 'sealed') {
    const { dek, version } = await withOrg(deps.db, orgId, (tx) => loadOrgDek(tx, deps.ring))
    return decryptRow(row, dek, version, aad)
  }

  const { dek, version, tokens } = await withOrg(deps.db, orgId, async (tx) => {
    const { dek, version } = await loadOrgDek(tx, deps.ring)
    const opened = await openSealedForOrg(tx, deps.ring, row.refreshTokenCiphertext)
    const parsed = JSON.parse(opened.toString('utf8')) as { refreshToken: string; accessToken: string | null; accessTokenExpiresAt: string | null }
    return { dek, version, tokens: parsed }
  })

  const accessTokenExpiresAt = tokens.accessTokenExpiresAt !== null ? new Date(tokens.accessTokenExpiresAt) : null
  const refreshTokenHash = hashToken('refresh', tokens.refreshToken)
  const refreshTokenCiphertext = encrypt(dek, Buffer.from(tokens.refreshToken, 'utf8'), aad)
  const accessTokenCiphertext = tokens.accessToken !== null ? encrypt(dek, Buffer.from(tokens.accessToken, 'utf8'), aad) : null

  const won = await withPlatform(deps.db, `job:${jobName}:credentials`, (tx) =>
    tx
      .update(mailboxCredentials)
      .set({
        refreshTokenCiphertext,
        accessTokenCiphertext,
        accessTokenExpiresAt,
        refreshTokenHash,
        encryption: 'dek',
        dataKeyVersion: version,
      })
      .where(
        and(
          eq(mailboxCredentials.connectionId, connectionId),
          eq(mailboxCredentials.orgId, orgId),
          eq(mailboxCredentials.encryption, 'sealed'),
        ),
      )
      .returning({ connectionId: mailboxCredentials.connectionId }),
  )

  if (won.length > 0) {
    return { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessTokenExpiresAt, dek, dekVersion: version }
  }

  // Lost the migration race — another worker already flipped this row to 'dek'. Re-read and decrypt
  // ITS values rather than trusting the ones we just opened (the winner may have gone on to refresh
  // already, e.g. if it read a since-expired access token).
  const winnerRow = await readRow(deps.db, jobName, orgId, connectionId)
  return decryptRow(winnerRow, dek, version, aad)
}

async function clearLease(db: Db, jobName: string, orgId: string, connectionId: string): Promise<void> {
  await withPlatform(db, `job:${jobName}:credentials`, (tx) =>
    tx
      .update(mailboxCredentials)
      .set({ refreshLockUntil: null })
      .where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId))),
  )
}

/** Re-reads the row once and returns its access token if fresh; throws otherwise. Used both when we
 *  lost the lease race (after the contention wait) and when we lost the persist race. */
async function readFreshOrThrow(
  deps: GetAccessTokenDeps,
  orgId: string,
  connectionId: string,
  jobName: string,
  dek: Buffer,
  aad: string,
  now: Date,
  message: string,
): Promise<string> {
  const row = await readRow(deps.db, jobName, orgId, connectionId)
  const accessToken = row.accessTokenCiphertext ? decrypt(dek, row.accessTokenCiphertext, aad).toString('utf8') : null
  if (isFresh(accessToken, row.accessTokenExpiresAt, now)) return accessToken
  throw new Error(message)
}

/** Bounds provider.refresh() to REFRESH_TIMEOUT_MS: passes an AbortSignal for a well-behaved adapter
 *  to cancel its own fetch with, and independently races the call locally so a non-conforming adapter
 *  can't hold this function past the timeout either (the loser is simply abandoned, never persisted —
 *  the persist fence in getAccessToken is what protects against it finishing later anyway). */
function refreshWithTimeout(
  provider: Pick<MailboxProvider, 'refresh'>,
  connectionId: string,
  params: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<TokenSet> {
  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS)
  return new Promise<TokenSet>((resolve, reject) => {
    let settled = false
    const onTimeout = () => {
      if (settled) return
      settled = true
      reject(new Error(`mailbox_credentials: provider.refresh() for connection ${connectionId} timed out after ${REFRESH_TIMEOUT_MS}ms`))
    }
    signal.addEventListener('abort', onTimeout, { once: true })
    provider.refresh({ ...params, signal }).then(
      (result) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onTimeout)
        resolve(result)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onTimeout)
        reject(err)
      },
    )
  })
}

/**
 * The worker's ONLY path to a usable access token. Every read runs inside `withPlatform`, audited as
 * `job:${jobName}:credentials`. See contract steps 1-4 in the task brief; summarized in the file header.
 */
export async function getAccessToken(deps: GetAccessTokenDeps, orgId: string, connectionId: string, jobName: string): Promise<string> {
  return attemptGetAccessToken(deps, orgId, connectionId, jobName, MAX_STALE_HASH_RETRIES)
}

async function attemptGetAccessToken(
  deps: GetAccessTokenDeps,
  orgId: string,
  connectionId: string,
  jobName: string,
  staleHashRetriesLeft: number,
): Promise<string> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const aad = credentialAad(orgId, connectionId)

  const state = await materialize(deps, orgId, connectionId, jobName)

  if (isFresh(state.accessToken, state.accessTokenExpiresAt, now())) {
    return state.accessToken
  }

  if (deps.beforeLeaseClaim) await deps.beforeLeaseClaim()

  const leaseRows = await withPlatform(deps.db, `job:${jobName}:credentials`, (tx) =>
    tx
      .update(mailboxCredentials)
      .set({ refreshLockUntil: sql`now() + interval '60 seconds'` })
      .where(
        and(
          eq(mailboxCredentials.connectionId, connectionId),
          eq(mailboxCredentials.orgId, orgId),
          or(isNull(mailboxCredentials.refreshLockUntil), lt(mailboxCredentials.refreshLockUntil, sql`now()`)),
        ),
      )
      .returning(),
  )
  const leaseRow = leaseRows[0]

  if (!leaseRow) {
    // Another worker holds the lease. Wait once, outside any transaction, then take whatever it left.
    await sleep(CONTENTION_WAIT_MS)
    return readFreshOrThrow(
      deps,
      orgId,
      connectionId,
      jobName,
      state.dek,
      aad,
      now(),
      `mailbox_credentials: connection ${connectionId} refresh is still in progress`,
    )
  }

  // Re-check freshness against the row AS CLAIMED, not the pre-lease snapshot in `state`: another
  // worker may have completed a full cycle (and cleared the lock) between our initial read and this
  // claim succeeding. If so, there's nothing to refresh — release the lease we didn't need and return.
  const leased = decryptRow(leaseRow, state.dek, state.dekVersion, aad)
  if (isFresh(leased.accessToken, leased.accessTokenExpiresAt, now())) {
    await clearLease(deps.db, jobName, orgId, connectionId)
    return leased.accessToken
  }

  const consumedRefreshToken = leased.refreshToken
  const consumedHash = hashToken('refresh', consumedRefreshToken)

  let refreshed: TokenSet
  try {
    refreshed = await refreshWithTimeout(deps.provider, connectionId, {
      clientId: deps.clientId,
      clientSecret: deps.clientSecret,
      refreshToken: consumedRefreshToken,
    })
  } catch (err) {
    if (!(err instanceof ProviderAuthError)) {
      await clearLease(deps.db, jobName, orgId, connectionId)
      throw err
    }

    // Terminal only if the token we just tried is still the row's CURRENT one — a concurrent worker
    // may have rotated it while our network call was in flight, in which case the failure is stale,
    // not real. Check the current hash and act on it in ONE transaction (no network call in the gap)
    // so a rotation can't land between the check and the write.
    const isCurrent = await withPlatform(deps.db, `job:${jobName}:credentials`, async (tx) => {
      const [currentRow] = await tx
        .select({ refreshTokenHash: mailboxCredentials.refreshTokenHash })
        .from(mailboxCredentials)
        .where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId)))
      const current = currentRow !== undefined && currentRow.refreshTokenHash !== null && hashesEqual(consumedHash, currentRow.refreshTokenHash)

      await tx
        .update(mailboxCredentials)
        .set({ refreshLockUntil: null })
        .where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId)))
      if (current) {
        await tx
          .update(mailboxConnections)
          .set({ status: 'reauth_required' })
          .where(and(eq(mailboxConnections.id, connectionId), eq(mailboxConnections.orgId, orgId)))
      }
      return current
    })

    if (isCurrent) throw err
    if (staleHashRetriesLeft <= 0) throw err
    return attemptGetAccessToken(deps, orgId, connectionId, jobName, staleHashRetriesLeft - 1)
  }

  // Google's refresh grant does not echo a refresh_token; the adapter must synthesize one from the
  // request token — this layer refuses to overwrite the only stored copy with an empty string.
  const newRefreshToken = refreshed.refreshToken
  if (!newRefreshToken) {
    await clearLease(deps.db, jobName, orgId, connectionId)
    throw new Error(`mailbox_credentials: provider.refresh() for connection ${connectionId} returned an empty refresh token`)
  }
  const newAccessToken = refreshed.accessToken
  if (newAccessToken === null) {
    await clearLease(deps.db, jobName, orgId, connectionId)
    throw new Error(`mailbox_credentials: provider.refresh() for connection ${connectionId} returned no access token`)
  }

  // Persist fence: only write if the row's hash still matches the token we consumed. A >60s refresh
  // (slow network, GC pause) can outlive its own lease — if another worker already claimed it fresh
  // and finished first, this UPDATE matches zero rows and we must not clobber their result with ours.
  const persisted = await withPlatform(deps.db, `job:${jobName}:credentials`, (tx) =>
    tx
      .update(mailboxCredentials)
      .set({
        refreshTokenCiphertext: encrypt(state.dek, Buffer.from(newRefreshToken, 'utf8'), aad),
        accessTokenCiphertext: encrypt(state.dek, Buffer.from(newAccessToken, 'utf8'), aad),
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        refreshTokenHash: hashToken('refresh', newRefreshToken),
        refreshLockUntil: null,
      })
      .where(
        and(
          eq(mailboxCredentials.connectionId, connectionId),
          eq(mailboxCredentials.orgId, orgId),
          eq(mailboxCredentials.refreshTokenHash, consumedHash),
        ),
      )
      .returning({ connectionId: mailboxCredentials.connectionId }),
  )

  if (persisted.length === 0) {
    return readFreshOrThrow(
      deps,
      orgId,
      connectionId,
      jobName,
      state.dek,
      aad,
      now(),
      `mailbox_credentials: connection ${connectionId} lost the persist race to a concurrent refresh`,
    )
  }

  return newAccessToken
}
