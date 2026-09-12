import { z } from 'zod'
import { HttpsUrl } from './workspace.ts'

/** The providers Settings → AI offers. `custom` is any OpenAI-compatible https endpoint (vLLM, LM
 * Studio, a hosted Ollama, Gemini's OpenAI-compatible route) — the spec's Ollama/vLLM/LM Studio
 * presets collapse into it because v1 reaches only public https hosts (plan deviation 11). */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'groq', 'together', 'openrouter', 'custom'] as const
export type LlmProviderId = (typeof LLM_PROVIDERS)[number]

/** Managed AI's models (spec §Decisions: drafting opus-5, triage haiku-4-5). The ONE source — the
 * worker's prompt builders and the api's run rows read these; `DRAFT_MODEL_ID` aliases `draft`. */
export const MANAGED_MODELS = { draft: 'claude-opus-5', triage: 'claude-haiku-4-5', guidanceSuggest: 'claude-haiku-4-5' } as const

export const QUALITY_TIERS = ['calibrated', 'standard', 'limited'] as const
export type QualityTier = (typeof QUALITY_TIERS)[number]

export const MODEL_CONFIG_ROLES = ['draft', 'triage'] as const
export type ModelConfigRole = (typeof MODEL_CONFIG_ROLES)[number]
export const MODEL_CONFIG_MODES = ['managed', 'byok'] as const
export type ModelConfigMode = (typeof MODEL_CONFIG_MODES)[number]
export const CREDENTIAL_HEALTH = ['unknown', 'healthy', 'degraded', 'dead'] as const
export type CredentialHealth = (typeof CREDENTIAL_HEALTH)[number]
export const LLM_EFFORTS = ['low', 'medium', 'high'] as const
export type LlmEffort = (typeof LLM_EFFORTS)[number]
export const LLM_MAX_CREDENTIALS = 5

/**
 * The owner-facing sentence for every soft refusal Settings → AI can produce, keyed on the service's
 * own soft code. ONE source for two readers that cannot see each other: `trpc/routers/llm.ts` throws
 * these as its `TRPCError.message`, and the app's two screens (`settings/ai.tsx`,
 * `settings/model-card.tsx`) key their own owner copy on them — the app only ever sees the message,
 * because `keys_not_provisioned` and `cap_reached` share one tRPC code. Before this constant the
 * literals lived in three files and a reword on the api side silently collapsed the screen's copy to
 * "try again" (review C-I3). The screens keep their own, warmer wording; what must not drift is the
 * KEY. Plain strings, not zod — this file is zod-only by rule, and these are constants, not schemas.
 */
export const LLM_ERROR_MESSAGES = {
  keys_not_provisioned: 'this workspace is still being set up; try again in a moment',
  cap_reached: 'connection limit reached',
  unsafe_url: 'that endpoint must be a public https address',
  credential_dead: 'that connection was rejected by the provider; test it before using it',
  credential_not_found: 'provider connection not found',
  not_found: 'agent not found',
} as const
export type LlmErrorKey = keyof typeof LLM_ERROR_MESSAGES

export interface SuggestedModel { id: string; role: ModelConfigRole | 'both'; tier: QualityTier }

export interface ProviderPreset {
  id: LlmProviderId
  label: string
  /** The name the consent sentence uses ("Email content will be sent to OpenAI under its terms"). */
  consentName: string
  /** Null for `custom` (the owner supplies it); for a preset the owner never sees or edits it. */
  baseUrl: string | null
  /** What a key from this provider looks like, for the placeholder only — never validated. */
  keyHint: string
  suggestedModels: SuggestedModel[]
}

/** Spec §Default models (seed; ids re-verified against each provider's `/models` by the probe). */
export const PROVIDER_PRESETS: Record<LlmProviderId, ProviderPreset> = {
  anthropic: { id: 'anthropic', label: 'Anthropic', consentName: 'Anthropic', baseUrl: 'https://api.anthropic.com', keyHint: 'sk-ant-…',
    suggestedModels: [{ id: 'claude-opus-5', role: 'draft', tier: 'calibrated' }, { id: 'claude-sonnet-5', role: 'draft', tier: 'calibrated' }, { id: 'claude-haiku-4-5', role: 'triage', tier: 'standard' }] },
  openai: { id: 'openai', label: 'OpenAI', consentName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyHint: 'sk-…',
    suggestedModels: [{ id: 'gpt-5', role: 'draft', tier: 'standard' }, { id: 'gpt-5-mini', role: 'triage', tier: 'standard' }] },
  deepseek: { id: 'deepseek', label: 'DeepSeek', consentName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyHint: 'sk-…',
    suggestedModels: [{ id: 'deepseek-chat', role: 'both', tier: 'standard' }, { id: 'deepseek-reasoner', role: 'draft', tier: 'standard' }] },
  groq: { id: 'groq', label: 'Groq', consentName: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyHint: 'gsk_…',
    suggestedModels: [{ id: 'llama-3.3-70b-versatile', role: 'draft', tier: 'standard' }, { id: 'llama-3.1-8b-instant', role: 'triage', tier: 'limited' }] },
  together: { id: 'together', label: 'Together', consentName: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyHint: '…',
    suggestedModels: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', role: 'draft', tier: 'standard' }, { id: 'meta-llama/Llama-3.1-8B-Instruct-Turbo', role: 'triage', tier: 'limited' }] },
  openrouter: { id: 'openrouter', label: 'OpenRouter', consentName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyHint: 'sk-or-…',
    suggestedModels: [{ id: 'anthropic/claude-opus-5', role: 'draft', tier: 'standard' }, { id: 'anthropic/claude-haiku-4.5', role: 'triage', tier: 'standard' }] },
  custom: { id: 'custom', label: 'Custom (OpenAI-compatible)', consentName: 'the endpoint you configured', baseUrl: null, keyHint: '…', suggestedModels: [] },
}

/** The catalog lookup behind every tier decision: a listed model's tier, else `limited` (spec
 * §Risks: an unknown or local/small model is capped until proven). The probe may downgrade this,
 * never upgrade it (`@aesa/db`'s `resolveModelConfig`). */
export function qualityTierFor(provider: LlmProviderId, model: string): QualityTier {
  const hit = PROVIDER_PRESETS[provider].suggestedModels.find((m) => m.id === model)
  return hit?.tier ?? 'limited'
}

/** The preset's first suggestion for a role (a `both` model serves either), or null (custom). */
export function presetModel(provider: LlmProviderId, role: ModelConfigRole): string | null {
  const models = PROVIDER_PRESETS[provider].suggestedModels
  return (models.find((m) => m.role === role) ?? models.find((m) => m.role === 'both'))?.id ?? null
}

export const AddCredentialInput = z.object({
  provider: z.enum(LLM_PROVIDERS),
  label: z.string().trim().min(1).max(60),
  apiKey: z.string().min(8).max(512),
  /** Required for `custom`, ignored for a preset (the api substitutes the preset's own). */
  baseUrl: HttpsUrl.optional(),
  /** The model the probe exercises. Required for `custom` (no catalog suggestion exists); a preset defaults to `presetModel(provider, 'draft')`. */
  probeModel: z.string().trim().min(1).max(120).optional(),
}).refine((v) => v.provider !== 'custom' || v.baseUrl !== undefined, { message: 'a custom endpoint needs its base URL', path: ['baseUrl'] })
  .refine((v) => v.provider !== 'custom' || v.probeModel !== undefined, { message: 'a custom endpoint needs the model to probe', path: ['probeModel'] })
export type AddCredentialInput = z.infer<typeof AddCredentialInput>

export const CredentialIdInput = z.object({ credentialId: z.uuid() })
export type CredentialIdInput = z.infer<typeof CredentialIdInput>

export const SetAgentModelInput = z.object({
  agentId: z.uuid(),
  mode: z.enum(MODEL_CONFIG_MODES),
  credentialId: z.uuid().nullable(),
  draftModel: z.string().trim().min(1).max(120).nullable(),
  triageModel: z.string().trim().min(1).max(120).nullable(),
  effort: z.enum(LLM_EFFORTS).nullable(),
  fallbackToManaged: z.boolean(),
}).refine((v) => v.mode === 'managed' || v.credentialId !== null, { message: 'a BYOK agent needs a provider connection', path: ['credentialId'] })
export type SetAgentModelInput = z.infer<typeof SetAgentModelInput>

/** What `llm.probe` stores on `llm_credentials.last_probe` and the screen renders. */
export const ProbeResult = z.object({
  ok: z.boolean(),
  probedAt: z.string(),
  /** Null when the adapter cannot list models (or the endpoint refused the call). */
  models: z.array(z.string()).nullable(),
  chat: z.enum(['ok', 'failed']),
  /** Which structured-output rung actually worked; null when the chat step already failed. */
  structured: z.enum(['native', 'json_mode', 'none']).nullable(),
  latencyMs: z.number().int().nonnegative(),
  error: z.object({ code: z.string(), message: z.string().max(200) }).nullable(),
})
export type ProbeResultView = z.infer<typeof ProbeResult>
