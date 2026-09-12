import { describe, expect, it } from 'vitest'
import { createFakeProvider, LlmError, type ChatMeta } from '@aesa/llm'
import { INVARIANTS } from '@aesa/core'
import {
  createUsageAccumulator,
  DRAFT_MODEL,
  emptyRetriever,
  runDraftCall,
  withWatchdog,
  type DraftDecision,
  type DraftPromptInput,
  type WorkspaceProfile,
} from '../src/index.ts'

const META: ChatMeta = {
  orgId: '11111111-1111-1111-1111-111111111111',
  agentId: '22222222-2222-2222-2222-222222222222',
  runId: '33333333-3333-3333-3333-333333333333',
  role: 'draft',
  idempotencyKey: 'draft:33333333-3333-3333-3333-333333333333:1',
}

const PROFILE: WorkspaceProfile = {
  businessName: 'Acme Dog Supplies',
  websiteUrl: 'https://acme.test',
  description: null,
  tone: 'friendly',
  timezone: 'UTC',
  locale: 'en',
  contactPhone: null,
  contactUrls: [],
  allowedUrlHosts: ['acme.test'],
  allowedEmailDomains: ['acme.test'],
}

const INPUT: DraftPromptInput = {
  ticket: { subject: 'Where is my order?', categoryKey: 'order_status', sentiment: 'neutral', language: 'en', triageQuestions: [], dmarcPass: true },
  thread: [{ direction: 'inbound', at: null, from: 'jo@customer.test', body: 'Any update?' }],
  priorDraft: null,
  ownerFeedback: null,
  guardrailRetry: null,
  categoryKeys: ['order_status', 'other'],
  profile: PROFILE,
  persona: { preset: 'support', personaText: '', displayName: 'Acme Support', address: 'support@acme.test' },
  guidance: { workspaceGuidance: '', agentGuidance: '' },
  knowledge: { chunks: [], answers: [] },
  cacheAgentBlocks: false,
  effort: 'medium',
  model: DRAFT_MODEL,
}

const DECISION: DraftDecision = {
  outcome: 'reply',
  categoryKey: 'order_status',
  body: 'It shipped on Monday.',
  confidence: 0.7,
  citedChunkIds: [],
  usedAnswerIds: [],
  memoryConflictIds: [],
  unresolvedQuestions: [],
  customerLanguage: 'en',
  rationale: 'The thread asks for the shipping status.',
}

describe('runDraftCall', () => {
  it('returns the parsed decision and the raw result from one provider call', async () => {
    const provider = createFakeProvider([{ parsed: DECISION }])

    const { decision, result } = await runDraftCall(provider, INPUT, META, new AbortController().signal)

    expect(decision).toEqual(DECISION)
    expect(result.parsed).toEqual(DECISION)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.model).toBe(DRAFT_MODEL)
    expect(provider.calls[0]!.meta).toEqual(META)
  })

  it('returns decision: null without throwing when the ladder gave up on the parse', async () => {
    const provider = createFakeProvider([{ text: 'nope' }])

    const { decision, result } = await runDraftCall(provider, INPUT, META, new AbortController().signal)

    expect(decision).toBeNull()
    expect(result.text).toBe('nope')
    expect(result.parseStrategy).toBe('none')
  })

  it('returns decision: null on a refusal even when something parsed', async () => {
    const provider = createFakeProvider([{ parsed: DECISION, finish: 'refusal' }])

    const { decision, result } = await runDraftCall(provider, INPUT, META, new AbortController().signal)

    expect(decision).toBeNull()
    expect(result.finish).toBe('refusal')
  })

  it('propagates an LlmError from an already-aborted signal', async () => {
    const provider = createFakeProvider([{ parsed: DECISION }])
    const controller = new AbortController()
    controller.abort()

    await expect(runDraftCall(provider, INPUT, META, controller.signal)).rejects.toThrow(LlmError)
  })
})

describe('withWatchdog', () => {
  it('defaults to the DRAFT_WATCHDOG_SECONDS budget', () => {
    const signal = withWatchdog(new AbortController().signal)
    expect(signal.aborted).toBe(false)
    expect(INVARIANTS.DRAFT_WATCHDOG_SECONDS).toBe(240)
  })

  it('fires on its own timeout', async () => {
    const signal = withWatchdog(new AbortController().signal, 20)
    expect(signal.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(signal.aborted).toBe(true)
  })

  it('fires when the caller signal fires first', () => {
    const controller = new AbortController()
    const signal = withWatchdog(controller.signal, 60_000)
    controller.abort()
    expect(signal.aborted).toBe(true)
  })
})

describe('emptyRetriever', () => {
  it('returns no chunks and no answers (Phase 4 fills it in)', async () => {
    const result = await emptyRetriever.retrieve({ orgId: META.orgId, questions: ['where is my order?'], text: 'body', signal: new AbortController().signal })
    expect(result).toEqual({ chunks: [], answers: [] })
  })
})

describe('createUsageAccumulator', () => {
  it('starts at zero', () => {
    expect(createUsageAccumulator().totals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      apiCalls: 0,
      costMicros: 0,
    })
  })

  it('sums usage and cost across calls', () => {
    const acc = createUsageAccumulator()
    acc.add({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, apiCalls: 1 }, 1_500)
    acc.add({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 2 }, 500)

    expect(acc.totals()).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      apiCalls: 3,
      costMicros: 2_000,
    })
  })

  it('hands back a snapshot that later adds do not mutate', () => {
    const acc = createUsageAccumulator()
    acc.add({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 }, 100)
    const snapshot = acc.totals()
    acc.add({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 }, 100)

    expect(snapshot.inputTokens).toBe(10)
    expect(acc.totals().inputTokens).toBe(20)
  })
})
