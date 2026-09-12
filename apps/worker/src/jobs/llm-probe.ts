/**
 * `llm.probe` — store, probe, land the health, re-wrap. One job, four steps, in that order:
 *
 *  1. STORE (a `connect` payload only): the api sealed the owner's key to the org's box public key
 *     and put the base64 blob on this job's payload — `mailbox.store-credentials`'s shape exactly,
 *     for the same reason (`llm_credential_secrets` is platform-role-only; the api has no privilege
 *     on it at all). delete+insert, so a re-connect is idempotent by construction.
 *  2. OPEN the key (no network): the sealed box, or the DEK if a previous probe already re-wrapped it.
 *  3. PROBE (network, outside every transaction) through the RAW metered adapter — `probeProvider`
 *     drives the structured rungs itself, so the ladder must NOT be in the way.
 *  4. LAND the verdict in ONE org transaction, then re-wrap a still-sealed secret under the org DEK.
 *
 * Spec §Capabilities are probed, not assumed: `last_probe.structured` is what `resolveModelConfig`
 * turns into a quality tier and what the resolver hands `createByokProvider` as its
 * `structuredOverride`, so every landing invalidates the resolver's cached provider for this
 * credential — a provider built on the previous verdict must never outlive it.
 */
import { and, eq, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { presetModel, PROVIDER_PRESETS, type LlmProviderId, type ProbeResultView } from '@aesa/contracts'
import { createPinnedFetch, encrypt, type KekRing } from '@aesa/crypto'
import {
  audit, llmCredentials, llmCredentialSecrets, loadOrgDek, withOrg, withPlatform, type Db,
} from '@aesa/db'
import {
  BYOK_MAX_CONCURRENT_PER_CREDENTIAL, createByokProvider, createLlmLimiter, probeProvider, scrubSecrets,
  type MeterSink, type ModelPricing,
} from '@aesa/llm'
import { defineJob, enqueue, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { notifyProviderHealth } from '../provider-health-notify.ts'
import {
  CREDENTIAL_ERROR_MAX_CHARS, markCredentialDead, openCredentialKey, secretAad, type ProviderResolver,
} from '../provider-resolver.ts'

export const LlmProbePayload = z.object({
  orgId: z.string(),
  credentialId: z.string(),
  /** base64 sealed `{ apiKey }` — present on a `connect` only; a re-probe reads the stored row. */
  sealed: z.string().optional(),
  reason: z.enum(['connect', 'manual', 'scheduled']),
})
export type LlmProbePayload = z.infer<typeof LlmProbePayload>

export const llmProbeJob: RegisteredJobDefinition<LlmProbePayload> = defineJob({
  name: JOB_NAMES.llmProbe,
  schema: LlmProbePayload,
  handler: async () => {
    throw new Error('llm.probe: this definition has no bound deps — register it through registerLlmProbe(boss, deps)')
  },
})

/** How stale a credential's health may get before `llm.reprobe-sweep` re-checks it. */
export const REPROBE_INTERVAL_HOURS = 6

/** Consecutive non-auth failures that flip a credential to `degraded`. One bad minute is not a verdict. */
export const DEGRADED_AFTER_FAILURES = 2

const ACTOR = `system:${JOB_NAMES.llmProbe}` as const

/** What a probe leaves the credential at. `skipped` means nothing was written at all. */
export type ProbeOutcome = 'unknown' | 'healthy' | 'degraded' | 'dead' | 'skipped'

export interface LlmProbeDeps {
  db: Db
  ring: KekRing
  sink: MeterSink
  logger: pino.Logger
  /** `notify.dispatch`'s enqueue — the `provider_health` page when a key is rejected outright. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  /** The process-wide resolver, for `invalidate` alone: this job never resolves a provider. */
  resolver: ProviderResolver
  pricing?: ModelPricing[]
  /** Test seam. Production leaves it unset and the adapter builds its own SSRF-pinned transport. */
  fetchFn?: typeof fetch
  now?: () => Date
}

export async function runLlmProbe(deps: LlmProbeDeps, p: LlmProbePayload, signal: AbortSignal): Promise<ProbeOutcome> {
  const now = deps.now?.() ?? new Date()

  // 1. Store the sealed blob (connect only). delete+insert: correct for a first connect AND a
  //    re-key, and the platform role is the only one with any privilege on this table.
  if (p.sealed) {
    const sealed = Buffer.from(p.sealed, 'base64')
    await withPlatform(deps.db, `job:llm.probe:store:${p.credentialId}`, async (tx) => {
      await tx
        .delete(llmCredentialSecrets)
        .where(and(eq(llmCredentialSecrets.credentialId, p.credentialId), eq(llmCredentialSecrets.orgId, p.orgId)))
      await tx.insert(llmCredentialSecrets).values({
        credentialId: p.credentialId, orgId: p.orgId, keyCiphertext: sealed, encryption: 'sealed',
      })
    })
    deps.resolver.invalidate(p.credentialId)
  }

  const [cred] = await withOrg(deps.db, p.orgId, (tx) =>
    tx.select().from(llmCredentials).where(eq(llmCredentials.id, p.credentialId)))
  // Deleted between the enqueue and now (`llm_credential_secrets` cascades, so the store above is
  // gone too, if it ever landed): nothing to probe, and nothing to report.
  if (!cred) return 'skipped'

  // 2. Open the key. No network in either transaction.
  const opened = await openCredentialKey({ db: deps.db, ring: deps.ring }, p.orgId, p.credentialId)
  if (!opened) {
    deps.logger.warn({ credentialId: p.credentialId }, 'llm.probe: no secret row')
    return 'skipped'
  }

  const provider = cred.provider as LlmProviderId
  const model = cred.probeModel ?? presetModel(provider, 'draft')
  // Impossible after the api's `addCredential` (it requires `probeModel` for `custom` and fills the
  // preset's own otherwise) — a row from before that, or a hand-edited one, simply is not probed.
  if (!model) {
    deps.logger.warn({ credentialId: p.credentialId }, 'llm.probe: no probe model')
    return 'skipped'
  }
  // A preset always has one and the api validates a `custom` credential's own, so a row with
  // neither is corrupt — and an EMPTY base URL is not a harmless default: the OpenAI SDK would
  // quietly send this tenant's key to `api.openai.com` instead of the endpoint they configured.
  const baseUrl = cred.baseUrl ?? PROVIDER_PRESETS[provider].baseUrl
  if (!baseUrl) {
    deps.logger.warn({ credentialId: p.credentialId }, 'llm.probe: no base URL')
    return 'skipped'
  }

  // 3. The probe itself — the RAW metered adapter, so `probeProvider` drives the rungs rather than
  //    the ladder silently climbing them and reporting whichever one happened to work.
  const raw = createByokProvider({
    provider,
    apiKey: opened.apiKey,
    baseUrl,
    orgId: p.orgId,
    credentialId: p.credentialId,
    sink: deps.sink,
    limiter: createLlmLimiter({ maxConcurrentPerKey: BYOK_MAX_CONCURRENT_PER_CREDENTIAL }),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : { fetchFn: createPinnedFetch({ allowNonstandardPort: true, timeoutMs: 120_000 }) }),
    ...(deps.pricing ? { pricing: deps.pricing } : {}),
    // A probe asks the endpoint what it can do; last time's answer must not colour this one's.
    structuredOverride: null,
    raw: true,
  })
  const result = await probeProvider(
    raw, model,
    { orgId: p.orgId, mode: 'byok', credentialId: p.credentialId, idempotencyPrefix: `probe:${p.credentialId}:${now.toISOString()}` },
    signal,
  )

  // 4. Land it. Health per probe is monotone (this run's verdict simply replaces the last one), so
  //    the write is guarded on identity alone — there is no read-value to guard against.
  const landed = await landVerdict(deps, p, cred, result, now)

  // The `provider_health` page is enqueued OUTSIDE the transaction above: no network inside a
  // `withOrg` tx, ever. `markCredentialDead`'s own guard is what makes this at-most-once per flip.
  if (landed.flippedDead) {
    await notifyProviderHealth(
      { db: deps.db, enqueueNotify: deps.enqueueNotify }, p.orgId, p.credentialId, cred.label, provider, now,
    )
  }

  // The api seals a key it cannot open again; this worker can, so the long-lived shape is the DEK
  // one — a sealed row costs a box-open on every cold resolve and keeps a second format alive.
  if (opened.encryption === 'sealed') {
    const { version, dek } = await withOrg(deps.db, p.orgId, (tx) => loadOrgDek(tx, deps.ring))
    const ciphertext = encrypt(
      dek, Buffer.from(JSON.stringify({ apiKey: opened.apiKey.expose() }), 'utf8'), secretAad(p.orgId, p.credentialId),
    )
    await withPlatform(deps.db, `job:llm.probe:rewrap:${p.credentialId}`, (tx) =>
      tx
        .update(llmCredentialSecrets)
        .set({ keyCiphertext: ciphertext, encryption: 'dek', dataKeyVersion: version, updatedAt: sql`now()` })
        // Guarded on the encryption it was READ at: a concurrent probe that re-wrapped first wins.
        .where(and(
          eq(llmCredentialSecrets.credentialId, p.credentialId),
          eq(llmCredentialSecrets.orgId, p.orgId),
          eq(llmCredentialSecrets.encryption, 'sealed'),
        )))
  }

  // Unconditional: `last_probe.structured` is the resolver's `structuredOverride`, so ANY landing —
  // healthy, degraded or dead — makes a cached provider for this credential stale.
  deps.resolver.invalidate(p.credentialId)
  return landed.health
}

type CredentialRow = typeof llmCredentials.$inferSelect

/** The ONE org transaction the probe's verdict is written in: health, counters, `last_probe`, audit. */
async function landVerdict(
  deps: LlmProbeDeps, p: LlmProbePayload, cred: CredentialRow, result: ProbeResultView, now: Date,
): Promise<{ health: ProbeOutcome; flippedDead: boolean }> {
  return withOrg(deps.db, p.orgId, async (tx) => {
    const where = and(eq(llmCredentials.orgId, p.orgId), eq(llmCredentials.id, p.credentialId))
    const set = (patch: Partial<typeof llmCredentials.$inferInsert>) =>
      tx.update(llmCredentials).set({ lastProbe: result, lastProbedAt: now, updatedAt: sql`now()`, ...patch }).where(where)

    let health: ProbeOutcome
    let flippedDead = false
    if (result.ok) {
      await set({ healthStatus: 'healthy', consecutiveFailures: 0, lastError: null })
      health = 'healthy'
    } else if (result.error?.code === 'auth') {
      // The key itself was rejected: no number of retries fixes that, so it goes dead on the first one.
      await set({})
      flippedDead = await markCredentialDead(tx, p.orgId, p.credentialId, result.error.message, ACTOR)
      health = 'dead'
    } else {
      const failures = cred.consecutiveFailures + 1
      // One bad minute keeps whatever health the credential already had; a pattern is a verdict.
      const next = failures >= DEGRADED_AFTER_FAILURES ? 'degraded' : cred.healthStatus
      await set({
        healthStatus: next,
        consecutiveFailures: failures,
        lastError: scrubSecrets(result.error?.message ?? 'probe failed').slice(0, CREDENTIAL_ERROR_MAX_CHARS),
      })
      health = next as ProbeOutcome
    }

    await audit(tx, {
      actor: ACTOR,
      action: 'llm.credential_probed',
      entityType: 'llm_credential',
      entityId: p.credentialId,
      detail: { reason: p.reason, ok: result.ok, structured: result.structured, health },
    })
    return { health, flippedDead }
  })
}

export async function registerLlmProbe(boss: PgBoss, deps: LlmProbeDeps): Promise<void> {
  await registerJob(boss, {
    ...llmProbeJob,
    handler: async (ctx) => { await runLlmProbe(deps, ctx.data, ctx.signal) },
  })
}

/** A `short` queue keyed on the credential: a manual re-probe that arrives while a scheduled one is
 *  still `created` collapses into it, which is exactly right — they would ask the same question. */
export async function enqueueLlmProbe(
  boss: PgBoss, orgId: string, credentialId: string, opts: { sealed?: string; reason: LlmProbePayload['reason'] },
): Promise<string | null> {
  return enqueue(
    boss, llmProbeJob,
    { orgId, credentialId, reason: opts.reason, ...(opts.sealed === undefined ? {} : { sealed: opts.sealed }) },
    { entityId: credentialId },
  )
}
