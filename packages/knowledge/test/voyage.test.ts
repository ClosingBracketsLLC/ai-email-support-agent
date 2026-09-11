import { describe, expect, it } from 'vitest'
import { Secret } from '@aesa/crypto'
import { batchTexts, createVoyageEmbedder, createVoyageReranker, EmbedError } from '../src/index.ts'

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch
}
const vec = (n: number) => Array.from({ length: 1024 }, (_, i) => (i === n ? 1 : 0))

describe('createVoyageEmbedder', () => {
  it('posts the documented body, maps the response by index, and reports total_tokens', async () => {
    const calls: { url: string; body: unknown; auth: string | undefined }[] = []
    const embedder = createVoyageEmbedder({ apiKey: new Secret('vk-test'), fetch: fakeFetch((url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization })
      return new Response(JSON.stringify({ object: 'list', data: [{ object: 'embedding', embedding: vec(1), index: 1 }, { object: 'embedding', embedding: vec(0), index: 0 }], model: 'voyage-4', usage: { total_tokens: 12 } }), { status: 200 })
    }) })
    const out = await embedder.embed(['a', 'b'], 'document')
    expect(calls[0]).toEqual({ url: 'https://api.voyageai.com/v1/embeddings', auth: 'Bearer vk-test', body: { input: ['a', 'b'], model: 'voyage-4', input_type: 'document', truncation: true, output_dimension: 1024 } })
    expect(out.vectors[0]![0]).toBe(1); expect(out.vectors[1]![1]).toBe(1); expect(out.tokens).toBe(12)
    expect(embedder.model).toBe('voyage-4'); expect(embedder.dimensions).toBe(1024)
  })
  it('maps 401 → auth, 403 → auth, 429 → rate_limit with Retry-After, 5xx → transient, 400 → permanent', async () => {
    const mk = (status: number, headers?: Record<string, string>) => createVoyageEmbedder({ apiKey: new Secret('k'), fetch: fakeFetch(() => new Response('{"detail":"x"}', { status, headers })) })
    await expect(mk(401).embed(['a'], 'query')).rejects.toMatchObject({ code: 'auth', retryable: false })
    await expect(mk(403).embed(['a'], 'query')).rejects.toMatchObject({ code: 'auth', retryable: false })
    await expect(mk(429, { 'retry-after': '7' }).embed(['a'], 'query')).rejects.toMatchObject({ code: 'rate_limit', retryable: true, retryAfterMs: 7000 })
    await expect(mk(503).embed(['a'], 'query')).rejects.toMatchObject({ code: 'transient', retryable: true })
    await expect(mk(400).embed(['a'], 'query')).rejects.toMatchObject({ code: 'permanent', retryable: false })
    expect(new EmbedError('transient', 'x').retryable).toBe(true)
  })
  it('refuses more than 128 texts per call (batching is the caller\'s job) and never logs the key', async () => {
    const embedder = createVoyageEmbedder({ apiKey: new Secret('vk-secret'), fetch: fakeFetch(() => new Response('{}', { status: 500 })) })
    await expect(embedder.embed(Array.from({ length: 129 }, () => 'x'), 'document')).rejects.toThrow(/128/)
    await expect(embedder.embed(['x'], 'document')).rejects.not.toThrow(/vk-secret/)
  })
  it('a 200 with a malformed (non-JSON) body becomes a permanent EmbedError, not a raw SyntaxError', async () => {
    const embedder = createVoyageEmbedder({ apiKey: new Secret('k'), fetch: fakeFetch(() => new Response('not json', { status: 200 })) })
    await expect(embedder.embed(['a'], 'document')).rejects.toMatchObject({ code: 'permanent', retryable: false })
  })
  it('a 200 whose data array answers fewer texts than requested is a permanent EmbedError', async () => {
    const embedder = createVoyageEmbedder({ apiKey: new Secret('k'), fetch: fakeFetch(() => new Response(JSON.stringify({ object: 'list', data: [{ object: 'embedding', embedding: vec(0), index: 0 }], model: 'voyage-4', usage: { total_tokens: 3 } }), { status: 200 })) })
    await expect(embedder.embed(['a', 'b'], 'document')).rejects.toMatchObject({ code: 'permanent', retryable: false })
  })
})

describe('batchTexts', () => {
  it('packs in order under the count and the estimated-token ceilings', () => {
    const texts = [...Array.from({ length: 130 }, (_, i) => `t${i}`), 'y'.repeat(400_004), 'z']
    const batches = batchTexts(texts, { maxTexts: 128, maxTokens: 100_000, maxChars: 10_000_000 })
    expect(batches.map((b) => b.length)).toEqual([128, 2, 1, 1])   // 128 · the last two short ones · the 100,001-token text alone · z
    expect(batches.flat()).toEqual(texts)
  })

  it('packs under the CHARACTER ceiling too, which is what binds for CJK (≈ 1 token per character)', () => {
    // Each text estimates at 250 tokens but is 1,000 characters: under the token ceiling alone all
    // ten would ride in one call, which for Chinese content is ~10,000 real tokens, not 2,500.
    const texts = Array.from({ length: 10 }, () => '据'.repeat(1_000))
    const batches = batchTexts(texts, { maxTexts: 128, maxTokens: 100_000, maxChars: 3_000 })
    expect(batches.map((b) => b.length)).toEqual([3, 3, 3, 1])
    expect(batches.flat()).toEqual(texts)
    // A single text over the character ceiling still reaches the provider, alone.
    const oversized = batchTexts(['a', '据'.repeat(5_000), 'b'], { maxTexts: 128, maxTokens: 100_000, maxChars: 3_000 })
    expect(oversized.map((b) => b.length)).toEqual([1, 1, 1])
  })
})

describe('createVoyageReranker', () => {
  it('posts the documented rerank body and returns index/score pairs in score order', async () => {
    const reranker = createVoyageReranker({ apiKey: new Secret('k'), fetch: fakeFetch((url, init) => {
      expect(url).toBe('https://api.voyageai.com/v1/rerank')
      expect(JSON.parse(String(init.body))).toEqual({ query: 'q', documents: ['a', 'b'], model: 'rerank-2.5', top_k: 1, return_documents: false, truncation: true })
      return new Response(JSON.stringify({ object: 'list', data: [{ index: 1, relevance_score: 0.9 }], model: 'rerank-2.5', usage: { total_tokens: 5 } }), { status: 200 })
    }) })
    expect(await reranker.rerank('q', ['a', 'b'], 1)).toEqual([{ index: 1, score: 0.9 }])
  })
})
