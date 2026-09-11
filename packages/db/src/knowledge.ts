import { eq, sql } from 'drizzle-orm'
import { workspaces } from './schema/tenancy.ts'
import type { OrgTx } from './tenant.ts'

/**
 * Every change to the org's chunk set — a document ingested or re-ingested, a crawl page landed, a
 * source or chunk deleted, a flag cleared — bumps this in the SAME transaction. It is provenance, not
 * a cache key: the knowledge block is `volatile` (Phase 3), and Phase 5's `resolved_answers` compare
 * their `knowledge_version` against it to notice a stale answer (plan deviation 4).
 */
export async function bumpKnowledgeVersion(tx: OrgTx, orgId: string): Promise<number> {
  const [row] = await tx.update(workspaces)
    .set({ knowledgeVersion: sql`${workspaces.knowledgeVersion} + 1` })
    .where(eq(workspaces.orgId, orgId))
    .returning({ knowledgeVersion: workspaces.knowledgeVersion })
  if (!row) throw new Error(`bumpKnowledgeVersion: no workspace for org ${orgId}`)
  return row.knowledgeVersion
}
