import { describe, expect, it } from 'vitest'
import { IllegalTransitionError, defineTransitions, draftTransitions, ticketTransitions } from '../src/transitions.ts'

describe('transitions', () => {
  it('self-transitions are always illegal', () => {
    for (const s of ['new', 'triaged', 'resolved'] as const) expect(ticketTransitions.can(s, s)).toBe(false)
  })
  it('ticket happy path: new → triaged → awaiting_review → waiting_on_customer → new (reopen)', () => {
    expect(ticketTransitions.can('new', 'triaged')).toBe(true)
    expect(ticketTransitions.can('triaged', 'awaiting_review')).toBe(true)
    expect(ticketTransitions.can('awaiting_review', 'waiting_on_customer')).toBe(true)
    expect(ticketTransitions.can('waiting_on_customer', 'new')).toBe(true)
    expect(ticketTransitions.can('resolved', 'triaged')).toBe(false)
  })
  it('draft terminal states have no exits', () => {
    for (const s of ['sent', 'rejected', 'superseded', 'expired', 'failed'] as const)
      expect(draftTransitions.can(s, 'pending')).toBe(false)
    expect(() => draftTransitions.assert('sent', 'pending')).toThrow(IllegalTransitionError)
  })
  it('defineTransitions rejects a matrix that lists a self-transition', () => {
    expect(() => defineTransitions({ a: ['a'], b: [] } as const)).toThrow(/self/)
  })
  it('rejects an unknown status key at compile time when the status type is explicit', () => {
    type S = 'x' | 'y'
    // @ts-expect-error 'bogus' is not a status
    defineTransitions<S>({ x: ['y'], y: [], bogus: [] })
    expect(true).toBe(true)
  })
})
