/**
 * The `llm` router: input → `src/llm/service.ts` → tRPC error mapping, and nothing else — mirrors
 * `routers/memory.ts` and `routers/knowledge.ts`. Seeing which provider a workspace is on, and what
 * it has cost, is every teammate's business (`orgProcedure`); pasting a key, testing it, removing it
 * or moving an agent onto it is workspace management (`managerProcedure`).
 *
 * No router-only logic lives here: the sealing, the SSRF guard, the generation bump and the
 * `model_changed` demotion are all the service's, so the `/a/...`-style surfaces and Task 11's E2E
 * can call the same functions directly.
 */
import { TRPCError } from '@trpc/server'
import { AddCredentialInput, AgentIdInput, CredentialIdInput, SetAgentModelInput } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type pino from 'pino'
import type { ApiFacade, EnqueueFn } from '../../deps.ts'
import {
  addCredential, getAgentModel, listCredentials, probeCredential, removeCredential, setAgentModel,
  type LlmActor, type LlmServiceDeps,
} from '../../llm/service.ts'
import { managerProcedure, orgProcedure, router } from '../init.ts'

/** The slice of the tRPC context the service needs — structural, so the real context just satisfies it. */
interface LlmContext {
  deps: { api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger }
  user: { id: string }
  actor: AuditActor
  ip: string
  userAgent: string | null
}

const serviceDeps = (ctx: LlmContext): LlmServiceDeps => ({ api: ctx.deps.api, enqueue: ctx.deps.enqueue, logger: ctx.deps.logger })
const appActor = (ctx: LlmContext): LlmActor => ({ userId: ctx.user.id, actor: ctx.actor, ip: ctx.ip, userAgent: ctx.userAgent })

/** "Not this workspace's credential" and "no such credential" are reported the same way on purpose:
 * the difference would leak whether an id exists in another workspace. */
const notFound = (what: string): TRPCError => new TRPCError({ code: 'NOT_FOUND', message: `${what} not found` })

export const llmRouter = router({
  list: orgProcedure.query(({ ctx }) => listCredentials(serviceDeps(ctx), ctx.orgId)),

  /**
   * `keys_not_provisioned` and `cap_reached` are both PRECONDITION_FAILED — states of the workspace
   * that a retry can clear (provision finishes; a connection is removed). `unsafe_url` is
   * BAD_REQUEST: the owner typed an endpoint this platform will not call, and only a different
   * input fixes it.
   */
  add: managerProcedure.input(AddCredentialInput).mutation(async ({ ctx, input }) => {
    const res = await addCredential(serviceDeps(ctx), ctx.orgId, input, appActor(ctx))
    if (res.ok) return { credentialId: res.credentialId }
    switch (res.code) {
      case 'keys_not_provisioned':
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this workspace is still being set up; try again in a moment' })
      case 'cap_reached':
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'connection limit reached' })
      case 'unsafe_url':
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'that endpoint must be a public https address' })
    }
  }),

  probe: managerProcedure.input(CredentialIdInput).mutation(async ({ ctx, input }) => {
    const res = await probeCredential(serviceDeps(ctx), ctx.orgId, input.credentialId, appActor(ctx))
    if (!res.ok) throw notFound('provider connection')
    return { ok: true as const }
  }),

  remove: managerProcedure.input(CredentialIdInput).mutation(async ({ ctx, input }) => {
    const res = await removeCredential(serviceDeps(ctx), ctx.orgId, input.credentialId, appActor(ctx))
    if (!res.ok) throw notFound('provider connection')
    return { ok: true as const, agentsReset: res.agentsReset }
  }),

  agentModel: orgProcedure.input(AgentIdInput).query(async ({ ctx, input }) => {
    const res = await getAgentModel(serviceDeps(ctx), ctx.orgId, input.agentId)
    if (!res) throw notFound('agent')
    return res
  }),

  setAgentModel: managerProcedure.input(SetAgentModelInput).mutation(async ({ ctx, input }) => {
    const res = await setAgentModel(serviceDeps(ctx), ctx.orgId, input, appActor(ctx))
    if (res.ok) return { ok: true as const, generationBumped: res.generationBumped, demoted: res.demoted }
    switch (res.code) {
      case 'not_found': throw notFound('agent')
      case 'credential_not_found': throw notFound('provider connection')
      case 'credential_dead':
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'that connection was rejected by the provider; test it before using it' })
    }
  }),
})
