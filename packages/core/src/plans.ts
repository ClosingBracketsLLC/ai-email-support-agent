import type { SettingKey } from './settings-catalog.ts'

export const PLANS = {
  trial: { dailyDraftCap: 50, dailyLlmUsdCap: 3, sandboxDailyCap: 10, maxConnections: 1, maxAgentsPerDomain: 3, includedConversationsPerDomain: 0, trialDays: 14 },
  standard: { dailyDraftCap: 2000, dailyLlmUsdCap: 60, sandboxDailyCap: 100, maxConnections: 5, maxAgentsPerDomain: 3, includedConversationsPerDomain: 300, trialDays: 0 },
} as const
export type PlanId = keyof typeof PLANS

export function planSettingDefaults(plan: PlanId): Partial<Record<SettingKey, number | boolean>> {
  const p = PLANS[plan]
  return {
    'autonomy.daily_draft_cap': p.dailyDraftCap,
    'autonomy.daily_llm_usd_cap': p.dailyLlmUsdCap,
    'triage.daily_cap': p.dailyDraftCap * 3,
    'sandbox.daily_cap': p.sandboxDailyCap,
    'mailboxes.max_connections': p.maxConnections,
  }
}
