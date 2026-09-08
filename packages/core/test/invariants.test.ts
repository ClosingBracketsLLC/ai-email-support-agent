import { describe, expect, it } from 'vitest'
import { INVARIANTS, assertInvariants, checkInvariants } from '../src/invariants.ts'

describe('invariants', () => {
  it('the shipped constants satisfy every invariant', () => {
    expect(() => assertInvariants()).not.toThrow()
    expect(checkInvariants(INVARIANTS)).toEqual([])
  })
  it('names the violated rule', () => {
    expect(checkInvariants({ ...INVARIANTS, REDRAFT_MAX: 3 })).toEqual([
      '1 + REDRAFT_MAX (3) must be <= AGENT_MAX_RUNS_PER_TICKET_PER_DAY (3)',
    ])
    expect(checkInvariants({ ...INVARIANTS, SEND_CLAIM_HORIZON_SECONDS: 500 })).toEqual([
      'SEND_CLAIM_HORIZON_SECONDS (500) must equal SEND_QUEUE_EXPIRE_SECONDS (600)',
    ])
  })
})
