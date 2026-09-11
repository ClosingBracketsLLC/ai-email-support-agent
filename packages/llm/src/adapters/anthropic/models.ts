import type { Capabilities } from '../../core/types.ts'

/**
 * Per-model capability table for the Anthropic adapter (task brief, verified 2026-09-09 against
 * the installed `@anthropic-ai/sdk` 0.124.0). Model ids carry no date suffix on this generation.
 */
export const ANTHROPIC_MODELS: Record<string, Capabilities> = {
  'claude-opus-5': { structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 512 },
  'claude-sonnet-5': { structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 1024 },
  'claude-haiku-4-5': { structuredOutput: 'native', tools: true, effort: false, cacheMinTokens: 4096 },
}

/** Fallback for a model id this adapter doesn't recognize — assume the safe, widely-supported
 * baseline (forced tool use, no effort control, no caching) rather than guessing at a feature the
 * model may not actually have. */
export const UNKNOWN_ANTHROPIC_MODEL: Capabilities = { structuredOutput: 'json_mode', tools: true, effort: false, cacheMinTokens: null }
