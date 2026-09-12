import { router } from './init.ts'
import { activityRouter } from './routers/activity.ts'
import { agentsRouter } from './routers/agents.ts'
import { devicesRouter } from './routers/devices.ts'
import { draftsRouter } from './routers/drafts.ts'
import { inboxRouter } from './routers/inbox.ts'
import { knowledgeRouter } from './routers/knowledge.ts'
import { llmRouter } from './routers/llm.ts'
import { mailboxesRouter } from './routers/mailboxes.ts'
import { memoryRouter } from './routers/memory.ts'
import { teamRouter } from './routers/team.ts'
import { workspaceRouter } from './routers/workspace.ts'

export const appRouter = router({
  workspace: workspaceRouter,
  team: teamRouter,
  devices: devicesRouter,
  mailboxes: mailboxesRouter,
  agents: agentsRouter,
  inbox: inboxRouter,
  drafts: draftsRouter,
  activity: activityRouter,
  memory: memoryRouter,
  knowledge: knowledgeRouter,
  llm: llmRouter,
})
export type AppRouter = typeof appRouter
