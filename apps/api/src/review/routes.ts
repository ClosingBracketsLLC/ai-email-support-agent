/**
 * The one-click review pages the daily digest email links to: `GET /a/:draftId?t=` renders, and the two
 * POSTs it renders decide. Session-less by construction — the click arrives from a mail client that
 * carries no cookie — so the 256-bit action token IS the capability, minted per (draft, recipient) by
 * `digest-email.ts` and single-use.
 *
 * The three rules this file exists to keep (ported from doge-buddy `apps/ops/src/http/actions.ts`):
 *  - **GET never mutates.** Mail clients, link scanners and corporate gateways prefetch every URL in a
 *    message; a GET that decided anything would approve replies nobody read. `viewed_at` is stamped by
 *    the POST — whose page rendered the body, which is what makes the click proof of a read.
 *  - **One constant failure page.** An unknown draft, a garbage token, a consumed token and an expired
 *    token render `friendlyPage()` byte for byte, so probing ids reveals nothing.
 *  - **Nothing escapes as a 500.** Every handler runs inside `safeRender`: any throw becomes a warn
 *    line (with the url redacted) and the same friendly page at 200. Fastify's default 5xx body would
 *    otherwise carry request detail on a link anyone can click.
 *
 * The decisions themselves are NOT implemented here — `approveDraft`/`holdDraft` in `../drafts/service.ts`
 * are the one implementation behind both this surface and the `drafts` tRPC router, and they consume the
 * token in the SAME transaction as the decision (and only on success, so a lever or guardrail refusal
 * leaves the link usable once the owner fixes the cause).
 */
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hashToken, hashesEqual } from '@aesa/crypto'
import { categories, tickets } from '@aesa/db'
import type { ServerDeps } from '../deps.ts'
import {
  approveDraft, holdDraft, loadDraftView, type DraftActor, type DraftServiceDeps, type DraftView,
} from '../drafts/service.ts'
import { redactUrl } from '../redact.ts'
import { friendlyPage, resultPage, reviewPage, statusPage } from './pages.ts'

/** `generateToken` is 32 random bytes as base64url — exactly 43 characters. Anything else is not a
 * token this system ever minted, so it is rejected before it costs a hash and a query. The hash lookup
 * is the real gate; this is only the cheap door. */
const RAW_TOKEN = /^[A-Za-z0-9_-]{43}$/

interface ResolvedToken {
  tokenId: string
  orgId: string
  userId: string
  /** The DB's own draft id, not the path parameter — every read and write below uses THIS. */
  draftId: string
  /** The raw token, carried through so the page it renders can put it back in the form. */
  raw: string
}

/**
 * The five checks, in cost order: shape, then the (SECURITY DEFINER, cross-org) hash lookup, then the
 * three properties of the row itself. The draft id is compared in constant time against the path
 * parameter — a token is bound to one draft, and a mismatch is exactly as unremarkable as a bad token.
 * The parameter is lower-cased first: Postgres renders a uuid lower-case, but link rewriters (and users
 * retyping a link) normalize case, and a real token on its own draft must not fail over that. Case is
 * the only thing folded — `hashesEqual` still guards length and compares in constant time.
 */
async function resolveActionToken(deps: ServerDeps, draftId: string, raw: unknown): Promise<ResolvedToken | null> {
  // `unknown`, not `string | undefined`: a duplicated `?t=`/`t=` arrives as an ARRAY, and the typeof
  // guard is what keeps that out of `hashToken`'s template literal.
  if (typeof raw !== 'string' || !RAW_TOKEN.test(raw)) return null
  const row = await deps.api.resolveDraftActionToken(hashToken('action', raw))
  if (!row) return null
  if (!hashesEqual(row.draftId, draftId.toLowerCase())) return null
  if (row.consumedAt !== null) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  return { tokenId: row.tokenId, orgId: row.orgId, userId: row.userId, draftId: row.draftId, raw }
}

/** Everything a page needs, read in ONE `withOrg` (the resolver above is what supplied the org). */
interface ReviewData {
  draft: DraftView
  subject: string | null
  customer: string
  categoryLabel: string | null
  appUrl: string
}

async function loadReviewData(deps: ServerDeps, orgId: string, draftId: string): Promise<ReviewData | null> {
  return deps.api.withOrg(orgId, async (tx) => {
    // `loadDraftView` is the shared loader (body, final body, status, confidence, the send row); only
    // the customer-facing header — who wrote in, about what — has to be read beside it.
    const draft = await loadDraftView(tx, orgId, draftId)
    if (!draft) return null
    const [ticket] = await tx.select({
      subject: tickets.subject, customerName: tickets.customerName, customerEmail: tickets.customerEmail,
      categoryLabel: categories.label,
    })
      .from(tickets)
      .leftJoin(categories, eq(categories.id, tickets.categoryId))
      .where(and(eq(tickets.orgId, orgId), eq(tickets.id, draft.ticketId)))
      .limit(1)
    return {
      draft,
      subject: ticket?.subject ?? null,
      // Same fallback ladder the digest email itself uses, so the page reads like the mail it came from.
      customer: ticket?.customerName || ticket?.customerEmail || 'unknown sender',
      categoryLabel: draft.categoryLabel ?? ticket?.categoryLabel ?? null,
      appUrl: `${deps.config.appWebOrigin}/ticket/${draft.ticketId}`,
    }
  })
}

/** `drafts.guardrail_result` is jsonb — trusted in shape by convention only, so read it defensively. */
function findingText(f: { code: string; detail?: string | null }): string {
  return f.detail ? `${f.code} — ${f.detail}` : f.code
}

function guardrailWarnings(result: Record<string, unknown>): string[] {
  const findings = (result as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return []
  return findings
    .filter((f): f is { code: string; severity: string; detail?: string } =>
      typeof f === 'object' && f !== null
      && typeof (f as { code?: unknown }).code === 'string'
      && (f as { severity?: unknown }).severity === 'warn')
    .map(findingText)
}

/** The draft is `approved` and its send has not been claimed yet: the 15-second undo window is open. */
function holdable(draft: DraftView): boolean {
  return draft.status === 'approved' && draft.send?.status === 'queued'
}

function statusPageFor(data: ReviewData): string {
  return statusPage({
    status: data.draft.status, sentAt: data.draft.send?.sentAt ?? null, now: new Date(), appUrl: data.appUrl,
  })
}

/** What the GET renders: the review page while there is still something to decide (a `pending` draft, or
 * an `approved` one inside its undo window), the status page once there is not. */
function renderState(data: ReviewData, token: string): string {
  const { draft } = data
  const canHold = holdable(draft)
  if (draft.status !== 'pending' && !canHold) return statusPageFor(data)
  return reviewPage({
    draftId: draft.id,
    token,
    subject: data.subject ?? '',
    customer: data.customer,
    categoryLabel: data.categoryLabel,
    confidencePct: draft.confidence === null ? null : Math.round(draft.confidence * 100),
    // An approved draft shows what will actually go out; a pending one has no final body yet.
    body: draft.finalBody ?? draft.body,
    warnings: guardrailWarnings(draft.guardrailResult),
    canApprove: draft.status === 'pending',
    canHold,
    appUrl: data.appUrl,
  })
}

const serviceDeps = (deps: ServerDeps): DraftServiceDeps => ({ api: deps.api, enqueue: deps.enqueue, logger: deps.logger })

/** The token's own user is the decider — that is what minting one per recipient buys: a forwarded
 * email cannot act as somebody else, and the audit row names the person who actually clicked. */
function emailActor(tok: ResolvedToken, req: FastifyRequest): DraftActor {
  return {
    userId: tok.userId, actor: `user:${tok.userId}`, source: 'email',
    ip: req.ip, userAgent: req.headers['user-agent'] ?? null,
  }
}

async function handleGet(deps: ServerDeps, draftId: string, raw: unknown): Promise<string> {
  const tok = await resolveActionToken(deps, draftId, raw)
  if (!tok) return friendlyPage()
  const data = await loadReviewData(deps, tok.orgId, tok.draftId)
  // A token whose draft is gone (cascade-deleted with its ticket) is as dead as an unknown one.
  if (!data) return friendlyPage()
  return renderState(data, tok.raw)
}

async function handleApprove(deps: ServerDeps, req: FastifyRequest, draftId: string, raw: unknown): Promise<string> {
  const tok = await resolveActionToken(deps, draftId, raw)
  if (!tok) return friendlyPage()

  const res = await approveDraft(serviceDeps(deps), tok.orgId, { draftId: tok.draftId }, emailActor(tok, req), { consumeTokenId: tok.tokenId })
  if (res.ok) {
    const data = await loadReviewData(deps, tok.orgId, tok.draftId)
    return resultPage('approved', { appUrl: data?.appUrl })
  }
  if (res.code === 'not_found') return friendlyPage()
  if (res.code === 'not_viewed') {
    // Unreachable on this surface: `source: 'email'` stamps `viewed_at` itself, because the page that
    // rendered the body IS the read. Reaching it would be a service bug, so say so in the log and give
    // the clicker the same page a dead link gets rather than copy about a rule they cannot satisfy.
    req.log.warn({ draftId: tok.draftId }, 'review: approve refused not_viewed on the email surface')
    return friendlyPage()
  }

  const data = await loadReviewData(deps, tok.orgId, tok.draftId)
  if (!data) return friendlyPage()
  // Someone else — the owner in the app, a sweep, a resolve — got there first.
  if (res.code === 'not_pending') return statusPageFor(data)
  // The three refusals that wrote nothing at all, token included.
  return resultPage(res.code, { appUrl: data.appUrl, findings: res.findings?.map(findingText) })
}

async function handleHold(deps: ServerDeps, req: FastifyRequest, draftId: string, raw: unknown): Promise<string> {
  const tok = await resolveActionToken(deps, draftId, raw)
  if (!tok) return friendlyPage()

  const res = await holdDraft(serviceDeps(deps), tok.orgId, tok.draftId, emailActor(tok, req), { consumeTokenId: tok.tokenId })
  if (!res.ok && res.code === 'not_found') return friendlyPage()

  const data = await loadReviewData(deps, tok.orgId, tok.draftId)
  if (!data) return friendlyPage()
  // `too_late` (the send is already claimed or gone) and `not_holdable` (never approved, or held
  // already) are both "the state moved on" — the status page says which, off the row itself.
  return res.ok ? resultPage('held', { appUrl: data.appUrl }) : statusPageFor(data)
}

/**
 * The uniform 200. A public link anyone can click may never surface anything but the friendly page:
 * without this a route change, a driver error or an unanticipated input reaches Fastify's default
 * handler, which answers 500 with request detail in the body — and a distinguishable response is a
 * state oracle even when it carries nothing else.
 */
async function safeRender(req: FastifyRequest, work: () => Promise<string>): Promise<string> {
  try {
    return await work()
  } catch (err) {
    // `redactUrl` masks every query value, `t` included; the `err` serializer strips SQL and parameters.
    req.log.warn({ err, url: redactUrl(req.url) }, 'review page failed')
    return friendlyPage()
  }
}

/**
 * The ONE reply shape every route here uses. `no-store` is not decoration: the GET's url carries a live
 * single-use token in its query string and its body carries the customer's message context and that same
 * token in a form field, so no shared cache, browser back-forward store or corporate proxy may keep a
 * copy. Applying it unconditionally is also what keeps the four failure modes identical in their HEADERS
 * as well as their bytes — a `no-store` present on some review responses and absent on others would be
 * exactly the oracle `friendlyPage()` exists to deny.
 *
 * Three defence-in-depth headers ride alongside it, unconditionally, for the same reason. The pages
 * render a customer's message body (escaped, but still attacker-influenced text) inside a page that
 * carries a live single-use action token, so: `content-security-policy` — `style-src 'unsafe-inline'`
 * because the brand branch put the review pages' CSS in an inline `<style>` (`src/brand/css.ts`), and
 * `default-src 'none'` blocks everything else since the pages have no script and load no external
 * resource, and `base-uri 'none'` refuses any `<base>` element outright — `form-action 'self'` is
 * resolved against the document base, so an injected `<base href>` would otherwise be a way to aim
 * the approve/hold form somewhere else; `x-frame-options: DENY` stops the form from being framed
 * for a clickjack;
 * `x-content-type-options: nosniff` stops a browser from ever second-guessing the `text/html` type.
 */
function reviewReply(reply: FastifyReply, body: string): FastifyReply {
  return reply.code(200)
    .header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
    .header('x-frame-options', 'DENY')
    .header('x-content-type-options', 'nosniff')
    .type('text/html; charset=utf-8').send(body)
}

export function registerReviewRoutes(routes: FastifyInstance, deps: ServerDeps): void {
  routes.get<{ Params: { draftId: string }; Querystring: { t?: string } }>('/a/:draftId', async (req, reply) =>
    reviewReply(reply, await safeRender(req, () => handleGet(deps, req.params.draftId, req.query.t))))

  // The token comes off the FORM, not the query string: a POST's url is what lands in the access log.
  // `@fastify/formbody` — registered in server.ts on THIS encapsulation context and no wider (fix
  // wave A4) — is what turns the body into this object at all.
  routes.post<{ Params: { draftId: string }; Body: { t?: string } }>('/a/:draftId/approve', async (req, reply) =>
    reviewReply(reply, await safeRender(req, () => handleApprove(deps, req, req.params.draftId, req.body?.t))))

  routes.post<{ Params: { draftId: string }; Body: { t?: string } }>('/a/:draftId/hold', async (req, reply) =>
    reviewReply(reply, await safeRender(req, () => handleHold(deps, req, req.params.draftId, req.body?.t))))
}
