/**
 * Every page the session-less `/a/:draftId` review links can render. Pure functions over plain data:
 * no database, no request, no template engine — just hand-rolled HTML with EVERY interpolation run
 * through `esc()` (the same discipline connect/routes.ts keeps, and for the same reason: a customer's
 * subject line and the model's own reply body are untrusted text on their way into an HTML response).
 *
 * `friendlyPage()` is a constant on purpose. It is what an unknown draft, a garbage token, an already
 * consumed token and an expired token ALL render, byte for byte, so a link nobody holds the token for
 * can never become a state oracle for someone probing ids.
 */
import { APPROVE_UNDO_SECONDS, type DraftStatus } from '@aesa/contracts'
import { REVIEW_CSS, WORDMARK_SVG } from '../brand/css.ts'

export const FRIENDLY_COPY = 'This link was already handled or has expired.'

/** The five HTML-significant characters, on every value that reaches a template literal below. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * These URLs ARE the capability, which is what the two head metas are about: `noindex` so nothing that
 * reaches one ends up in a search index, and `no-referrer` so clicking "Open in the app" cannot hand the
 * web origin a `Referer` carrying `?t=<live token>`. (The caching half of the same concern is a
 * `Cache-Control: no-store` header, set on every response in routes.ts.)
 */
function page(body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">'
    + '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'
    + '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">'
    + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'
    // REVIEW_CSS and WORDMARK_SVG are compile-time constants built from BRAND (src/brand/css.ts) —
    // never request data — so, unlike every other interpolation in this file, they run outside esc().
    + `<title>aesa</title><style>${REVIEW_CSS}</style></head>`
    + `<body><main><header>${WORDMARK_SVG}</header>${body}</main></body></html>`
}

function appLink(appUrl: string | undefined, trailing: string): string {
  return appUrl ? `<p><a href="${esc(appUrl)}">Open in the app</a> — ${esc(trailing)}</p>` : ''
}

export function friendlyPage(): string {
  return page(`<p>${FRIENDLY_COPY}</p>`)
}

export interface ReviewPageProps {
  draftId: string
  token: string
  subject: string
  customer: string
  categoryLabel: string | null
  confidencePct: number | null
  /** What would actually go out: an approved draft's `final_body`, a pending one's model body. */
  body: string
  warnings: string[]
  /** The draft is `pending` — Approve is on the table. */
  canApprove: boolean
  /** The draft is `approved` with its send still `queued` — the undo window is open. */
  canHold: boolean
  appUrl: string
}

/**
 * The page the review link lands on. Both buttons are `<form method="post">`, never a link: a GET may
 * never decide anything (mail clients and link scanners prefetch), so the decision needs a real POST.
 * The token rides in a hidden field rather than the action's query string, which keeps it out of the
 * request line the POST would otherwise write to the access log.
 */
export function reviewPage(p: ReviewPageProps): string {
  const meta = [
    p.subject || '(no subject)',
    p.customer,
    p.categoryLabel,
    p.confidencePct === null ? null : `${p.confidencePct}% confident`,
  ].filter((part): part is string => Boolean(part)).map(esc).join(' · ')

  const warnings = p.warnings.length === 0
    ? ''
    : `<div class="warn"><p>Heads up:</p><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`

  const hidden = `<input type="hidden" name="t" value="${esc(p.token)}">`
  const approve = p.canApprove
    ? `<form method="post" action="/a/${esc(p.draftId)}/approve">${hidden}`
      + `<button type="submit">Approve — sends in ${APPROVE_UNDO_SECONDS} seconds</button></form>`
    : ''
  const hold = p.canHold
    ? `<form method="post" action="/a/${esc(p.draftId)}/hold">${hidden}`
      + '<button type="submit" class="secondary">Hold — do not send this</button></form>'
    : ''

  return page(
    `<h1>Reply ready</h1><p class="meta">${meta}</p><pre>${esc(p.body)}</pre>${warnings}${approve}${hold}`
    + appLink(p.appUrl, 'reject or edit in the app.'),
  )
}

/** One sentence per draft status — what happened to this reply, for someone who holds a real token. */
const STATUS_DETAIL: Record<DraftStatus, string> = {
  pending: 'This reply is still waiting for a decision.',
  approved: 'It is approved and on its way.',
  held: 'It is paused — nothing was sent.',
  sending: 'It is going out right now.',
  sent: 'It was already sent.',
  rejected: 'It was rejected.',
  superseded: 'A newer reply replaced it.',
  expired: 'It expired before anyone decided.',
  failed: 'It could not be sent.',
}

/** '2 hours ago' — coarse on purpose; this is a sentence in an email-client browser, not a timestamp. */
function ago(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * A VALID token on a draft nobody can act on any more. Naming the real status is safe here and only
 * here: the caller already proved they hold the unconsumed, unexpired token for THIS draft, so there
 * is no oracle left to protect — and "already handled" beats the friendly page's misleading "expired".
 * `now` is passed in rather than read here so every function in this module stays a pure fold of its props.
 */
export function statusPage(p: { status: DraftStatus; sentAt: Date | null; now: Date; appUrl: string }): string {
  const heading = p.status === 'pending' ? 'Still waiting' : 'Already handled'
  const detail = p.status === 'sent' && p.sentAt ? `It was sent ${ago(p.sentAt, p.now)}.` : STATUS_DETAIL[p.status]
  return page(`<h1>${heading}</h1><p>${esc(detail)}</p>` + appLink(p.appUrl, 'see the whole thread there.'))
}

export type ResultKind = 'approved' | 'held' | 'agent_disabled' | 'kill_switch' | 'guardrail'

const RESULT_COPY: Record<ResultKind, { heading: string; detail: string; link: string }> = {
  approved: {
    heading: 'Approved',
    detail: `Sending in ${APPROVE_UNDO_SECONDS} seconds.`,
    link: 'pull it back there if you change your mind.',
  },
  held: {
    heading: 'Held',
    detail: 'Nothing was sent — this reply is on hold and back in your review list.',
    link: 'approve or edit it there when you are ready.',
  },
  // The three refusals below write NOTHING (the token included), so the same link still works once the
  // owner fixes the cause — every copy says so rather than sending them back for a new email.
  agent_disabled: {
    heading: 'Could not approve',
    detail: 'The agent is off, so nothing can be sent. Turn the agent on in the app, then use this link again.',
    link: 'turn the agent on there.',
  },
  kill_switch: {
    heading: 'Could not approve',
    detail: 'Sending is paused for this workspace. Resume it in the app, then use this link again.',
    link: 'resume sending there.',
  },
  guardrail: {
    heading: 'Could not approve',
    detail: 'The guardrails blocked this reply. Edit it in the app — the edited version has to pass before it can send.',
    link: 'edit it there.',
  },
}

export function resultPage(kind: ResultKind, extra: { findings?: string[]; appUrl?: string } = {}): string {
  const copy = RESULT_COPY[kind]
  const findings = extra.findings?.length
    ? `<ul>${extra.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : ''
  return page(`<h1>${copy.heading}</h1><p>${esc(copy.detail)}</p>${findings}` + appLink(extra.appUrl, copy.link))
}
