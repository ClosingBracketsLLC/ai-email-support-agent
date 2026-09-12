import { and, eq, isNull } from 'drizzle-orm'
import {
  MANAGED_MODELS, ProbeResult, qualityTierFor, type CredentialHealth, type LlmEffort, type LlmProviderId, type ModelConfigRole,
  type ProbeResultView, type QualityTier,
} from '@aesa/contracts'
import { agentModelConfig, llmCredentials } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

export interface ResolvedModelConfig {
  mode: 'managed' | 'byok'
  credentialId: string | null
  provider: LlmProviderId
  model: string
  effort: LlmEffort | null
  fallbackToManaged: boolean
  tier: QualityTier
  modelGeneration: number
  modelGenerationAt: Date | null
  credential: { label: string; baseUrl: string | null; healthStatus: CredentialHealth; lastProbe: ProbeResultView | null } | null
}

export function managedConfig(role: ModelConfigRole): ResolvedModelConfig {
  return {
    mode: 'managed', credentialId: null, provider: 'anthropic', model: MANAGED_MODELS[role], effort: null, fallbackToManaged: false,
    tier: 'calibrated', modelGeneration: 1, modelGenerationAt: null, credential: null,
  }
}

/**
 * The ONE reader of an agent's model choice — the api (run rows, the Model card) and the worker (every
 * model call) resolve through here, so they can never disagree. A byok row whose credential is gone
 * (ON DELETE SET NULL) resolves as managed; the catalog tier is downgraded to `limited` when the last
 * probe found no structured output at all (the probe may lower a tier, never raise one).
 */
export async function resolveModelConfig(tx: OrgTx, agentId: string | null, role: ModelConfigRole): Promise<ResolvedModelConfig> {
  const scope = agentId === null ? isNull(agentModelConfig.agentId) : eq(agentModelConfig.agentId, agentId)
  const [row] = await tx.select().from(agentModelConfig).where(and(eq(agentModelConfig.orgId, tx.orgId), scope, eq(agentModelConfig.role, role)))
  if (!row) return managedConfig(role)
  const base = { ...managedConfig(role), modelGeneration: row.modelGeneration, modelGenerationAt: row.modelGenerationAt, effort: row.effort as LlmEffort | null, fallbackToManaged: row.fallbackToManaged }
  if (row.mode !== 'byok' || !row.credentialId) return base
  const [cred] = await tx.select().from(llmCredentials).where(and(eq(llmCredentials.orgId, tx.orgId), eq(llmCredentials.id, row.credentialId)))
  if (!cred) return base
  const provider = cred.provider as LlmProviderId
  const model = row.model ?? MANAGED_MODELS[role]
  const probe = cred.lastProbe ? ProbeResult.safeParse(cred.lastProbe) : null
  const lastProbe = probe?.success ? probe.data : null
  const catalogTier = qualityTierFor(provider, model)
  const tier: QualityTier = lastProbe?.structured === 'none' ? 'limited' : catalogTier
  return {
    mode: 'byok', credentialId: cred.id, provider, model, effort: base.effort, fallbackToManaged: row.fallbackToManaged, tier,
    modelGeneration: row.modelGeneration, modelGenerationAt: row.modelGenerationAt,
    credential: { label: cred.label, baseUrl: cred.baseUrl, healthStatus: cred.healthStatus as CredentialHealth, lastProbe },
  }
}
