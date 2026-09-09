import { describe, expect, it } from 'vitest'
import { scrubCardNumbers } from '../src/scrub.ts'

describe('scrubCardNumbers', () => {
  it('masks a Luhn-valid card with spaces or dashes', () => {
    expect(scrubCardNumbers('pay 4111 1111 1111 1111 thanks')).toBe('pay [card removed] thanks')
    expect(scrubCardNumbers('4111-1111-1111-1111')).toBe('[card removed]')
  })
  it('leaves non-Luhn digit runs alone (order and tracking numbers)', () => {
    expect(scrubCardNumbers('order 1234567890123 and RA9400111899223197428490')).toBe(
      'order 1234567890123 and RA9400111899223197428490',
    )
  })
})
