import { describe, expect, it } from 'vitest'
import { LlmError } from '../src/core/errors.ts'
import type { ChatRequest } from '../src/core/types.ts'
import { createFakeProvider } from '../src/testing/fake-provider.ts'

function baseRequest(overrides: Partial<ChatRequest<unknown>> = {}): ChatRequest<unknown> {
  return {
    model: 'claude-haiku-4-5',
    system: [],
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 256,
    meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'key-1' },
    ...overrides,
  }
}

describe('createFakeProvider', () => {
  it('pops one script per call in order, then repeats the last script forever', async () => {
    const provider = createFakeProvider([{ text: 'first' }, { text: 'second' }])

    const r1 = await provider.chat(baseRequest())
    const r2 = await provider.chat(baseRequest())
    const r3 = await provider.chat(baseRequest())
    const r4 = await provider.chat(baseRequest())

    expect([r1.text, r2.text, r3.text, r4.text]).toEqual(['first', 'second', 'second', 'second'])
  })

  it('records every request on .calls, including meta, in call order', async () => {
    const provider = createFakeProvider([{ text: 'a' }, { text: 'b' }])
    const first = baseRequest({ meta: { orgId: 'org_9', role: 'draft', idempotencyKey: 'k-9', runId: 'run-1' } })
    const second = baseRequest({ meta: { orgId: 'org_9', role: 'probe', idempotencyKey: 'k-10' } })

    await provider.chat(first)
    await provider.chat(second)

    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[0]).toBe(first)
    expect(provider.calls[1]).toBe(second)
    expect(provider.calls[0]?.meta).toEqual({ orgId: 'org_9', role: 'draft', idempotencyKey: 'k-9', runId: 'run-1' })
    expect(provider.calls[1]?.meta.role).toBe('probe')
  })

  it('records the request even when the script throws', async () => {
    const failure = new LlmError('boom', 'permanent', false)
    const provider = createFakeProvider([{ error: failure }])
    const req = baseRequest()

    await expect(provider.chat(req)).rejects.toBe(failure)
    expect(provider.calls).toEqual([req])
  })

  it('rejects with a transient aborted LlmError when the signal aborts mid-delay', async () => {
    const provider = createFakeProvider([{ text: 'slow', delayMs: 50 }])
    const controller = new AbortController()

    const promise = provider.chat(baseRequest({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 5)

    await expect(promise).rejects.toBeInstanceOf(LlmError)
    try {
      await promise
      expect.unreachable('expected the promise to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      const llmError = err as LlmError
      expect(llmError.code).toBe('transient')
      expect(llmError.retryable).toBe(true)
    }
  })

  it('rejects immediately for a signal that is already aborted before the call', async () => {
    const provider = createFakeProvider([{ text: 'ok', delayMs: 50 }])
    const controller = new AbortController()
    controller.abort()

    await expect(provider.chat(baseRequest({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'transient',
      retryable: true,
    })
  })

  it('resolves normally when the delay elapses without an abort', async () => {
    const provider = createFakeProvider([{ text: 'done', delayMs: 10 }])
    const controller = new AbortController()

    const result = await provider.chat(baseRequest({ signal: controller.signal }))

    expect(result.text).toBe('done')
  })

  it('merges a partial usage override onto the default usage', async () => {
    const provider = createFakeProvider([{ text: 'ok', usage: { inputTokens: 42 } }])

    const result = await provider.chat(baseRequest())

    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 })
  })

  it('sets parseStrategy to native with a parsed value, and none without one', async () => {
    const provider = createFakeProvider([{ parsed: { ok: true } }, { text: 'no structured output' }])

    const withParsed = await provider.chat(baseRequest())
    const withoutParsed = await provider.chat(baseRequest())

    expect(withParsed.parseStrategy).toBe('native')
    expect(withParsed.parsed).toEqual({ ok: true })
    expect(withoutParsed.parseStrategy).toBe('none')
    expect(withoutParsed.parsed).toBeNull()
  })
})
