/**
 * POST /webhooks/microsoft — Microsoft Graph change notifications (spec §Mailbox providers →
 * Microsoft 365). Unauthenticated by session; the only trust anchor per notification is `clientState`,
 * the random token this app itself generated and handed to Graph at subscribe/renew time
 * (mailbox-renew-watch.ts, `generateToken('action')`), checked here in constant time against the hash
 * `mailbox_connections.push_client_state_hash` stores. Mounted inside server.ts's rate-limited nested
 * routes block — outside the /trpc CSRF guard and outside Better Auth entirely.
 *
 * Two response shapes only: the subscription validation handshake (200 text/plain echo of
 * `validationToken`) and everything else (always 202 — Graph retries the WHOLE batch on anything but
 * 2xx, so one bad or unresolvable item in a batch must never fail the others).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashesEqual, hashToken } from '@aesa/crypto'
import { JOB_NAMES } from '@aesa/queue'
import type { ServerDeps } from '../deps.ts'

const NotificationItem = z.object({
  subscriptionId: z.string().min(1),
  clientState: z.string().optional(),
  changeType: z.string().optional(),
  resourceData: z.object({ id: z.string().optional() }).passthrough().optional(),
}).passthrough()

const NotificationBody = z.object({ value: z.array(NotificationItem) })

export function registerMicrosoftWebhook(routes: FastifyInstance, deps: ServerDeps): void {
  routes.post<{ Querystring: { validationToken?: string } }>('/webhooks/microsoft', async (req, reply) => {
    // The subscription handshake: Graph POSTs with ?validationToken=… (no body, no clientState — the
    // subscription doesn't exist yet) and expects the raw token echoed back as text/plain within 10 s.
    const { validationToken } = req.query
    if (validationToken !== undefined) return reply.code(200).type('text/plain').send(validationToken)

    // A batch shaped wrong isn't a single item's fault — ack 202 rather than 500 (Graph would retry
    // the whole thing either way, and a malformed batch will look exactly the same on retry).
    const parsed = NotificationBody.safeParse(req.body)
    if (!parsed.success) return reply.code(202).send()

    for (const item of parsed.data.value) {
      const resolved = await deps.api.resolveMailboxSubscription(item.subscriptionId)
      if (!resolved) continue

      const presented = hashToken('action', item.clientState ?? '')
      if (resolved.clientStateHash === null || !hashesEqual(presented, resolved.clientStateHash)) {
        req.log.warn({ subscriptionId: item.subscriptionId }, 'webhooks.microsoft_client_state_mismatch')
        continue
      }

      // Graph has no single dedupe id of its own (RULING, task brief): `${subscriptionId}:${resourceId
      // ?? changeType}` accepts that a genuine re-notification of the same message dedupes away too —
      // mailbox.poll-sweep is the safety net (push is an accelerator, never a dependency).
      const dedupeId = `${item.subscriptionId}:${item.resourceData?.id ?? item.changeType}`
      const isNew = await deps.api.recordWebhookEvent('microsoft', dedupeId, {
        subscriptionId: item.subscriptionId,
        resourceData: item.resourceData ?? null,
        changeType: item.changeType ?? null,
      })
      if (!isNew) continue

      await deps.enqueue(
        JOB_NAMES.mailboxSync,
        { orgId: resolved.orgId, connectionId: resolved.connectionId },
        { entityId: resolved.connectionId, debounceSeconds: 10 },
      )
    }

    return reply.code(202).send()
  })
}
