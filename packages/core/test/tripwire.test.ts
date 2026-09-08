import { describe, expect, it } from 'vitest'
import { TRIPWIRE_BASELINE, tripwireHit } from '../src/tripwire.ts'

describe('tripwire', () => {
  it.each([
    ['I will sue you if this is not fixed', 'sue you'],
    ['My attorney will be in touch', 'attorney'],
    ['CHARGEBACK filed with my bank', 'chargeback'],
    ['the toy hurt my dog', 'hurt'],
    ['Please delete my data under GDPR', 'delete my data'],
    ['I am a journalist writing a story', 'journalist'],
    ['ｌａｗｙｅｒ', 'lawyer'],                          // NFKC fullwidth
    ['legal\n  action', 'legal action'],                // whitespace inside a phrase
  ])('hits: %s → %s', (text, phrase) => expect(tripwireHit(text)).toBe(phrase))

  it.each([
    'I have an issue with my order',                    // "issue" contains "sue"
    'Can I get express shipping?',                      // "express" contains "press"
    'There is a minor scratch on the box',              // "minor"
    'I will pursue the tracking number myself',         // "pursue"
    'Very impressed with the tissue paper wrapping',    // "impressed", "tissue"
    'The minority of orders arrive late',
    'Hurting for a discount code',                      // "hurting" ≠ "hurt"
  ])('does NOT trip on ordinary mail: %s', (text) => expect(tripwireHit(text)).toBeNull())

  it('adds workspace phrases but never removes baseline ones', () => {
    expect(tripwireHit('my vet said the leash is unsafe', ['vet'])).toBe('vet')
    expect(tripwireHit('a veteran customer here', ['vet'])).toBeNull()
    expect(tripwireHit('I will sue you', [])).toBe('sue you')
  })

  it('baseline contains no bare short tokens that collide with ordinary words', () => {
    for (const bad of ['sue', 'press', 'minor']) expect(TRIPWIRE_BASELINE).not.toContain(bad)
  })

  it('tolerates leading/trailing whitespace in extra phrases and returns the canonical phrase', () => {
    expect(tripwireHit('please see the vet today', ['vet '])).toBe('vet')
    expect(tripwireHit('the vet said it is fine', [' vet'])).toBe('vet')
    expect(tripwireHit('the VET said it is fine', ['  Vet  '])).toBe('vet')
  })
})
