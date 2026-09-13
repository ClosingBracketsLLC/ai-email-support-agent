import type { LlmProviderId } from '@aesa/contracts'
import type { Capabilities } from '../../core/types.ts'

/** Every provider this adapter serves — i.e. every one in the catalog except Anthropic, which has
 * its own adapter. */
export type OpenAiCompatibleKind = Exclude<LlmProviderId, 'anthropic'>

/** Provider quirks the request builder needs (spec §provider table). */
export interface PresetQuirks {
  /** OpenAI's reasoning models reject `max_tokens`; everyone else rejects `max_completion_tokens`. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens'
  /** DeepSeek's json_object mode 400s unless the prompt contains the word JSON; harmless everywhere else, so always on. */
  jsonModeNeedsPromptMention: true
  /** Deviation 12: never `strict: true`. A strict json_schema rejects the schema shapes zod emits
   * for an optional or a union, and a rejected REQUEST is worse than a reply the ladder can repair. */
  strictJsonSchema: false
}

export const PRESET_QUIRKS: Record<OpenAiCompatibleKind, PresetQuirks> = {
  openai: { maxTokensParam: 'max_completion_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  deepseek: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  groq: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  together: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  openrouter: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
  custom: { maxTokensParam: 'max_tokens', jsonModeNeedsPromptMention: true, strictJsonSchema: false },
}

const NATIVE: Capabilities = { structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }
const NATIVE_NO_EFFORT: Capabilities = { structuredOutput: 'native', tools: true, effort: false, cacheMinTokens: null }
const JSON_ONLY: Capabilities = { structuredOutput: 'json_mode', tools: false, effort: false, cacheMinTokens: null }

/**
 * Per (preset, model) capability seed (spec §provider table); the probe overrides downward.
 * `cacheMinTokens` is null everywhere: these providers cache automatically, so there is no
 * breakpoint to place.
 */
export const OPENAI_COMPATIBLE_MODELS: Record<OpenAiCompatibleKind, Record<string, Capabilities>> = {
  openai: { 'gpt-5': NATIVE, 'gpt-5-mini': NATIVE },
  deepseek: { 'deepseek-chat': JSON_ONLY, 'deepseek-reasoner': JSON_ONLY },
  groq: { 'llama-3.3-70b-versatile': NATIVE_NO_EFFORT, 'llama-3.1-8b-instant': JSON_ONLY },
  together: { 'meta-llama/Llama-3.3-70B-Instruct-Turbo': JSON_ONLY, 'meta-llama/Llama-3.1-8B-Instruct-Turbo': JSON_ONLY },
  openrouter: { 'anthropic/claude-opus-5': NATIVE_NO_EFFORT, 'anthropic/claude-haiku-4.5': NATIVE_NO_EFFORT },
  custom: {},
}

/** An unlisted model: json_object mode (every OpenAI-compatible server accepts it), no tools, no effort. */
export const UNKNOWN_OPENAI_COMPATIBLE_MODEL: Capabilities = JSON_ONLY
