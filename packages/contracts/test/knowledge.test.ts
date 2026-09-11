import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_FAILURE_REASONS, KNOWLEDGE_INJECTION_REASONS, KNOWLEDGE_MAX_UPLOAD_BYTES, KNOWLEDGE_SOURCE_KINDS, KNOWLEDGE_SOURCE_STATUSES,
  KNOWLEDGE_UPLOAD_MIMES, PasteInput, StartCrawlInput, StartUploadInput, UpdateGuidanceInput,
} from '../src/index.ts'

describe('knowledge vocabularies', () => {
  it('pins the kinds, statuses, mimes and failure reasons', () => {
    expect(KNOWLEDGE_SOURCE_KINDS).toEqual(['upload', 'paste', 'crawl'])
    expect(KNOWLEDGE_SOURCE_STATUSES).toEqual(['queued', 'processing', 'ready', 'failed'])
    expect(KNOWLEDGE_UPLOAD_MIMES).toEqual(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown', 'text/plain'])
    expect(KNOWLEDGE_FAILURE_REASONS).toContain('parse_timeout')
    expect(KNOWLEDGE_MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024)
  })

  // The app renders one label per code, so the list is a contract with `screenChunk`'s rule table
  // (packages/knowledge/src/injection.ts) — including the ORDER, which decides which reason an
  // owner sees when a chunk trips more than one rule.
  it('pins the injection reasons and their rule order', () => {
    expect(KNOWLEDGE_INJECTION_REASONS).toEqual([
      'override_instructions', 'role_reassignment', 'system_prompt', 'concealment', 'role_marker', 'forced_output', 'exfiltration', 'invisible_text',
    ])
  })
})

describe('StartUploadInput', () => {
  it('accepts a bounded file and refuses a path, a control character, an unknown type and an oversized byte count', () => {
    expect(StartUploadInput.safeParse({ fileName: 'returns.pdf', mime: 'application/pdf', byteSize: 1024 }).success).toBe(true)
    expect(StartUploadInput.safeParse({ fileName: '../etc/passwd', mime: 'text/plain', byteSize: 10 }).success).toBe(false)
    expect(StartUploadInput.safeParse({ fileName: 'a\tb.txt', mime: 'text/plain', byteSize: 10 }).success).toBe(false)
    expect(StartUploadInput.safeParse({ fileName: 'a.exe', mime: 'application/octet-stream', byteSize: 10 }).success).toBe(false)
    expect(StartUploadInput.safeParse({ fileName: 'big.pdf', mime: 'application/pdf', byteSize: KNOWLEDGE_MAX_UPLOAD_BYTES + 1 }).success).toBe(false)
  })
})

describe('PasteInput / StartCrawlInput / UpdateGuidanceInput', () => {
  it('bounds the paste, the crawl and the guidance', () => {
    expect(PasteInput.safeParse({ title: 'Returns', text: 'x'.repeat(50_000) }).success).toBe(true)
    expect(PasteInput.safeParse({ title: 'Returns', text: 'x'.repeat(50_001) }).success).toBe(false)
    expect(StartCrawlInput.safeParse({ url: 'https://acme.example', maxPages: 50 }).success).toBe(true)
    expect(StartCrawlInput.safeParse({ url: 'ftp://acme.example', maxPages: 50 }).success).toBe(false)
    // https only (`HttpsUrl`): the crawler never fetches plain http, so the input refuses it up
    // front with a message the owner-facing form can key off.
    const http = StartCrawlInput.safeParse({ url: 'http://acme.example', maxPages: 50 })
    expect(http.success).toBe(false)
    expect(http.error?.issues[0]?.message).toBe('must be an https:// URL')
    expect(StartCrawlInput.safeParse({ url: 'https://acme.example', maxPages: 0 }).success).toBe(false)
    expect(UpdateGuidanceInput.safeParse({ operatingGuidance: 'x'.repeat(8000) }).success).toBe(true)
    expect(UpdateGuidanceInput.safeParse({ operatingGuidance: 'x'.repeat(8001) }).success).toBe(false)
  })
})
