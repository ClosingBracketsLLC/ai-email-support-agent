/**
 * The `send.execute` job (spec §Send): turns ONE owner-approved draft into a real, threaded email to
 * the customer, and records that it went out exactly once.
 *
 * Ported from doge-buddy's `apps/ops/src/proposals/apply-support-reply.ts` (`applySupportReply`'s
 * pinned step order, `completeSend`'s idempotent tail and conditional ticket flip,
 * `findAlreadySentMessageId`'s scan) plus `apply-shared.ts`'s `failStaleAndHandBack`, adapted to
 * this codebase: the reference's single `proposals` row becomes an `outbound_sends` ledger row plus
 * a `drafts` row, `awaiting_approval` becomes `awaiting_review`, and the gmail-only client becomes
 * `@aesa/mail`'s provider-agnostic port.
 *
 * **Two failure modes this file exists to prevent, in priority order:**
 *
 *  1. **A double send.** Neither provider offers an idempotency key, so the send itself cannot be
 *     made idempotent — instead every reply carries `X-Aesa-Draft: <draftId>`, and a re-entered run
 *     reads the thread back looking for its own marker BEFORE doing anything else. Deliberately not
 *     "anything newer than the approval": the mailbox is also the owner's own manual channel, and
 *     their hand-typed reply in the crash window must never be mistaken for ours (which would
 *     silently drop the approved reply while marking the send delivered).
 *  2. **A stale send.** An approval is a snapshot of a conversation. If the customer wrote again
 *     between the draft and the owner's tap, the draft may now be wrong ("your refund is on the way"
 *     answering "never mind, it arrived"). Any inbound newer than `drafts.thread_snapshot_at` aborts
 *     the send and hands the ticket back to the agent.
 *
 * **The recovery scan runs FIRST — before staleness and before the pre-checks.** A completed send is
 * a fait accompli: once the customer has the mail the only correct continuation is the post-send
 * bookkeeping (all of it idempotent and guarded), never a refusal claiming it never sent. Only the
 * checks that make recovery itself impossible run ahead of it: an unclaimable ledger row, a missing
 * agent (no persona, no From address, nothing to reconstruct a `messages` row from), an unusable
 * draft, and a credential we cannot even build a client with.
 *
 * The kill levers sit on BOTH sides of that line (controller ruling, fix round 1). On a fresh
 * `approved` draft nothing has been attempted, so they refuse at step 1. On a `sending` draft — a
 * crash re-entry — they are deferred past the scan: a lever flipped after a reply was already
 * delivered must not turn that reply into a `held` send the owner is told never went out. A scan HIT
 * completes regardless of the levers; a MISS applies them before staleness, moving the send AND the
 * draft to `held` together.
 *
 * **Refusals vs throws.** A *refusal* is terminal (`→ failed` + audit + escalation + return, never a
 * throw): none of them get better on a retry, and the owner tapped Approve — a silent, log-only
 * failure of an approved send is unacceptable. Throws are reserved for a state this run could not
 * ESTABLISH (an unverifiable thread, a failed send). Those must retry, because the alternative is
 * sending blind.
 *
 * **Transaction discipline.** Every database touch is a short `withOrg` transaction; the credential
 * lease, the limiter wait, the recovery scan, `sendReply` and the read-back all happen OUTSIDE every
 * one of them (the app role's 5 s idle-in-transaction timeout would turn a slow provider call into a
 * killed connection). The claim (step 1) and the pre-send flip (step 8) are each ONE statement set in
 * ONE transaction. The api never runs any of this: sending is worker-only.
 */
import { and, asc, eq, gt, lte, ne, or, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import {
  appendSignature, clearRedraftCycle, INVARIANTS, validateReplyBody,
} from '@aesa/core'
import type { KekRing } from '@aesa/crypto'
import {
  agentCategoryPolicies, agents, audit, bumpMeter, drafts, escalateTicket, mailboxConnections,
  messages, notifications, outboundSends, platformState, SEND_METERS, tickets, withOrg, workspaces,
  type Db, type OrgTx,
} from '@aesa/db'
import {
  buildReferences, getAccessToken, MARKER_HEADER, MessageGoneError, ProviderAuthError,
  type MailboxClient, type MailboxProvider, type MailLimiter,
} from '@aesa/mail'
import { defineJob, enqueue, JOB_NAMES, registerJob, type JobDefinition } from '@aesa/queue'
import type { WorkerConfig } from '../config.ts'
import { utcDayString } from '../date-utils.ts'
import { buildReplyPolicy, personaFor } from '../drafting/policy.ts'
import { errorMessage } from '../err-message.ts'
import { resolveMailProvider } from '../mail-provider.ts'
import { notifyReauthRequired } from '../reauth-notify.ts'

/**
 * How many messages the recovery scan may examine on one thread. A THROW, never a slice: doge-buddy
 * fix round 1, CRITICAL 1 — a truncated scan silently reported "not sent" and duplicated a
 * customer-visible reply. Past this many unverifiable messages the scan cannot cheaply prove
 * whether we already sent, so the run refuses to guess and retries instead.
 */
export const RECOVERY_SCAN_LIMIT = 50

/** `Subject: Re: …` stays under RFC 5322's 998-octet line limit on the ASCII path. */
export const OUTBOUND_SUBJECT_MAX_CHARS = 900

/** `outbound_sends.last_error` for the staleness refusal — the api's review surface reads it. */
export const STALE_ERROR = 'stale: newer customer message'

/** How long a claim released for a retry-later (an unverifiable thread) waits before it is due again. */
const RELEASE_RETRY_SECONDS = 60

const SEND_ACTOR = `system:${JOB_NAMES.sendExecute}` as const

/** Owner-facing copy for the kill levers, in the order step 1 evaluates them. */
const LEVER_WORDS = {
  platform_killswitch: 'sending is paused across the platform',
  workspace_kill_switch: 'your workspace kill switch is on',
  agent_disabled: 'the agent is switched off for this workspace',
  agent_inactive: 'this agent is not active',
  connection_unavailable: 'this mailbox is not connected',
  category_off: "the agent is switched off for this ticket's category",
} as const
type KillLever = keyof typeof LEVER_WORDS

const HOLD_BODY = 'The approved reply is on hold and will not go out until this is switched back on.'
const STALE_TITLE = 'Your approved reply was not sent'
const STALE_BODY =
  'The customer wrote again after this reply was approved, so nothing was sent. The agent is re-drafting — ' +
  're-approve once the fresh draft arrives.'

export const SendExecutePayload = z.object({ orgId: z.string(), sendId: z.string() })
export type SendExecutePayload = z.infer<typeof SendExecutePayload>

/**
 * The importable definition: producers (the api's approve mutation, Task 14's due-send sweep, this
 * job's own retry-later release) `enqueue()` against this — which only ever reads `.name`/`.schema`.
 * `registerSendExecute` builds the deps-bound definition.
 *
 * `retryLimit: 5` with backoff: a provider 5xx or a busy thread is worth several attempts, and every
 * re-entry scans for the marker first, so a retry can never duplicate a delivered reply. The last
 * attempt dead-letters (step 12) rather than disappearing into pg-boss's `failed` state.
 */
export const sendExecuteJob: JobDefinition<SendExecutePayload> = defineJob({
  name: JOB_NAMES.sendExecute,
  schema: SendExecutePayload,
  queue: { expireInSeconds: INVARIANTS.SEND_QUEUE_EXPIRE_SECONDS, retryLimit: 5, retryDelay: 30, retryBackoff: true },
  handler: async () => {
    throw new Error('send.execute: this definition has no bound deps — register it through registerSendExecute(boss, deps)')
  },
})

export interface SendExecuteDeps {
  db: Db
  ring: KekRing
  config: WorkerConfig
  /** MUST be the same instance `mailbox.sync` holds — per-connection concurrency 1 is what
   *  serializes a send against a poll of the same mailbox (index.ts creates exactly one). */
  limiter: MailLimiter
  logger: pino.Logger
  /** index.ts wires this to `enqueueNotifyDispatch`. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  /** The stale hand-back and the inbound-landed-mid-send hand-back both re-run the agent. */
  enqueueDraft: (orgId: string, ticketId: string) => Promise<void>
  /** Phase 5 wires `memory.capture` here; Phase 3 passes a no-op. */
  onSent?: (p: { orgId: string; ticketId: string; draftId: string }) => Promise<void>
  /** Test seam for the mailbox client; production builds it off `providerFactory`. */
  clientFactory?: (provider: 'gmail' | 'microsoft', accessToken: string, selfAddress: string) => MailboxClient
  /** Test seam for the whole adapter (covers `.refresh` for `getAccessToken` too). */
  providerFactory?: (provider: 'gmail' | 'microsoft') => MailboxProvider
  now?: () => Date
}

export interface SendExecuteContext {
  signal: AbortSignal
  /** 1-based; `job.retryCount + 1`. */
  attempt: number
  /** `job.retryCount >= job.retryLimit` — pg-boss will not run this payload again. */
  lastAttempt: boolean
}

export async function registerSendExecute(boss: PgBoss, deps: SendExecuteDeps): Promise<void> {
  const wired: JobDefinition<SendExecutePayload> = {
    ...sendExecuteJob,
    handler: async (ctx) => {
      const retryCount = ctx.job.retryCount ?? 0
      const retryLimit = ctx.job.retryLimit ?? (sendExecuteJob.queue.retryLimit ?? 0)
      await runSendExecute(deps, ctx.data, { signal: ctx.signal, attempt: retryCount + 1, lastAttempt: retryCount >= retryLimit })
    },
  }
  await registerJob(boss, wired)
}

export async function enqueueSendExecute(
  boss: PgBoss, orgId: string, sendId: string, opts?: { startAfter?: Date },
): Promise<string | null> {
  return enqueue(boss, sendExecuteJob, { orgId, sendId }, { entityId: sendId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) })
}

// ---------------------------------------------------------------------------
// Step 1: the claim and everything it reads
// ---------------------------------------------------------------------------

interface ClaimedSend {
  claimToken: string
  send: { id: string; draftId: string; ticketId: string; connectionId: string; agentId: string | null; providerDraftId: string | null }
  draft: { id: string; status: string; finalBody: string | null; threadSnapshotAt: Date; customerLanguage: string | null; categoryId: string | null }
  ticket: {
    id: string; status: string; subject: string | null; customerEmail: string | null
    providerThreadId: string; language: string | null; aiHandledMonth: string | null
  }
  agent: {
    id: string; status: string; address: string; replyFromAddress: string | null; signature: string
    domain: string; displayName: string; personaPreset: string; personaText: string; guidanceExtra: string
  } | null
  connection: { status: string; provider: string; emailAddress: string }
  workspace: {
    agentEnabled: boolean; killSwitch: boolean; allowedUrlHosts: string[]; allowedEmailDomains: string[]
    contactPhone: string | null; contactUrls: string[]; locale: string; operatingGuidance: string
  }
  platformKillSwitch: boolean
  categoryMode: 'off' | 'review' | 'auto'
}

/**
 * ONE transaction: the CAS claim plus every uncached input the rest of the run needs.
 *
 * The predicate admits a row that is `queued` and due, OR one whose previous claim has EXPIRED —
 * that second arm is what makes a crashed run recoverable at all (step 9 collapses the horizon to
 * `now` precisely so the pg-boss retry can reclaim immediately and scan first). A live claim held by
 * another worker, a `held`/`sent`/`failed` row, or a future `send_after` all match nothing.
 *
 * The expiry comparison is `claim_expires_at <= now`, not `<`: step 9 writes the horizon as EXACTLY
 * its own `now`, and a strict `<` would make a same-instant retry (a fast in-process retry, or any
 * clock with second granularity) refuse to reclaim the very row that collapse exists to free.
 */
async function claimSend(deps: SendExecuteDeps, orgId: string, sendId: string, now: Date): Promise<ClaimedSend | null> {
  const claimToken = crypto.randomUUID()
  return withOrg(deps.db, orgId, async (tx) => {
    const [send] = await tx
      .update(outboundSends)
      .set({
        status: 'claimed',
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + INVARIANTS.SEND_CLAIM_HORIZON_SECONDS * 1000),
        claimToken,
        attempts: sql`${outboundSends.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(outboundSends.id, sendId),
          or(eq(outboundSends.status, 'queued'), eq(outboundSends.status, 'claimed')),
          lte(outboundSends.sendAfter, now),
          or(eq(outboundSends.status, 'queued'), lte(outboundSends.claimExpiresAt, now)),
        ),
      )
      .returning({
        id: outboundSends.id, draftId: outboundSends.draftId, ticketId: outboundSends.ticketId,
        connectionId: outboundSends.connectionId, agentId: outboundSends.agentId,
        providerDraftId: outboundSends.providerDraftId,
      })
    if (!send) return null

    const [draft] = await tx
      .select({
        id: drafts.id, status: drafts.status, finalBody: drafts.finalBody, threadSnapshotAt: drafts.threadSnapshotAt,
        customerLanguage: drafts.customerLanguage, categoryId: drafts.categoryId,
      })
      .from(drafts)
      .where(eq(drafts.id, send.draftId))
    if (!draft) throw new Error(`send.execute: send ${sendId} references a missing draft ${send.draftId}`)

    const [ticket] = await tx
      .select({
        id: tickets.id, status: tickets.status, subject: tickets.subject, customerEmail: tickets.customerEmail,
        providerThreadId: tickets.providerThreadId, language: tickets.language, aiHandledMonth: tickets.aiHandledMonth,
      })
      .from(tickets)
      .where(eq(tickets.id, send.ticketId))
    if (!ticket) throw new Error(`send.execute: send ${sendId} references a missing ticket ${send.ticketId}`)

    // The send row's OWN agent (nullable: deleting an agent nulls it). Never re-routed here — the
    // persona, signature and From address the owner reviewed are the ones that must go out.
    const [resolvedAgent] = send.agentId
      ? await tx
          .select({
            id: agents.id, status: agents.status, address: agents.address, replyFromAddress: agents.replyFromAddress,
            signature: agents.signature, domain: agents.domain, displayName: agents.displayName,
            personaPreset: agents.personaPreset, personaText: agents.personaText, guidanceExtra: agents.guidanceExtra,
          })
          .from(agents)
          .where(eq(agents.id, send.agentId))
          .limit(1)
      : []

    const [connection] = await tx
      .select({ status: mailboxConnections.status, provider: mailboxConnections.provider, emailAddress: mailboxConnections.emailAddress })
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, send.connectionId))
    if (!connection) throw new Error(`send.execute: send ${sendId} references a missing connection ${send.connectionId}`)

    const [workspace] = await tx
      .select({
        agentEnabled: workspaces.agentEnabled, killSwitch: workspaces.killSwitch,
        allowedUrlHosts: workspaces.allowedUrlHosts, allowedEmailDomains: workspaces.allowedEmailDomains,
        contactPhone: workspaces.contactPhone, contactUrls: workspaces.contactUrls, locale: workspaces.locale,
        operatingGuidance: workspaces.operatingGuidance,
      })
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId))
    if (!workspace) throw new Error(`send.execute: org ${orgId} has no workspace row`)

    const [lever] = await tx.select({ value: platformState.value }).from(platformState).where(eq(platformState.key, 'killswitch.global'))

    let categoryMode: 'off' | 'review' | 'auto' = 'review'
    if (resolvedAgent && draft.categoryId) {
      const [policy] = await tx
        .select({ mode: agentCategoryPolicies.mode })
        .from(agentCategoryPolicies)
        .where(and(eq(agentCategoryPolicies.agentId, resolvedAgent.id), eq(agentCategoryPolicies.categoryId, draft.categoryId)))
      if (policy) categoryMode = policy.mode as 'off' | 'review' | 'auto'
    }

    return {
      claimToken, send, draft, ticket, agent: resolvedAgent ?? null, connection, workspace,
      platformKillSwitch: lever?.value === true, categoryMode,
    }
  })
}

/**
 * The first lever that is on, in the spec's order, or null. Pure — which is what lets `afterClaim`
 * evaluate it once and apply it at either of two points (see the file header). The `agent === null`
 * arm is a formality by the time the deferred call runs: `afterClaim` refuses a missing agent row
 * ahead of the scan for every draft status, since nothing can be sent OR recovered without one.
 */
function firstKillLever(c: ClaimedSend): KillLever | null {
  if (c.platformKillSwitch) return 'platform_killswitch'
  if (c.workspace.killSwitch) return 'workspace_kill_switch'
  if (!c.workspace.agentEnabled) return 'agent_disabled'
  if (c.agent === null || c.agent.status !== 'active') return 'agent_inactive'
  if (c.connection.status !== 'connected') return 'connection_unavailable'
  if (c.categoryMode === 'off') return 'category_off'
  return null
}

// ---------------------------------------------------------------------------
// The landings
// ---------------------------------------------------------------------------

interface Landing {
  deps: SendExecuteDeps
  orgId: string
  sendId: string
  draftId: string
  ticketId: string
  connectionId: string
  now: Date
  day: string
}

/**
 * `claimed → held` + `approved | sending → held` + audit + ONE day-scoped page. Never throws.
 *
 * The draft guard covers `sending` as well as `approved` because a lever can also be applied on a
 * crash RE-ENTRY, after the recovery scan proved nothing was delivered (controller ruling, fix round
 * 1). A `held` send beside a permanently `sending` draft is unrecoverable — no sweep selects either
 * — so the two must always move together; `draftTransitions` allows `sending → held` for this.
 */
async function landHeld(l: Landing, lever: KillLever): Promise<void> {
  const notificationId = await withOrg(l.deps.db, l.orgId, async (tx) => {
    await setSendStatus(tx, l.sendId, 'held', { lastError: `held:${lever}`, now: l.now })
    await tx
      .update(drafts)
      .set({ status: 'held' })
      .where(and(eq(drafts.id, l.draftId), or(eq(drafts.status, 'approved'), eq(drafts.status, 'sending'))))
    await audit(tx, {
      actor: SEND_ACTOR, action: 'send.held', entityType: 'outbound_send', entityId: l.sendId,
      detail: { lever, ticketId: l.ticketId, draftId: l.draftId },
    })
    const [row] = await tx
      .insert(notifications)
      .values({
        orgId: l.orgId, kind: 'escalation',
        title: `Reply on hold — ${LEVER_WORDS[lever]}`,
        body: HOLD_BODY,
        dedupeKey: `send_held:${l.sendId}:${l.day}`,
        payload: { ticketId: l.ticketId, draftId: l.draftId },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (notificationId) await l.deps.enqueueNotify(l.orgId, notificationId)
}

/**
 * The terminal-refusal path shared by the third-pass guardrail failure, the send pre-checks and the
 * "draft is no longer approved" exit: the send and the draft fail, the ticket goes to the owner, and
 * the caller returns. Never throws.
 *
 * `escalate` is false for the not-approved case: a draft that is `rejected`/`superseded` was already
 * dispositioned by the owner or by a newer draft, and escalating the ticket on top of that would page
 * about a send nobody is waiting on.
 */
async function landTerminal(l: Landing, reason: string, opts: { escalate: boolean } = { escalate: true }): Promise<void> {
  const notificationId = await withOrg(l.deps.db, l.orgId, async (tx) => {
    await setSendStatus(tx, l.sendId, 'failed', { lastError: reason, now: l.now })
    // The draft fails only when the send's failure is NEWS about a draft still awaiting delivery.
    // The one `escalate: false` caller is the not-approved exit, where the draft is already
    // `rejected`/`superseded` — overwriting that with `failed` would erase the owner's own decision.
    if (opts.escalate) {
      await tx
        .update(drafts)
        .set({ status: 'failed' })
        .where(and(eq(drafts.id, l.draftId), or(eq(drafts.status, 'approved'), eq(drafts.status, 'sending'))))
    }
    await audit(tx, {
      actor: SEND_ACTOR, action: 'send.failed', entityType: 'outbound_send', entityId: l.sendId,
      detail: { reason, ticketId: l.ticketId, draftId: l.draftId },
    })
    if (!opts.escalate) return undefined
    const { notificationId } = await escalateTicket(tx, {
      orgId: l.orgId, ticketId: l.ticketId, fromStatus: 'awaiting_review', reason: 'send_failed',
      day: l.day, now: l.now, draftId: l.draftId, actor: SEND_ACTOR, auditAction: 'ticket.escalated',
      // Reason-scoped, like `ticket.draft`'s cap key: a ticket that already paged today for a
      // different reason (a blocked draft the owner then fixed and re-approved) must still page for
      // the send failure, or the flip to `needs_owner` happens silently.
      dedupeKey: `send_failed:${l.ticketId}:${l.day}`,
      detail: { sendId: l.sendId, error: reason },
    })
    return notificationId
  })
  if (notificationId) await l.deps.enqueueNotify(l.orgId, notificationId)
}

/**
 * Step 5's landing (doge-buddy `failStaleAndHandBack`). ONE transaction, then the page and the
 * re-draft enqueue outside it.
 *
 * `lastAgentRunAt: null` is load-bearing, not hygiene: the newer message's provider timestamp can
 * PREDATE the wall-clock claim stamp of the run that produced this draft, in which case the
 * re-draft's own claim CAS ("a new inbound arrived since the last run") sees nothing new and no-ops
 * until the stuck branch eventually fires. Clearing the stamp puts the ticket back in "never run"
 * territory so the re-run claims immediately.
 *
 * It deliberately does NOT call `clearRedraftCycle()`: nothing shipped, so the owner's correction is
 * still UNFULFILLED and must ride into the fresh draft. (Contrast `completeSend`'s hand-back, which
 * DOES clear it precisely because the reply already went out.)
 */
async function landStale(l: Landing, threadSnapshotAt: Date, newerInboundAt: Date | null): Promise<void> {
  const notificationId = await withOrg(l.deps.db, l.orgId, async (tx) => {
    await setSendStatus(tx, l.sendId, 'failed', { lastError: STALE_ERROR, now: l.now })
    // `sending` too: a crash re-entry whose scan MISSED can reach staleness with the draft already
    // flipped by the crashed attempt's step 8, and leaving it `sending` strands it forever.
    await tx
      .update(drafts)
      .set({ status: 'failed' })
      .where(and(eq(drafts.id, l.draftId), or(eq(drafts.status, 'approved'), eq(drafts.status, 'sending'))))
    await tx
      .update(tickets)
      .set({ status: 'triaged', lastAgentRunAt: null })
      .where(and(eq(tickets.id, l.ticketId), eq(tickets.status, 'awaiting_review')))
    await audit(tx, {
      actor: SEND_ACTOR, action: 'send.stale', entityType: 'outbound_send', entityId: l.sendId,
      detail: {
        ticketId: l.ticketId, draftId: l.draftId,
        threadSnapshotAt: threadSnapshotAt.toISOString(),
        newerInboundAt: newerInboundAt?.toISOString() ?? null,
      },
    })
    const [row] = await tx
      .insert(notifications)
      .values({
        orgId: l.orgId, kind: 'escalation', title: STALE_TITLE, body: STALE_BODY,
        dedupeKey: `send_stale:${l.sendId}`, payload: { ticketId: l.ticketId },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (notificationId) await l.deps.enqueueNotify(l.orgId, notificationId)
  // Best-effort: the ticket is already `triaged`, so the backstop sweep re-runs the agent even if
  // this enqueue never lands.
  await l.deps.enqueueDraft(l.orgId, l.ticketId)
}

/**
 * Step 12. Called only on the LAST attempt, immediately before the error is rethrown.
 *
 * It refuses to touch a row that is already `sent`: `completeSend`'s post-commit hooks
 * (`enqueueDraft`, and Phase 5's `memory.capture` behind `onSent`) run outside its transaction, so a
 * throw from one of them reaches here for a reply the customer already has. Flipping `sent → failed`
 * there is an illegal edge, contradicts `sent_at`/`provider_message_id`, and makes the row eligible
 * for Task 14's re-approve re-queue — a genuine double-send hazard.
 */
async function landDeadLetter(deps: SendExecuteDeps, orgId: string, sendId: string, now: Date, err: unknown): Promise<void> {
  const reason = errorMessage(err)
  const day = utcDayString(now)
  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const [send] = await tx
      .select({ draftId: outboundSends.draftId, ticketId: outboundSends.ticketId, status: outboundSends.status })
      .from(outboundSends)
      .where(eq(outboundSends.id, sendId))
    if (!send) return undefined
    if (send.status === 'sent') {
      deps.logger.warn({ sendId, error: reason }, 'send.dead_letter_skipped_already_sent')
      return undefined
    }
    await setSendStatus(tx, sendId, 'failed', { lastError: reason, now })
    await tx
      .update(drafts)
      .set({ status: 'failed' })
      .where(and(eq(drafts.id, send.draftId), or(eq(drafts.status, 'approved'), eq(drafts.status, 'sending'))))
    await audit(tx, {
      actor: SEND_ACTOR, action: 'send.dead_letter', entityType: 'outbound_send', entityId: sendId,
      detail: { reason, ticketId: send.ticketId, draftId: send.draftId },
    })
    const { notificationId } = await escalateTicket(tx, {
      orgId, ticketId: send.ticketId, fromStatus: 'awaiting_review', reason: 'send_failed',
      day, now, draftId: send.draftId, actor: SEND_ACTOR, auditAction: 'ticket.escalated',
      dedupeKey: `send_failed:${send.ticketId}:${day}`,
      detail: { sendId, error: reason },
    })
    return notificationId
  })
  if (notificationId) await deps.enqueueNotify(orgId, notificationId)
}

/**
 * Collapse THIS run's claim horizon to `now` so the pg-boss retry can reclaim immediately. Guarded on
 * `status = 'claimed' AND claim_token = $token`, so it is a no-op once any landing has released the
 * row (every landing nulls the token) or another worker has reclaimed it — which makes it safe to
 * call from both step 9's own catch and the generic post-claim catch.
 *
 * Safe in every case because a re-entry must pass through the recovery scan first: the alternative
 * (leaving the horizon at `now + 600`) makes attempts 2-4 of pg-boss's backoff find an unclaimable
 * row and return silently, burning the whole retry budget and deferring the dead-letter by ~15
 * minutes (Task 13 review, Important 3).
 */
async function collapseClaimHorizon(
  deps: SendExecuteDeps, orgId: string, sendId: string, claimToken: string, now: Date, lastError: string,
): Promise<void> {
  await withOrg(deps.db, orgId, (tx) =>
    tx
      .update(outboundSends)
      .set({ claimExpiresAt: now, lastError, updatedAt: now })
      .where(and(eq(outboundSends.id, sendId), eq(outboundSends.status, 'claimed'), eq(outboundSends.claimToken, claimToken))))
}

/**
 * Every terminal/held/release write clears the claim: a row that is no longer `claimed` must not look
 * held. Guarded on `status <> 'sent'` — `sent` is terminal in `outboundSendTransitions`, and the one
 * way to reach here with a `sent` row is a deadline-overlap retry that completed the reply while this
 * handler was inside a provider call. Downgrading it would contradict `sent_at`/`provider_message_id`
 * and make the row eligible for Task 14's re-approve re-queue — a double-send hazard.
 */
async function setSendStatus(
  tx: OrgTx, sendId: string, status: 'held' | 'failed' | 'queued', p: { lastError: string; now: Date; sendAfter?: Date },
): Promise<void> {
  await tx
    .update(outboundSends)
    .set({
      status,
      lastError: p.lastError,
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
      updatedAt: p.now,
      ...(p.sendAfter ? { sendAfter: p.sendAfter } : {}),
    })
    .where(and(eq(outboundSends.id, sendId), ne(outboundSends.status, 'sent')))
}

// ---------------------------------------------------------------------------
// Step 11: the idempotent tail (a fresh send AND a recovered one land here)
// ---------------------------------------------------------------------------

interface CompleteSendInput {
  recovered: boolean
  providerMessageId: string
  providerThreadId: string
  rfcMessageId: string | null
  fromAddress: string
  subject: string | null
  bodyText: string
  threadSnapshotAt: Date
  aiHandledMonth: string | null
  /** Present only on the fresh-send path; a recovery has no threading context to record. */
  threading?: { to: string[]; inReplyTo: string; refs: string[] }
}

/**
 * Every write here is idempotent or guarded, which is what makes it safe as the recovery path's
 * landing point: a re-entry that finds its own marker runs exactly this and nothing else.
 */
async function completeSend(l: Landing, input: CompleteSendInput): Promise<void> {
  const month = l.now.toISOString().slice(0, 7)
  const { completed, handBack } = await withOrg(l.deps.db, l.orgId, async (tx) => {
    // The mailbox poll will see this same SENT message and run its own insert; whichever writer gets
    // there first wins and exactly ONE outbound row survives. `draft_id` is force-written (the poll
    // reads it off the marker too, so both agree) and the rfc id is only ever FILLED IN, never
    // overwritten — the poll's own metadata fetch is authoritative once it has one.
    await tx
      .insert(messages)
      .values({
        // NOTE: this row is a RECONSTRUCTION of what went out, not a record of it — the body,
        // subject, From and especially `sent_at` are THIS run's values, and on the recovery path the
        // message was actually sent by an earlier attempt at an earlier instant. The marker
        // guarantees it is the same draft, and the mailbox poll's own insert is `DO NOTHING`, so
        // nothing corrects it later: downstream surfaces must not read an outbound `sent_at` as
        // provider truth (Task 13 review, Minor 6).
        orgId: l.orgId, ticketId: l.ticketId, connectionId: l.connectionId, providerMessageId: input.providerMessageId,
        direction: 'outbound', fromAddress: input.fromAddress, subject: input.subject, bodyText: input.bodyText,
        rfcMessageId: input.rfcMessageId, draftId: l.draftId, sentAt: l.now,
        ...(input.threading
          ? { toAddresses: input.threading.to, inReplyTo: input.threading.inReplyTo, refs: input.threading.refs }
          : {}),
      })
      .onConflictDoUpdate({
        target: [messages.connectionId, messages.providerMessageId],
        set: {
          draftId: sql`excluded.draft_id`,
          rfcMessageId: sql`COALESCE(${messages.rfcMessageId}, excluded.rfc_message_id)`,
        },
      })

    // THE completion gate. Zero rows means this reply was already completed — by a deadline-overlap
    // retry that reclaimed, recovered by marker and finished while this handler was still inside its
    // provider call (`expireInSeconds` equals the claim horizon, so the two windows touch). Every
    // row write above and below is guarded or idempotent, but the meters, the audit row and the
    // post-commit hooks are NOT: `review_sends` is a billing meter and must count one reply once.
    const completedRows = await tx
      .update(outboundSends)
      .set({
        status: 'sent',
        providerMessageId: input.providerMessageId,
        providerThreadId: input.providerThreadId,
        rfcMessageId: input.rfcMessageId,
        sentAt: l.now,
        lastError: null,
        claimExpiresAt: null,
        updatedAt: l.now,
      })
      .where(and(eq(outboundSends.id, l.sendId), eq(outboundSends.status, 'claimed')))
      .returning({ id: outboundSends.id })
    const completed = completedRows.length > 0

    // `approved → sending → sent`: the fresh path already flipped to `sending` in step 8, a recovery
    // that crashed before step 8 has not — both walk the same two guarded statements.
    await tx.update(drafts).set({ status: 'sending' }).where(and(eq(drafts.id, l.draftId), eq(drafts.status, 'approved')))
    await tx.update(drafts).set({ status: 'sent' }).where(and(eq(drafts.id, l.draftId), eq(drafts.status, 'sending')))

    // The conditional flip: park on the customer ONLY if the thread still looks the way it did when
    // the owner approved. Guarded on `awaiting_review`, so a recovery landing here after the flip
    // already happened (or after the owner moved the ticket) matches 0 rows and leaves it alone.
    const flipped = await tx
      .update(tickets)
      .set({ status: 'waiting_on_customer', ...clearRedraftCycle() })
      .where(
        and(
          eq(tickets.id, l.ticketId),
          eq(tickets.status, 'awaiting_review'),
          lte(tickets.lastInboundAt, input.threadSnapshotAt),
        ),
      )
      .returning({ id: tickets.id })

    let handBack = false
    if (flipped.length === 0) {
      // Still awaiting review but the watermark moved: an inbound landed mid-send. Hand the ticket
      // back to the agent instead of parking it. `last_agent_run_at: null` for the same reason the
      // stale path clears it (see `landStale`), and the redraft cycle IS cleared here — the reply
      // shipped, so any owner correction on it is now fulfilled and dead.
      const rows = await tx
        .update(tickets)
        .set({ status: 'triaged', lastAgentRunAt: null, ...clearRedraftCycle() })
        .where(and(eq(tickets.id, l.ticketId), eq(tickets.status, 'awaiting_review')))
        .returning({ id: tickets.id })
      handBack = rows.length > 0
    }

    if (!completed) {
      l.deps.logger.warn({ sendId: l.sendId, providerMessageId: input.providerMessageId }, 'send.already_completed')
      return { completed: false, handBack: false }
    }

    await bumpMeter(tx, l.orgId, l.day, SEND_METERS.reviewSends, 1)
    // At most once per ticket per calendar month — the stamp IS the dedupe, so a second send in the
    // same month matches nothing and the meter stays put.
    if (input.aiHandledMonth !== month) {
      const stamped = await tx
        .update(tickets)
        .set({ aiHandledMonth: month })
        .where(and(eq(tickets.id, l.ticketId), or(sql`${tickets.aiHandledMonth} IS NULL`, sql`${tickets.aiHandledMonth} <> ${month}`)))
        .returning({ id: tickets.id })
      if (stamped.length > 0) await bumpMeter(tx, l.orgId, l.day, SEND_METERS.aiHandledConversations, 1)
    }

    await audit(tx, {
      actor: SEND_ACTOR, action: 'send.sent', entityType: 'outbound_send', entityId: l.sendId,
      detail: { recovered: input.recovered, providerMessageId: input.providerMessageId, ticketId: l.ticketId, draftId: l.draftId },
    })
    return { completed: true, handBack }
  })

  if (!completed) return

  // Post-commit: never inside the transaction (a queue outage must not roll back a delivered reply),
  // and never allowed to propagate — the reply IS sent, and letting a queue hiccup or Phase 5's
  // memory capture surface as a send failure would dead-letter a delivered message on the last
  // attempt (Task 13 review, Important 1).
  if (handBack) {
    try {
      await l.deps.enqueueDraft(l.orgId, l.ticketId)
    } catch (err) {
      l.deps.logger.warn({ sendId: l.sendId, ticketId: l.ticketId, error: errorMessage(err) }, 'send.handback_enqueue_failed')
    }
  }
  try {
    await l.deps.onSent?.({ orgId: l.orgId, ticketId: l.ticketId, draftId: l.draftId })
  } catch (err) {
    l.deps.logger.warn({ sendId: l.sendId, ticketId: l.ticketId, error: errorMessage(err) }, 'send.on_sent_failed')
  }
}

// ---------------------------------------------------------------------------
// The run function (pure w.r.t. pg-boss — this is what tests call directly)
// ---------------------------------------------------------------------------

export async function runSendExecute(deps: SendExecuteDeps, payload: SendExecutePayload, ctx: SendExecuteContext): Promise<void> {
  try {
    await execute(deps, payload, ctx)
  } catch (err) {
    // Step 12. pg-boss will not run this payload again, so the owner has to hear about it from here
    // — a dead-lettered approved send that only ever reached the job log is exactly the silent
    // failure this whole file exists to avoid.
    if (ctx.lastAttempt) {
      try {
        await landDeadLetter(deps, payload.orgId, payload.sendId, deps.now?.() ?? new Date(), err)
      } catch (deadLetterErr) {
        deps.logger.error({ sendId: payload.sendId, error: errorMessage(deadLetterErr) }, 'send.dead_letter_failed')
      }
    }
    throw err
  }
}

async function execute(deps: SendExecuteDeps, payload: SendExecutePayload, ctx: SendExecuteContext): Promise<void> {
  const { orgId, sendId } = payload
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)

  // --- Step 1: the claim + everything it reads, ONE transaction.
  const claimed = await claimSend(deps, orgId, sendId, now)
  if (!claimed) {
    deps.logger.info({ sendId, attempt: ctx.attempt }, 'send.execute_not_claimable')
    return
  }
  const l: Landing = {
    deps, orgId, sendId, draftId: claimed.draft.id, ticketId: claimed.ticket.id,
    connectionId: claimed.send.connectionId, now, day,
  }

  try {
    await afterClaim(deps, ctx, claimed, l)
  } catch (err) {
    // The claim is COMMITTED, so any throw from here on would otherwise leave the row `claimed` for
    // a full 600 s while pg-boss's first three or four retries land inside that horizon, match
    // nothing and return silently — the retry budget burnt doing nothing and the dead-letter
    // deferred by ~15 minutes. Collapse the horizon on our own token so the very next retry
    // reclaims (and, as always, scans first). A no-op when a landing already released the row.
    await collapseClaimHorizon(deps, orgId, sendId, claimed.claimToken, deps.now?.() ?? new Date(), errorMessage(err))
    throw err
  }
}

/**
 * Step 1's landings through step 11 — everything the COMMITTED claim owns. Split out of `execute`
 * only so its single caller can wrap it in the claim-horizon collapse; the step order is unchanged.
 */
async function afterClaim(deps: SendExecuteDeps, ctx: SendExecuteContext, claimed: ClaimedSend, l: Landing): Promise<void> {
  const { orgId, sendId, now } = l
  const { claimToken, send, draft, ticket, agent, connection, workspace } = claimed

  // A missing agent row holds at step 1 for ANY draft status, levers-deferred or not: without it
  // there is no persona, no signature and no From address, so there is nothing to send AND nothing
  // for `completeSend` to reconstruct a `messages` row from on a recovery. It is the one lever that
  // makes even recovery impossible, so it keeps its place ahead of the scan — and it is what proves
  // `agent` non-null for the policy (step 2) and the threading (step 7) below.
  if (agent === null) {
    await landHeld(l, 'agent_inactive')
    return
  }
  const sendingAgent = agent

  // A draft the owner rejected, or one a newer draft superseded, must never go out on a late claim.
  // `sending` IS acceptable: it is what a crashed attempt leaves behind, and step 4's scan is the
  // only thing allowed to decide what actually happened to it.
  if (draft.status !== 'approved' && draft.status !== 'sending') {
    await landTerminal(l, 'draft not approved', { escalate: false })
    return
  }
  if (draft.finalBody === null) {
    await landTerminal(l, 'draft has no final body')
    return
  }

  /**
   * The kill levers (controller ruling, fix round 1). For an `approved` draft nothing has been
   * attempted yet, so they apply HERE, ahead of everything. For a `sending` draft — a crash
   * re-entry — they are DEFERRED past the recovery scan: a lever flipped after a reply was already
   * delivered must not turn that reply into a `held` send the owner is told never went out. On a
   * scan HIT the send completes regardless of the levers; on a MISS they apply before staleness.
   */
  const deferLevers = draft.status === 'sending'
  const lever = firstKillLever(claimed)
  if (lever && !deferLevers) {
    await landHeld(l, lever)
    return
  }

  // --- Step 2: the guardrails, third pass. The draft gate screened the MODEL's body; this screens
  // what the owner actually approved, edits and all.
  const policy = buildReplyPolicy({
    workspace: {
      allowedUrlHosts: workspace.allowedUrlHosts,
      allowedEmailDomains: workspace.allowedEmailDomains,
      contactPhone: workspace.contactPhone,
      contactUrls: workspace.contactUrls,
      locale: workspace.locale,
    },
    agent: sendingAgent,
    workspaceGuidance: workspace.operatingGuidance,
    agentGuidance: sendingAgent.guidanceExtra,
    expectedLanguage: ticket.language,
  })
  const screened = validateReplyBody(draft.finalBody, policy, { replyLanguage: draft.customerLanguage })
  if (!screened.ok) {
    const codes = screened.findings.filter((f) => f.severity === 'fail').map((f) => f.code)
    await landTerminal(l, `guardrail:${codes.join(',')}`)
    return
  }

  // The signature is appended by CODE, after validation, never by the model and never by the owner.
  const bodyText = appendSignature(draft.finalBody, sendingAgent.signature)
  const subject = (ticket.subject ?? '(no subject)').slice(0, OUTBOUND_SUBJECT_MAX_CHARS)
  const fromAddress = personaFor(sendingAgent).address

  // --- Step 3: credentials and the client. OUTSIDE every transaction.
  const provider = connection.provider as 'gmail' | 'microsoft'
  const providerObj = (deps.providerFactory ?? resolveMailProvider)(provider)
  const oauth = provider === 'gmail' ? deps.config.gmailOauth : deps.config.msOauth
  if (!oauth) throw new Error(`send.execute: no OAuth client configured for provider ${provider}`)

  let accessToken: string
  try {
    accessToken = await getAccessToken(
      { db: deps.db, ring: deps.ring, provider: providerObj, clientId: oauth.clientId, clientSecret: oauth.clientSecret.expose() },
      orgId, send.connectionId, JOB_NAMES.sendExecute,
    )
  } catch (err) {
    if (!(err instanceof ProviderAuthError)) throw err
    // `getAccessToken` already flipped the connection to `reauth_required`; either way the owner
    // hears about it, once per UTC day.
    if (deferLevers) {
      // A crash re-entry: the credential died before we could scan, so DELIVERY IS UNVERIFIED and
      // holding would park a possibly-delivered reply in a state nothing can move. Release for a
      // retry and throw — a reconnect inside the retry budget recovers by marker, and the last
      // attempt dead-letters into `send_failed`, which is a state the owner can act on.
      await withOrg(deps.db, orgId, (tx) =>
        setSendStatus(tx, sendId, 'queued', {
          lastError: 'reauth_required: delivery unverified', now,
          sendAfter: new Date(now.getTime() + RELEASE_RETRY_SECONDS * 1000),
        }))
      await notifyReauthRequired({ db: deps.db, enqueueNotify: deps.enqueueNotify }, orgId, send.connectionId, now)
      throw err
    }
    // Nothing was attempted: hold the send (the owner's approval survives) and page them.
    await withOrg(deps.db, orgId, async (tx) => {
      await setSendStatus(tx, sendId, 'held', { lastError: 'reauth_required', now })
      await tx.update(drafts).set({ status: 'held' }).where(and(eq(drafts.id, draft.id), eq(drafts.status, 'approved')))
      await audit(tx, {
        actor: SEND_ACTOR, action: 'send.held', entityType: 'outbound_send', entityId: sendId,
        detail: { lever: 'reauth_required', ticketId: ticket.id, draftId: draft.id },
      })
    })
    await notifyReauthRequired({ db: deps.db, enqueueNotify: deps.enqueueNotify }, orgId, send.connectionId, now)
    return
  }

  const client = deps.clientFactory
    ? deps.clientFactory(provider, accessToken, connection.emailAddress)
    : providerObj.client(accessToken, connection.emailAddress)

  // The SAME limiter instance `mailbox.sync` holds: per-connection concurrency 1 means a send and a
  // poll of the same mailbox never run against the provider at the same time.
  const release = await deps.limiter.acquire(send.connectionId)
  try {
    // --- Step 4: the recovery scan, FIRST. See the file header for why it precedes staleness.
    let recoveredId: string | null = null
    try {
      recoveredId = await client.findSentByMarker(ticket.providerThreadId, draft.id, RECOVERY_SCAN_LIMIT)
    } catch (err) {
      if (err instanceof MessageGoneError) {
        // A message deleted out from under the scan cannot be ours — treat it as a miss.
        recoveredId = null
      } else {
        // We could NOT establish whether we already sent (an over-busy thread, a 5xx, a rate limit).
        // Release the claim so the retry can reclaim and scan again — never send blind.
        const reason = errorMessage(err)
        await withOrg(deps.db, orgId, (tx) =>
          setSendStatus(tx, sendId, 'queued', { lastError: reason, now, sendAfter: new Date(now.getTime() + RELEASE_RETRY_SECONDS * 1000) }))
        deps.logger.warn({ sendId, threadId: ticket.providerThreadId, error: reason }, 'send.scan_unverifiable')
        throw err
      }
    }
    if (recoveredId !== null) {
      const rfcMessageId = await readBackRfcId(deps, client, recoveredId, sendId)
      await completeSend(l, {
        recovered: true, providerMessageId: recoveredId, providerThreadId: ticket.providerThreadId, rfcMessageId,
        fromAddress, subject, bodyText, threadSnapshotAt: draft.threadSnapshotAt, aiHandledMonth: ticket.aiHandledMonth,
      })
      return
    }

    // The deferred levers (see `deferLevers` above). The scan proved nothing was delivered, so a
    // lever now means the same thing it would have meant at step 1 — with the wider draft guard
    // (`sending → held`) so the send and the draft move together.
    if (lever) {
      await landHeld(l, lever)
      return
    }

    // --- The thread, in one short read transaction: staleness input AND threading input.
    const thread = await withOrg(deps.db, orgId, (tx) =>
      tx
        .select({
          direction: messages.direction, sentAt: messages.sentAt, rfcMessageId: messages.rfcMessageId,
          providerMessageId: messages.providerMessageId,
        })
        .from(messages)
        .where(eq(messages.ticketId, ticket.id))
        .orderBy(asc(messages.sentAt), asc(messages.createdAt)))

    // --- Step 5: staleness. Strict `>`: a message stamped exactly at the snapshot was already in
    // the thread the owner reviewed.
    const newerInbound = thread.find((m) => m.direction === 'inbound' && m.sentAt !== null && m.sentAt > draft.threadSnapshotAt)
    if (newerInbound) {
      await landStale(l, draft.threadSnapshotAt, newerInbound.sentAt)
      return
    }

    // --- Step 6: the pre-checks. Terminal, same shape as step 2's.
    if (ticket.customerEmail === null) {
      await landTerminal(l, 'ticket has no customer email')
      return
    }
    const latestInbound = [...thread].reverse().find((m) => m.direction === 'inbound')
    if (!latestInbound) {
      await landTerminal(l, 'no inbound message to reply to')
      return
    }
    const latestOutboundWithId = [...thread].reverse().find((m) => m.direction === 'outbound' && m.rfcMessageId !== null)
    const inReplyTo = latestInbound.rfcMessageId ?? latestOutboundWithId?.rfcMessageId ?? null
    if (inReplyTo === null) {
      // Never send unthreaded: a reply with no In-Reply-To starts a NEW conversation in the
      // customer's client, detached from the thread they wrote in.
      await landTerminal(l, 'no rfc message id to thread the reply onto')
      return
    }

    // --- Step 7: threading and body.
    const references = buildReferences(thread.map((m) => m.rfcMessageId), inReplyTo)

    // The job's own deadline has already passed (pg-boss will retry this payload): starting a send
    // now would be a provider call nobody is waiting on the result of, and a crash-shaped one at
    // that. Release the claim so the retry reclaims immediately and re-enters through the scan.
    if (ctx.signal.aborted) {
      await withOrg(deps.db, orgId, (tx) =>
        setSendStatus(tx, sendId, 'queued', { lastError: 'aborted before send: job deadline reached', now, sendAfter: now }))
      deps.logger.warn({ sendId }, 'send.aborted_before_send')
      return
    }

    // --- Step 8: the atomic pre-send flip, immediately before the send. Zero rows means the claim
    // was lost (its horizon expired and another worker took it) — that worker owns the send now.
    // A FRESH clock read, not the run-start `now`: `claim_expires_at` was written as `now + 600` by
    // this same run's claim, so comparing against the start instant makes that half of the predicate
    // vacuously true. What it is meant to assert is that the horizon has not lapsed WHILE the scan
    // and the thread read were running.
    const flipAt = deps.now?.() ?? new Date()
    const stillOurs = await withOrg(deps.db, orgId, async (tx) => {
      const rows = await tx
        .update(outboundSends)
        .set({ updatedAt: flipAt })
        .where(
          and(
            eq(outboundSends.id, sendId),
            eq(outboundSends.status, 'claimed'),
            eq(outboundSends.claimToken, claimToken),
            gt(outboundSends.claimExpiresAt, flipAt),
          ),
        )
        .returning({ id: outboundSends.id })
      if (rows.length === 0) return false
      await tx.update(drafts).set({ status: 'sending' }).where(and(eq(drafts.id, draft.id), eq(drafts.status, 'approved')))
      return true
    })
    if (!stillOurs) {
      deps.logger.warn({ sendId }, 'send.claim_lost_before_send')
      return
    }

    // --- Step 9: the send. NEVER retried inside this job — the retry has to come back through the
    // recovery scan or it can duplicate a delivered reply.
    let sent: { id: string; threadId: string; providerDraftId?: string }
    try {
      sent = await client.sendReply({
        threadId: ticket.providerThreadId,
        to: ticket.customerEmail,
        subject,
        inReplyTo,
        references: references.join(' '),
        bodyText,
        from: fromAddress,
        replyToProviderMessageId: latestInbound.providerMessageId,
        ...(send.providerDraftId ? { existingDraftId: send.providerDraftId } : {}),
        extraHeaders: { [MARKER_HEADER]: draft.id },
        // Graph's two-phase send: persist the createReply draft id BEFORE the PATCH/send, so a crash
        // between the two is recoverable through `existingDraftId` instead of leaving an orphan draft.
        onDraftCreated: async (providerDraftId) => {
          await withOrg(deps.db, orgId, (tx) =>
            tx
              .update(outboundSends)
              .set({ providerDraftId, updatedAt: now })
              .where(and(eq(outboundSends.id, sendId), eq(outboundSends.claimToken, claimToken))))
        },
      })
    } catch (err) {
      // Collapse the claim horizon so the pg-boss retry can reclaim IMMEDIATELY and scan first.
      // Status stays `claimed` and the draft stays `sending`: this run genuinely does not know
      // whether the customer has the mail, and only the marker scan can answer that.
      await collapseClaimHorizon(deps, orgId, sendId, claimToken, now, errorMessage(err))
      throw err
    }

    // --- Step 10: the read-back, best effort. A failure costs nothing — the mailbox poll backfills
    // the rfc id from its own metadata fetch within a minute.
    const rfcMessageId = await readBackRfcId(deps, client, sent.id, sendId)

    // --- Step 11.
    await completeSend(l, {
      recovered: false,
      providerMessageId: sent.id,
      providerThreadId: sent.threadId,
      rfcMessageId,
      fromAddress,
      subject,
      bodyText,
      threadSnapshotAt: draft.threadSnapshotAt,
      aiHandledMonth: ticket.aiHandledMonth,
      threading: { to: [ticket.customerEmail], inReplyTo, refs: references },
    })
  } finally {
    release()
  }
}

/** Step 10, shared by the fresh and the recovered path. Never throws. */
async function readBackRfcId(deps: SendExecuteDeps, client: MailboxClient, providerMessageId: string, sendId: string): Promise<string | null> {
  try {
    return (await client.getMessage(providerMessageId, { format: 'metadata' })).rfcMessageId
  } catch (err) {
    deps.logger.warn({ sendId, providerMessageId, error: errorMessage(err) }, 'send.readback_failed')
    return null
  }
}
