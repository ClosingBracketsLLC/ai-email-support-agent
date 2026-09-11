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
  // fix wave W2 / final-A2 I-1: a release that lands PAST pg-boss's first retry is never claimable,
  // so the retry returns a no-op, the chain ends and the dead-letter never runs.
  it('catches a release delay that outruns pg-boss first retry', () => {
    expect(checkInvariants({ ...INVARIANTS, SEND_RELEASE_RETRY_SECONDS: 60 })).toEqual([
      'SEND_RELEASE_RETRY_SECONDS (60) must be < SEND_RETRY_DELAY_SECONDS (30) — pg-boss retries a failed send.execute at retryDelay seconds at the earliest, and a row whose send_after is later is not claimable then',
    ])
  })
})
