/**
 * The worker's credential path for a mailbox connection: sealed → DEK re-wrap on first open, then
 * lease-guarded refresh. The api never reaches this file — `mailbox_credentials` REVOKEs it entirely
 * (Task 3); every touch below runs as the platform role via `withPlatform`, or as the org-scoped app
 * role via `withOrg` for the two DEK primitives that require it (`loadOrgDek`/`openSealedForOrg` take
 * an `OrgTx` because they rely on RLS to scope `orgDataKeys`/`workspaces` to one org — there is no
 * `WHERE org_id = …` in their queries, so calling them under `withPlatform` would silently return an
 * ARBITRARY org's key). Every DB touch here is its own short transaction; `provider.refresh()` — the
 * only network call in this file — always runs between transactions, never inside one.
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

async function readRow(db: Db, jobName: string, connectionId: string): Promise<CredentialRow> {
  const rows = await withPlatform(db, `job:${jobName}:credentials`, (tx) =>
    tx.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, connectionId)),
  )
  const row = rows[0]
  if (!row) throw new Error(`mailbox_credentials: no row for connection ${connectionId}`)
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
  const row = await readRow(deps.db, jobName, connectionId)
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
      .where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.encryption, 'sealed')))
      .returning({ connectionId: mailboxCredentials.connectionId }),
  )

  if (won.length > 0) {
    return { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessTokenExpiresAt, dek, dekVersion: version }
  }

  // Lost the migration race — another worker already flipped this row to 'dek'. Re-read and decrypt
  // ITS values rather than trusting the ones we just opened (the winner may have gone on to refresh
  // already, e.g. if it read a since-expired access token).
  const winnerRow = await readRow(deps.db, jobName, connectionId)
  return decryptRow(winnerRow, dek, version, aad)
}

/**
 * The worker's ONLY path to a usable access token. Every read runs inside `withPlatform`, audited as
 * `job:${jobName}:credentials`. See contract steps 1-4 in the task brief; summarized in the file header.
 */
export async function getAccessToken(deps: GetAccessTokenDeps, orgId: string, connectionId: string, jobName: string): Promise<string> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const aad = credentialAad(orgId, connectionId)

  const state = await materialize(deps, orgId, connectionId, jobName)

  if (isFresh(state.accessToken, state.accessTokenExpiresAt, now())) {
    return state.accessToken
  }

  const leased = await withPlatform(deps.db, `job:${jobName}:credentials`, (tx) =>
    tx
      .update(mailboxCredentials)
      .set({ refreshLockUntil: sql`now() + interval '60 seconds'` })
      .where(
        and(
          eq(mailboxCredentials.connectionId, connectionId),
          or(isNull(mailboxCredentials.refreshLockUntil), lt(mailboxCredentials.refreshLockUntil, sql`now()`)),
        ),
      )
      .returning({ connectionId: mailboxCredentials.connectionId }),
  )

  if (leased.length === 0) {
    // Another worker holds the lease. Wait once, outside any transaction, then take whatever it left.
    await sleep(CONTENTION_WAIT_MS)
    const row = await readRow(deps.db, jobName, connectionId)
    const accessToken = row.accessTokenCiphertext ? decrypt(state.dek, row.accessTokenCiphertext, aad).toString('utf8') : null
    if (isFresh(accessToken, row.accessTokenExpiresAt, now())) return accessToken
    throw new Error(`mailbox_credentials: connection ${connectionId} refresh is still in progress`)
  }

  let refreshed: TokenSet
  try {
    refreshed = await deps.provider.refresh({ clientId: deps.clientId, clientSecret: deps.clientSecret, refreshToken: state.refreshToken })
  } catch (err) {
    if (!(err instanceof ProviderAuthError)) {
      await withPlatform(deps.db, `job:${jobName}:credentials`, (tx) =>
        tx.update(mailboxCredentials).set({ refreshLockUntil: null }).where(eq(mailboxCredentials.connectionId, connectionId)),
      )
      throw err
    }

    // Terminal only if the token we just tried is still the row's CURRENT one — a concurrent worker
    // may have rotated it while our network call was in flight, in which case the failure is stale,
    // not real: release our lease and retry against the row it left behind.
    const attemptedHash = hashToken('refresh', state.refreshToken)
    const currentRow = await readRow(deps.db, jobName, connectionId)
    const isCurrent = currentRow.refreshTokenHash !== null && hashesEqual(attemptedHash, currentRow.refreshTokenHash)

    await withPlatform(deps.db, `job:${jobName}:credentials`, async (tx) => {
      await tx.update(mailboxCredentials).set({ refreshLockUntil: null }).where(eq(mailboxCredentials.connectionId, connectionId))
      if (isCurrent) {
        await tx.update(mailboxConnections).set({ status: 'reauth_required' }).where(eq(mailboxConnections.id, connectionId))
      }
    })

    if (isCurrent) throw err
    return getAccessToken(deps, orgId, connectionId, jobName)
  }

  const newAccessToken = refreshed.accessToken
  if (newAccessToken === null) {
    throw new Error(`mailbox_credentials: provider.refresh() for connection ${connectionId} returned no access token`)
  }

  await withPlatform(deps.db, `job:${jobName}:credentials`, (tx) =>
    tx
      .update(mailboxCredentials)
      .set({
        // Microsoft rotates the refresh token on every use — always store the one just returned.
        refreshTokenCiphertext: encrypt(state.dek, Buffer.from(refreshed.refreshToken, 'utf8'), aad),
        accessTokenCiphertext: encrypt(state.dek, Buffer.from(newAccessToken, 'utf8'), aad),
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        refreshTokenHash: hashToken('refresh', refreshed.refreshToken),
        refreshLockUntil: null,
      })
      .where(eq(mailboxCredentials.connectionId, connectionId)),
  )

  return newAccessToken
}
