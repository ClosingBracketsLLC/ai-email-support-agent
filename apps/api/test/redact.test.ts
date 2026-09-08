import { describe, expect, it } from 'vitest'
import { redactUrl } from '../src/redact.ts'

describe('redactUrl', () => {
  it('redacts every query value, not only t=', () => {
    expect(redactUrl('/a/123?t=SECRET&code=ABC&x=')).toBe('/a/123?t=[redacted]&code=[redacted]&x=[redacted]')
  })
  it('redacts long base64url path segments (tokens in paths) but keeps ids and words', () => {
    const tok = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'   // 35 chars
    expect(redactUrl(`/a/${tok}/approve`)).toBe('/a/[redacted]/approve')
    expect(redactUrl('/tickets/0190f7a2-1c3e-7e2a-9b1a-3c5d6e7f8a9b')).toBe('/tickets/0190f7a2-1c3e-7e2a-9b1a-3c5d6e7f8a9b')
  })
})
