/**
 * The ticket-independent half of a drafting run's context: the tenant-visible workspace profile,
 * the workspace's own guidance and kill/enable levers, and the org's category list. Shared by
 * `ticket.draft` (`jobs/ticket-draft.ts`'s `loadContext`, which layers the ticket, the thread, the
 * prior draft, the ticket-scoped human-decision count, the ticket's category mode and its
 * connection's health on top) and `agent.sandbox` (`jobs/agent-sandbox.ts`, which layers its
 * synthetic thread and the same lookups keyed on the MODEL's own decided category instead of a
 * ticket's).
 *
 * Split out purely so both jobs read the identical workspace row and category list the identical
 * way — a drift between two copies of this query is exactly the kind of thing that would make the
 * "try it" sandbox answer differently than a real draft would for the same thread.
 */
import { eq } from 'drizzle-orm'
import type { WorkspaceProfile } from '@aesa/agent'
import type { Tone } from '@aesa/contracts'
import { categories, workspaces, type OrgTx } from '@aesa/db'

export interface SharedDraftContext {
  profile: WorkspaceProfile
  workspaceGuidance: string
  workspaceKillSwitch: boolean
  agentEnabled: boolean
  cats: { id: string; key: string; label: string }[]
}

export async function loadSharedDraftContext(tx: OrgTx, orgId: string): Promise<SharedDraftContext> {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.orgId, orgId))
  if (!workspace) throw new Error(`drafting: org ${orgId} has no workspace row`)

  const cats = await tx.select({ id: categories.id, key: categories.key, label: categories.label }).from(categories)

  const profile: WorkspaceProfile = {
    businessName: workspace.businessName,
    websiteUrl: workspace.websiteUrl,
    description: workspace.description,
    tone: workspace.tone as Tone,
    timezone: workspace.timezone,
    locale: workspace.locale,
    contactPhone: workspace.contactPhone,
    contactUrls: workspace.contactUrls,
    allowedUrlHosts: workspace.allowedUrlHosts,
    allowedEmailDomains: workspace.allowedEmailDomains,
  }

  return {
    profile,
    workspaceGuidance: workspace.operatingGuidance,
    workspaceKillSwitch: workspace.killSwitch,
    agentEnabled: workspace.agentEnabled,
    cats,
  }
}
