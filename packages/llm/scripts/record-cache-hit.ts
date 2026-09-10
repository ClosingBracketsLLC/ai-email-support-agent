/**
 * Records the ONE fixture CI cannot fake: a real Anthropic response whose `usage` reports
 * `cache_read_input_tokens > 0`.
 *
 *     LLM_RECORD=1 ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @aesa/llm exec tsx scripts/record-cache-hit.ts
 *
 * `packages/llm/test/anthropic.test.ts`'s "(g) reports cache_read tokens per response" is the only
 * assertion in the repo that proves prompt caching is actually wired — the `cache_control` block
 * placement, the 1-hour TTL, and the adapter's mapping of `cache_read_input_tokens` onto
 * `ChatUsage.cacheReadTokens`. It runs against `test/fixtures/anthropic/draft-cache-hit.json`,
 * which no test can produce: only a live API call reports a cache hit. This script makes that
 * round trip — the same ~1,500-token static system prefix sent TWICE, one second apart — and
 * rewrites the fixture from the SECOND response.
 *
 * **It never runs in CI.** Like `packages/test-kit/src/recorder.ts` (the shape this is modeled on),
 * the live sequence runs only when this file is the process entry point AND `LLM_RECORD=1`, so an
 * accidental `tsx` invocation is a no-op in every environment, credentialed or not. It is a step in
 * `docs/runbooks/2026-09-phase-3-external-setup.md`, run by hand, and the fixture it writes is
 * committed.
 *
 * **Scrubbing is structural first, asserted second.** The recording `fetchFn` captures the response
 * BODY only — never the request, never a header — so the `Authorization` bearer carrying the API key
 * is excluded by construction rather than by redaction. `assertScrubbed` then re-checks the
 * serialized body for `sk-`, `Bearer ` and PEM material before anything is written, and the write is
 * skipped entirely if the cache-hit assertion fails.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Secret } from '@aesa/crypto'
import { z } from 'zod'
import { createAnthropicProvider } from '../src/adapters/anthropic/index.ts'
import { estimateTokens } from '../src/core/tokens.ts'
import type { ChatRequest } from '../src/core/types.ts'

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'anthropic')
const FIXTURE_NAME = 'draft-cache-hit.json'

/**
 * `claude-sonnet-5` by default: the model `anthropic.test.ts`'s (g) case asks for, and the one whose
 * 1,024-token cache minimum the prefix below is sized against. Override with `RECORD_MODEL` when the
 * recording account cannot call that id — the fixture's own `model` field is whatever came back.
 */
const MODEL = process.env.RECORD_MODEL ?? 'claude-sonnet-5'

/** Comfortably above `claude-sonnet-5`'s 1,024-token cache minimum, so `buildSystemBlocks` really
 *  places the 1-hour breakpoint instead of silently skipping it. */
const MIN_STATIC_TOKENS = 1_500

/** Anthropic serves a cache write and a cache read from the same prefix, but the write has to land
 *  first; a short pause between the two calls keeps a same-millisecond race out of the recording. */
const PAUSE_BETWEEN_CALLS_MS = 1_000

/** Never allowed in a committed fixture, wherever it appears once the body is serialized. */
export const FORBIDDEN_SUBSTRINGS = ['sk-', 'Bearer ', 'PRIVATE KEY'] as const

/** The same schema `anthropic.test.ts` parses the fixture against, so the recorded body stays
 *  drop-in compatible with the test that reads it. */
const OUTPUT_SCHEMA = z.object({
  category: z.enum(['toys', 'other']),
  is_spam: z.boolean(),
})
type Verdict = z.infer<typeof OUTPUT_SCHEMA>

/** Throws rather than writing: a fixture carrying auth material must never reach the repository. */
export function assertScrubbed(name: string, body: unknown): void {
  const serialized = JSON.stringify(body)
  const found = FORBIDDEN_SUBSTRINGS.filter((needle) => serialized.includes(needle))
  if (found.length > 0) {
    throw new Error(`assertScrubbed: ${name} contains auth material (${found.join(', ')}) and must NOT be written`)
  }
}

/** A deterministic, secret-free static prefix at least `minTokens` long by `estimateTokens`
 *  (chars/4) — the same estimate the adapter's own cache-minimum check uses. */
export function staticBlockText(minTokens: number = MIN_STATIC_TOKENS): string {
  const paragraph =
    'You classify inbound customer support email for an online shop. Read the message, decide which ' +
    'single category it belongs to, and say whether it is unsolicited bulk mail. Categories are ' +
    'stable across every request and never change between calls, which is exactly why this block is ' +
    'marked static and carries the cache breakpoint. '
  let text = ''
  while (estimateTokens(text) < minTokens) text += paragraph
  return text
}

/** Captures each response BODY — never the request, never a header. */
export function createRecordingFetch(bodies: unknown[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(url as string, init)
    const text = await res.clone().text()
    bodies.push(text.length > 0 ? (JSON.parse(text) as unknown) : null)
    return res
  }) as unknown as typeof fetch
}

function request(): ChatRequest<Verdict> {
  return {
    model: MODEL,
    system: [
      { id: 'platform', text: staticBlockText(), stability: 'static' },
      { id: 'thread', text: 'The customer message follows.', stability: 'volatile' },
    ],
    messages: [{ role: 'user', content: 'Do you sell squeaky toys for a small dog?' }],
    output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'native' },
    maxOutputTokens: 256,
    meta: { orgId: 'record', role: 'triage', idempotencyKey: `record-cache-hit-${Date.now()}` },
  }
}

const usageOf = (body: unknown): Record<string, unknown> =>
  ((body as { usage?: Record<string, unknown> } | null)?.usage ?? {})

/** Returns the process exit code: 0 on a recorded cache hit, 1 on anything else. */
export async function record(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('record-cache-hit: ANTHROPIC_API_KEY is required (LLM_RECORD=1 ANTHROPIC_API_KEY=… tsx scripts/record-cache-hit.ts)')
    return 1
  }

  const bodies: unknown[] = []
  const provider = createAnthropicProvider({ apiKey: new Secret(apiKey), fetchFn: createRecordingFetch(bodies) })

  console.log(`record-cache-hit: model ${MODEL}, static prefix ~${estimateTokens(staticBlockText())} tokens`)
  const first = await provider.chat(request())
  console.log(`  call 1: cacheWrite=${first.usage.cacheWriteTokens} cacheRead=${first.usage.cacheReadTokens} input=${first.usage.inputTokens}`)
  await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_CALLS_MS))
  const second = await provider.chat(request())
  console.log(`  call 2: cacheWrite=${second.usage.cacheWriteTokens} cacheRead=${second.usage.cacheReadTokens} input=${second.usage.inputTokens}`)

  if (bodies.length < 2) {
    console.error(`record-cache-hit: expected two captured responses, got ${bodies.length} — nothing written`)
    return 1
  }
  const body = bodies[bodies.length - 1]
  const cacheRead = Number(usageOf(body).cache_read_input_tokens ?? 0)
  if (!(cacheRead > 0)) {
    console.error(
      `record-cache-hit: the second response reported cache_read_input_tokens=${cacheRead} — no cache hit, so ` +
      'the fixture was NOT rewritten. Check that the static prefix clears the model\'s cache minimum and that ' +
      'both calls were byte-identical.',
    )
    return 1
  }

  assertScrubbed(FIXTURE_NAME, body)
  const target = path.join(FIXTURE_DIR, FIXTURE_NAME)
  writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  console.log(`record-cache-hit: wrote ${target} (cache_read_input_tokens=${cacheRead}) — commit it.`)
  return 0
}

/** Only true when this file is the actual process entry point, never on import — the same run gate
 *  `packages/test-kit/src/recorder.ts` uses. */
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  if (process.env.LLM_RECORD !== '1') {
    console.log(
      [
        'record-cache-hit: LLM_RECORD is unset (or not "1") — nothing was recorded.',
        '',
        'This script makes a REAL, billed Anthropic API call twice. Run it by hand, per',
        'docs/runbooks/2026-09-phase-3-external-setup.md:',
        '',
        '  LLM_RECORD=1 ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @aesa/llm exec tsx scripts/record-cache-hit.ts',
      ].join('\n'),
    )
    process.exit(0)
  }
  process.exit(await record())
}
