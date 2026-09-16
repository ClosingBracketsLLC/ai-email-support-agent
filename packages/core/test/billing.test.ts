import { describe, expect, it } from 'vitest'
import {
  allowanceOf, type BillingRowLike, billingStateOf, handledPeriodStamp, handledPeriodStamps, isAllowanceExhausted, isBillingActive,
  isHandledInPeriod, overageOf, periodOf, trialEndsAtFor,
} from '../src/billing.ts'

const row = (over: Partial<BillingRowLike> = {}): BillingRowLike => ({
  plan: 'standard',
  status: 'active',
  trialEndsAt: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  domainQuantity: 2,
  includedConversationsPerDomain: 300,
  overageMode: 'automatic',
  ...over,
})

describe('billingStateOf (the status plus the derived trial expiry)', () => {
  const now = new Date('2026-09-12T10:00:00Z')
  it.each([
    ['trialing, no trialEndsAt', row({ status: 'trialing', trialEndsAt: null }), 'trialing'],
    ['trialing, ends tomorrow', row({ status: 'trialing', trialEndsAt: new Date('2026-09-13T10:00:00Z') }), 'trialing'],
    ['trialing, ended an hour ago', row({ status: 'trialing', trialEndsAt: new Date('2026-09-12T09:00:00Z') }), 'trial_expired'],
    ['active passes through regardless of trialEndsAt', row({ status: 'active', trialEndsAt: new Date('2020-01-01T00:00:00Z') }), 'active'],
    ['past_due passes through regardless of trialEndsAt', row({ status: 'past_due', trialEndsAt: new Date('2020-01-01T00:00:00Z') }), 'past_due'],
    ['canceled passes through regardless of trialEndsAt', row({ status: 'canceled', trialEndsAt: new Date('2020-01-01T00:00:00Z') }), 'canceled'],
  ] as const)('%s → %s', (_name, r, want) => {
    expect(billingStateOf(r, now)).toBe(want)
  })
})

describe('isBillingActive', () => {
  it.each([
    ['trialing', true], ['trial_expired', false], ['active', true], ['past_due', false], ['canceled', false],
  ] as const)('%s → %s', (state, want) => {
    expect(isBillingActive(state)).toBe(want)
  })
})

describe('allowanceOf (trial: the flat BILLING_PRICING.trialIncludedConversations constant, field ignored; standard: includedPerDomain × max(1, domains))', () => {
  it.each([
    ['trial, 3 domains → the flat trial allowance regardless of domain count', row({ plan: 'trial', includedConversationsPerDomain: 50, domainQuantity: 3 }), 50],
    // Ruling R6 regression: a trial row's `includedConversationsPerDomain` is what the workspace
    // gets on SUBSCRIBING (the column default, 300) — it must never leak onto the trial's own
    // allowance. A row-backed trial and a missing trial row must read identically.
    ['trial with the column default (300) still reads the flat trial allowance, never 300', row({ plan: 'trial', includedConversationsPerDomain: 300, domainQuantity: 1 }), 50],
    ['standard, 0 domains → includedPerDomain × 1 (never zero)', row({ plan: 'standard', includedConversationsPerDomain: 300, domainQuantity: 0 }), 300],
    ['standard, 2 domains → includedPerDomain × 2', row({ plan: 'standard', includedConversationsPerDomain: 300, domainQuantity: 2 }), 600],
  ] as const)('%s', (_name, r, want) => {
    expect(allowanceOf(r)).toBe(want)
  })
})

describe('periodOf', () => {
  it('returns the Stripe period when the row has one', () => {
    const start = new Date('2026-08-15T00:00:00Z')
    const end = new Date('2026-09-15T00:00:00Z')
    expect(periodOf(row({ currentPeriodStart: start, currentPeriodEnd: end }), new Date('2026-09-12T10:00:00Z'))).toEqual({ start, end })
  })
  it('falls back to the UTC calendar month containing now for a trial row with no Stripe dates', () => {
    expect(periodOf(row({ plan: 'trial', currentPeriodStart: null, currentPeriodEnd: null }), new Date('2026-09-12T10:00:00Z'))).toEqual({
      start: new Date('2026-09-01T00:00:00Z'),
      end: new Date('2026-10-01T00:00:00Z'),
    })
  })
})

describe('overageOf', () => {
  it.each([[601, 600, 1], [599, 600, 0], [600, 600, 0]])('overageOf(%s, %s) = %s', (used, allowance, want) => {
    expect(overageOf(used, allowance)).toBe(want)
  })
})

describe('isAllowanceExhausted', () => {
  it('byok is never exhausted', () => {
    expect(isAllowanceExhausted({ mode: 'byok', plan: 'standard', overageMode: 'blocked', used: 1_000_000, allowance: 1 })).toBe(false)
  })
  it('managed standard automatic overage is never exhausted (overage just accrues)', () => {
    expect(isAllowanceExhausted({ mode: 'managed', plan: 'standard', overageMode: 'automatic', used: 10_000, allowance: 600 })).toBe(false)
  })
  it('managed standard blocked at the allowance is exhausted', () => {
    expect(isAllowanceExhausted({ mode: 'managed', plan: 'standard', overageMode: 'blocked', used: 600, allowance: 600 })).toBe(true)
  })
  it('managed trial is exhausted at the allowance regardless of overageMode', () => {
    expect(isAllowanceExhausted({ mode: 'managed', plan: 'trial', overageMode: 'automatic', used: 49, allowance: 50 })).toBe(false)
    expect(isAllowanceExhausted({ mode: 'managed', plan: 'trial', overageMode: 'automatic', used: 50, allowance: 50 })).toBe(true)
  })
})

describe('trialEndsAtFor', () => {
  it('is BILLING_PRICING.trialDays (14) days after agent_enabled_at', () => {
    expect(trialEndsAtFor(new Date('2026-09-12T10:00:00Z'))).toEqual(new Date('2026-09-26T10:00:00Z'))
  })
})

// Plan deviation 3: one usage recomputation walked with numbers — standard, 2 domains, allowance 600.
describe('worked example: overage reporting deltas across three days (plan deviation 3)', () => {
  it('day 1: used 601 → overage 1, nothing reported yet → delta 1', () => {
    const allowance = allowanceOf(row({ plan: 'standard', includedConversationsPerDomain: 300, domainQuantity: 2 }))
    expect(allowance).toBe(600)
    const overageDay1 = overageOf(601, allowance)
    const reportedDay1 = 0
    expect(overageDay1).toBe(1)
    expect(overageDay1 - reportedDay1).toBe(1)
  })
  it('day 2: used 650 → overage 50, 1 already reported → delta 49', () => {
    const allowance = 600
    const overageDay2 = overageOf(650, allowance)
    const reportedSoFar = 1
    expect(overageDay2).toBe(50)
    expect(overageDay2 - reportedSoFar).toBe(49)
  })
  it('day 3: used stays 650 → overage still 50, all of it already reported → delta 0 (no event)', () => {
    const allowance = 600
    const overageDay3 = overageOf(650, allowance)
    const reportedSoFar = 50
    expect(overageDay3).toBe(50)
    expect(overageDay3 - reportedSoFar).toBe(0)
  })
})

// Ruling R26: the conversation dedupe is keyed on the BILLING PERIOD, not the calendar month.
describe('handledPeriodStamp / handledPeriodStamps / isHandledInPeriod', () => {
  it('stamps the period START\'s UTC date — a Stripe anniversary period mid-month, a calendar-month trial period on the 1st', () => {
    expect(handledPeriodStamp(new Date('2026-01-15T00:00:00Z'))).toBe('2026-01-15')
    expect(handledPeriodStamp(periodOf(row({ status: 'trialing', plan: 'trial' }), new Date('2026-02-20T09:00:00Z')).start)).toBe('2026-02-01')
    // The date, not the instant: a period that starts at 23:30 UTC on the 15th is still the 15th.
    expect(handledPeriodStamp(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-15')
  })

  it('a stored legacy calendar-month stamp (\'YYYY-MM\') counts as \'YYYY-MM-01\' — and ONLY for a period starting on the 1st', () => {
    expect(handledPeriodStamps(new Date('2026-09-01T00:00:00Z'))).toEqual(['2026-09-01', '2026-09'])
    expect(handledPeriodStamps(new Date('2026-09-15T00:00:00Z'))).toEqual(['2026-09-15'])

    const firstOfSept = new Date('2026-09-01T00:00:00Z')
    expect(isHandledInPeriod('2026-09', firstOfSept)).toBe(true)      // stamped before the wave deployed
    expect(isHandledInPeriod('2026-09-01', firstOfSept)).toBe(true)
    expect(isHandledInPeriod('2026-08', firstOfSept)).toBe(false)
    expect(isHandledInPeriod('2026-08-01', firstOfSept)).toBe(false)
    expect(isHandledInPeriod(null, firstOfSept)).toBe(false)

    const fifteenth = new Date('2026-09-15T00:00:00Z')
    expect(isHandledInPeriod('2026-09-15', fifteenth)).toBe(true)
    expect(isHandledInPeriod('2026-09', fifteenth)).toBe(false)       // a mid-month period has no legacy form
    expect(isHandledInPeriod('2026-09-01', fifteenth)).toBe(false)    // the previous period's stamp — this is the new one
  })

  it('two replies straddling a calendar boundary inside one Stripe period read as the SAME period', () => {
    const period = periodOf(row({ currentPeriodStart: new Date('2026-01-15T00:00:00Z'), currentPeriodEnd: new Date('2026-02-15T00:00:00Z') }), new Date('2026-02-01T08:00:00Z'))
    const stampOnJan31 = handledPeriodStamp(period.start)
    // Feb 1's send reads the same period start (it is stored on the row), so the Jan 31 stamp holds.
    expect(isHandledInPeriod(stampOnJan31, period.start)).toBe(true)
  })
})
