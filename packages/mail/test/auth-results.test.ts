import { describe, expect, it } from 'vitest'
import { detectAutomated, parseAuthResults } from '../src/auth-results.ts'

describe('parseAuthResults', () => {
  it.each([
    ['mx.google.com; dkim=pass; dmarc=pass (p=NONE)', true],
    ['mx.google.com; dmarc=fail', false],
    ['mx.google.com; spf=pass', false],
    [null, false],
    ['mx.google.com; dmarc=bestguesspass', false],
  ])('parseAuthResults(%j).dmarcPass === %s', (raw, want) => {
    expect(parseAuthResults(raw).dmarcPass).toBe(want)
  })

  it('rejects a quoted-local-part forgery that fakes a dmarc=pass clause via an injected ";"', () => {
    // smtp.mailfrom's quoted local part embeds a ";" that a flat clause-split-on-";" regex would
    // misread as a real clause boundary, exposing a fake "dmarc=pass"@evil.example" clause. The
    // real verdict — the last clause that genuinely BEGINS with "dmarc=" — is dmarc=fail.
    const forged =
      'mx.google.com; spf=pass (...) smtp.mailfrom="x;dmarc=pass"@evil.example; dmarc=fail (p=NONE)'
    expect(parseAuthResults(forged).dmarcPass).toBe(false)
  })

  it('accepts a genuine dmarc=pass clause terminated by the params group', () => {
    expect(
      parseAuthResults('mx.google.com; dkim=pass; dmarc=pass (p=NONE) header.from=outlook.com').dmarcPass,
    ).toBe(true)
  })

  it('does not treat "dmarc=passing" as a pass (result token must be exactly "pass")', () => {
    expect(parseAuthResults('mx.google.com; dmarc=passing').dmarcPass).toBe(false)
  })
})

describe('detectAutomated', () => {
  it.each([
    [{ autoSubmitted: 'auto-replied', precedence: null, listId: null }, true],
    [{ autoSubmitted: 'no', precedence: null, listId: null }, false],
    [{ autoSubmitted: null, precedence: 'Bulk', listId: null }, true],
    [{ autoSubmitted: null, precedence: 'first-class', listId: null }, false],
    [{ autoSubmitted: null, precedence: null, listId: '<news.example.com>' }, true],
    [{ autoSubmitted: null, precedence: null, listId: null }, false],
  ])('detectAutomated(%j) === %s', (h, want) => {
    expect(detectAutomated(h)).toBe(want)
  })
})
