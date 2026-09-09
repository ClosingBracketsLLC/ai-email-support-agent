import type PgBoss from 'pg-boss'
import { notifications, withOrg, type Db } from '@aesa/db'
import { utcDayString } from './date-utils.ts'
import { enqueueNotifyDispatch } from './jobs/notify-dispatch.ts'

/**
 * The `mailbox_reauth` notification path — day-deduped insert + `notify.dispatch` enqueue. Shared by
 * `mailbox.sync` (getAccessToken throwing `ProviderAuthError` mid-poll) and `mailbox.renew-watch`
 * (the same error can surface there too, refreshing the token before a subscribe/renew call) — both
 * are the ONE way a worker discovers a connection needs the owner to reconnect, and a connection that
 * has flipped to `reauth_required` is excluded from both `mailbox.sync`'s lease claim (status must be
 * `connected`) and `mailbox.poll-sweep`'s (a) selection, so this is the only place left that can ever
 * tell the owner about it.
 */
export async function notifyReauthRequired(boss: PgBoss, db: Db, orgId: string, connectionId: string, now: Date): Promise<void> {
  const dedupeKey = `reauth:${connectionId}:${utcDayString(now)}`
  const notificationId = await withOrg(db, orgId, async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({
        orgId,
        kind: 'mailbox_reauth',
        title: 'Reconnect your mailbox',
        body: 'We could not refresh access to your mailbox. Reconnect it to keep receiving support email.',
        dedupeKey,
        payload: { connectionId },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (notificationId) await enqueueNotifyDispatch(boss, orgId, notificationId)
}
