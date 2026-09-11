import { describe, expect, it } from 'vitest'
import { REDRAFT_MAX, clearRedraftCycle, resolveRejectAction } from '../src/redraft.ts'

describe('REDRAFT_MAX', () => {
  it('is 2 (pinned to INVARIANTS.REDRAFT_MAX)', () => {
    expect(REDRAFT_MAX).toBe(2)
  })
})

describe('clearRedraftCycle', () => {
  it('returns the reset shape spread into a redraft-cycle-clearing write', () => {
    expect(clearRedraftCycle()).toEqual({ ownerRedraftFeedback: null, redraftCount: 0 })
  })
})

// Guard ORDER is load-bearing: blank reason -> terminal; wrong status -> terminal; at cap -> limit
// regardless of the action; action !== 'redraft' -> terminal; else redraft.
describe('resolveRejectAction', () => {
  it('a blank reason escalates terminal even with a redraft action and zero redrafts so far', () => {
    expect(resolveRejectAction({ reason: '', action: 'redraft', redraftCount: 0, ticketStatus: 'awaiting_review' })).toEqual({
      kind: 'escalate_terminal',
    })
  })
  it('a blank reason wins over everything else — at cap, wrong status, handle action', () => {
    expect(resolveRejectAction({ reason: '   ', action: 'handle', redraftCount: 5, ticketStatus: 'triaged' })).toEqual({
      kind: 'escalate_terminal',
    })
  })
  it('a non-blank reason on a ticket no longer awaiting_review escalates terminal, even under the cap with a redraft action', () => {
    expect(resolveRejectAction({ reason: 'wrong item', action: 'redraft', redraftCount: 0, ticketStatus: 'resolved' })).toEqual({
      kind: 'escalate_terminal',
    })
  })
  it('at the redraft cap escalates limit regardless of action — redraft', () => {
    expect(resolveRejectAction({ reason: 'still wrong', action: 'redraft', redraftCount: 2, ticketStatus: 'awaiting_review' })).toEqual({
      kind: 'escalate_limit',
    })
  })
  it('at the redraft cap escalates limit regardless of action — handle', () => {
    expect(resolveRejectAction({ reason: 'still wrong', action: 'handle', redraftCount: 2, ticketStatus: 'awaiting_review' })).toEqual({
      kind: 'escalate_limit',
    })
  })
  it('a non-redraft action under the cap on an awaiting_review ticket escalates terminal', () => {
    expect(resolveRejectAction({ reason: "I'll handle it", action: 'handle', redraftCount: 0, ticketStatus: 'awaiting_review' })).toEqual({
      kind: 'escalate_terminal',
    })
  })
  it('the happy path: non-blank reason, awaiting_review, under the cap, redraft action', () => {
    expect(resolveRejectAction({ reason: 'wrong tone', action: 'redraft', redraftCount: 1, ticketStatus: 'awaiting_review' })).toEqual({
      kind: 'redraft',
    })
  })
})
