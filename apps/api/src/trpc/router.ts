import { router } from './init.ts'
import { workspaceRouter } from './routers/workspace.ts'

export const appRouter = router({
  workspace: workspaceRouter,
})
export type AppRouter = typeof appRouter
