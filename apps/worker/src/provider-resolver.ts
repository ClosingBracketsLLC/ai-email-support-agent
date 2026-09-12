/**
 * The worker's ONE way to get a model provider for a call (Phase 6). `resolve` reads the agent's
 * config through `resolveModelConfig` (the same reader the api uses), and:
 *  - managed → the process-wide managed provider (built once by agent-role.ts);
 *  - byok → the credential's key, opened under the org DEK (or straight out of the sealed box if the
 *    probe has not re-wrapped it yet), composed by `createByokProvider` and CACHED per credential —
 *    a key is decrypted once per process, not once per draft.
 *
 * The cache is keyed on the credential's FRESHNESS, `${credentialId}:${lastProbedAt}`, not on its id:
 * a cached provider holds a decrypted key, a base URL and the probe's `structuredOverride` frozen at
 * build time, and `invalidate()` only ever reaches the replica that called it — the replica that runs
 * `llm.probe` is usually not the one that drafts. Keying on a value `resolve` re-reads anyway means a
 * probe on ANY replica retires every replica's entry, and the `PROVIDER_CACHE_TTL_MS` ceiling bounds the
 * never-probed case (a key rotated in place behind an id that never moves). `invalidate(credentialId)`
 * stays, as the same-process fast path `llm.probe` calls after a store/re-wrap; it is a belt on top of
 * the key, not the guarantee.
 *
 * Every failure to produce a provider is a typed refusal the job lands as `provider_unavailable`,
 * never a throw: a dead credential, a missing ring (dev only — production refuses to boot),
 * a missing secret row (the store step of `llm.probe` has not run yet). No transaction here spans
 * network I/O — `resolve` only reads; the caller calls the model afterwards.
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import type pino from 'pino'
import { PROVIDER_PRESETS, type LlmProviderId, type ModelConfigRole } from '@aesa/contracts'
import { createPinnedFetch, decrypt, Secret, type KekRing } from '@aesa/crypto'
import {
  audit, llmCredentials, llmCredentialSecrets, loadOrgDek, managedConfig, openSealedForOrg, resolveModelConfig, withOrg,
  withPlatform, type AuditActor, type Db, type OrgTx, type ResolvedModelConfig,
} from '@aesa/db'
import {
  BYOK_MAX_CONCURRENT_PER_CREDENTIAL, createByokProvider, createLlmLimiter, scrubSecrets, type LlmProvider,
  type MeterSink, type ModelPricing,
} from '@aesa/llm'

export type ProviderUnavailableReason = 'credential_dead' | 'no_kek' | 'no_secret' | 'no_managed_key'

/**
 * Provider-failure policy, shared by every job that calls a model (`ticket.draft`, `ticket.triage`).
 * These are the `LlmError` codes an agent's opt-in `fallback_to_managed` may cover with ONE managed
 * retry. Deliberately NOT `permanent` / `context_too_long` / `content_filter`: those say something
 * about the REQUEST, and re-sending it to another provider would only spend the platform's allowance
 * to fail the same way. `auth` is here because a dead tenant key is exactly what the opt-in is for.
 */
export const FALLBACK_CODES = ['auth', 'rate_limit', 'transient'] as const

/**
 * Which cache-write rate a call's cost is priced at. It must match the TTL the metering wrapper that
 * actually served the call was built with: `createManagedProvider` uses `'1h'` (the Anthropic
 * adapter puts the static prefix on the 1-hour breakpoint), `createByokProvider` uses `'5m'`. Takes
 * the mode of the provider that SERVED the call — a managed fallback on a byok agent is `'managed'`.
 */
export function cacheTtlFor(mode: 'managed' | 'byok'): '5m' | '1h' {
  return mode === 'byok' ? '5m' : '1h'
}

export type ResolvedProvider =
  | { ok: true; provider: LlmProvider; fallback: LlmProvider | null; config: ResolvedModelConfig }
  | { ok: false; reason: ProviderUnavailableReason; config: ResolvedModelConfig }

export interface ProviderResolver {
  resolve(orgId: string, agentId: string | null, role: ModelConfigRole): Promise<ResolvedProvider>
  /** Drops one credential's cached provider IN THIS PROCESS. `llm.probe` calls it after a store or a
   *  re-wrap; nothing else does. It is a fast path, not the invalidation guarantee — the cache key
   *  carries the credential's `lastProbedAt`, which is what retires other replicas' entries. */
  invalidate(credentialId: string): void
}

export interface ProviderResolverDeps {
  db: Db
  /** Null only outside production (`loadConfig` refuses an `agent` replica without a ring there). */
  ring: KekRing | null
  /** Null when the platform itself has no `ANTHROPIC_API_KEY` — then managed configs cannot resolve. */
  managed: LlmProvider | null
  sink: MeterSink
  pricing?: ModelPricing[]
  /** Test seam. Production leaves it unset and every BYOK adapter gets its own SSRF-pinned transport. */
  fetchFn?: typeof fetch
  /** Test seam for the cache TTL's clock; production leaves it unset and reads the wall clock. */
  now?: () => Date
  logger: pino.Logger
}

/** The AAD that binds a wrapped provider key to ONE org and ONE credential. `llm.probe`'s re-wrap
 *  and `openCredentialKey`'s decrypt must spell it identically, so it is spelled exactly once. */
export function secretAad(orgId: string, credentialId: string): string {
  return `${orgId}:llm_credential_secrets:${credentialId}`
}

/** A cached provider is a decrypted key held in memory; 256 credentials is far more than any one
 *  replica drafts for, and evicting the oldest keeps that ceiling hard. */
const PROVIDER_CACHE_MAX = 256

/** How long one composed provider may live before it is rebuilt from the database regardless of
 *  freshness. The key already retires an entry whenever a probe lands anywhere; this bounds the
 *  case where nothing probes at all — a credential whose key was replaced behind the same id would
 *  otherwise be called with the revoked one until 256 other credentials pushed it out. */
export const PROVIDER_CACHE_TTL_MS = 15 * 60_000

export interface OpenedCredentialKey {
  apiKey: Secret
  /** `sealed` means `llm.probe` has not re-wrapped this row yet — the probe job acts on that. */
  encryption: 'sealed' | 'dek'
  /** The EXACT bytes this key was opened from. `llm.probe`'s re-wrap guards its UPDATE on them, so a
   *  key the owner rotated while the probe was in flight can never be overwritten by the old one —
   *  `encryption` alone identifies the wrapping, not the blob, and would not catch sealed → sealed. */
  ciphertext: Buffer
}

/**
 * Reads one credential's secret row (platform role — `llm_credential_secrets` REVOKEs `aesa_app`
 * entirely) and opens it under the org's own keys: the sealed box the api wrote, or the DEK the
 * probe re-wrapped it under. No network in either transaction. Null means there is no row at all.
 */
export async function openCredentialKey(
  deps: { db: Db; ring: KekRing },
  orgId: string,
  credentialId: string,
): Promise<OpenedCredentialKey | null> {
  const [row] = await withPlatform(deps.db, `job:llm.resolve:${credentialId}`, (tx) =>
    tx
      .select()
      .from(llmCredentialSecrets)
      .where(and(eq(llmCredentialSecrets.credentialId, credentialId), eq(llmCredentialSecrets.orgId, orgId))))
  if (!row) return null

  const plaintext = await withOrg(deps.db, orgId, async (tx) =>
    row.encryption === 'sealed'
      ? openSealedForOrg(tx, deps.ring, row.keyCiphertext)
      : decrypt((await loadOrgDek(tx, deps.ring)).dek, row.keyCiphertext, secretAad(orgId, credentialId)))
  return {
    apiKey: new Secret(readApiKey(plaintext)),
    encryption: row.encryption as 'sealed' | 'dek',
    ciphertext: row.keyCiphertext,
  }
}

/**
 * `JSON.parse` quotes the first ~10 characters of its input in the `SyntaxError` it throws — which
 * here is the API key itself, and that error would reach the job's failure output and the worker
 * log. So the parse is wrapped and BOTH failure modes (unparseable, or parsed to something without
 * a string `apiKey`) raise the same plaintext-free message.
 */
function readApiKey(plaintext: Buffer): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new Error('llm credential secret is not readable')
  }
  const apiKey = (parsed as { apiKey?: unknown } | null)?.apiKey
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('llm credential secret is not readable')
  return apiKey
}

export function createProviderResolver(deps: ProviderResolverDeps): ProviderResolver {
  // ONE limiter for the process, keyed `byok:${orgId}:${credentialId}` by `createByokProvider`, so a
  // rebuilt provider for the same credential still draws from that credential's own two slots.
  const limiter = createLlmLimiter({ maxConcurrentPerKey: BYOK_MAX_CONCURRENT_PER_CREDENTIAL })
  /** Keyed on `${credentialId}:${lastProbedAt}` — see the file header. */
  const cache = new Map<string, { provider: LlmProvider; builtAt: number }>()
  /** The freshness key each credential currently occupies, so a rebuild (or `invalidate`) can drop
   *  the entry it replaces instead of leaving a stale key holding a decrypted secret. */
  const keyByCredential = new Map<string, string>()
  let warnedNoManagedFallback = false

  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime()

  function freshnessKey(credentialId: string, config: ResolvedModelConfig): string {
    return `${credentialId}:${config.credential?.lastProbedAt?.getTime() ?? 0}`
  }

  function cacheProvider(credentialId: string, key: string, provider: LlmProvider): void {
    const previous = keyByCredential.get(credentialId)
    if (previous !== undefined && previous !== key) cache.delete(previous)
    if (cache.size >= PROVIDER_CACHE_MAX) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { provider, builtAt: nowMs() })
    keyByCredential.set(credentialId, key)
  }

  function fallbackFor(config: ResolvedModelConfig): LlmProvider | null {
    if (!config.fallbackToManaged) return null
    if (deps.managed) return deps.managed
    if (!warnedNoManagedFallback) {
      warnedNoManagedFallback = true
      deps.logger.warn('fallbackToManaged is set on at least one agent but this platform has no managed key; BYOK failures will not fall back')
    }
    return null
  }

  return {
    async resolve(orgId: string, agentId: string | null, role: ModelConfigRole): Promise<ResolvedProvider> {
      const config = await withOrg(deps.db, orgId, (tx) => resolveModelConfig(tx, agentId, role))

      if (config.mode === 'managed') {
        if (!deps.managed) return { ok: false, reason: 'no_managed_key', config }
        return { ok: true, provider: deps.managed, fallback: null, config }
      }

      // Checked BEFORE the secret is read: a dead credential must report itself as dead, not as a
      // key we could not open, and a key nobody is going to use must not be decrypted at all.
      if (config.credential?.healthStatus === 'dead') return { ok: false, reason: 'credential_dead', config }
      if (!deps.ring) return { ok: false, reason: 'no_kek', config }

      const credentialId = config.credentialId
      // `resolveModelConfig` only ever returns mode `byok` alongside both of these; the guard keeps
      // that invariant honest rather than asserting it away.
      if (!credentialId || !config.credential) return { ok: false, reason: 'no_secret', config }

      const fallback = fallbackFor(config)
      const key = freshnessKey(credentialId, config)
      const cached = cache.get(key)
      if (cached) {
        if (nowMs() - cached.builtAt < PROVIDER_CACHE_TTL_MS) return { ok: true, provider: cached.provider, fallback, config }
        cache.delete(key)
      }

      const opened = await openCredentialKey({ db: deps.db, ring: deps.ring }, orgId, credentialId)
      if (!opened) return { ok: false, reason: 'no_secret', config }

      const provider = createByokProvider({
        provider: config.provider,
        apiKey: opened.apiKey,
        baseUrl: baseUrlFor(config.provider, config.credential.baseUrl),
        orgId,
        credentialId,
        sink: deps.sink,
        limiter,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : { fetchFn: createPinnedFetch({ allowNonstandardPort: true, timeoutMs: 120_000 }) }),
        ...(deps.pricing ? { pricing: deps.pricing } : {}),
        structuredOverride: config.credential.lastProbe?.structured ?? null,
      })
      cacheProvider(credentialId, key, provider)
      return { ok: true, provider, fallback, config }
    },

    invalidate(credentialId: string): void {
      const key = keyByCredential.get(credentialId)
      if (key !== undefined) cache.delete(key)
      keyByCredential.delete(credentialId)
    },
  }
}

/** What `llm_credentials.last_error` is allowed to hold: scrubbed of anything key-shaped, and short. */
export const CREDENTIAL_ERROR_MAX_CHARS = 200

/**
 * The ONE way a credential reaches `dead`. Guarded on `health_status <> 'dead'`, so a concurrent
 * probe (or Task 6's draft-time refusal) that got there first simply wins and this returns false —
 * and the audit row is written only by the call that actually flipped it, never by the loser.
 * Takes an `OrgTx`: the caller owns the transaction, because the health write usually rides along
 * with the probe's own `last_probe` update.
 */
export async function markCredentialDead(
  tx: OrgTx, orgId: string, credentialId: string, error: string, actor: AuditActor,
): Promise<boolean> {
  const lastError = scrubSecrets(error).slice(0, CREDENTIAL_ERROR_MAX_CHARS)
  const flipped = await tx
    .update(llmCredentials)
    .set({
      healthStatus: 'dead',
      lastError,
      consecutiveFailures: sql`${llmCredentials.consecutiveFailures} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(llmCredentials.orgId, orgId), eq(llmCredentials.id, credentialId), ne(llmCredentials.healthStatus, 'dead')))
    .returning({ id: llmCredentials.id })
  if (flipped.length === 0) return false
  await audit(tx, { actor, action: 'llm.credential_dead', entityType: 'llm_credential', entityId: credentialId, detail: { lastError } })
  return true
}

/** A `custom` credential always carries its own validated https URL; a preset never does. */
function baseUrlFor(provider: LlmProviderId, stored: string | null): string {
  const url = stored ?? PROVIDER_PRESETS[provider].baseUrl
  if (!url) throw new Error(`llm credential for provider ${provider} has no base URL`)
  return url
}

/** Tests only: one fixed provider for every org, agent and role, with an optional fallback beside it. */
export function staticResolver(
  provider: LlmProvider, config: Partial<ResolvedModelConfig> = {}, fallback: LlmProvider | null = null,
): ProviderResolver {
  return {
    async resolve(_orgId, _agentId, role): Promise<ResolvedProvider> {
      return { ok: true, provider, fallback, config: { ...managedConfig(role), ...config } }
    },
    invalidate(): void {},
  }
}

/** Tests only: a resolver that refuses every call, for driving a job's `provider_unavailable` landing. */
export function staticRefusal(reason: ProviderUnavailableReason, config: Partial<ResolvedModelConfig> = {}): ProviderResolver {
  return {
    async resolve(_orgId, _agentId, role): Promise<ResolvedProvider> {
      return { ok: false, reason, config: { ...managedConfig(role), ...config } }
    },
    invalidate(): void {},
  }
}
