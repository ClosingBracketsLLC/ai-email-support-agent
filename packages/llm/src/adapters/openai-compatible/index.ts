/**
 * The OpenAI-compatible adapter (Phase 6 — spec §Bring your own key): ONE `chat.completions.create`
 * call against any endpoint that speaks the OpenAI Chat Completions dialect — OpenAI itself,
 * DeepSeek, Groq, Together, OpenRouter, and `custom` (vLLM, LM Studio, a hosted Ollama, Gemini's
 * OpenAI-compatible route). Everything provider-specific lives in `models.ts`'s `PRESET_QUIRKS`
 * and capability seed; this file is the one request builder and the one response mapper.
 *
 * Same two contracts as the Anthropic adapter: `maxRetries: 0` (retry policy belongs to the job
 * layer, spec §Budgets — a transparent SDK retry would double-count the job layer's budget and
 * hide the rate-limit signal a caller needs), and a schema violation NEVER throws — it is a failed
 * ATTEMPT the structured-output ladder decides what to do with.
 *
 * Verified against the INSTALLED `openai` 7.15.0 before writing (`node_modules/openai/...`):
 *   - request (`resources/chat/completions/completions.d.ts` ChatCompletionCreateParamsBase):
 *     `messages`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`, `response_format`.
 *   - `response_format` (`resources/shared.d.ts`): `ResponseFormatJSONSchema` is
 *     `{ type: 'json_schema', json_schema: { name, description?, schema?, strict? } }` and
 *     `ResponseFormatJSONObject` is `{ type: 'json_object' }`; `ReasoningEffort` is
 *     `'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|null`, a superset of our `Effort`.
 *   - response: `ChatCompletion.id`/`.model`/`.choices[]`, `ChatCompletion.Choice.finish_reason`
 *     (`'stop'|'length'|'tool_calls'|'content_filter'|'function_call'` — `function_call` is
 *     deprecated and mapped with the default), `ChatCompletionMessage.content: string | null` and
 *     `.refusal: string | null`.
 *   - usage (`resources/completions.d.ts` CompletionUsage): `prompt_tokens`, `completion_tokens`,
 *     `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`.
 *     7.15.0 ALSO exposes `prompt_tokens_details.cache_write_tokens`, which the OpenAI API does
 *     not populate for automatic caching and which none of these providers bills separately —
 *     `cacheWriteTokens` stays 0 here, matching the 0 cache-write rates seeded for these models.
 *   - `client.models.list(options?)` returns a `PagePromise<ModelsPage, Model>`; `ModelsPage`
 *     extends the plain `Page`, whose `nextPageRequestOptions()` is always null, so iterating it
 *     is exactly one request.
 *   - errors (`core/error.d.ts`): `RateLimitError`, `AuthenticationError`, `PermissionDeniedError`,
 *     `BadRequestError`, `APIUserAbortError`, `APIConnectionError`, `InternalServerError`,
 *     `APIError` — every one both a named export and a static on the `OpenAI` class (see
 *     `map-errors.ts`). Every name the plan listed exists under the name it listed.
 */
import type { Secret } from '@aesa/crypto'
import OpenAI from 'openai'
import { envelopeSchema, toJsonObjectSchema } from '../../core/shared.ts'
import type { Capabilities, ChatRequest, ChatResult, ChatUsage, LlmProvider, ParseStrategy, StructuredMode } from '../../core/types.ts'
import { mapError } from './map-errors.ts'
import { OPENAI_COMPATIBLE_MODELS, PRESET_QUIRKS, UNKNOWN_OPENAI_COMPATIBLE_MODEL, type OpenAiCompatibleKind } from './models.ts'

export interface CreateOpenAiCompatibleProviderOptions {
  kind: OpenAiCompatibleKind
  apiKey: Secret
  baseUrl: string
  /** The pinned, redirect-refusing `fetch` a BYOK caller builds with `createPinnedFetch`. */
  fetchFn?: typeof fetch
  /** The probe's stored verdict, applied over the preset (the model-config resolver passes it). */
  capabilitiesOverride?: (model: string, preset: Capabilities) => Capabilities
}

/** A refusal outranks the finish reason: `refusal` is set exactly when the model declined, whatever
 * reason accompanies it. `tool_calls` is a normal stop for this adapter, which asks for no tools. */
function mapFinish(reason: string | null | undefined, refusal: string | null | undefined): ChatResult<unknown>['finish'] {
  if (refusal) return 'refusal'
  switch (reason) {
    case 'stop':
    case 'tool_calls':
      return 'stop'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'refusal'
    default:
      return 'unknown'
  }
}

export function createOpenAiCompatibleProvider(opts: CreateOpenAiCompatibleProviderOptions): LlmProvider {
  const client = new OpenAI({
    apiKey: opts.apiKey.expose(),
    baseURL: opts.baseUrl,
    maxRetries: 0,
    ...(opts.fetchFn ? { fetch: opts.fetchFn } : {}),
  })
  const quirks = PRESET_QUIRKS[opts.kind]

  const capabilitiesFor = (model: string): Capabilities => {
    const preset = OPENAI_COMPATIBLE_MODELS[opts.kind][model] ?? UNKNOWN_OPENAI_COMPATIBLE_MODEL
    return opts.capabilitiesOverride ? opts.capabilitiesOverride(model, preset) : preset
  }

  return {
    kind: opts.kind,

    capabilities: capabilitiesFor,

    async listModels(signal?: AbortSignal): Promise<string[]> {
      try {
        const ids: string[] = []
        for await (const model of client.models.list({ signal })) ids.push(model.id)
        return ids
      } catch (err) {
        throw mapError(err)
      }
    },

    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const caps = capabilitiesFor(req.model)
      const mode: StructuredMode | undefined = req.output ? (req.output.mode ?? (caps.structuredOutput === 'native' ? 'native' : 'json_mode')) : undefined

      // Spec §Prompt blocks → caching: the same static → agent → volatile order the caller built,
      // concatenated into ONE system message so the provider's automatic prefix caching benefits.
      // Unlike Anthropic's, this dialect has no per-block breakpoint to place, so an out-of-order
      // block costs nothing and is sent as given rather than refused.
      let system = req.system.map((b) => b.text).join('\n\n')

      let responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']
      if (req.output && mode === 'native') {
        responseFormat = {
          type: 'json_schema',
          json_schema: { name: req.output.name, strict: quirks.strictJsonSchema, schema: toJsonObjectSchema(envelopeSchema(req.output.schema)) },
        }
      } else if (req.output && mode === 'json_mode') {
        responseFormat = { type: 'json_object' }
        // `jsonModeNeedsPromptMention`: DeepSeek 400s a json_object request whose prompt never says
        // "JSON", and spelling the shape out helps every other server too — so it is always on.
        system += `\n\nRespond with a JSON object of the shape ${JSON.stringify(toJsonObjectSchema(envelopeSchema(req.output.schema)))}. JSON only.`
      }

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        ...req.messages.map((m) =>
          m.role === 'user' ? ({ role: 'user' as const, content: m.content }) : ({ role: 'assistant' as const, content: m.content }),
        ),
      ]

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: req.model,
        messages,
        ...(quirks.maxTokensParam === 'max_completion_tokens'
          ? { max_completion_tokens: req.maxOutputTokens }
          : { max_tokens: req.maxOutputTokens }),
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(req.effort && caps.effort ? { reasoning_effort: req.effort } : {}),
      }

      const start = performance.now()
      let res: OpenAI.Chat.Completions.ChatCompletion
      try {
        res = await client.chat.completions.create(params, { signal: req.signal })
      } catch (err) {
        throw mapError(err)
      }
      // `llm_calls.latency_ms` is an integer column — performance.now() - start is a float, so it
      // must be rounded here, not left for the sink to reject.
      const latencyMs = Math.round(performance.now() - start)

      const choice = res.choices[0]
      const text = choice?.message?.content ?? ''
      // These providers price a cache read separately from a fresh input token, and report the
      // cached count INSIDE prompt_tokens — so the two must be split apart here or every cached
      // call is billed twice over in the meter.
      const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const usage: ChatUsage = {
        inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
        outputTokens: res.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        apiCalls: 1,
      }

      let parsed: T | null = null
      let parseStrategy: ParseStrategy = 'none'
      if (req.output && mode && text) {
        try {
          const outcome = envelopeSchema(req.output.schema).safeParse(JSON.parse(text))
          if (outcome.success) {
            parsed = outcome.data.decision
            parseStrategy = mode
          }
        } catch {
          // Not JSON at all — `parsed` stays null and the ladder decides what happens next.
        }
      }

      return {
        text,
        parsed,
        parseStrategy,
        usage,
        finish: mapFinish(choice?.finish_reason, choice?.message?.refusal),
        provider: opts.kind,
        model: res.model || req.model,
        latencyMs,
        providerRequestId: res.id,
      }
    },
  }
}
