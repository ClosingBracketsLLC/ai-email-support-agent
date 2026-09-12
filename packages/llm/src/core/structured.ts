/**
 * The structured-output ladder (task brief §core/structured.ts): native structured output ->
 * forced-tool json_mode -> (Phase 6, for a model with NEITHER: one plain-text JSON request) -> one
 * low-effort repair call -> local balanced-brace extraction -> give
 * up. Each rung that calls the model suffixes `meta.idempotencyKey` (`:native`, `:json_mode`,
 * `:plain`, `:repair`) so `withMetering`, wrapped INSIDE this ladder in the registry, records one distinct
 * `llm_calls` row per rung. A `finish: 'refusal'` result from any model call is returned
 * immediately — the model has already declined; asking again would just waste a call. An
 * `LlmError` thrown by any rung is not caught here — it propagates to the caller unchanged; retry
 * policy belongs to the job layer (spec §Budgets), not this package. The ONE exception is rung 1:
 * a `permanent` error from the NATIVE rung is a rejected rung, not a failed request (see there).
 */
import { z } from 'zod'
import { LlmError } from './errors.ts'
import type { ChatRequest, ChatResult, ChatUsage, LlmProvider, StructuredMode } from './types.ts'

export const REPAIR_MAX_OUTPUT_TOKENS = 1024

const ZERO_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 }

/** Keeps "no rung reported a TTL split" (both absent -> absent) distinct from "the split was zero",
 * so `computeCostMicros`'s fallback still applies to a rung that never got a breakdown. */
function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

function sumUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  const cacheWrite5mTokens = addOptional(a.cacheWrite5mTokens, b.cacheWrite5mTokens)
  const cacheWrite1hTokens = addOptional(a.cacheWrite1hTokens, b.cacheWrite1hTokens)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens }),
    ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }),
    apiCalls: a.apiCalls + b.apiCalls,
  }
}

/**
 * Finds the matching `}` for the `{` at `start`, tracking string literals (and escapes inside
 * them) so a brace inside a JSON string value never throws off the depth count. Returns -1 when
 * `start`'s brace is never closed.
 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let j = start; j < text.length; j++) {
    const ch = text[j]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

/**
 * Every balanced top-level `{...}` span in `text` (a nested object is consumed as part of its
 * enclosing span, never reported as its own), longest first — rung 4's last resort when a model's
 * "JSON only" reply still carries surrounding prose.
 */
export function extractBalancedJson(text: string): string[] {
  const spans: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') {
      i++
      continue
    }
    const end = findMatchingBrace(text, i)
    if (end === -1) {
      i++
      continue
    }
    spans.push(text.slice(i, end + 1))
    i = end + 1
  }
  return spans.sort((a, b) => b.length - a.length)
}

/** `JSON.parse` + `schema.safeParse`, no throw on either failure — used by rungs 3 and 4 alike. */
function tryParse<T>(text: string, schema: z.ZodType<T>): T | undefined {
  try {
    const json: unknown = JSON.parse(text)
    const outcome = schema.safeParse(json)
    return outcome.success ? outcome.data : undefined
  } catch {
    return undefined
  }
}

function isRefusal(result: ChatResult<unknown>): boolean {
  return result.finish === 'refusal'
}

/**
 * Wraps `inner` so a `ChatRequest` carrying `output` climbs the ladder instead of making a single
 * call: native (rung 1, only when the model supports it) -> json_mode (rung 2, whenever the model
 * supports either rung) -> one repair call (rung 3) -> local extraction (rung 4) -> `parsed: null`.
 * A request with no `output` passes straight through, untouched, one call.
 */
export function withStructuredLadder(inner: LlmProvider): LlmProvider {
  return {
    kind: inner.kind,

    capabilities(model: string) {
      return inner.capabilities(model)
    },

    ...(inner.listModels ? { listModels: (signal?: AbortSignal) => inner.listModels!(signal) } : {}),

    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const output = req.output
      if (!output) return inner.chat(req)

      const baseKey = req.meta.idempotencyKey
      const caps = inner.capabilities(req.model)

      let usage: ChatUsage = { ...ZERO_USAGE }
      let latencyMs = 0
      let last: ChatResult<T> | null = null

      // Only calls the model — the caller assigns the outcome onto `usage`/`latencyMs`/`last`
      // itself, right in the linear body below, so TypeScript's narrowing of the `let last` guard
      // further down isn't invalidated by a closure that could otherwise reassign it out of turn.
      const callRung = (mode: StructuredMode, suffix: string): Promise<ChatResult<T>> =>
        inner.chat<T>({
          ...req,
          output: { ...output, mode },
          meta: { ...req.meta, idempotencyKey: `${baseKey}:${suffix}` },
        })

      // Rung 1: the model's own structured-output feature — only when it has one.
      if (caps.structuredOutput === 'native') {
        /**
         * The one caught rung. `native` is no longer only a hand-curated fact about a model this
         * platform ships against: Phase 6's probe RAISES it onto any OpenAI-compatible endpoint that
         * honoured `json_schema` once, per CREDENTIAL, and that verdict is then applied to every
         * model on it. A server that does not honour the rung for THIS model answers 400, which
         * `mapError` calls `permanent` — not retryable, not a `FALLBACK_CODE`, so without this catch
         * a raised verdict would fail every draft and triage on that credential outright. A rejected
         * rung is exactly the `parsed: null` case: fall through to json_mode below, which runs for
         * every `!== 'none'` model anyway. Only `permanent`, and only here — every other code (`auth`,
         * `rate_limit`, `context_too_long`, …) describes the credential or the request as a whole and
         * still propagates unchanged, from this rung as from every other.
         */
        let result: ChatResult<T> | null = null
        try {
          result = await callRung('native', 'native')
        } catch (err) {
          if (!(err instanceof LlmError) || err.code !== 'permanent') throw err
        }
        if (result) {
          usage = sumUsage(usage, result.usage)
          latencyMs += result.latencyMs
          last = result
          if (isRefusal(result)) return { ...result, usage, latencyMs }
          if (result.parsed !== null) return { ...result, usage, latencyMs }
        }
      }

      // Rung 2: the forced-tool fallback — whenever the model can take structured output at all
      // (covers both a 'native' model whose rung 1 attempt didn't parse, and a 'json_mode'-only
      // model for which rung 1 above never ran).
      if (caps.structuredOutput !== 'none') {
        const result = await callRung('json_mode', 'json_mode')
        usage = sumUsage(usage, result.usage)
        latencyMs += result.latencyMs
        last = result
        if (isRefusal(result)) return { ...result, usage, latencyMs }
        if (result.parsed !== null) return { ...result, usage, latencyMs, parseStrategy: 'json_mode' }
      }

      if (!last) {
        // caps.structuredOutput === 'none' (Phase 6, ruling ledger 74): neither adapter rung
        // exists, so ask in plain text — the instruction rides as one more VOLATILE system block
        // so the adapter's stability ordering holds — and parse the reply here. A direct parse is
        // `plain`; anything else falls through to the repair + extract rungs below exactly as a
        // failed json_mode reply would.
        const plainSchema = JSON.stringify(z.toJSONSchema(output.schema))
        const plain = await inner.chat<T>({
          ...req,
          output: undefined,
          system: [
            ...req.system,
            {
              id: 'json-instruction',
              stability: 'volatile',
              text: `Reply with ONE JSON object that satisfies this JSON schema exactly, and nothing else — no prose, no code fence.\n${plainSchema}`,
            },
          ],
          meta: { ...req.meta, idempotencyKey: `${baseKey}:plain` },
        })
        usage = sumUsage(usage, plain.usage)
        latencyMs += plain.latencyMs
        last = plain
        if (isRefusal(plain)) return { ...plain, usage, latencyMs }
        const direct = tryParse(plain.text, output.schema)
        if (direct !== undefined) return { ...plain, usage, latencyMs, parsed: direct, parseStrategy: 'plain' }
      }

      // Rung 3: one repair call — plain text in, plain text out, no `output`/tools, so the ladder
      // parses the reply itself against the caller's own schema (not the adapter's envelope).
      const jsonSchema = JSON.stringify(z.toJSONSchema(output.schema))
      const repairResult = await inner.chat<T>({
        model: req.model,
        system: [
          {
            id: 'repair',
            stability: 'volatile',
            text: `Rewrite the following as ONE JSON object that satisfies this JSON schema exactly. Output the JSON only.\n${jsonSchema}`,
          },
        ],
        messages: [{ role: 'user', content: last.text }],
        effort: 'low',
        maxOutputTokens: REPAIR_MAX_OUTPUT_TOKENS,
        signal: req.signal,
        meta: { ...req.meta, idempotencyKey: `${baseKey}:repair` },
      })
      usage = sumUsage(usage, repairResult.usage)
      latencyMs += repairResult.latencyMs
      if (isRefusal(repairResult)) return { ...repairResult, usage, latencyMs }

      const repaired = tryParse(repairResult.text, output.schema)
      if (repaired !== undefined) {
        return { ...repairResult, usage, latencyMs, parsed: repaired, parseStrategy: 'repair' }
      }

      // Rung 4: the repair reply wasn't valid JSON on its own — look for a balanced object inside it.
      for (const candidate of extractBalancedJson(repairResult.text)) {
        const extracted = tryParse(candidate, output.schema)
        if (extracted !== undefined) {
          return { ...repairResult, usage, latencyMs, parsed: extracted, parseStrategy: 'extract' }
        }
      }

      return { ...repairResult, usage, latencyMs, parsed: null, parseStrategy: 'none' }
    },
  }
}
