/**
 * The daily digest EMAIL — one per owner/admin, once per org per local day, carrying a single-use
 * action token per (recipient, draft) so an owner can approve a reply straight from their inbox.
 *
 * Deliberately separate from the `notify.digest` push pass (`jobs/notify-digest.ts`): the push
 * digest is the cap-overflow channel (collapsed `notifications` rows, every 5 minutes), while this
 * is a scheduled morning summary of everything still waiting. `notify.digest` calls into here once
 * per tick per org; the once-per-local-day lock below is what makes "every 5 minutes" safe.
 *
 * Transaction discipline (CLAUDE.md): every read/write is its own short `withOrg` transaction, and
 * `mail.send` — the only network I/O — happens strictly OUTSIDE all of them. The recipient lookup
 * is the one cross-table read into Better Auth's data (`member` JOIN `user`): both are RLS-exempt
 * and readable by the app role, so it is a plain, org-filtered query on the pooled handle rather
 * than a tenant transaction.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type pino from 'pino'
import { resolveSetting, type SettingKey } from '@aesa/core'
import { generateToken } from '@aesa/crypto'
import {
  categories, draftActionTokens, drafts, member, notifications, orgSettings, tickets, user, withOrg, workspaces, type Db,
} from '@aesa/db'
import { digestMail, type DigestDraftItem, type DigestEscalationItem, type MailTransport } from '@aesa/platform-mail'

export interface DigestEmailDeps {
  db: Db
  mail: MailTransport
  /** The api's public origin: the base of the one-click review links. */
  appBaseUrl: string
  /** The Expo web origin: the base of the "open the ticket" links. */
  appWebOrigin: string
  logger: pino.Logger
  now?: () => Date
}

/** How long an emailed action token stays usable. Long enough to survive a weekend and a holiday. */
export const ACTION_TOKEN_TTL_DAYS = 7

/** Matches `draftReviewCopy`'s push body: enough of the reply to judge it, short enough to skim. */
const EXCERPT_CHARS = 140

const DIGEST_SETTING_KEYS = ['notifications.digest_email', 'notifications.digest_email_hour'] as const

/**
 * The workspace-local hour (0-23) and calendar day (YYYY-MM-DD) of `now`. Both the "is it time?"
 * check and the once-per-day lock key must be LOCAL, or an org west of UTC gets two digests on the
 * day its UTC date rolls over. An unknown/invalid timezone falls back to UTC rather than throwing:
 * a bad `workspaces.timezone` must not stop the cron for every other org.
 */
export function localHourAndDay(now: Date, timeZone: string): { hour: number; day: string } {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).formatToParts(now)
  }
  const at = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '0'
  return { hour: Number(at('hour')), day: `${at('year')}-${at('month')}-${at('day')}` }
}

interface DigestHead {
  businessName: string
  timezone: string
  enabled: boolean
  hour: number
}

async function loadHead(db: Db, orgId: string): Promise<DigestHead | null> {
  return withOrg(db, orgId, async (tx) => {
    const [ws] = await tx
      .select({ businessName: workspaces.businessName, timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId))
    if (!ws) return null // No workspace: onboarding never finished, so there is nothing to summarize.

    const rows = await tx
      .select({ key: orgSettings.key, value: orgSettings.value })
      .from(orgSettings)
      .where(and(eq(orgSettings.orgId, orgId), inArray(orgSettings.key, [...DIGEST_SETTING_KEYS])))
    const org: Partial<Record<SettingKey, unknown>> = {}
    for (const row of rows) org[row.key as SettingKey] = row.value

    return {
      ...ws,
      enabled: resolveSetting('notifications.digest_email', { org }),
      hour: resolveSetting('notifications.digest_email_hour', { org }),
    }
  })
}

/**
 * The once-per-local-day lock: a `notifications` row whose `dedupe_key` is unique org-wide. The
 * INSERT is the claim — whoever gets the row runs today's digest and everyone else (a 5-minute
 * re-tick, a second cron replica) sees no row and skips. Written BEFORE the content is read, so
 * "there was nothing to say today" still counts as today's run.
 */
async function claimToday(db: Db, orgId: string, day: string, now: Date): Promise<boolean> {
  const [row] = await withOrg(db, orgId, (tx) =>
    tx
      .insert(notifications)
      .values({
        orgId, kind: 'digest', title: 'Daily digest email', body: '',
        dedupeKey: `digest_email:${orgId}:${day}`, status: 'sent', sentAt: now, payload: { channel: 'email' },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id }))
  return Boolean(row)
}

interface PendingDraft {
  draftId: string
  ticketId: string
  subject: string
  customer: string
  categoryLabel: string | null
  confidencePct: number | null
  excerpt: string
}

interface PendingEscalation {
  ticketId: string
  subject: string
  customer: string
  reason: string
}

/** Everything still waiting on the owner: pending drafts to approve, and open `needs_owner` tickets. */
async function loadPending(db: Db, orgId: string): Promise<{ drafts: PendingDraft[]; escalations: PendingEscalation[] }> {
  return withOrg(db, orgId, async (tx) => {
    const draftRows = await tx
      .select({
        draftId: drafts.id, ticketId: drafts.ticketId, body: drafts.body, confidence: drafts.confidence,
        subject: tickets.subject, customerName: tickets.customerName, customerEmail: tickets.customerEmail,
        categoryLabel: categories.label,
      })
      .from(drafts)
      .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
      .leftJoin(categories, eq(categories.id, tickets.categoryId))
      .where(and(eq(drafts.orgId, orgId), eq(drafts.status, 'pending')))
      .orderBy(asc(drafts.createdAt))

    const escalationRows = await tx
      .select({ id: tickets.id, subject: tickets.subject, customerName: tickets.customerName, customerEmail: tickets.customerEmail, reason: tickets.needsOwnerReason })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), eq(tickets.status, 'needs_owner')))
      .orderBy(asc(tickets.createdAt))

    return {
      drafts: draftRows.map((r) => ({
        draftId: r.draftId,
        ticketId: r.ticketId,
        subject: r.subject ?? '',
        customer: r.customerName || r.customerEmail || 'unknown sender',
        categoryLabel: r.categoryLabel,
        confidencePct: r.confidence === null ? null : Math.round(r.confidence * 100),
        excerpt: r.body.slice(0, EXCERPT_CHARS),
      })),
      escalations: escalationRows.map((r) => ({
        ticketId: r.id,
        subject: r.subject ?? '',
        customer: r.customerName || r.customerEmail || 'unknown sender',
        reason: r.reason ?? 'needs a decision',
      })),
    }
  })
}

/** Owners and admins of the org: the only people the digest email (and its action tokens) go to. */
async function loadRecipients(db: Db, orgId: string): Promise<{ userId: string; email: string }[]> {
  return db
    .select({ userId: user.id, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ['owner', 'admin'])))
    .orderBy(asc(user.email))
}

/**
 * One recipient's tokens: a fresh single-use `draft_action_tokens` row per draft, minted per
 * RECIPIENT so a forwarded email can never act as someone else — the api's review route resolves
 * the hash back to (draft, user) and stamps `consumed_at`.
 */
async function mintDraftItems(deps: DigestEmailDeps, orgId: string, userId: string, pending: PendingDraft[], now: Date): Promise<DigestDraftItem[]> {
  if (pending.length === 0) return [] // escalation-only digest: nothing to approve, nothing to mint
  const expiresAt = new Date(now.getTime() + ACTION_TOKEN_TTL_DAYS * 86_400_000)
  const minted = pending.map((d) => ({ draft: d, token: generateToken('action') }))
  await withOrg(deps.db, orgId, (tx) =>
    tx.insert(draftActionTokens).values(minted.map(({ draft, token }) => ({ orgId, draftId: draft.draftId, userId, tokenHash: token.hash, expiresAt }))))
  return minted.map(({ draft, token }) => ({
    subject: draft.subject,
    customer: draft.customer,
    categoryLabel: draft.categoryLabel,
    confidencePct: draft.confidencePct,
    excerpt: draft.excerpt,
    approveUrl: `${deps.appBaseUrl}/a/${draft.draftId}?t=${token.token}`,
    openUrl: `${deps.appWebOrigin}/ticket/${draft.ticketId}`,
  }))
}

/**
 * One org's daily digest email. `skipped` means nothing was sent — wrong hour, setting off, no
 * workspace, already run today, nothing pending, or nobody to send to. `sent` means today's run
 * happened (individual sends may still have failed; each is logged and left for tomorrow).
 */
export async function runDigestEmailForOrg(deps: DigestEmailDeps, orgId: string, now: Date): Promise<'sent' | 'skipped'> {
  const head = await loadHead(deps.db, orgId)
  if (!head || !head.enabled) return 'skipped'

  const { hour, day } = localHourAndDay(now, head.timezone)
  if (hour !== head.hour) return 'skipped'

  if (!(await claimToday(deps.db, orgId, day, now))) return 'skipped'

  const pending = await loadPending(deps.db, orgId)
  // Nothing to say is nothing to say — but the lock row above still marks today as run.
  if (pending.drafts.length === 0 && pending.escalations.length === 0) return 'skipped'

  const recipients = await loadRecipients(deps.db, orgId)
  if (recipients.length === 0) return 'skipped'

  const escalations: DigestEscalationItem[] = pending.escalations.map(({ ticketId, ...rest }) => ({ ...rest, openUrl: `${deps.appWebOrigin}/ticket/${ticketId}` }))
  const inboxUrl = `${deps.appWebOrigin}/inbox`

  for (const recipient of recipients) {
    const draftItems = await mintDraftItems(deps, orgId, recipient.userId, pending.drafts, now)
    try {
      // Network I/O: strictly outside every transaction above.
      await deps.mail.send(digestMail({ to: recipient.email, businessName: head.businessName, drafts: draftItems, escalations, inboxUrl }))
    } catch (err) {
      // The tokens stay valid for a week, so tomorrow's digest simply mints another set; nothing
      // here is worth failing the whole cron over.
      deps.logger.warn({ orgId, error: err instanceof Error ? err.message : String(err) }, 'digest_email_failed')
    }
  }
  return 'sent'
}
