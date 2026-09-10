import type { MailProvider } from '@aesa/contracts'
import type { OutgoingMail } from './transport.ts'

export function otpMail(to: string, otp: string): OutgoingMail {
  return {
    to,
    subject: `${otp} is your aesa sign-in code`,
    text: `Your sign-in code is ${otp}\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.`,
  }
}

export function invitationMail(p: { to: string; inviterName: string; orgName: string; url: string }): OutgoingMail {
  return {
    to: p.to,
    subject: `${p.inviterName} invited you to ${p.orgName} on aesa`,
    text: `${p.inviterName} invited you to join the ${p.orgName} workspace on aesa.\n\nOpen this link to accept:\n${p.url}\n\nThe invitation expires in 48 hours. If you were not expecting it, ignore this email.`,
  }
}

/** The claim-time email (Phase 3 pre-flight): sent to the mailbox address itself, not the claiming user —
 * it's the mailbox owner's only record of who attached this workspace to their inbox. Closes most of the
 * reverse-phish window named in the Phase 2 review. */
export function mailboxClaimedMail(p: { to: string; emailAddress: string; provider: MailProvider; claimedByEmail: string; settingsUrl: string }): OutgoingMail {
  return {
    to: p.to,
    subject: `Your mailbox ${p.emailAddress} was connected to aesa`,
    text: `${p.claimedByEmail} connected this mailbox (${p.provider}) to the aesa workspace. If that wasn't you, disconnect it here: ${p.settingsUrl}.`,
  }
}

/**
 * The mailbox address-verification code mail (api Task 19). The code rides in the subject (so it
 * survives even if the body is stripped) AND the body (belt and braces, since the worker's regex
 * scans `subject + '\n' + bodyText`). This mail's `from` is whatever the sending `MailTransport`
 * sends as (the api's own `MAIL_FROM`) — the worker's sync walk only intercepts a code from its OWN
 * `MAIL_FROM` (`apps/worker/src/config.ts`'s `platformSender`). The two must be the SAME address in
 * every real deployment, or a verification mail lands as an ordinary, unauthenticated customer
 * message instead of being caught before ticketing (`packages/mail/src/sync.ts`'s
 * `interceptVerification`).
 */
export function verificationMail(address: string, code: string): OutgoingMail {
  return {
    to: address,
    subject: `aesa address verification ${code}`,
    text: `Someone added ${address} as a support address on your aesa workspace.\n\n` +
      `Verification code: ${code}\n\n` +
      `You don't need to reply or do anything with this code yourself — as soon as this address ` +
      `receives any email carrying it, aesa's mailbox sync notices it automatically and activates the ` +
      `address. This code expires in 24 hours.`,
  }
}

/** One pending draft in the daily digest: what the owner needs to decide without opening the app. */
export interface DigestDraftItem {
  subject: string
  customer: string
  categoryLabel: string | null
  confidencePct: number | null
  /** The first ~140 characters of the drafted reply; the caller truncates. */
  excerpt: string
  /** The api's one-click review page: `${appBaseUrl}/a/${draftId}?t=${token}` — single-use, per recipient. */
  approveUrl: string
  /** The app's ticket screen: `${appWebOrigin}/ticket/${ticketId}`. */
  openUrl: string
}

/** One open `needs_owner` ticket in the daily digest — no draft to approve, only a reason to look. */
export interface DigestEscalationItem {
  subject: string
  /** Carried for parity with DigestDraftItem; the text digest's escalation line renders subject · reason only. */
  customer: string
  reason: string
  openUrl: string
}

/** Cap on RENDERED items per section (drafts, escalations); the overflow becomes one `…and N more` line. */
export const DIGEST_MAX_ITEMS = 10

const NO_SUBJECT = '(no subject)'

function renderSection<T>(items: T[], render: (item: T) => string[]): string[] {
  const lines: string[] = []
  for (const item of items.slice(0, DIGEST_MAX_ITEMS)) lines.push(...render(item), '')
  const overflow = items.length - DIGEST_MAX_ITEMS
  if (overflow > 0) lines.push(`…and ${overflow} more`, '')
  return lines
}

/**
 * The once-a-day owner/admin email. Text-only on purpose: it has to survive every client, and every
 * action it offers is a link, so there is nothing HTML would add but a spam score.
 */
export function digestMail(p: {
  to: string
  businessName: string
  drafts: DigestDraftItem[]
  escalations: DigestEscalationItem[]
  inboxUrl: string
}): OutgoingMail {
  const n = p.drafts.length
  const m = p.escalations.length
  const draftHeadline = `${n} draft${n === 1 ? '' : 's'} waiting for review`
  // With no drafts at all the escalations ARE the news, so the subject leads with them instead.
  const subject = n > 0 ? `${draftHeadline} · ${p.businessName}` : `${m} tickets need you`

  const lines: string[] = []
  if (n > 0) {
    lines.push(`${draftHeadline}:`, '')
    lines.push(...renderSection(p.drafts, (d) => {
      const head = [d.subject || NO_SUBJECT, d.customer, d.categoryLabel, d.confidencePct === null ? null : `${d.confidencePct}% confidence`]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
      return [head, ...(d.excerpt ? [d.excerpt] : []), `Approve: ${d.approveUrl}`, `Open: ${d.openUrl}`]
    }))
  }
  if (m > 0) {
    lines.push(`${m} ticket${m === 1 ? '' : 's'} need${m === 1 ? 's' : ''} you:`, '')
    lines.push(...renderSection(p.escalations, (e) => [
      [e.subject || NO_SUBJECT, e.reason].filter(Boolean).join(' · '),
      `Open: ${e.openUrl}`,
    ]))
  }
  lines.push(`Everything else is in your inbox: ${p.inboxUrl}`)

  return { to: p.to, subject, text: lines.join('\n') }
}
