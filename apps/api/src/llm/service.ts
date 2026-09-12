/**
 * Settings › AI as ONE service module, mirroring `src/memory/service.ts` and
 * `src/knowledge/service.ts`: every procedure is a plain exported async function
 * `(deps, orgId, …) => result`, a soft outcome is a typed `{ ok: false; code }` (never a thrown
 * error), and `trpc/routers/llm.ts` does nothing but map those codes onto `TRPCError`s.
 *
 * Discipline every function here keeps (CLAUDE.md):
 *  - ONE `withOrg` transaction per call, holding no network I/O: a `custom` endpoint's URL is
 *    validated AND resolved before the transaction opens, and `notify.dispatch` is enqueued only
 *    after it has committed. `addCredential`'s own `llm.probe` enqueue is the one deliberate
 *    exception and is the transaction's LAST statement — see the comment there.
 *  - the owner's pasted key touches memory only long enough to be fingerprinted and sealed. It is
 *    never stored by this process (`llm_credential_secrets` is platform-role-only — migration 0020
 *    REVOKEs `aesa_app` outright), never logged, never audited, and never returned: the ONE path out
 *    is the sealed blob on the `llm.probe` payload, which only the worker can open.
 *  - every write is guarded on what it was read at, so a concurrent owner simply wins and this call
 *    reports `not_found`; every demotion goes through `@aesa/db`'s `demoteCategory` (CLAUDE.md,
 *    Autonomy — the single entry into a mode change), and the notifications it mints are dispatched
 *    after the commit, exactly as `drafts/service.ts`'s `maybeDemote` does.
 *
 * Lock order: nothing here touches `outbound_sends` / `drafts` / `tickets`, so the four-row-kind
 * order is not engaged. The order this file does take is `llm_credentials` → `agent_model_config` →
 * `agent_category_policies` → `notifications`, the same in `setAgentModel` and `removeCredential`.
 */
import { createHash } from 'node:crypto'
import { and, count, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import type pino from 'pino'
import {
  LLM_MAX_CREDENTIALS, PROVIDER_PRESETS, ProbeResult, presetModel,
  type AddCredentialInput, type CredentialHealth, type LlmProviderId, type ProbeResultView, type SetAgentModelInput,
} from '@aesa/contracts'
import { resolvePublic, sealTo, validateOutboundUrl, type Resolver } from '@aesa/crypto'
import {
  agentCategoryPolicies, agentModelConfig, agents, audit, categories, demoteCategory, getOrgBoxPublicKeyOrNull,
  llmCalls, llmCredentials, resolveModelConfig,
  type AuditActor, type OrgTx, type ResolvedModelConfig,
} from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import type { ApiFacade, EnqueueFn } from '../deps.ts'

/** Who is acting — the same shape as `memory/service.ts`'s `MemoryActor`. */
export interface LlmActor {
  userId: string
  actor: AuditActor
  ip?: string | null
  userAgent?: string | null
}

export interface LlmServiceDeps {
  api: ApiFacade
  enqueue: EnqueueFn
  logger: pino.Logger
  /** Test seam for the `custom` endpoint's DNS check; production leaves it unset and uses `node:dns`. */
  resolver?: Resolver
  /** Test seam; production leaves it unset and reads the wall clock per call. */
  now?: () => Date
}

const clock = (deps: LlmServiceDeps): Date => deps.now?.() ?? new Date()
const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

/** The window `listCredentials` reports usage over — the Settings › AI card's "last 30 days" block. */
const USAGE_WINDOW_DAYS = 30

// ---------------------------------------------------------------------------
// the connection list
// ---------------------------------------------------------------------------

export interface CredentialUsage30d {
  calls: number
  errors: number
  costMicros: number
  /** Calls whose model matched no pricing row: their `cost_micros` is 0 because we don't know, not because it was free. */
  costUnknownCalls: number
  lastErrorCode: string | null
}

export interface CredentialView {
  id: string
  provider: LlmProviderId
  label: string
  baseUrl: string | null
  keyFingerprint: string
  healthStatus: CredentialHealth
  lastProbe: ProbeResultView | null
  lastProbedAt: Date | null
  lastError: string | null
  createdAt: Date
  usage30d: CredentialUsage30d
  /** How many `agent_model_config` rows point at this credential (an agent on BYOK owns two: draft and triage). */
  agentsUsing: number
}

const noUsage = (): CredentialUsage30d => ({ calls: 0, errors: 0, costMicros: 0, costUnknownCalls: 0, lastErrorCode: null })

export async function listCredentials(deps: LlmServiceDeps, orgId: string): Promise<{ credentials: CredentialView[] }> {
  const since = new Date(clock(deps).getTime() - USAGE_WINDOW_DAYS * 86_400_000)

  const credentials = await deps.api.withOrg(orgId, async (tx) => {
    const rows = await tx.select().from(llmCredentials)
      .where(eq(llmCredentials.orgId, orgId))
      .orderBy(desc(llmCredentials.createdAt), desc(llmCredentials.id))

    const inWindow = and(
      eq(llmCalls.orgId, orgId), isNotNull(llmCalls.credentialId), gte(llmCalls.createdAt, since),
    )
    const usage = await tx.select({
      credentialId: llmCalls.credentialId,
      calls: count(),
      errors: sql<number>`count(*) filter (where ${llmCalls.errorCode} is not null)`.mapWith(Number),
      costMicros: sql<number>`coalesce(sum(${llmCalls.costMicros}), 0)`.mapWith(Number),
      costUnknownCalls: sql<number>`count(*) filter (where ${llmCalls.costUnknown})`.mapWith(Number),
    }).from(llmCalls).where(inWindow).groupBy(llmCalls.credentialId)
    const usageBy = new Map(usage.map((u) => [u.credentialId, u]))

    // The newest error code per credential — what the card renders under a `degraded`/`dead` badge.
    const lastErrors = await tx
      .selectDistinctOn([llmCalls.credentialId], { credentialId: llmCalls.credentialId, errorCode: llmCalls.errorCode })
      .from(llmCalls)
      .where(and(inWindow, isNotNull(llmCalls.errorCode)))
      .orderBy(llmCalls.credentialId, desc(llmCalls.createdAt))
    const lastErrorBy = new Map(lastErrors.map((e) => [e.credentialId, e.errorCode]))

    const using = await tx.select({ credentialId: agentModelConfig.credentialId, value: count() })
      .from(agentModelConfig)
      .where(and(eq(agentModelConfig.orgId, orgId), isNotNull(agentModelConfig.credentialId)))
      .groupBy(agentModelConfig.credentialId)
    const usingBy = new Map(using.map((u) => [u.credentialId, u.value]))

    return rows.map((row): CredentialView => {
      const u = usageBy.get(row.id)
      return {
        id: row.id, provider: row.provider as LlmProviderId, label: row.label, baseUrl: row.baseUrl,
        keyFingerprint: row.keyFingerprint, healthStatus: row.healthStatus as CredentialHealth,
        lastProbe: parseProbe(row.lastProbe), lastProbedAt: row.lastProbedAt, lastError: row.lastError,
        createdAt: row.createdAt,
        usage30d: u
          ? { calls: u.calls, errors: u.errors, costMicros: u.costMicros, costUnknownCalls: u.costUnknownCalls, lastErrorCode: lastErrorBy.get(row.id) ?? null }
          : noUsage(),
        agentsUsing: usingBy.get(row.id) ?? 0,
      }
    })
  })
  return { credentials }
}

/** `last_probe` is jsonb the api never validated on the way in (the worker wrote it), so it is parsed
 * defensively — a shape this build doesn't recognise renders as "never probed", never as a 500. */
function parseProbe(value: unknown): ProbeResultView | null {
  if (value === null || value === undefined) return null
  const parsed = ProbeResult.safeParse(value)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// add / probe / remove
// ---------------------------------------------------------------------------

export type AddCredentialResult =
  | { ok: true; credentialId: string }
  | { ok: false; code: 'keys_not_provisioned' | 'cap_reached' | 'unsafe_url' }

/** Display only, and never enough to reconstruct: the key's sha256 prefix plus its last four characters. */
function fingerprint(apiKey: string): string {
  return `${createHash('sha256').update(apiKey).digest('hex').slice(0, 8)}…${apiKey.slice(-4)}`
}

export async function addCredential(
  deps: LlmServiceDeps, orgId: string, input: AddCredentialInput, actor: LlmActor,
): Promise<AddCredentialResult> {
  const preset = PROVIDER_PRESETS[input.provider]
  let baseUrl: string | null = null
  if (input.provider === 'custom') {
    // Network BEFORE the transaction (CLAUDE.md, Transactions): https + hostname + public resolution.
    // A preset's base URL is the platform's own constant and is never re-validated here.
    try {
      const url = validateOutboundUrl(input.baseUrl!, { allowNonstandardPort: true })
      await resolvePublic(url.hostname, { resolver: deps.resolver })
      baseUrl = url.href.replace(/\/+$/, '')
    } catch (err) {
      deps.logger.warn({ err: (err as Error).message }, 'llm.addCredential: unsafe base URL')
      return { ok: false, code: 'unsafe_url' }
    }
  }
  const keyFingerprint = fingerprint(input.apiKey)

  return deps.api.withOrg(orgId, async (tx) => {
    const boxPublicKey = await getOrgBoxPublicKeyOrNull(tx)
    if (!boxPublicKey) return { ok: false as const, code: 'keys_not_provisioned' as const }

    const [existing] = await tx.select({ n: count() }).from(llmCredentials).where(eq(llmCredentials.orgId, orgId))
    if ((existing?.n ?? 0) >= LLM_MAX_CREDENTIALS) return { ok: false as const, code: 'cap_reached' as const }

    // libsodium, not network: CPU only, exactly as the mailbox connect route seals its OAuth tokens.
    const sealed = await sealTo(boxPublicKey, Buffer.from(JSON.stringify({ apiKey: input.apiKey }), 'utf8'))

    const [row] = await tx.insert(llmCredentials).values({
      orgId, provider: input.provider, label: input.label, baseUrl, keyFingerprint,
      probeModel: input.probeModel ?? presetModel(input.provider, 'draft'),
      createdBy: actor.actor,
    }).returning({ id: llmCredentials.id })

    await audit(tx, {
      actor: actor.actor, action: 'llm.credential_added', entityType: 'llm_credential', entityId: row!.id,
      detail: {
        provider: input.provider, label: input.label, fingerprint: keyFingerprint,
        baseUrlHost: baseUrl ? new URL(baseUrl).hostname : null, presetBaseUrl: preset.baseUrl,
      },
      ip: actor.ip, userAgent: actor.userAgent,
    })

    // The enqueue is the LAST statement of the transaction, deliberately: the sealed key rides the
    // payload and nowhere else, so an enqueue that THROWS must take the credential row with it
    // rather than leave a row whose secret was never handed to anyone. A null id (the queue is
    // missing) is logged loud and the row simply stays `unknown` — the owner's "Test connection"
    // re-enqueues.
    const jobId = await deps.enqueue(
      JOB_NAMES.llmProbe,
      { orgId, credentialId: row!.id, sealed: sealed.toString('base64'), reason: 'connect' },
      { entityId: row!.id },
    )
    if (jobId === null) deps.logger.error({ credentialId: row!.id }, 'llm.addCredential: llm.probe enqueue returned null')

    return { ok: true as const, credentialId: row!.id }
  })
}

export type ProbeCredentialResult = { ok: true } | { ok: false; code: 'not_found' }

/** "Test connection": a re-probe of a credential whose key is already stored, so NO sealed blob rides
 * this payload — the worker reads `llm_credential_secrets` itself. */
export async function probeCredential(
  deps: LlmServiceDeps, orgId: string, credentialId: string, actor: LlmActor,
): Promise<ProbeCredentialResult> {
  const found = await deps.api.withOrg(orgId, async (tx) => {
    const [row] = await tx.select({ id: llmCredentials.id }).from(llmCredentials)
      .where(and(eq(llmCredentials.orgId, orgId), eq(llmCredentials.id, credentialId)))
    if (!row) return false
    await audit(tx, {
      actor: actor.actor, action: 'llm.credential_probed', entityType: 'llm_credential', entityId: credentialId,
      detail: { credentialId, reason: 'manual' }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return true
  })
  if (!found) return { ok: false, code: 'not_found' }

  const jobId = await deps.enqueue(JOB_NAMES.llmProbe, { orgId, credentialId, reason: 'manual' }, { entityId: credentialId })
  if (jobId === null) {
    deps.logger.warn({ orgId, credentialId }, 'llm.probe enqueue returned no job id; the 6-hourly reprobe sweep will pick it up')
  }
  return { ok: true }
}

export type RemoveCredentialResult = { ok: true; agentsReset: number } | { ok: false; code: 'not_found' }

/**
 * "Disconnect". Every agent pointing at this credential goes back to Managed AI in the same
 * transaction — leaving them on a credential that is about to vanish would silently resolve as
 * managed anyway (`resolveModelConfig`'s `ON DELETE SET NULL` branch) with NO generation bump and NO
 * demotion, which is exactly the case the `model_changed` demotion exists for.
 *
 * The credential row itself is deleted by the api; `llm_credential_secrets` cascades from the FK
 * (referential actions bypass RLS and the REVOKE), so the api never names that table.
 */
export async function removeCredential(
  deps: LlmServiceDeps, orgId: string, credentialId: string, actor: LlmActor,
): Promise<RemoveCredentialResult> {
  const now = clock(deps)
  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    // Locked for the whole read-modify-write: `setAgentModel` takes a SHARE lock on this same row
    // before it points an agent at it, so without this an agent could be moved onto the credential
    // between the config read below and the DELETE — and the FK's ON DELETE SET NULL would then
    // quietly strand that agent on `byok` with no credential, no generation bump and no demotion.
    const [row] = await tx.select({ id: llmCredentials.id, label: llmCredentials.label, provider: llmCredentials.provider })
      .from(llmCredentials)
      .where(and(eq(llmCredentials.orgId, orgId), eq(llmCredentials.id, credentialId)))
      .limit(1)
      .for('update')
    if (!row) return null

    const reset = await resetAgentsToManaged(tx, orgId, credentialId, now, actor)

    await tx.delete(llmCredentials).where(and(eq(llmCredentials.orgId, orgId), eq(llmCredentials.id, credentialId)))
    await audit(tx, {
      actor: actor.actor, action: 'llm.credential_removed', entityType: 'llm_credential', entityId: credentialId,
      detail: { credentialId, provider: row.provider, label: row.label, agentsReset: reset.agentsReset },
      ip: actor.ip, userAgent: actor.userAgent,
    })
    return reset
  })
  if (!outcome) return { ok: false, code: 'not_found' }

  await dispatchNotifications(deps, orgId, outcome.notificationIds)
  return { ok: true, agentsReset: outcome.agentsReset }
}

/**
 * The ONE "this agent is back on Managed AI" routine: managed rows, one generation bump, and the
 * `model_changed` demotion of every category that was on Autopilot. `removeCredential` runs it for
 * every agent on the credential; `setAgentModel` walks the same three steps for the single agent the
 * owner is changing.
 */
async function resetAgentsToManaged(
  tx: OrgTx, orgId: string, credentialId: string, now: Date, actor: LlmActor,
): Promise<{ agentsReset: number; notificationIds: string[] }> {
  const rows = await tx.select({ agentId: agentModelConfig.agentId })
    .from(agentModelConfig)
    .where(and(eq(agentModelConfig.orgId, orgId), eq(agentModelConfig.credentialId, credentialId), isNotNull(agentModelConfig.agentId)))
  const agentIds = [...new Set(rows.map((r) => r.agentId!))]

  const notificationIds: string[] = []
  for (const agentId of agentIds) {
    const owned = await tx.select({ modelGeneration: agentModelConfig.modelGeneration })
      .from(agentModelConfig)
      .where(and(eq(agentModelConfig.orgId, orgId), eq(agentModelConfig.agentId, agentId)))
    // Both roles are written in lockstep by `setAgentModel`, so the max is what they already share.
    const generation = Math.max(0, ...owned.map((r) => r.modelGeneration)) + 1

    await tx.update(agentModelConfig)
      .set({ mode: 'managed', credentialId: null, model: null, modelGeneration: generation, modelGenerationAt: now, updatedAt: now })
      .where(and(
        eq(agentModelConfig.orgId, orgId), eq(agentModelConfig.agentId, agentId),
        eq(agentModelConfig.credentialId, credentialId),
      ))

    await audit(tx, {
      actor: actor.actor, action: 'agent.model_changed', entityType: 'agent', entityId: agentId,
      detail: { mode: 'managed', provider: 'anthropic', draftModel: null, triageModel: null, generation, reason: 'credential_removed' },
      ip: actor.ip, userAgent: actor.userAgent,
    })

    const demoted = await demoteAutoCategories(tx, { orgId, agentId, now, actor })
    notificationIds.push(...demoted.notificationIds)
  }
  // The workspace-default row (`agent_id IS NULL`) is admitted by the schema but unwritten in v1.
  // If one ever sat on this credential, the FK's ON DELETE SET NULL alone would leave it `byok` with
  // no credential; there is no agent to bump a generation for or to demote, so it just goes managed.
  await tx.update(agentModelConfig)
    .set({ mode: 'managed', credentialId: null, model: null, updatedAt: now })
    .where(and(
      eq(agentModelConfig.orgId, orgId), eq(agentModelConfig.credentialId, credentialId),
      isNull(agentModelConfig.agentId),
    ))

  return { agentsReset: agentIds.length, notificationIds }
}

// ---------------------------------------------------------------------------
// the per-agent model choice
// ---------------------------------------------------------------------------

export type SetAgentModelResult =
  | { ok: true; generationBumped: boolean; demoted: number }
  | { ok: false; code: 'not_found' | 'credential_not_found' | 'credential_dead' }

/** What the Model card reads: the agent's two roles, resolved through the SAME reader the worker calls. */
export async function getAgentModel(
  deps: LlmServiceDeps, orgId: string, agentId: string,
): Promise<{ draft: ResolvedModelConfig; triage: ResolvedModelConfig } | null> {
  return deps.api.withOrg(orgId, async (tx) => {
    const [agent] = await tx.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    if (!agent) return null
    return { draft: await resolveModelConfig(tx, agentId, 'draft'), triage: await resolveModelConfig(tx, agentId, 'triage') }
  })
}

/**
 * The Model card's Save. One transaction: read the agent (a cross-org id is `not_found` by
 * construction — RLS hides the row), read the credential when the choice is BYOK, write BOTH role
 * rows, and — only when the DRAFT row's (mode, credential, model) actually changed — bump the model
 * generation and demote every category that was on Autopilot.
 *
 * Why the generation and the demotion hang off the draft row alone: the draft model is what writes
 * the replies Autopilot sends unattended, and `stats.rollup` counts a category's evidence from the
 * agent's current generation onward. An effort change, or a triage-only change, is not a new writer.
 */
export async function setAgentModel(
  deps: LlmServiceDeps, orgId: string, input: SetAgentModelInput, actor: LlmActor,
): Promise<SetAgentModelResult> {
  const now = clock(deps)

  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const [agent] = await tx.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, input.agentId)))
    if (!agent) return { ok: false as const, code: 'not_found' as const }

    let provider: LlmProviderId = 'anthropic'
    let credentialId: string | null = null
    let draftModel: string | null = null
    let triageModel: string | null = null

    if (input.mode === 'byok') {
      const [credential] = await tx.select({
        id: llmCredentials.id, provider: llmCredentials.provider,
        healthStatus: llmCredentials.healthStatus, probeModel: llmCredentials.probeModel,
      }).from(llmCredentials)
        .where(and(eq(llmCredentials.orgId, orgId), eq(llmCredentials.id, input.credentialId!)))
        .limit(1)
        // Pairs with `removeCredential`'s FOR UPDATE on the same row: a disconnect running
        // concurrently either waits for this to commit (and then sees the rows it must reset), or
        // wins and this re-read finds nothing — `credential_not_found`, never a half-moved agent.
        .for('share')
      if (!credential) return { ok: false as const, code: 'credential_not_found' as const }
      // A key the probe found rejected outright cannot be chosen: it would fail every call the
      // moment it was saved, and (without `fallbackToManaged`) strand the agent entirely.
      if (credential.healthStatus === 'dead') return { ok: false as const, code: 'credential_dead' as const }

      provider = credential.provider as LlmProviderId
      credentialId = credential.id
      draftModel = input.draftModel ?? presetModel(provider, 'draft') ?? credential.probeModel
      triageModel = input.triageModel ?? presetModel(provider, 'triage') ?? draftModel
    }
    // Managed AI's two models are the platform's own constants (`MANAGED_MODELS`), so the rows keep
    // a null model and `resolveModelConfig` fills the role's default in.

    const [existing] = await tx.select({
      mode: agentModelConfig.mode, credentialId: agentModelConfig.credentialId,
      model: agentModelConfig.model, modelGeneration: agentModelConfig.modelGeneration,
      modelGenerationAt: agentModelConfig.modelGenerationAt,
    }).from(agentModelConfig)
      .where(and(
        eq(agentModelConfig.orgId, orgId), eq(agentModelConfig.agentId, input.agentId),
        eq(agentModelConfig.role, 'draft'),
      ))
      .limit(1)
      .for('update')

    const changed = !existing
      || existing.mode !== input.mode
      || existing.credentialId !== credentialId
      || existing.model !== draftModel
    const modelGeneration = changed ? (existing?.modelGeneration ?? 0) + 1 : existing.modelGeneration
    const modelGenerationAt = changed ? now : existing!.modelGenerationAt

    const shared = {
      orgId, agentId: input.agentId, mode: input.mode, credentialId,
      effort: input.effort, fallbackToManaged: input.fallbackToManaged,
      modelGeneration, modelGenerationAt,
    }
    for (const [role, model] of [['draft', draftModel], ['triage', triageModel]] as const) {
      await tx.insert(agentModelConfig).values({ ...shared, role, model })
        .onConflictDoUpdate({
          target: [agentModelConfig.orgId, agentModelConfig.agentId, agentModelConfig.role],
          set: {
            mode: input.mode, credentialId, model, effort: input.effort, fallbackToManaged: input.fallbackToManaged,
            modelGeneration, modelGenerationAt, updatedAt: now,
          },
        })
    }

    const demoted = changed
      ? await demoteAutoCategories(tx, { orgId, agentId: input.agentId, now, actor })
      : { demoted: 0, notificationIds: [] as string[] }

    await audit(tx, {
      actor: actor.actor, action: 'agent.model_changed', entityType: 'agent', entityId: input.agentId,
      detail: {
        mode: input.mode, provider, draftModel, triageModel, effort: input.effort,
        fallbackToManaged: input.fallbackToManaged, generation: modelGeneration,
      },
      ip: actor.ip, userAgent: actor.userAgent,
    })

    return { ok: true as const, generationBumped: changed, demoted: demoted.demoted, notificationIds: demoted.notificationIds }
  })

  if (!outcome.ok) return outcome
  await dispatchNotifications(deps, orgId, outcome.notificationIds)
  return { ok: true, generationBumped: outcome.generationBumped, demoted: outcome.demoted }
}

/**
 * A new model has not earned the old model's autonomy (spec §Risks): every category this agent had on
 * Autopilot goes back to review with reason `model_changed`. Through `demoteCategory` alone — the
 * single entry into a mode change, which owns the guarded `auto → review` write, the audit row and
 * the deduped notification.
 */
async function demoteAutoCategories(
  tx: OrgTx, p: { orgId: string; agentId: string; now: Date; actor: LlmActor },
): Promise<{ demoted: number; notificationIds: string[] }> {
  const autos = await tx.select({ categoryId: agentCategoryPolicies.categoryId, label: categories.label })
    .from(agentCategoryPolicies)
    .innerJoin(categories, eq(categories.id, agentCategoryPolicies.categoryId))
    .where(and(
      eq(agentCategoryPolicies.orgId, p.orgId), eq(agentCategoryPolicies.agentId, p.agentId),
      eq(agentCategoryPolicies.mode, 'auto'),
    ))

  const day = utcDay(p.now)
  const notificationIds: string[] = []
  let demoted = 0
  for (const category of autos) {
    const res = await demoteCategory(tx, {
      orgId: p.orgId, agentId: p.agentId, categoryId: category.categoryId, categoryLabel: category.label,
      reason: 'model_changed', now: p.now, day, actor: p.actor.actor,
    })
    if (res.demoted) demoted += 1
    if (res.notificationId) notificationIds.push(res.notificationId)
  }
  return { demoted, notificationIds }
}

/** Post-commit, exactly as `drafts/service.ts` does it: a collapsed or missing job is a warn, never a
 * failure — the daily digest still carries the demotion. */
async function dispatchNotifications(deps: LlmServiceDeps, orgId: string, notificationIds: string[]): Promise<void> {
  for (const notificationId of notificationIds) {
    const jobId = await deps.enqueue(JOB_NAMES.notifyDispatch, { orgId, notificationId }, { entityId: notificationId })
    if (jobId === null) deps.logger.warn({ orgId, notificationId }, 'notify.dispatch enqueue returned no job id; the digest will collapse it')
  }
}
