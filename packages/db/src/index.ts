export * from './schema/index.ts'
export type { Db } from './client.ts'
export { withOrg, withOrgIdentity, withPlatform, isUuid, type OrgTx, type PlatformTx } from './tenant.ts'
export { provisionOrgKeys, loadOrgDek, getOrgBoxPublicKey, getOrgBoxPublicKeyOrNull, openSealedForOrg } from './keys.ts'
export { audit, type AuditActor, type AuditEntry } from './audit.ts'
export { escalateTicket, escalationCopy, escalationDedupeKey, insertEscalationNotification, type EscalateTicketParams } from './escalations.ts'
export { ensureDefaultCategories } from './categories.ts'
export { bumpMeter, createMeterSink, GUIDANCE_METERS, KNOWLEDGE_METERS, LLM_METERS, SANDBOX_METERS, SEND_METERS } from './metering.ts'
export { bumpKnowledgeVersion } from './knowledge.ts'
export { customerHash, ensureCustomerHashSalt } from './memory.ts'
export {
  countHumanDecisions, demoteCategory, graduateCategory, readDemotionSignals,
  type DemotionSignals, type DemotionWindows,
} from './autonomy.ts'
export { managedConfig, resolveModelConfig, type ResolvedModelConfig } from './model-config.ts'
export { loadModelPricing } from './pricing.ts'
