import { describe, expect, it } from 'vitest'
import { createFakeProvider, LlmError, probeProvider, withStructuredLadder } from '../src/index.ts'

const meta = { orgId: 'org', mode: 'byok' as const, credentialId: 'cred', idempotencyPrefix: 'probe:cred:1' }
const good = { parsed: { answer: 'yes', n: 7 } }

describe('probeProvider', () => {
  it('lists models, chats once, then proves the structured rung that worked (native)', async () => {
    const fake = Object.assign(createFakeProvider([{ text: 'OK' }, good], { capabilities: { structuredOutput: 'native' } }), {
      listModels: async () => ['m1', 'm2'],
    })
    const r = await probeProvider(fake, 'm1', meta)
    expect(r).toMatchObject({ ok: true, models: ['m1', 'm2'], chat: 'ok', structured: 'native', error: null })
    expect(fake.calls.map((c) => c.meta.idempotencyKey)).toEqual(['probe:cred:1:chat', 'probe:cred:1:structured:native'])
    expect(fake.calls.every((c) => c.meta.role === 'probe')).toBe(true)
  })

  it('a model that parses nothing at either rung reports none, but ok', async () => {
    const fake = createFakeProvider([{ text: 'OK' }, { text: 'nope' }, { text: 'nope' }], { capabilities: { structuredOutput: 'json_mode' } })
    const r = await probeProvider(fake, 'm', meta) // the RAW fake: the probe drives the rungs itself
    expect(r).toMatchObject({ ok: true, chat: 'ok', structured: 'none', models: null })
  })

  /**
   * Spec §LLM provider adapter: an OpenAI-compatible server's `json_schema` support is "treated as
   * json_mode unless probe passes". The preset for an unlisted model on one of those kinds is a
   * GUESS, and the probe is the one call allowed to replace it — so `native` is attempted even
   * though the preset says json_mode, and a server that honours it is recorded as native.
   */
  it('an OpenAI-compatible kind is always asked for native first, whatever its preset guessed', async () => {
    const custom = createFakeProvider([{ text: 'OK' }, good], { kind: 'custom', capabilities: { structuredOutput: 'json_mode' } })
    expect(await probeProvider(custom, 'm', meta)).toMatchObject({ ok: true, structured: 'native' })
    expect(custom.calls.map((c) => c.meta.idempotencyKey)).toEqual(['probe:cred:1:chat', 'probe:cred:1:structured:native'])
  })

  /** …and Anthropic is the exception: its capability table is a fact about the models this platform
   *  ships against, so a json_mode-only one never spends a call proving `native` fails. */
  it('an anthropic-kind model the table calls json_mode-only skips the native rung entirely', async () => {
    const jsonOnly = createFakeProvider([{ text: 'OK' }, good], { kind: 'anthropic', capabilities: { structuredOutput: 'json_mode' } })
    expect(await probeProvider(jsonOnly, 'm', meta)).toMatchObject({ ok: true, structured: 'json_mode' })
    expect(jsonOnly.calls.map((c) => c.meta.idempotencyKey)).toEqual(['probe:cred:1:chat', 'probe:cred:1:structured:json_mode'])
  })

  it('an auth failure on the chat step is ok false with the code, and no structured step runs', async () => {
    const fake = createFakeProvider([{ error: new LlmError('401 bad key', 'auth', false) }])
    const r = await probeProvider(fake, 'm', meta)
    expect(r).toMatchObject({ ok: false, chat: 'failed', structured: null, error: { code: 'auth' } })
    expect(fake.calls).toHaveLength(1)
  })

  it('a models-list failure is not fatal: models null, the rest proceeds', async () => {
    const fake = Object.assign(createFakeProvider([{ text: 'OK' }, good]), {
      listModels: async () => {
        throw new LlmError('403', 'auth', false)
      },
    })
    expect((await probeProvider(fake, 'm', meta)).models).toBeNull()
  })

  it('falls back from a failing native rung to json_mode', async () => {
    const fake = createFakeProvider([{ text: 'OK' }, { error: new LlmError('unsupported response_format', 'permanent', false) }, good], {
      capabilities: { structuredOutput: 'native' },
    })
    const r = await probeProvider(fake, 'm', meta)
    expect(r).toMatchObject({ ok: true, structured: 'json_mode' })
    expect(fake.calls.map((c) => c.meta.idempotencyKey)).toEqual([
      'probe:cred:1:chat',
      'probe:cred:1:structured:native',
      'probe:cred:1:structured:json_mode',
    ])
  })

  it('reports latency and probedAt, and truncates a long error message to 200 characters', async () => {
    const fake = createFakeProvider([{ error: new LlmError('x'.repeat(500), 'permanent', false) }])
    const r = await probeProvider(fake, 'm', meta)
    expect(r.error!.message).toHaveLength(200)
    expect(Number.isInteger(r.latencyMs)).toBe(true)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(r.probedAt))).toBe(false)
  })

  it('is driven through the ladder only by a caller that wants the ladder: the raw adapter keys are unsuffixed', async () => {
    // The ladder would suffix the probe's own idempotency keys again (`…:structured:native:native`)
    // — the probe's contract is to drive the RAW adapter's rungs itself.
    const fake = createFakeProvider([{ text: 'OK' }, good], { capabilities: { structuredOutput: 'native' } })
    await probeProvider(withStructuredLadder(fake), 'm', meta)
    expect(fake.calls.map((c) => c.meta.idempotencyKey)).toEqual(['probe:cred:1:chat', 'probe:cred:1:structured:native:native'])
  })
})
