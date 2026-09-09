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
