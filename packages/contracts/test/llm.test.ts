import { describe, expect, it } from 'vitest'
import {
  AddCredentialInput, DEMOTION_REASONS, DRAFT_MODEL_ID, LLM_ERROR_MESSAGES, LLM_PROVIDERS, MANAGED_MODELS, NEEDS_OWNER_REASONS,
  NOTIFICATION_KINDS, PROVIDER_PRESETS, presetModel, qualityTierFor, SetAgentModelInput,
} from '../src/index.ts'

describe('llm contracts', () => {
  it('every provider has a preset with a label, a consent name and a draft + triage suggestion (custom has no base URL)', () => {
    for (const id of LLM_PROVIDERS) {
      const p = PROVIDER_PRESETS[id]
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.consentName.length).toBeGreaterThan(0)
      if (id === 'custom') expect(p.baseUrl).toBeNull()
      else expect(p.baseUrl).toMatch(/^https:\/\//)
      if (id !== 'custom') { expect(presetModel(id, 'draft')).not.toBeNull(); expect(presetModel(id, 'triage')).not.toBeNull() }
    }
    expect(presetModel('custom', 'draft')).toBeNull()
  })

  it('LLM_ERROR_MESSAGES carries a non-empty sentence for every soft refusal the api can return', () => {
    // The api throws these and the two app screens key their owner copy on them; a key that vanishes
    // (or empties) is a screen that silently falls back to "try again".
    const keys = ['keys_not_provisioned', 'cap_reached', 'unsafe_url', 'credential_dead', 'credential_not_found', 'not_found'] as const
    expect(Object.keys(LLM_ERROR_MESSAGES).sort()).toEqual([...keys].sort())
    for (const key of keys) expect(LLM_ERROR_MESSAGES[key].length).toBeGreaterThan(0)
  })

  it('DRAFT_MODEL_ID still names the managed draft model', () => {
    expect(DRAFT_MODEL_ID).toBe(MANAGED_MODELS.draft)
    expect(MANAGED_MODELS.draft).toBe('claude-opus-5')
    expect(MANAGED_MODELS.triage).toBe('claude-haiku-4-5')
  })

  it('quality tiers: managed Anthropic is calibrated, frontier BYOK is standard, everything unknown is limited', () => {
    expect(qualityTierFor('anthropic', 'claude-opus-5')).toBe('calibrated')
    expect(qualityTierFor('anthropic', 'claude-haiku-4-5')).toBe('standard')
    expect(qualityTierFor('openai', 'gpt-5')).toBe('standard')
    expect(qualityTierFor('openai', 'gpt-5-mini')).toBe('standard')
    expect(qualityTierFor('deepseek', 'deepseek-chat')).toBe('standard')
    expect(qualityTierFor('openrouter', 'anthropic/claude-opus-5')).toBe('standard')
    expect(qualityTierFor('groq', 'llama-3.3-70b-versatile')).toBe('standard')
    expect(qualityTierFor('groq', 'llama-3.1-8b-instant')).toBe('limited')
    expect(qualityTierFor('custom', 'qwen3:32b')).toBe('limited')
    expect(qualityTierFor('openai', 'something-new')).toBe('limited')
  })

  it('AddCredentialInput: a preset ignores baseUrl; custom requires an https URL; the key is bounded', () => {
    expect(AddCredentialInput.safeParse({ provider: 'openai', label: 'Prod', apiKey: 'sk-abcdefghij' }).success).toBe(true)
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij' }).success).toBe(false)
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij', baseUrl: 'http://10.0.0.1/v1' }).success).toBe(false)
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij', baseUrl: 'https://llm.example.com:8443/v1' }).success).toBe(false)   // custom also needs probeModel
    expect(AddCredentialInput.safeParse({ provider: 'custom', label: 'vLLM', apiKey: 'sk-abcdefghij', baseUrl: 'https://llm.example.com:8443/v1', probeModel: 'qwen3:32b' }).success).toBe(true)
    expect(AddCredentialInput.safeParse({ provider: 'openai', label: 'Prod', apiKey: 'short' }).success).toBe(false)
  })

  it('SetAgentModelInput: byok needs a credential; managed carries none', () => {
    expect(SetAgentModelInput.safeParse({ agentId: crypto.randomUUID(), mode: 'byok', credentialId: null, draftModel: 'gpt-5', triageModel: 'gpt-5-mini', effort: null, fallbackToManaged: false }).success).toBe(false)
    expect(SetAgentModelInput.safeParse({ agentId: crypto.randomUUID(), mode: 'managed', credentialId: null, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false }).success).toBe(true)
  })

  it('the three vocabularies gained their Phase 6 words', () => {
    expect(NEEDS_OWNER_REASONS).toContain('provider_unavailable')
    expect(NOTIFICATION_KINDS).toContain('provider_health')
    expect(DEMOTION_REASONS).toContain('model_changed')
  })
})
