import { describe, expect, it } from 'vitest'
import {
  BILLING_ERROR_MESSAGES, BILLING_PRICING, BILLING_STATES, BILLING_STATUSES, NOTIFICATION_KINDS, OVERAGE_MODES, PLAN_IDS,
  RequestDeletionInput, SetOverageModeInput,
} from '../src/index.ts'

describe('billing vocabulary', () => {
  it('pins the plan ids, billing statuses/states and overage modes', () => {
    expect(PLAN_IDS).toEqual(['trial', 'standard'])
    expect(BILLING_STATUSES).toEqual(['trialing', 'active', 'past_due', 'canceled'])
    expect(BILLING_STATES).toEqual(['trialing', 'trial_expired', 'active', 'past_due', 'canceled'])
    expect(OVERAGE_MODES).toEqual(['automatic', 'blocked'])
  })
  it('pins the pricing numbers (spec §Usage / pricing)', () => {
    expect(BILLING_PRICING).toEqual({
      perDomainCents: 4999,
      includedPerDomain: 300,
      overageUnitCents: 12,
      trialDays: 14,
      trialIncludedConversations: 50,
      trialLlmUsdBudget: 10,
    })
  })
  it('pins the billing error message keys', () => {
    expect(BILLING_ERROR_MESSAGES).toEqual({
      not_configured: 'Billing is not set up on this server yet.',
      no_customer: 'Subscribe first, then manage billing.',
      already_subscribed: 'This workspace already has a subscription — use Manage billing.',
      stripe_unavailable: 'Stripe did not answer. Try again in a minute.',
      connection_limit: 'Your plan allows no more mailbox connections. Upgrade or disconnect one.',
    })
  })
})

describe('SetOverageModeInput', () => {
  it('accepts both modes and rejects an unknown one', () => {
    expect(SetOverageModeInput.safeParse({ mode: 'automatic' }).success).toBe(true)
    expect(SetOverageModeInput.safeParse({ mode: 'blocked' }).success).toBe(true)
    expect(SetOverageModeInput.safeParse({ mode: 'packs' }).success).toBe(false)
  })
})

describe('NOTIFICATION_KINDS', () => {
  it('gained billing and workspace', () => {
    expect(NOTIFICATION_KINDS).toContain('billing')
    expect(NOTIFICATION_KINDS).toContain('workspace')
  })
})

describe('RequestDeletionInput', () => {
  it('trims and bounds the confirmation text', () => {
    expect(RequestDeletionInput.parse({ confirm: '  Acme Inc  ' })).toEqual({ confirm: 'Acme Inc' })
    expect(RequestDeletionInput.safeParse({ confirm: '' }).success).toBe(false)
    expect(RequestDeletionInput.safeParse({ confirm: '   ' }).success).toBe(false)
    expect(RequestDeletionInput.safeParse({ confirm: 'x'.repeat(120) }).success).toBe(true)
    expect(RequestDeletionInput.safeParse({ confirm: 'x'.repeat(121) }).success).toBe(false)
  })
})
