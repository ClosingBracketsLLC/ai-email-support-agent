import { router } from './init.ts'
import { agentsRouter } from './routers/agents.ts'
import { devicesRouter } from './routers/devices.ts'
import { inboxRouter } from './routers/inbox.ts'
import { mailboxesRouter } from './routers/mailboxes.ts'
import { teamRouter } from './routers/team.ts'
import { workspaceRouter } from './routers/workspace.ts'

export const appRouter = router({
  workspace: workspaceRouter,
  team: teamRouter,
  devices: devicesRouter,
  mailboxes: mailboxesRouter,
  agents: agentsRouter,
  inbox: inboxRouter,
})
export type AppRouter = typeof appRouter
