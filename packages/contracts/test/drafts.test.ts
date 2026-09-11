import { describe, expect, it } from 'vitest'
import {
  APPROVE_UNDO_SECONDS, ApproveDraftInput, DECISION_REASONS, NEEDS_OWNER_REASONS, NOTIFICATION_KINDS,
  RejectDraftInput, SandboxStartInput,
} from '../src/index.ts'

describe('ApproveDraftInput', () => {
  it('accepts a bare draftId and a draftId with an edited body', () => {
    const id = '9f8e7d6c-1234-4321-8888-abcdef012345'
    expect(ApproveDraftInput.safeParse({ draftId: id }).success).toBe(true)
    expect(ApproveDraftInput.safeParse({ draftId: id, body: 'Thanks for reaching out!' }).success).toBe(true)
  })
  it('rejects a body over the max and an empty (trimmed) body', () => {
    const id = '9f8e7d6c-1234-4321-8888-abcdef012345'
    expect(ApproveDraftInput.safeParse({ draftId: id, body: 'x'.repeat(4001) }).success).toBe(false)
    expect(ApproveDraftInput.safeParse({ draftId: id, body: '   ' }).success).toBe(false)
  })
})

describe('RejectDraftInput', () => {
  const id = '9f8e7d6c-1234-4321-8888-abcdef012345'
  it('defaults reason to an empty string', () => {
    const parsed = RejectDraftInput.parse({ draftId: id, action: 'redraft' })
    expect(parsed.reason).toBe('')
  })
  it('rejects a reason over the max', () => {
    expect(RejectDraftInput.safeParse({ draftId: id, action: 'handle', reason: 'x'.repeat(2001) }).success).toBe(false)
  })
})

describe('SandboxStartInput', () => {
  it('defaults subject to "Question"', () => {
    const parsed = SandboxStartInput.parse({ agentId: '9f8e7d6c-1234-4321-8888-abcdef012345', question: 'Can you handle refunds?' })
    expect(parsed.subject).toBe('Question')
  })
})

describe('DECISION_REASONS', () => {
  it('starts with platform_killswitch and ends with ok — the evaluation order is the contract', () => {
    expect(DECISION_REASONS[0]).toBe('platform_killswitch')
    expect(DECISION_REASONS[DECISION_REASONS.length - 1]).toBe('ok')
  })
})

describe('NEEDS_OWNER_REASONS', () => {
  it('still contains the five Phase 2 values', () => {
    for (const reason of ['tripwire', 'triage_flags', 'sentiment_angry', 'triage_failed', 'triage_cap']) {
      expect(NEEDS_OWNER_REASONS).toContain(reason)
    }
  })
})

describe('NOTIFICATION_KINDS', () => {
  it('contains draft_review', () => {
    expect(NOTIFICATION_KINDS).toContain('draft_review')
  })
})

describe('APPROVE_UNDO_SECONDS', () => {
  it('is 15', () => {
    expect(APPROVE_UNDO_SECONDS).toBe(15)
  })
})
