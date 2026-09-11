import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRPCError } from '@trpc/server'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import type { ServerDeps } from '../src/deps.ts'
import type { SessionBundle } from '../src/trpc/context.ts'
import { stubDeps, WEB } from './helpers/app.ts'

// Phase 1 review, Critical 1: /trpc had no errorFormatter/isDev, so a thrown DrizzleQueryError (or any other
// unexpected error) reached the client with its raw message and, outside NODE_ENV=production, a full stack —
// both pre-auth (createContextFactory calls getSession before any procedure) and inside a procedure. The api's
// own Fastify error handler (which strips SQL/params and collapses 5xx) never runs for /trpc, so init.ts's
// isDev:false + errorFormatter is the only thing masking this.

const SECRET = 'ExponentPushToken[SECRET]'
const QUERY = 'insert into "notification_devices" ("expo_push_token") values ($1)'
const boom = () => new DrizzleQueryError(QUERY, [SECRET], Object.assign(new Error('duplicate key'), { code: '23505' }))

const ORG_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID = '22222222-2222-2222-2222-222222222222'
const FAKE_SESSION = {
  session: { id: 'sess1', token: 'tok', userId: USER_ID, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(), ipAddress: null, userAgent: null, activeOrganizationId: ORG_ID },
  user: { id: USER_ID, email: 'a@example.com', name: 'A', emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() },
} as unknown as SessionBundle

/**
 * stubDeps() plus a stubbed authenticated session/member (so `devices.list`, a real orgProcedure query,
 * is reachable without a real database) and a withOrg that always throws. `sessionThrows` moves the failure
 * before any procedure runs, into createContextFactory's own getSession call (the pre-auth path).
 */
function buildFailingDeps(opts: { sessionThrows?: boolean } = {}): { deps: ServerDeps; log: () => string } {
  const lines: string[] = []
  const base = stubDeps({}, { level: 'trace', stream: { write: (line: string) => void lines.push(line) } })
  const auth = {
    handler: base.auth.handler,
    api: {
      getSession: async () => { if (opts.sessionThrows) throw boom(); return FAKE_SESSION },
      getActiveMember: async () => ({ id: 'member1', organizationId: ORG_ID, role: 'owner' }),
    },
  } as unknown as ServerDeps['auth']
  const api: ServerDeps['api'] = {
    withOrg: async () => { throw boom() },
    resolveOauthFlow: base.api.resolveOauthFlow,
    resolveMailboxConnection: base.api.resolveMailboxConnection,
    resolveMailboxSubscription: base.api.resolveMailboxSubscription,
    resolveDraftActionToken: base.api.resolveDraftActionToken,
    recordWebhookEvent: base.api.recordWebhookEvent,
    health: base.api.health,
  }
  return { deps: { ...base, auth, api }, log: () => lines.join('') }
}

/** superjson (the tRPC transformer) wraps every response as `{ json, meta }`, so the real payload is nested. */
interface SuperjsonTrpcError { error: { json: { message: string; data: { code: string } } } }

function assertMaskedBody(body: string): void {
  expect(body).not.toContain('insert into')
  expect(body).not.toContain('ExponentPushToken')
  expect(body).not.toContain('params:')
  expect(body).not.toContain('"stack"')
}

function assertRedactedLog(log: string): void {
  expect(log).toContain('Failed query: [redacted]')
  expect(log).toContain('"code":"23505"')
  expect(log).not.toContain(SECRET)
  expect(log).not.toContain('insert into')
}

describe('/trpc error surface (init.ts isDev:false + errorFormatter)', () => {
  it('(a) a procedure that reaches withOrg (devices.list) masks an INTERNAL_SERVER_ERROR to a bare message, no stack, no SQL', async () => {
    const { deps, log } = buildFailingDeps()
    const app = buildServer(deps)
    const res = await app.inject({ method: 'GET', url: '/trpc/devices.list', headers: { origin: WEB } })
    await app.close()

    expect(res.statusCode).toBe(500)
    assertMaskedBody(res.body)
    const body = res.json() as SuperjsonTrpcError
    expect(body.error.json.message).toBe('Internal Server Error')
    assertRedactedLog(log())
  })

  it('(b) getSession itself throwing (pre-auth, before any procedure) gets the same masking', async () => {
    const { deps, log } = buildFailingDeps({ sessionThrows: true })
    const app = buildServer(deps)
    const res = await app.inject({ method: 'GET', url: '/trpc/devices.list', headers: { origin: WEB } })
    await app.close()

    expect(res.statusCode).toBe(500)
    assertMaskedBody(res.body)
    const body = res.json() as SuperjsonTrpcError
    expect(body.error.json.message).toBe('Internal Server Error')
    assertRedactedLog(log())
  })

  it('(c) a plain Fastify route throwing the same error still gets the bare 500 body, with the same log guarantees', async () => {
    const { deps, log } = buildFailingDeps()
    const app = buildServer(deps)
    app.get('/boom', async () => { throw boom() })
    const res = await app.inject({ method: 'GET', url: '/boom' })
    await app.close()

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
    assertMaskedBody(res.body)
    assertRedactedLog(log())
  })

  it('a client-thrown TRPCError (not INTERNAL_SERVER_ERROR) keeps its own message', async () => {
    const { deps } = buildFailingDeps()
    const app = deps
    const withThrow: ServerDeps = { ...app, api: { ...app.api, withOrg: async () => { throw new TRPCError({ code: 'FORBIDDEN', message: 'x' }) } } }
    const server = buildServer(withThrow)
    const res = await server.inject({ method: 'GET', url: '/trpc/devices.list', headers: { origin: WEB } })
    await server.close()

    expect(res.statusCode).toBe(403)
    const body = res.json() as SuperjsonTrpcError
    expect(body.error.json.message).toBe('x')
    expect(body.error.json.data.code).toBe('FORBIDDEN')
  })

  it('(d) the guardrail cause passthrough never applies to a 500: an INTERNAL_SERVER_ERROR carrying { findings } exposes nothing', async () => {
    // Task 17 extends the errorFormatter so a NON-500 error (drafts.approve's BAD_REQUEST 'guardrail')
    // can hand the app its findings through `cause`. The 500 branch runs first and is untouched, so an
    // internal error that happens to carry the same cause shape still says only "Internal Server Error".
    const base = stubDeps()
    const auth = {
      handler: base.auth.handler,
      api: {
        getSession: async () => FAKE_SESSION,
        getActiveMember: async () => ({ id: 'member1', organizationId: ORG_ID, role: 'owner' }),
      },
    } as unknown as ServerDeps['auth']
    const api: ServerDeps['api'] = {
      ...base.api,
      withOrg: async () => {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: SECRET, cause: { findings: [{ code: 'secret_leak', severity: 'fail', detail: SECRET }] } })
      },
    }
    const app = buildServer({ ...base, auth, api })
    const res = await app.inject({ method: 'GET', url: '/trpc/devices.list', headers: { origin: WEB } })
    await app.close()

    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('findings')
    expect(res.body).not.toContain(SECRET)
    const body = res.json() as SuperjsonTrpcError
    expect(body.error.json.message).toBe('Internal Server Error')
    expect((body.error.json.data as { findings?: unknown }).findings).toBeUndefined()
  })
})

/**
 * The other surface: what the api lets IN. CLAUDE.md — "the api never holds the KEK, never calls a
 * model". Fix wave A1 makes the approve gate build the SAME guardrail policy as the worker's send
 * gate, which means `apps/api` now depends on `@aesa/agent` — but only through the pure
 * `@aesa/agent/policy` sub-path (prompt TEXT plus `@aesa/core`, no `@aesa/llm`, no `run.ts`).
 *
 * This walks the REAL module graph the way `tsx` builds it at runtime, not vitest's, so a value
 * import of `@aesa/llm` or a slip to the package root (`@aesa/agent`) anywhere under the draft
 * service fails here — the Anthropic SDK must never be resolvable from an api process.
 */
describe('the api module graph', () => {
  const API_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

  it('importing the draft service never pulls in @aesa/llm or @anthropic-ai/sdk', () => {
    const probe = `
      import { registerHooks } from 'node:module'
      const seen = []
      registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context) } })
      const mod = await import('./src/drafts/service.ts')
      console.log(JSON.stringify({ approve: typeof mod.approveDraft, seen }))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: API_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    })
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { approve: string; seen: string[] }

    expect(result.approve).toBe('function')                       // the service really loaded
    expect(result.seen).toContain('@aesa/agent/policy')           // through the pure sub-path...
    expect(result.seen).not.toContain('@aesa/agent')              // ...and never the package root
    expect(result.seen.filter((sp) => sp.includes('@aesa/llm') || sp.includes('@anthropic-ai'))).toEqual([])
  })
})
