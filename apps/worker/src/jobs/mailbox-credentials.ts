/**
 * `mailbox.store-credentials` and `mailbox.revoke` — the ONLY writer of `mailbox_credentials`
 * (deviation 2 of the phase's plan: the api has no privilege on that table at all, migration 0006).
 *
 * storeCredentialsJob: the api seals a fresh token set to the org's box public key and enqueues this
 * job with the base64 sealed blob as the payload; the sealed payload riding through pg-boss leaks
 * nothing — only this worker's KEK path (via `@aesa/mail`'s `getAccessToken`) can ever open it. The
 * handler DELETEs any existing row for the connection and INSERTs the fresh sealed blob — idempotent
 * by construction (delete+insert), and correct for both a first connect and a reconnect.
 *
 * revokeMailboxJob: mirrors `getAccessToken`'s own platform-read-then-decrypt shape (its internals are
 * private to `@aesa/mail`) to recover the connection's CURRENT refresh token — no lease, no refresh
 * cycle, since the credential is about to be deleted regardless of whether it is still valid. Every
 * network call here (provider.revoke, the push unsubscribe) is best-effort: a revoke that fails
 * upstream (or a mailbox that never even reached a usable access token) must not block the LOCAL
 * cleanup a user's disconnect promised them — the credentials row is deleted and the connection is
 * audited as revoked regardless. Tolerates a missing credentials row (disconnect racing the store job)
 * and a missing connection row (poll-sweep's claim-expiry cleanup racing a disconnect) by simply
 * skipping the network calls that need data neither row can supply.
 */
import { and, eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { decrypt, type KekRing } from '@aesa/crypto'
import {
  auditLog, loadOrgDek, mailboxConnections, mailboxCredentials, openSealedForOrg, withOrg, withPlatform, type Db,
} from '@aesa/db'
import type { MailboxProvider } from '@aesa/mail'
import { defineJob, registerJob, JOB_NAMES, type RegisteredJobDefinition } from '@aesa/queue'
import type { WorkerConfig } from '../config.ts'
import { errorMessage } from '../err-message.ts'
import { resolveMailProvider } from '../mail-provider.ts'

// ---------------------------------------------------------------------------------------------
// mailbox.store-credentials
// ---------------------------------------------------------------------------------------------

export const StoreCredentialsPayload = z.object({ orgId: z.string(), connectionId: z.string(), sealed: z.string() })
export type StoreCredentialsPayload = z.infer<typeof StoreCredentialsPayload>

export const storeCredentialsJob: RegisteredJobDefinition<StoreCredentialsPayload> = defineJob({
  name: JOB_NAMES.storeCredentials,
  schema: StoreCredentialsPayload,
  handler: async () => {
    throw new Error('mailbox.store-credentials: this definition has no bound deps — register it through registerStoreCredentials(boss, deps)')
  },
})

export interface StoreCredentialsDeps {
  db: Db
}

export async function runStoreCredentials(deps: StoreCredentialsDeps, payload: StoreCredentialsPayload): Promise<void> {
  const sealed = Buffer.from(payload.sealed, 'base64')
  const reason = `job:mailbox.store-credentials:${payload.connectionId}`
  await withPlatform(deps.db, reason, async (tx) => {
    await tx
      .delete(mailboxCredentials)
      .where(and(eq(mailboxCredentials.connectionId, payload.connectionId), eq(mailboxCredentials.orgId, payload.orgId)))
    await tx.insert(mailboxCredentials).values({
      connectionId: payload.connectionId,
      orgId: payload.orgId,
      refreshTokenCiphertext: sealed,
      encryption: 'sealed',
    })
  })
}

export async function registerStoreCredentials(boss: PgBoss, deps: StoreCredentialsDeps): Promise<void> {
  const wired: RegisteredJobDefinition<StoreCredentialsPayload> = {
    ...storeCredentialsJob,
    handler: async (ctx) => {
      await runStoreCredentials(deps, ctx.data)
    },
  }
  await registerJob(boss, wired)
}

// ---------------------------------------------------------------------------------------------
// mailbox.revoke
// ---------------------------------------------------------------------------------------------

export const RevokeMailboxPayload = z.object({ orgId: z.string(), connectionId: z.string() })
export type RevokeMailboxPayload = z.infer<typeof RevokeMailboxPayload>

export const revokeMailboxJob: RegisteredJobDefinition<RevokeMailboxPayload> = defineJob({
  name: JOB_NAMES.revokeMailbox,
  schema: RevokeMailboxPayload,
  handler: async () => {
    throw new Error('mailbox.revoke: this definition has no bound deps — register it through registerRevokeMailbox(boss, deps)')
  },
})

export interface RevokeMailboxDeps {
  db: Db
  ring: KekRing
  config: WorkerConfig
  logger: pino.Logger
  /** Test seam; production always resolves the real Gmail/Graph adapter. */
  providerFactory?: (provider: 'gmail' | 'microsoft') => MailboxProvider
}

type CredentialRow = typeof mailboxCredentials.$inferSelect

/** Recovers { refreshToken, accessToken } from a credentials row whatever its `encryption` state —
 *  mirrors `@aesa/mail`'s private `materialize()`/`decryptRow()` shape, minus the lease/migration-write
 *  dance that function owns (irrelevant here: the row is about to be deleted either way). */
async function readTokens(
  deps: { db: Db; ring: KekRing },
  orgId: string,
  connectionId: string,
  row: CredentialRow,
): Promise<{ refreshToken: string; accessToken: string | null }> {
  const aad = `${orgId}:mailbox_credentials:${connectionId}`
  if (row.encryption === 'sealed') {
    const opened = await withOrg(deps.db, orgId, (tx) => openSealedForOrg(tx, deps.ring, row.refreshTokenCiphertext))
    const parsed = JSON.parse(opened.toString('utf8')) as { refreshToken: string; accessToken: string | null }
    return { refreshToken: parsed.refreshToken, accessToken: parsed.accessToken }
  }
  const { dek } = await withOrg(deps.db, orgId, (tx) => loadOrgDek(tx, deps.ring))
  const refreshToken = decrypt(dek, row.refreshTokenCiphertext, aad).toString('utf8')
  const accessToken = row.accessTokenCiphertext ? decrypt(dek, row.accessTokenCiphertext, aad).toString('utf8') : null
  return { refreshToken, accessToken }
}

export async function runRevokeMailbox(deps: RevokeMailboxDeps, payload: RevokeMailboxPayload): Promise<void> {
  const { orgId, connectionId } = payload
  const reason = `job:mailbox.revoke:${connectionId}`

  const connRows = await withOrg(deps.db, orgId, (tx) =>
    tx
      .select({
        provider: mailboxConnections.provider,
        emailAddress: mailboxConnections.emailAddress,
        pushSubscriptionId: mailboxConnections.pushSubscriptionId,
      })
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, connectionId)),
  )
  const connRow = connRows[0]

  const credRows = await withPlatform(deps.db, reason, (tx) =>
    tx
      .select()
      .from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId))),
  )
  const credRow = credRows[0]

  if (connRow && credRow) {
    const provider = connRow.provider as 'gmail' | 'microsoft'
    const oauth = provider === 'gmail' ? deps.config.gmailOauth : deps.config.msOauth
    try {
      const { refreshToken, accessToken } = await readTokens(deps, orgId, connectionId, credRow)
      const providerObj = (deps.providerFactory ?? resolveMailProvider)(provider)

      try {
        // clientId/clientSecret are UNUSED by both real revoke implementations today (gmail's only
        // sends the token; graph has no revoke endpoint at all) — passed through anyway for shape
        // conformance and so a future provider that DOES need them just works.
        await providerObj.revoke({ clientId: oauth?.clientId ?? '', clientSecret: oauth?.clientSecret?.expose() ?? '', refreshToken })
      } catch (err) {
        deps.logger.warn({ connectionId, provider, error: errorMessage(err) }, 'mailbox.revoke_provider_revoke_failed')
      }

      if (connRow.pushSubscriptionId && accessToken) {
        try {
          const client = providerObj.client(accessToken, connRow.emailAddress)
          await client.unsubscribe(connRow.pushSubscriptionId)
        } catch (err) {
          deps.logger.warn({ connectionId, provider, error: errorMessage(err) }, 'mailbox.revoke_unsubscribe_failed')
        }
      }
    } catch (err) {
      deps.logger.warn({ connectionId, error: errorMessage(err) }, 'mailbox.revoke_token_read_failed')
    }
  }

  await withPlatform(deps.db, reason, async (tx) => {
    await tx.delete(mailboxCredentials).where(and(eq(mailboxCredentials.connectionId, connectionId), eq(mailboxCredentials.orgId, orgId)))
    await tx.insert(auditLog).values({
      orgId, actor: 'system:mailbox.revoke', action: 'mailbox.revoked', entityType: 'mailbox_connection', entityId: connectionId, detail: {},
    })
  })
}

export async function registerRevokeMailbox(boss: PgBoss, deps: RevokeMailboxDeps): Promise<void> {
  const wired: RegisteredJobDefinition<RevokeMailboxPayload> = {
    ...revokeMailboxJob,
    handler: async (ctx) => {
      await runRevokeMailbox(deps, ctx.data)
    },
  }
  await registerJob(boss, wired)
}
