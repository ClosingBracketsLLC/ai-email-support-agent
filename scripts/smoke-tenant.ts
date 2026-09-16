#!/usr/bin/env tsx
/**
 * Task 11's post-deploy walk: a handful of authenticated reads (plus, optionally, one real sandbox
 * run) against a THROWAWAY workspace, run BY HAND after a deploy — `pnpm smoke:tenant` at the root.
 * Not part of CI (it needs a deployed stack, not the local dev compose).
 *
 * Env:
 *   SMOKE_API_URL     the api's origin, e.g. https://api.example.com (no trailing slash needed)
 *   SMOKE_WEB_ORIGIN  the app's web origin — sent as the `origin` header on every call, which is
 *                      what the api's CSRF hook (server.ts) checks on a POST to /trpc
 *   SMOKE_COOKIE      the FULL `cookie` header value copied from a signed-in browser session of a
 *                      throwaway workspace (devtools → Network → any /trpc request → Cookie)
 *   SMOKE_SANDBOX=1   optional — also runs one real `agents.sandboxStart` + polls `sandboxGet`
 *
 * This script NEVER prints SMOKE_COOKIE, in any form — not the raw value, not inside a logged
 * request/error object. Every failure line below is built from a short message string alone.
 *
 * Built the same way the app's own client is (`apps/app/src/lib/trpc.ts`): createTRPCClient +
 * httpBatchLink + superjson.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '@aesa/api'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`smoke-tenant: missing required env ${name}`)
    process.exit(1)
  }
  return value
}

const apiUrl = requireEnv('SMOKE_API_URL').replace(/\/+$/, '')
const webOrigin = requireEnv('SMOKE_WEB_ORIGIN').replace(/\/+$/, '')
const cookie = requireEnv('SMOKE_COOKIE')
const runSandbox = process.env.SMOKE_SANDBOX === '1'
/** Never derived from `cookie` — used only to build request headers, never logged. */
const authHeaders = { cookie, origin: webOrigin }

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${apiUrl}/trpc`,
      transformer: superjson,
      headers: () => authHeaders,
    }),
  ],
})

interface StepResult { name: string; ok: boolean; ms: number; detail?: string }
const results: StepResult[] = []
let failed = false

/** Runs one check, prints its row immediately (`ok`/`FAIL` + ms), and never rethrows — a failed
 *  step must not stop the rest of the walk from reporting. `errorMessage`, never the raw error,
 *  keeps a stray header (this script sets exactly one: `cookie`) out of the printed line. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const startedAt = Date.now()
  try {
    const value = await fn()
    const ms = Date.now() - startedAt
    results.push({ name, ok: true, ms })
    console.log(`ok    ${ms.toString().padStart(6)}ms  ${name}`)
    return value
  } catch (err) {
    const ms = Date.now() - startedAt
    const detail = err instanceof Error ? err.message : String(err)
    results.push({ name, ok: false, ms, detail })
    failed = true
    console.log(`FAIL  ${ms.toString().padStart(6)}ms  ${name} — ${detail}`)
    return undefined
  }
}

async function fetchJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${apiUrl}${path}`, { headers: { origin: webOrigin } })
  const body: unknown = await res.json().catch(() => undefined)
  return { status: res.status, body }
}

const SANDBOX_POLL_INTERVAL_MS = 2_000
const SANDBOX_POLL_DEADLINE_MS = 120_000
const TERMINAL_SANDBOX_STATES = new Set(['succeeded', 'failed', 'aborted'])

async function pollSandbox(runId: string): Promise<string> {
  const deadline = Date.now() + SANDBOX_POLL_DEADLINE_MS
  for (;;) {
    const run = await client.agents.sandboxGet.query({ runId })
    if (TERMINAL_SANDBOX_STATES.has(run.status)) return run.status
    if (Date.now() >= deadline) throw new Error(`still '${run.status}' after ${SANDBOX_POLL_DEADLINE_MS / 1000}s`)
    await new Promise((resolve) => setTimeout(resolve, SANDBOX_POLL_INTERVAL_MS))
  }
}

async function main(): Promise<void> {
  console.log(`smoke-tenant: ${apiUrl} (sandbox: ${runSandbox ? 'on' : 'off'})`)
  console.log('')

  await step('GET /healthz is 200 with db: ok', async () => {
    const { status, body } = await fetchJson('/healthz')
    if (status !== 200) throw new Error(`status ${status}`)
    const db = (body as { db?: unknown } | undefined)?.db
    if (db !== 'ok') throw new Error(`db: ${JSON.stringify(db)}`)
  })

  await step('GET /meta lists billing, mail, providers', async () => {
    const { status, body } = await fetchJson('/meta')
    if (status !== 200) throw new Error(`status ${status}`)
    const keys = body && typeof body === 'object' ? Object.keys(body) : []
    for (const key of ['billing', 'mail', 'providers']) {
      if (!keys.includes(key)) throw new Error(`missing "${key}"`)
    }
  })

  await step('workspace.get returns the workspace', async () => {
    const ws = await client.workspace.get.query()
    if (!ws || typeof ws.orgId !== 'string') throw new Error('no orgId on the response')
  })

  await step('billing.get returns a state', async () => {
    const billing = await client.billing.get.query()
    if (!billing || typeof billing.state !== 'string') throw new Error('no state on the response')
  })

  const agentsResult = await step('agents.list ≥ 1 agent', async () => {
    const { agents } = await client.agents.list.query()
    if (agents.length < 1) throw new Error('zero agents')
    return agents
  })

  await step('knowledge.list responds', () => client.knowledge.list.query())
  await step('memory.summary responds', () => client.memory.summary.query())

  if (runSandbox) {
    const firstAgent = agentsResult?.[0]
    if (!firstAgent) {
      failed = true
      console.log('FAIL       0ms  agents.sandboxStart + sandboxGet — no agent to run it against (agents.list failed or was empty)')
    } else {
      await step('agents.sandboxStart + sandboxGet reach a terminal state', async () => {
        const { runId } = await client.agents.sandboxStart.mutate({
          agentId: firstAgent.id, question: 'What are your opening hours?',
        })
        const finalStatus = await pollSandbox(runId)
        if (finalStatus !== 'succeeded') throw new Error(`terminal status was '${finalStatus}', not 'succeeded'`)
      })
    }
  }

  console.log('')
  const okCount = results.filter((r) => r.ok).length
  console.log(`${okCount}/${results.length} ok`)
  process.exit(failed ? 1 : 0)
}

await main()
