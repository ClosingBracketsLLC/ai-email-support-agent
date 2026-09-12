/**
 * A `fetch`-shaped mock of an OpenAI-compatible server, for `e2e-phase6.test.ts`.
 *
 * It is a STUB OF THE WIRE, not of the adapter: every byte it returns is parsed by the real
 * `createOpenAiCompatibleProvider` (the real `openai` SDK), climbed by the real structured-output
 * ladder and metered by the real `withMetering`, so what the E2E asserts is the real composition.
 * Nothing opens a socket — the resolver's and the probe's `fetchFn` seams take this function, which
 * is also why the SSRF-pinned transport is bypassed here alone (it is unit-tested in `@aesa/crypto`).
 *
 * Two request shapes are answered:
 *
 *  - `GET  <base>/models`            → `{ object: 'list', data: [{ id }] }` — the probe's model list.
 *  - `POST <base>/chat/completions`  → one chat completion.
 *
 * Any other base URL is a 404: a credential whose validated base URL never reached the adapter
 * would therefore fail its probe, which is how this file proves the URL plumbing through the
 * DATABASE (`health_status`) rather than by reading the mock's own records.
 *
 * **`mode` is the best structured-output rung this endpoint honours**, and it is what makes the
 * ladder land where a scenario needs it:
 *
 *  | mode        | `response_format: json_schema` | `response_format: json_object` | neither      |
 *  |-------------|--------------------------------|--------------------------------|--------------|
 *  | `native`    | envelope `{ decision: … }`     | envelope                       | see below    |
 *  | `json_mode` | 400                            | envelope                       | see below    |
 *  | `plain`     | 400                            | 400                            | BARE json    |
 *  | `prose`     | 400                            | 400                            | prose + BARE |
 *  | `refusal`   | `content_filter` + a refusal   | same                           | same         |
 *
 * The envelope/bare split is the one thing a mock of this ladder MUST get right (see
 * `packages/llm/src/core/structured.ts`): the `native` and `json_mode` rungs go through the
 * adapter, which parses the `{ decision: … }` ENVELOPE, while the ladder's own `plain`, `repair`
 * and `extract` rungs parse the BARE caller schema out of the reply text themselves. A mock that
 * returns the wrong shape for a rung does not fail — it silently falls to the next one.
 *
 * WHICH decision comes back is inferred from the request itself, because a rung carries no role of
 * its own: the probe by its fixed prompt (or `json_schema.name === 'probe'`), triage by the word
 * `isSpam` — present in the triage system prompt at the `native`/`json_mode` rungs and in the
 * `TriageVerdict` JSON schema the `json_mode`, `plain` and `repair` rungs spell out — and anything
 * else is a draft.
 *
 * `setStatus(code)` arms an HTTP error on EVERY request (`/models` included), which is what a
 * revoked key or a provider outage actually looks like; `setStatus(null)` clears it.
 */

export type MockOpenAiMode = 'native' | 'json_mode' | 'plain' | 'prose' | 'refusal'

export interface MockOpenAiRequest {
  url: string
  method: string
  body: Record<string, unknown> | null
}

export interface MockOpenAiOptions {
  mode: MockOpenAiMode
  /** Armed on every request until cleared. */
  status?: number | null
  /** What `GET /models` lists. */
  models?: string[]
  /** The base URLs this server answers on; anything else 404s. */
  baseUrls: string[]
  /** The bare `TriageVerdict` every triage call resolves to. */
  triage: unknown
  /** The bare `DraftDecision` every draft call resolves to. */
  draft: unknown
  onRequest?: (req: MockOpenAiRequest) => void
}

export interface MockOpenAi {
  fetchFn: typeof fetch
  requests: MockOpenAiRequest[]
  setMode(mode: MockOpenAiMode): void
  setStatus(status: number | null): void
  mode(): MockOpenAiMode
}

/** The probe's own two-field answer (`packages/llm/src/core/probe.ts`'s `ProbeSchema`). */
const PROBE_DECISION = { answer: 'yes', n: 7 }

/** Wrapped around the bare JSON at the `prose` mode, so the plain rung cannot parse the reply
 *  directly and the ladder has to spend its repair + extract rungs. */
const PROSE_BEFORE = 'Sure — here is what I would send:\n\n'
const PROSE_AFTER = '\n\nLet me know if you want it shorter.'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function completion(content: string, over: { finishReason?: string; refusal?: string | null } = {}): unknown {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2, 10)}`,
    object: 'chat.completion',
    created: 1_757_000_000,
    model: 'mock-model',
    choices: [{
      index: 0,
      finish_reason: over.finishReason ?? 'stop',
      message: { role: 'assistant', content, refusal: over.refusal ?? null },
    }],
    usage: { prompt_tokens: 1200, completion_tokens: 180, prompt_tokens_details: { cached_tokens: 0 } },
  }
}

/** The probe's plain chat step — one fixed sentence, from `probeProvider`. */
const PROBE_CHAT_PROMPT = 'Reply with the single word OK.'

type Role = 'probe' | 'triage' | 'draft'

/**
 * The role a request is asking about. Deliberately read off the WHOLE request body: the ladder's
 * rungs carry different shapes (a json_schema name, a system prompt, a bare JSON schema spelled
 * into the system text, or — at the repair rung — only the schema plus the previous reply), and the
 * markers below are present in every one of them.
 */
function roleOf(body: Record<string, unknown>): Role {
  const text = JSON.stringify(body)
  if (text.includes(PROBE_CHAT_PROMPT) || text.includes('"name":"probe"') || text.includes('You answer a yes/no question')) return 'probe'
  if (text.includes('isSpam')) return 'triage'
  return 'draft'
}

export function createMockOpenAi(opts: MockOpenAiOptions): MockOpenAi {
  let mode: MockOpenAiMode = opts.mode
  let status: number | null = opts.status ?? null
  const requests: MockOpenAiRequest[] = []
  const models = opts.models ?? []

  const decisionFor = (role: Role): unknown => (role === 'probe' ? PROBE_DECISION : role === 'triage' ? opts.triage : opts.draft)

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
    let body: Record<string, unknown> | null = null
    if (init?.body != null) {
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>
      } catch {
        body = null
      }
    }
    const record: MockOpenAiRequest = { url, method, body }
    requests.push(record)
    opts.onRequest?.(record)

    if (!opts.baseUrls.some((base) => url.startsWith(base))) {
      return json({ error: { message: `no such endpoint: ${url}`, type: 'invalid_request_error' } }, 404)
    }
    if (status !== null) {
      return json({ error: { message: `mock endpoint refused with ${status}`, type: 'invalid_request_error' } }, status)
    }
    if (url.endsWith('/models')) return json({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) })
    if (!url.endsWith('/chat/completions') || body === null) {
      return json({ error: { message: `unsupported path ${url}`, type: 'invalid_request_error' } }, 404)
    }

    // A refusal is the endpoint's answer whatever was asked, and it short-circuits the ladder.
    if (mode === 'refusal') {
      return json(completion('', { finishReason: 'content_filter', refusal: 'I cannot help with that.' }))
    }
    const decision = decisionFor(roleOf(body))

    const responseFormat = body.response_format as { type?: string } | undefined
    const rung = responseFormat?.type === 'json_schema' ? 'native' : responseFormat?.type === 'json_object' ? 'json_mode' : 'plain'

    if (rung === 'native' || rung === 'json_mode') {
      const honoured = mode === 'native' || (mode === 'json_mode' && rung === 'json_mode')
      if (!honoured) {
        return json({ error: { message: `response_format ${responseFormat?.type} is not supported`, type: 'invalid_request_error' } }, 400)
      }
      return json(completion(JSON.stringify({ decision })))
    }

    // No `response_format` at all: the probe's plain chat step, or the ladder's own plain/repair rung.
    if (decision === PROBE_DECISION) return json(completion('OK'))
    const bare = JSON.stringify(decision)
    return json(completion(mode === 'prose' ? `${PROSE_BEFORE}${bare}${PROSE_AFTER}` : bare))
  }) as unknown as typeof fetch

  return {
    fetchFn,
    requests,
    setMode(next: MockOpenAiMode): void { mode = next },
    setStatus(next: number | null): void { status = next },
    mode: () => mode,
  }
}
