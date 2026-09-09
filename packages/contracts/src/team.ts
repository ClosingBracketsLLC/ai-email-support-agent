/** Better Auth organization plugin defaults. owner/admin manage the workspace and the team; member is read-only. */
export const ORG_ROLES = ['owner', 'admin', 'member'] as const
export type OrgRole = (typeof ORG_ROLES)[number]
export const canManageWorkspace = (role: OrgRole): boolean => role === 'owner' || role === 'admin'
