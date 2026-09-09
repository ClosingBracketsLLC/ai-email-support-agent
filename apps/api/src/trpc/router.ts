import { router } from './init.ts'
import { devicesRouter } from './routers/devices.ts'
import { mailboxesRouter } from './routers/mailboxes.ts'
import { teamRouter } from './routers/team.ts'
import { workspaceRouter } from './routers/workspace.ts'

export const appRouter = router({
  workspace: workspaceRouter,
  team: teamRouter,
  devices: devicesRouter,
  mailboxes: mailboxesRouter,
})
export type AppRouter = typeof appRouter
