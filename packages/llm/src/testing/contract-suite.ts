/**
 * The scenario table EVERY adapter in this package must satisfy identically (spec Verify:
 * "contract suite green for both adapters"). It exists because the two adapters are wired into the
 * same ladder, the same metering and the same job layer: a difference in what `finish` a refusal
 * produces, or in which `LlmErrorCode` a 429 becomes, silently changes what a draft job does with
 * a BYOK provider versus a managed one.
 *
 * Each scenario drives the REAL adapter through a `fetch` stub — never a mock of the adapter — so
 * what it pins is the adapter's own mapping of a wire response. The caller supplies the wire shapes
 * (its provider's own JSON) and `runProviderContract` supplies the expectations.
 *
 * This module imports `vitest`, so it is reachable only through the `@aesa/llm/testing` sub-path,
 * never the package root — a production importer must never pull a test framework into its graph.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LlmError } from '../core/errors.ts'
import type { ChatRequest, LlmProvider } from '../core/types.ts'

export const CONTRACT_SCHEMA = z.object({ category: z.enum(['toys', 'other']), is_spam: z.boolean() })
export type ContractVerdict = z.infer<typeof CONTRACT_SCHEMA>

export interface ProviderContractWire {
  /** A successful reply whose assistant text is exactly `text`. */
  ok(text: string): Response
  /** A reply the model refused. */
  refusal(): Response
  /** An HTTP error with this status (and headers — the suite passes `retry-after`). */
  status(code: number, headers?: Record<string, string>): Response
  /**
   * Anthropic refuses system blocks ordered volatile-before-static (a cache breakpoint after
   * per-request text would never hit); the OpenAI-compatible dialect has no breakpoint to place, so
   * it concatenates them as given. `true` expects the refusal.
   */
  expectsOrderedBlocks: boolean
  /** The envelope shape a structured reply carries, as the adapter's own rung returns it. */
  envelope(verdict: ContractVerdict): string
}

function baseRequest(over: Partial<ChatRequest<ContractVerdict>> = {}): ChatRequest<ContractVerdict> {
  return {
    model: 'contract-model',
    system: [
      { id: 'a', text: 'Rules.', stability: 'static' },
      { id: 'b', text: 'Now.', stability: 'volatile' },
    ],
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 128,
    meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'k' },
    ...over,
  }
}

const VERDICT: ContractVerdict = { category: 'toys', is_spam: false }

/**
 * Runs the shared table against `make`, which builds the adapter over a caller-supplied `fetch`.
 * `wire` describes that provider's own response shapes.
 */
export function runProviderContract(name: string, make: (fetchFn: typeof fetch) => LlmProvider, wire: ProviderContractWire): void {
  const stub = (respond: () => Response): typeof fetch => (async () => respond()) as unknown as typeof fetch
  const thrower = (err: unknown): typeof fetch =>
    (async () => {
      throw err
    }) as unknown as typeof fetch

  describe(`provider contract: ${name}`, () => {
    it('a plain call returns the text, parsed null, one api call and an integer latency', async () => {
      const res = await make(stub(() => wire.ok('hello there'))).chat(baseRequest())
      expect(res.text).toBe('hello there')
      expect(res.parsed).toBeNull()
      expect(res.parseStrategy).toBe('none')
      expect(res.usage.apiCalls).toBe(1)
      expect(Number.isInteger(res.latencyMs)).toBe(true)
      expect(res.latencyMs).toBeGreaterThanOrEqual(0)
      expect(res.finish).toBe('stop')
    })

    it('a structured call at the model’s best rung parses the envelope', async () => {
      const res = await make(stub(() => wire.ok(wire.envelope(VERDICT)))).chat(baseRequest({ output: { name: 'triage', schema: CONTRACT_SCHEMA } }))
      expect(res.parsed).toEqual(VERDICT)
      expect(['native', 'json_mode']).toContain(res.parseStrategy)
    })

    it('a schema-violating body is parsed null and does NOT throw', async () => {
      const res = await make(stub(() => wire.ok('{"decision":{"category":"nope"}}'))).chat(baseRequest({ output: { name: 'triage', schema: CONTRACT_SCHEMA } }))
      expect(res.parsed).toBeNull()
    })

    it('a refusal maps to finish refusal', async () => {
      const res = await make(stub(() => wire.refusal())).chat(baseRequest())
      expect(res.finish).toBe('refusal')
      expect(res.parsed).toBeNull()
    })

    it('401 is auth, not retryable', async () => {
      const err = (await make(stub(() => wire.status(401))).chat(baseRequest()).catch((e: unknown) => e)) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err.code).toBe('auth')
      expect(err.retryable).toBe(false)
    })

    it('429 with retry-after: 2 is rate_limit, retryable, retryAfterMs 2000', async () => {
      const err = (await make(stub(() => wire.status(429, { 'retry-after': '2' }))).chat(baseRequest()).catch((e: unknown) => e)) as LlmError
      expect(err.code).toBe('rate_limit')
      expect(err.retryable).toBe(true)
      expect(err.retryAfterMs).toBe(2000)
    })

    it('500 is transient', async () => {
      const err = (await make(stub(() => wire.status(500))).chat(baseRequest()).catch((e: unknown) => e)) as LlmError
      expect(err.code).toBe('transient')
      expect(err.retryable).toBe(true)
    })

    it('a raw fetch rejection is transient AND the key never survives into the message', async () => {
      const err = (await make(thrower(new Error('proxy said: Authorization: Bearer sk-secret-key-123456')))
        .chat(baseRequest())
        .catch((e: unknown) => e)) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err.code).toBe('transient')
      expect(err.message).not.toContain('sk-secret')
      expect(err.message).not.toMatch(/Bearer\s+\S*sk-/)
    })

    it('an already-aborted signal rejects with a transient LlmError', async () => {
      const ac = new AbortController()
      ac.abort()
      const err = (await make(stub(() => wire.ok('never'))).chat(baseRequest({ signal: ac.signal })).catch((e: unknown) => e)) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err.code).toBe('transient')
    })

    it(
      wire.expectsOrderedBlocks
        ? 'system blocks out of order (volatile before static) are refused as permanent'
        : 'system blocks out of order are concatenated as given',
      async () => {
        const outOfOrder = baseRequest({
          system: [
            { id: 'b', text: 'Now.', stability: 'volatile' },
            { id: 'a', text: 'Rules.', stability: 'static' },
          ],
        })
        const call = make(stub(() => wire.ok('fine'))).chat(outOfOrder)
        if (wire.expectsOrderedBlocks) {
          const err = (await call.catch((e: unknown) => e)) as LlmError
          expect(err).toBeInstanceOf(LlmError)
          expect(err.code).toBe('permanent')
          expect(err.retryable).toBe(false)
        } else {
          expect((await call).text).toBe('fine')
        }
      },
    )
  })
}
