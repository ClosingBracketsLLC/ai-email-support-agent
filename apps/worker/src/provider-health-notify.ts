/**
 * The `provider_health` notification path — day-deduped insert + `notify.dispatch` enqueue, exactly
 * `reauth-notify.ts`'s shape for exactly the same reason: a credential that has flipped to `dead` is
 * skipped by the resolver from then on (`credential_dead`), so this is the only thing left that can
 * tell the owner their BYOK key stopped working. Shared by `llm.probe` and, from Task 6, by the
 * draft path's own auth refusal.
 */
import { PROVIDER_PRESETS, type LlmProviderId } from '@aesa/contracts'
import { notifications, withOrg, type Db } from '@aesa/db'
import { utcDayString } from './date-utils.ts'

export interface ProviderHealthNotifyDeps {
  db: Db
  /** `notify.dispatch`'s enqueue, injected rather than a `PgBoss` handle — same seam `reauth-notify.ts` takes. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
}

export async function notifyProviderHealth(
  deps: ProviderHealthNotifyDeps,
  orgId: string,
  credentialId: string,
  label: string,
  provider: LlmProviderId,
  now: Date,
): Promise<void> {
  const dedupeKey = `provider_health:${credentialId}:${utcDayString(now)}`
  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({
        orgId,
        kind: 'provider_health',
        title: 'AI provider needs attention',
        body: `${label} was rejected by ${PROVIDER_PRESETS[provider].consentName}. Drafting for agents that use it is paused until you update the key in Settings → AI.`,
        dedupeKey,
        payload: { credentialId },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (notificationId) await deps.enqueueNotify(orgId, notificationId)
}
