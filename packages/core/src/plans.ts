import { BILLING_PRICING, type PlanId } from '@aesa/contracts'
import type { SettingKey } from './settings-catalog.ts'

export type { PlanId } from '@aesa/contracts'

interface PlanLimits {
  dailyDraftCap: number
  dailyLlmUsdCap: number
  sandboxDailyCap: number
  maxConnections: number
  maxAgentsPerDomain: number
  /** Standard: a real per-domain count. Trial: a FLAT per-workspace allowance (plan deviation 5) —
   *  the field name stays uniform with the standard tier's meaning so a future `billing_subscriptions`
   *  column and Stripe's own model never need two names for one number; `allowanceOf` (billing.ts)
   *  documents the trial reading. */
  includedConversationsPerDomain: number
  trialDays: number
  maxSources: number
  maxCrawlPages: number
  dailyEmbedTokensCap: number
  /** Total Managed-AI spend the plan may cost the platform, USD; null when there is no total cap
   *  (a paid plan is metered per period instead, spec §Budgets). */
  llmUsdBudget: number | null
}

export const PLANS = {
  trial: {
    dailyDraftCap: 50, dailyLlmUsdCap: 3, sandboxDailyCap: 10, maxConnections: 1, maxAgentsPerDomain: 3,
    includedConversationsPerDomain: BILLING_PRICING.trialIncludedConversations,
    trialDays: BILLING_PRICING.trialDays,
    maxSources: 10, maxCrawlPages: 20, dailyEmbedTokensCap: 200_000,
    llmUsdBudget: BILLING_PRICING.trialLlmUsdBudget,
  },
  standard: {
    dailyDraftCap: 2000, dailyLlmUsdCap: 60, sandboxDailyCap: 100, maxConnections: 5, maxAgentsPerDomain: 3,
    includedConversationsPerDomain: BILLING_PRICING.includedPerDomain,
    trialDays: 0,
    maxSources: 100, maxCrawlPages: 200, dailyEmbedTokensCap: 5_000_000,
    llmUsdBudget: null,
  },
} as const satisfies Record<PlanId, PlanLimits>

export function planSettingDefaults(plan: PlanId): Partial<Record<SettingKey, number | boolean>> {
  const p = PLANS[plan]
  return {
    'autonomy.daily_draft_cap': p.dailyDraftCap,
    'autonomy.daily_llm_usd_cap': p.dailyLlmUsdCap,
    'triage.daily_cap': p.dailyDraftCap * 3,
    'sandbox.daily_cap': p.sandboxDailyCap,
    'mailboxes.max_connections': p.maxConnections,
    'knowledge.max_sources': p.maxSources,
    'knowledge.max_crawl_pages': p.maxCrawlPages,
    'knowledge.daily_embed_tokens_cap': p.dailyEmbedTokensCap,
  }
}
