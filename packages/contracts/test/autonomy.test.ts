import { describe, expect, it } from 'vitest'
import {
  AUTONOMY_THRESHOLD_PRESETS, CATEGORY_MODES, DECISION_REASONS, DEMOTION_REASONS, DeleteByCustomerInput, MemoryListInput,
  NOTIFICATION_KINDS, RESOLVED_ANSWER_STATUSES, RejectDraftInput, SetCategoryPolicyInput, UpdateAgentInput,
} from '../src/index.ts'

describe('autonomy vocabulary', () => {
  it('pins the modes, presets, statuses and the three new decision reasons in order', () => {
    expect(CATEGORY_MODES).toEqual(['off', 'review', 'auto'])
    expect(AUTONOMY_THRESHOLD_PRESETS).toEqual({ cautious: 90, balanced: 80, eager: 70 })
    expect(RESOLVED_ANSWER_STATUSES).toEqual(['candidate', 'active', 'needs_review', 'retired'])
    expect(DEMOTION_REASONS).toEqual(['rejections', 'flags', 'hold_then_edit', 'edit_rate', 'model_changed'])
    const i = DECISION_REASONS.indexOf('guardrail_warning')
    expect(DECISION_REASONS.slice(i, i + 5)).toEqual(['guardrail_warning', 'memory_conflict', 'unresolved_questions', 'thread_too_long', 'cold_start'])
    expect(NOTIFICATION_KINDS).toEqual(['escalation', 'mailbox_reauth', 'digest', 'draft_review', 'auto_send', 'graduation', 'demotion', 'memory_sample', 'provider_health'])
  })
  it('SetCategoryPolicyInput bounds the threshold and refuses an unknown mode', () => {
    const ids = { agentId: '11111111-1111-4111-8111-111111111111', categoryId: '22222222-2222-4222-8222-222222222222' }
    expect(SetCategoryPolicyInput.safeParse({ ...ids, mode: 'auto', autoSendMinConfidence: 80 }).success).toBe(true)
    expect(SetCategoryPolicyInput.safeParse({ ...ids, mode: 'auto', autoSendMinConfidence: 49 }).success).toBe(false)
    expect(SetCategoryPolicyInput.safeParse({ ...ids, mode: 'always' }).success).toBe(false)
  })
  it('UpdateAgentInput accepts autoGraduate and a 1..60 minute delay; RejectDraftInput defaults addToGuidance to false', () => {
    const agentId = '11111111-1111-4111-8111-111111111111'
    expect(UpdateAgentInput.safeParse({ agentId, autoGraduate: true, autoSendDelayMin: 5 }).success).toBe(true)
    expect(UpdateAgentInput.safeParse({ agentId, autoSendDelayMin: 0 }).success).toBe(false)
    expect(RejectDraftInput.parse({ draftId: agentId, action: 'handle' })).toMatchObject({ addToGuidance: false, reason: '' })
  })
  it('memory inputs: the default tab is to_check; delete-by-customer wants an email', () => {
    expect(MemoryListInput.parse({})).toEqual({ tab: 'to_check', limit: 50 })
    expect(DeleteByCustomerInput.safeParse({ email: 'not-an-email' }).success).toBe(false)
  })
})
