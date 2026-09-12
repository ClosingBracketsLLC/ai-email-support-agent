import { describe, expect, it } from 'vitest'
import { scrubForMemory } from '../src/memory/scrub.ts'

describe('scrubForMemory (spec §Learning loop privacy: structural, not semantic)', () => {
  it('drops a greeting line and a sign-off block, keeps the substance', () => {
    const text = 'Hi Casey,\n\nWhere is my order? It was due yesterday.\n\nThanks,\nCasey Jordan\nAcme Customer'
    expect(scrubForMemory(text)).toBe('Where is my order? It was due yesterday.')
  })
  it.each([
    ['email me at casey.j@example.com please', 'email me at [email] please'],
    ['call +1 (415) 555-0134 or 0800 123 4567', 'call [phone] or [phone]'],
    ['order 4837261 and #AB-99812345 arrived', 'order [number] and #AB-[number] arrived'],
    ['it cost 30 dollars on 12 May', 'it cost 30 dollars on 12 May'],   // short digit runs survive: they are facts, not identifiers
  ])('masks %j → %j', (input, want) => {
    expect(scrubForMemory(input)).toBe(want)
  })
  it('masks the customer name and address it is told about, case-insensitively, whole words only', () => {
    expect(scrubForMemory('Casey said CASEY wants it; caseyness is a word', { customerName: 'Casey', customerEmail: 'casey@x.test' }))
      .toBe('[name] said [name] wants it; caseyness is a word')
  })
  it('never cuts the FIRST content line: a one-line reply that opens with a sign-off word survives whole', () => {
    // The defect this row exists for: the sign-off scan covers the trailing half, and a one-line
    // reply IS its own trailing half — so this body scrubbed to '' and `memory.capture` learned
    // nothing from it (`memory.skipped`, `empty_after_scrub`).
    const oneLine = 'Thanks for getting in touch. I have checked the details you gave us and everything looks correct on our side.'
    expect(scrubForMemory(oneLine)).toBe(oneLine)
  })
  it('still cuts a real sign-off block that FOLLOWS the answer', () => {
    expect(scrubForMemory('Your order ships tomorrow.\n\nThanks!\nCasey')).toBe('Your order ships tomorrow.')
  })
  it('collapses blank runs and trims; an all-greeting message becomes empty', () => {
    expect(scrubForMemory('Hello!\n\n\n\nBest regards,\nSam')).toBe('')
    expect(scrubForMemory('  a\n\n\n\nb  ')).toBe('a\n\nb')
  })
})
