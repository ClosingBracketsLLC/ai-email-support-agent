import { Secret } from '@aesa/crypto'
import { createAnthropicProvider } from '../src/adapters/anthropic/index.ts'
import { createOpenAiCompatibleProvider } from '../src/adapters/openai-compatible/index.ts'
import { runProviderContract, type ContractVerdict, type ProviderContractWire } from '../src/testing/contract-suite.ts'
import { jsonResponse } from './helpers/fetch-stub.ts'

/**
 * The SAME scenario table, twice. `contract-model` is in neither adapter's capability table, so
 * both resolve it to their UNKNOWN_* fallback (`json_mode`) and the structured scenario exercises
 * each adapter's json_mode rung — the forced tool for Anthropic, `response_format: json_object`
 * for the OpenAI-compatible one.
 */

const anthropicWire: ProviderContractWire = {
  ok: (text) =>
    jsonResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'contract-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  refusal: () =>
    jsonResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'contract-model',
      content: [{ type: 'text', text: '' }],
      stop_reason: 'refusal',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  status: (code, headers) => jsonResponse({ type: 'error', error: { type: 'x', message: 'upstream said no' } }, { status: code, headers: headers ?? {} }),
  expectsOrderedBlocks: true,
  envelope: (verdict: ContractVerdict) => JSON.stringify({ decision: verdict }),
}

/** Anthropic's json_mode rung reads `tool_use.input`, not the text block — so the structured
 * scenarios need the tool shape rather than `ok(text)`'s text block. */
const anthropicToolWire: ProviderContractWire = {
  ...anthropicWire,
  ok: (text) => {
    let input: unknown
    try {
      input = JSON.parse(text) as unknown
    } catch {
      input = undefined
    }
    if (input === undefined) return anthropicWire.ok(text)
    return jsonResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'contract-model',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: 'toolu_1', name: 'triage', input },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
  },
}

const openAiWire: ProviderContractWire = {
  ok: (text) =>
    jsonResponse({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'contract-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, refusal: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  refusal: () =>
    jsonResponse({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'contract-model',
      choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }),
  status: (code, headers) => jsonResponse({ error: { message: 'upstream said no', type: 'x' } }, { status: code, headers: headers ?? {} }),
  expectsOrderedBlocks: false,
  envelope: (verdict: ContractVerdict) => JSON.stringify({ decision: verdict }),
}

runProviderContract('anthropic', (fetchFn) => createAnthropicProvider({ apiKey: new Secret('sk-ant-contract-key-123456'), fetchFn }), anthropicToolWire)

runProviderContract(
  'openai-compatible',
  (fetchFn) =>
    createOpenAiCompatibleProvider({ kind: 'openai', apiKey: new Secret('sk-contract-key-123456'), baseUrl: 'https://api.example.test/v1', fetchFn }),
  openAiWire,
)
