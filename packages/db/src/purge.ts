/**
 * `PURGE_ORDER` is the complete list of tenant tables — every table in the schema EXCEPT
 * `workspaces`, which `purgeWorkspace` deletes separately, last — an org-delete purges, children
 * before parents in FK-dependency order. `purge.test.ts` PINS this list against the migration table
 * list (`EXPECTED_TABLES` minus `RLS_EXEMPT` minus `['workspaces']`, `test/helpers/tables.ts`), so a
 * future tenant table added to the schema without an entry here fails CI instead of silently
 * surviving a purge and leaking one tenant's rows past a workspace delete.
 *
 * Each table is deleted by a plain `DELETE FROM <table> WHERE org_id = $1` — RLS is bypassed
 * (`PlatformTx`, `<table>_platform_all USING (true)`), so the explicit `org_id` predicate here is the
 * WHOLE safety, not a redundant brace. `getTableName`/`sql.identifier` let one small loop delete
 * from every table generically regardless of its own primary key shape (composite, or none at all).
 */
import { eq, getTableName, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import {
  agentCategoryPolicies, agentModelConfig, agentRunEvents, agentRuns, agents, auditLog, billingSubscriptions,
  categories, categoryStatsDaily, draftActionTokens, drafts, gmailAccessRequests, guidanceSuggestions,
  knowledgeChunks, knowledgeDocuments, knowledgeSources, llmCalls, llmCredentialSecrets, llmCredentials,
  mailboxConnections, mailboxCredentials, messages, notificationDevices, notifications, oauthFlows,
  organization, orgDataKeys, orgSettings, outboundSends, resolvedAnswers, session, tickets, usageCounters,
  workspaces,
} from './schema/index.ts'
import type { PlatformTx } from './tenant.ts'

export const PURGE_ORDER: readonly PgTable[] = [
  draftActionTokens, outboundSends, agentRunEvents, llmCalls, drafts, agentRuns, messages, tickets,
  agentCategoryPolicies, categoryStatsDaily, guidanceSuggestions, resolvedAnswers, agentModelConfig,
  llmCredentialSecrets, llmCredentials, knowledgeChunks, knowledgeDocuments, knowledgeSources, agents,
  categories, mailboxCredentials, mailboxConnections, oauthFlows, gmailAccessRequests, notifications,
  notificationDevices, usageCounters, orgSettings, billingSubscriptions, orgDataKeys, auditLog,
]

async function deleteAllForOrg(tx: PlatformTx, table: PgTable, orgId: string): Promise<number> {
  const name = getTableName(table)
  const result = await tx.execute(sql`DELETE FROM ${sql.identifier(name)} WHERE org_id = ${orgId}`)
  return result.rowCount ?? 0
}

/** Deletes in `PURGE_ORDER`, then `workspaces`; returns the row count deleted per table (keyed by its
 *  real table name). Runs entirely inside the caller's `PlatformTx` — one transaction, one org. */
export async function purgeWorkspace(tx: PlatformTx, orgId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of PURGE_ORDER) {
    counts[getTableName(table)] = await deleteAllForOrg(tx, table, orgId)
  }
  counts[getTableName(workspaces)] = await deleteAllForOrg(tx, workspaces, orgId)
  return counts
}

/**
 * The auth-side half of an org delete (deviation 9): Better Auth's `organization` is not a tenant
 * table `purgeWorkspace` reaches, so this is separate. `session.active_organization_id` is nulled
 * FIRST — a session pointing at a row about to be deleted must never be left dangling — then
 * `organization` is deleted, which cascades `member` and `invitation` (both declared `onDelete:
 * 'cascade'` off `organization.id`, `schema/auth.ts`).
 */
export async function purgeAuthRows(tx: PlatformTx, orgId: string): Promise<void> {
  await tx.update(session).set({ activeOrganizationId: null }).where(eq(session.activeOrganizationId, orgId))
  await tx.delete(organization).where(eq(organization.id, orgId))
}
