import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import type { MailProvider } from '@aesa/contracts'
import { agents, audit, drafts, mailboxConnections, tickets } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { createMemoryStore } from '@aesa/knowledge/storage'
import type pino from 'pino'
import { expect } from 'vitest'
import { createAuth } from '../../src/auth.ts'
import { loadConfig } from '../../src/config.ts'
import { createApiFacade, type ApiFacade, type EnqueueFn, type ServerDeps } from '../../src/deps.ts'
import { createAppLogger } from '../../src/logging.ts'
import { createDevSink, type DevSink } from '../../src/mail/transport.ts'
import { buildServer } from '../../src/server.ts'

export const WEB = 'http://localhost:8081'
export const TEST_ENV = {
  DATABASE_URL: 'postgres://unused', APP_BASE_URL: 'http://localhost:3001', APP_WEB_ORIGIN: WEB,
  BETTER_AUTH_SECRET: 'test-secret-'.repeat(4), AUTH_RATE_LIMIT: 'off', API_RATE_LIMIT_PER_MINUTE: '0',
} as const

/** No suite here runs a real pg-boss client (that's connect-flow.test.ts's `enqueue`/`mailProviders`
 * overrides below) — this default just resolves null, same shape as pg-boss sending to a queue that
 * doesn't exist yet. */
const noopEnqueue: EnqueueFn = async () => null

/** A complete api over a throwaway database; `close()` drops it. `depsOverrides` lets a suite replace
 * `enqueue` with a recording fake and/or `mailProviders` with stubbed adapters (connect-flow.test.ts) —
 * every other suite gets the same behavior as before this parameter existed. `opts.logLevel` lifts the
 * default 'warn' so a suite can assert on Fastify's own (info-level) request line — the only way to see
 * what the `req` serializer's redactUrl() actually emitted (review-pages.test.ts). */
export async function createTestApi(
  overrides: Partial<NodeJS.ProcessEnv> = {},
  depsOverrides: Partial<Pick<ServerDeps, 'enqueue' | 'mailProviders' | 'verifyGoogleJwt' | 'store'>> = {},
  opts: { logLevel?: string } = {},
) {
  const t = await createTestDatabase()
  const config = loadConfig({ ...TEST_ENV, ...overrides, DATABASE_URL: t.url })
  const handle = createDb(t.url, { role: 'app' })
  const api = createApiFacade(handle)
  const mail = createDevSink()
  const lines: string[] = []
  const logger = createAppLogger({ level: opts.logLevel ?? 'warn', stream: { write: (line: string) => void lines.push(line) } })
  const auth = createAuth({ db: handle.db, config, mail, logger, audit: (orgId, entry) => api.withOrg(orgId, (tx) => audit(tx, entry)) })
  const enqueue = depsOverrides.enqueue ?? noopEnqueue
  const store = depsOverrides.store ?? createMemoryStore()
  const app = buildServer({
    config, auth, api, mail, logger, enqueue, store,
    mailProviders: depsOverrides.mailProviders,
    verifyGoogleJwt: depsOverrides.verifyGoogleJwt,
  })
  return { app, config, mail, api, handle, lines, store, close: async () => { await app.close(); await handle.pool.end(); await t.drop() } }
}

/** Deps for suites that never touch the database (error handler, redaction, /meta). Silent by default. */
export function stubDeps(env: Partial<NodeJS.ProcessEnv> = {}, opts: { level?: string; stream?: pino.DestinationStream } = {}): ServerDeps {
  const config = loadConfig({ ...TEST_ENV, ...env })
  const auth = { handler: async () => new Response(null, { status: 404 }), api: {} } as unknown as ServerDeps['auth']
  const api: ServerDeps['api'] = {
    withOrg: async () => { throw new Error('no database in stubDeps') },
    resolveOauthFlow: async () => null,
    resolveMailboxConnection: async () => null,
    resolveMailboxSubscription: async () => null,
    resolveDraftActionToken: async () => null,
    recordWebhookEvent: async () => { throw new Error('no database in stubDeps') },
    health: async () => ({ db: 'error', migrations: { count: 0, latest: null } }),
  }
  const logger = createAppLogger({ level: opts.level ?? 'silent', stream: opts.stream })
  return { config, auth, api, mail: createDevSink(), logger, enqueue: noopEnqueue, store: createMemoryStore() }
}

/** Email OTP sign-in through the real routes. Returns the session cookie (name=value) and the user. */
export async function signInWithOtp(app: FastifyInstance, mail: DevSink, email: string, name = 'Robert') {
  const headers = { origin: WEB, 'content-type': 'application/json' }
  const sent = await app.inject({ method: 'POST', url: '/api/auth/email-otp/send-verification-otp', headers, payload: { email, type: 'sign-in' } })
  expect(sent.statusCode).toBe(200)
  const otp = mail.latestTo(email)?.text.match(/\b(\d{6})\b/)?.[1]
  expect(otp).toBeDefined()
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email-otp', headers, payload: { email, otp, name } })
  expect(res.statusCode).toBe(200)
  const raw = res.headers['set-cookie']
  const first = (Array.isArray(raw) ? raw : [raw]).find((c) => c?.includes('session_token'))
  expect(first).toBeDefined()
  return { cookie: first!.split(';')[0]!, user: res.json().user as { id: string; email: string; name: string } }
}

/** Inserts an already-`connected` mailbox connection directly, bypassing the real OAuth dance
 * (connect-flow.test.ts already covers that end to end) — every mailboxes/agents/inbox router suite
 * needs a connected mailbox to exist before it can add an address, list agents, or seed tickets. */
export async function insertConnectedMailbox(
  api: ApiFacade, orgId: string, connectedByUserId: string, emailAddress: string, provider: MailProvider = 'gmail',
): Promise<string> {
  const [conn] = await api.withOrg(orgId, (tx) =>
    tx.insert(mailboxConnections).values({
      orgId, provider, providerAccountId: `acct-${emailAddress}`, emailAddress, status: 'connected', connectedByUserId,
    }).returning({ id: mailboxConnections.id }),
  )
  return conn!.id
}

/** Binds to a random port for suites that need real HTTP (the tRPC client). */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}

/** An `active` agent on a connection — the address a draft is answered from (its domain feeds the approve gate's policy). */
export async function insertAgent(
  api: ApiFacade, orgId: string, connectionId: string, address: string, overrides: Partial<typeof agents.$inferInsert> = {},
): Promise<string> {
  const [row] = await api.withOrg(orgId, (tx) =>
    tx.insert(agents).values({
      orgId, connectionId, address, domain: address.split('@')[1]!, displayName: 'Support', status: 'active', ...overrides,
    }).returning({ id: agents.id }),
  )
  return row!.id
}

/** A ticket with a unique provider thread id; every other column comes from `values`. */
export async function insertTicket(
  api: ApiFacade, orgId: string, values: Partial<typeof tickets.$inferInsert> & { connectionId: string },
): Promise<typeof tickets.$inferSelect> {
  const [row] = await api.withOrg(orgId, (tx) =>
    tx.insert(tickets).values({ orgId, providerThreadId: `thread-${randomUUID()}`, status: 'new', ...values }).returning(),
  )
  return row!
}

export const SEED_DRAFT_BODY = 'Hi Casey,\n\nYour order ships tomorrow and you will get tracking by email.\n\nThanks'

/** The row `ticket.draft` would have written: `pending`, version 1, decision review/ok, 7-day expiry. */
export async function seedPendingDraft(
  api: ApiFacade, orgId: string, ticketId: string,
  opts: { agentId?: string | null; body?: string; viewedAt?: Date | null; status?: string; confidence?: number } = {},
): Promise<typeof drafts.$inferSelect> {
  const now = new Date()
  const [row] = await api.withOrg(orgId, (tx) =>
    tx.insert(drafts).values({
      orgId, ticketId, agentId: opts.agentId ?? null, version: 1,
      body: opts.body ?? SEED_DRAFT_BODY,
      decision: 'review', decisionReason: 'ok', status: opts.status ?? 'pending',
      confidence: opts.confidence ?? 0.75, modelConfidence: opts.confidence ?? 0.75,
      rationale: 'The shipping date is in the knowledge base.',
      threadSnapshotAt: now, viewedAt: opts.viewedAt ?? null,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    }).returning(),
  )
  return row!
}
