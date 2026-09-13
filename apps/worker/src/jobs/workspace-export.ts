/**
 * `workspace.export` (spec §Retention & deletion) — one workspace's data as ONE newline-delimited
 * JSON object in the bucket, for the owner to download through a presigned GET the api issues.
 *
 * **Every column in the bundle is NAMED.** The per-table allowlists below are explicit maps, never
 * "the table minus a few columns": a column added to a table next year must be added here on purpose
 * to leave the building, and a bytea, a hash or a salt can never arrive by default. What that keeps
 * out, concretely: `llm_credential_secrets` and `mailbox_credentials` are not listed at all (they are
 * platform-role-only and hold the tenant's keys), `oauth_flows.pkce_ciphertext` is not listed,
 * `workspaces.box_public_key`/`customer_hash_salt`, `agents.verification_code_hash`,
 * `resolved_answers.source_customer_hash` and `knowledge_sources.storage_key` are not selected, and
 * `workspace-export.test.ts` greps the whole produced bundle for every one of those names — in both
 * spellings — plus the actual secret bytes it seeded.
 *
 * The shape, one JSON object per line:
 *   { "kind": "manifest", "orgId": …, "exportedAt": …, "tables": [ … ] }
 *   { "kind": "<table>", "row": { … } }   × every row, tables in the manifest's order
 *
 * Transaction discipline: ONE `withOrg` per PAGE of 1 000 rows, never one transaction around the
 * whole walk (the app role's 5 s idle-in-transaction timeout would kill it) and never a store call
 * inside one. The object is PUT once, at the end, outside every transaction. Tables with a uuid (or
 * bigint) `id` are keyset-paged on it; the handful that have no single unique column are OFFSET-paged
 * and are bounded small by construction (one workspace row, one subscription, settings, policies,
 * connections, daily stats, counters).
 *
 * The bundle is a walk, not a snapshot: each page is its own transaction, so a row written while the
 * walk is in flight may or may not appear depending on where its id sorts. That is the right trade —
 * one repeatable-read transaction around a whole tenant's mail would hold a connection (and a
 * snapshot) for the length of the export.
 *
 * Guards, both ends: the job proceeds only if the row still says `export_state = 'queued'` AND its
 * `export_key` is exactly `exportObjectKey(orgId, exportId)` — the ONE function `@aesa/contracts`
 * holds, which the api mints the key with and this job validates it against. A row that is no longer
 * `queued` (a cancelled export, a newer request, this job's own completed first attempt) is a quiet
 * `skipped`; a row that is `queued` for a DIFFERENT key is not — that can only be a programming error
 * between the two sides, so it lands `failed` and alerts rather than leaving the owner on a spinner.
 * The landing write is guarded on `queued` again. A failure lands `failed`, deletes the partial object and pages the
 * owner under the SAME dedupe key the success would have used, so one request pages once either way.
 */
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { exportObjectKey } from '@aesa/contracts'
import {
  agentCategoryPolicies, agentModelConfig, agents, audit, auditLog, billingSubscriptions, categories,
  categoryStatsDaily, drafts, guidanceSuggestions, knowledgeSources, llmCredentials, mailboxConnections,
  messages, notifications, orgSettings, resolvedAnswers, tickets, usageCounters, withOrg, workspaces,
  type AuditActor, type Db, type OrgTx,
} from '@aesa/db'
import type { ObjectStore } from '@aesa/knowledge'
import { defineJob, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { errorMessage } from '../err-message.ts'

export const WorkspaceExportPayload = z.object({ orgId: z.string(), exportId: z.string() })
export type WorkspaceExportPayload = z.infer<typeof WorkspaceExportPayload>

/** The hard ceiling on one bundle. Past it the export fails loudly rather than filling the bucket
 *  with something no browser will finish downloading; the runbook's answer is a narrower export. */
export const EXPORT_MAX_BYTES = 200 * 1024 * 1024

/** Rows per page. One page is one short `withOrg` transaction. */
export const EXPORT_PAGE_ROWS = 1_000

const EXPORT_ACTOR: AuditActor = 'system:job:workspace.export'

// ---------------------------------------------------------------------------------------------
// The allowlists. Read them as "what the owner gets", never as "the table minus …".
// ---------------------------------------------------------------------------------------------

/** Profile + settings. No `box_public_key`, no `customer_hash_salt`, and none of the export/deletion
 *  state machinery (it describes THIS request, not the workspace). */
const WORKSPACE_COLUMNS = {
  businessName: workspaces.businessName, websiteUrl: workspaces.websiteUrl, description: workspaces.description,
  tone: workspaces.tone, timezone: workspaces.timezone, locale: workspaces.locale,
  contactPhone: workspaces.contactPhone, contactUrls: workspaces.contactUrls,
  allowedUrlHosts: workspaces.allowedUrlHosts, allowedEmailDomains: workspaces.allowedEmailDomains,
  tripwireExtraKeywords: workspaces.tripwireExtraKeywords, operatingGuidance: workspaces.operatingGuidance,
  agentEnabled: workspaces.agentEnabled, agentEnabledAt: workspaces.agentEnabledAt, killSwitch: workspaces.killSwitch,
  onboardingStep: workspaces.onboardingStep, retentionDays: workspaces.retentionDays,
  knowledgeVersion: workspaces.knowledgeVersion, createdAt: workspaces.createdAt, updatedAt: workspaces.updatedAt,
}

const ORG_SETTINGS_COLUMNS = {
  key: orgSettings.key, value: orgSettings.value, updatedBy: orgSettings.updatedBy, updatedAt: orgSettings.updatedAt,
}

/** The Stripe ids are the OWNER's — they identify their own customer and subscription, and a support
 *  conversation with Stripe needs them. The three overage watermarks are ours and are left out. */
const BILLING_COLUMNS = {
  plan: billingSubscriptions.plan, status: billingSubscriptions.status,
  stripeCustomerId: billingSubscriptions.stripeCustomerId, stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
  stripeDomainItemId: billingSubscriptions.stripeDomainItemId, stripeOverageItemId: billingSubscriptions.stripeOverageItemId,
  domainQuantity: billingSubscriptions.domainQuantity,
  includedConversationsPerDomain: billingSubscriptions.includedConversationsPerDomain,
  overageMode: billingSubscriptions.overageMode, overageUnitCents: billingSubscriptions.overageUnitCents,
  trialEndsAt: billingSubscriptions.trialEndsAt, currentPeriodStart: billingSubscriptions.currentPeriodStart,
  currentPeriodEnd: billingSubscriptions.currentPeriodEnd, cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
  createdAt: billingSubscriptions.createdAt, updatedAt: billingSubscriptions.updatedAt,
}

/** No `consent_required_from_user_id` (another user's identity) and no `verification_code_hash`. */
const AGENT_COLUMNS = {
  id: agents.id, connectionId: agents.connectionId, address: agents.address, replyFromAddress: agents.replyFromAddress,
  domain: agents.domain, displayName: agents.displayName, signature: agents.signature,
  personaPreset: agents.personaPreset, personaText: agents.personaText, guidanceExtra: agents.guidanceExtra,
  priority: agents.priority, status: agents.status, autoGraduate: agents.autoGraduate,
  autoSendDelayMin: agents.autoSendDelayMin, createdAt: agents.createdAt, updatedAt: agents.updatedAt,
}

const CATEGORY_COLUMNS = {
  id: categories.id, key: categories.key, label: categories.label,
  createdAt: categories.createdAt, updatedAt: categories.updatedAt,
}

const CATEGORY_POLICY_COLUMNS = {
  agentId: agentCategoryPolicies.agentId, categoryId: agentCategoryPolicies.categoryId, mode: agentCategoryPolicies.mode,
  autoSendMinConfidence: agentCategoryPolicies.autoSendMinConfidence, graduatedAt: agentCategoryPolicies.graduatedAt,
  demotedAt: agentCategoryPolicies.demotedAt, demotedReason: agentCategoryPolicies.demotedReason,
  suggestedAt: agentCategoryPolicies.suggestedAt, suggestedWouldSend: agentCategoryPolicies.suggestedWouldSend,
  suggestedOf: agentCategoryPolicies.suggestedOf, updatedAt: agentCategoryPolicies.updatedAt,
}

const MODEL_CONFIG_COLUMNS = {
  id: agentModelConfig.id, agentId: agentModelConfig.agentId, role: agentModelConfig.role, mode: agentModelConfig.mode,
  credentialId: agentModelConfig.credentialId, model: agentModelConfig.model, effort: agentModelConfig.effort,
  fallbackToManaged: agentModelConfig.fallbackToManaged, modelGeneration: agentModelConfig.modelGeneration,
  modelGenerationAt: agentModelConfig.modelGenerationAt, createdAt: agentModelConfig.createdAt,
  updatedAt: agentModelConfig.updatedAt,
}

/** Metadata only. The key itself lives in `llm_credential_secrets`, which this bundle never names;
 *  `key_fingerprint` is the same display-only string every api already returns. */
const CREDENTIAL_COLUMNS = {
  id: llmCredentials.id, provider: llmCredentials.provider, label: llmCredentials.label, baseUrl: llmCredentials.baseUrl,
  keyFingerprint: llmCredentials.keyFingerprint, probeModel: llmCredentials.probeModel, transport: llmCredentials.transport,
  healthStatus: llmCredentials.healthStatus, lastProbedAt: llmCredentials.lastProbedAt, lastError: llmCredentials.lastError,
  createdBy: llmCredentials.createdBy, createdAt: llmCredentials.createdAt, updatedAt: llmCredentials.updatedAt,
}

/** Three columns, by ruling: which mailbox, which provider, whether it is live. Cursors, push
 *  subscription ids and lease state are operational internals the owner has no use for. */
const CONNECTION_COLUMNS = {
  provider: mailboxConnections.provider, emailAddress: mailboxConnections.emailAddress, status: mailboxConnections.status,
}

const TICKET_COLUMNS = {
  id: tickets.id, connectionId: tickets.connectionId, agentId: tickets.agentId, providerThreadId: tickets.providerThreadId,
  customerEmail: tickets.customerEmail, customerName: tickets.customerName, subject: tickets.subject,
  status: tickets.status, needsOwnerReason: tickets.needsOwnerReason, categoryId: tickets.categoryId,
  language: tickets.language, sentiment: tickets.sentiment, spamFlagged: tickets.spamFlagged,
  isSpam: tickets.isSpam, isAutomated: tickets.isAutomated, hasAttachments: tickets.hasAttachments,
  inboundCount: tickets.inboundCount, lastInboundAt: tickets.lastInboundAt,
  createdAt: tickets.createdAt, updatedAt: tickets.updatedAt,
}

/** The bodies ARE the point of the export. `bodyPurgedAt` rides along so a null body reads as
 *  "retention purged this", not "the export lost it". */
const MESSAGE_COLUMNS = {
  id: messages.id, ticketId: messages.ticketId, direction: messages.direction, fromAddress: messages.fromAddress,
  toAddresses: messages.toAddresses, ccAddresses: messages.ccAddresses, subject: messages.subject,
  bodyText: messages.bodyText, rfcMessageId: messages.rfcMessageId, inReplyTo: messages.inReplyTo,
  attachments: messages.attachments, sentAt: messages.sentAt, bodyPurgedAt: messages.bodyPurgedAt,
  createdAt: messages.createdAt,
}

const DRAFT_COLUMNS = {
  id: drafts.id, ticketId: drafts.ticketId, agentId: drafts.agentId, version: drafts.version, body: drafts.body,
  finalBody: drafts.finalBody, categoryId: drafts.categoryId, modelConfidence: drafts.modelConfidence,
  confidence: drafts.confidence, confidenceBreakdown: drafts.confidenceBreakdown, decision: drafts.decision,
  decisionReason: drafts.decisionReason, status: drafts.status, rationale: drafts.rationale,
  decidedAt: drafts.decidedAt, decisionSource: drafts.decisionSource, rejectReason: drafts.rejectReason,
  rejectAction: drafts.rejectAction, editDistanceRatio: drafts.editDistanceRatio,
  autoDecidedAt: drafts.autoDecidedAt, flaggedAt: drafts.flaggedAt, bodyPurgedAt: drafts.bodyPurgedAt,
  createdAt: drafts.createdAt,
}

/** The scrubbed texts, never the embedding (1 024 floats a human cannot read) and never
 *  `source_customer_hash` (a salted pseudonym for a customer, not the owner's to hold in a file). */
const ANSWER_COLUMNS = {
  id: resolvedAnswers.id, agentId: resolvedAnswers.agentId, categoryId: resolvedAnswers.categoryId,
  questionText: resolvedAnswers.questionText, answerBody: resolvedAnswers.answerBody, status: resolvedAnswers.status,
  approvals: resolvedAnswers.approvals, strikes: resolvedAnswers.strikes, reuseCount: resolvedAnswers.reuseCount,
  wasEdited: resolvedAnswers.wasEdited, knowledgeVersion: resolvedAnswers.knowledgeVersion,
  sourceTicketId: resolvedAnswers.sourceTicketId, reviewReason: resolvedAnswers.reviewReason,
  retiredReason: resolvedAnswers.retiredReason, lastApprovedAt: resolvedAnswers.lastApprovedAt,
  expiresAt: resolvedAnswers.expiresAt, createdAt: resolvedAnswers.createdAt, updatedAt: resolvedAnswers.updatedAt,
}

const GUIDANCE_COLUMNS = {
  id: guidanceSuggestions.id, agentId: guidanceSuggestions.agentId, categoryId: guidanceSuggestions.categoryId,
  sourceDraftId: guidanceSuggestions.sourceDraftId, text: guidanceSuggestions.text,
  rationale: guidanceSuggestions.rationale, status: guidanceSuggestions.status,
  createdAt: guidanceSuggestions.createdAt, decidedAt: guidanceSuggestions.decidedAt,
}

/** Metadata plus the pasted text and the crawl URL. An UPLOAD is listed by title/mime/byte_size —
 *  the file itself is the owner's own document and `storage_key` is our bucket path, not theirs. */
const SOURCE_COLUMNS = {
  id: knowledgeSources.id, kind: knowledgeSources.kind, status: knowledgeSources.status, title: knowledgeSources.title,
  mime: knowledgeSources.mime, byteSize: knowledgeSources.byteSize, url: knowledgeSources.url,
  pastedText: knowledgeSources.pastedText, documentCount: knowledgeSources.documentCount,
  chunkCount: knowledgeSources.chunkCount, failureReason: knowledgeSources.failureReason,
  createdAt: knowledgeSources.createdAt, completedAt: knowledgeSources.completedAt,
}

const STATS_COLUMNS = {
  agentId: categoryStatsDaily.agentId, categoryId: categoryStatsDaily.categoryId, day: categoryStatsDaily.day,
  drafted: categoryStatsDaily.drafted, approvedUnchanged: categoryStatsDaily.approvedUnchanged,
  approvedEdited: categoryStatsDaily.approvedEdited, rejected: categoryStatsDaily.rejected,
  autoSent: categoryStatsDaily.autoSent, autoSentConfirmed: categoryStatsDaily.autoSentConfirmed,
  autoSentFlagged: categoryStatsDaily.autoSentFlagged, held: categoryStatsDaily.held,
  updatedAt: categoryStatsDaily.updatedAt,
}

const COUNTER_COLUMNS = {
  day: usageCounters.day, meter: usageCounters.meter, value: usageCounters.value, updatedAt: usageCounters.updatedAt,
}

/** `id` is a bigserial, and `JSON.stringify` throws on a BigInt — so it is selected as text, which
 *  also makes it a usable keyset cursor. */
const AUDIT_COLUMNS = {
  id: sql<string>`${auditLog.id}::text`.as('id'), actor: auditLog.actor, action: auditLog.action,
  entityType: auditLog.entityType, entityId: auditLog.entityId, detail: auditLog.detail, createdAt: auditLog.createdAt,
}

/** One table's page reader. `cursorKey` names the row field to resume from (keyset paging); a table
 *  with none is OFFSET-paged and must be bounded small. */
interface ExportTable {
  name: string
  cursorKey: string | null
  read: (tx: OrgTx, orgId: string, after: string | null, offset: number) => Promise<Record<string, unknown>[]>
}

const EXPORT_TABLES: readonly ExportTable[] = [
  { name: 'workspaces', cursorKey: null, read: (tx, orgId, _a, offset) =>
    tx.select(WORKSPACE_COLUMNS).from(workspaces).where(eq(workspaces.orgId, orgId))
      .orderBy(asc(workspaces.orgId)).limit(EXPORT_PAGE_ROWS).offset(offset) },
  { name: 'org_settings', cursorKey: null, read: (tx, orgId, _a, offset) =>
    tx.select(ORG_SETTINGS_COLUMNS).from(orgSettings).where(eq(orgSettings.orgId, orgId))
      .orderBy(asc(orgSettings.key)).limit(EXPORT_PAGE_ROWS).offset(offset) },
  { name: 'billing_subscriptions', cursorKey: null, read: (tx, orgId, _a, offset) =>
    tx.select(BILLING_COLUMNS).from(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId))
      .orderBy(asc(billingSubscriptions.orgId)).limit(EXPORT_PAGE_ROWS).offset(offset) },
  { name: 'agents', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(AGENT_COLUMNS).from(agents)
      .where(and(eq(agents.orgId, orgId), after ? gt(agents.id, after) : undefined))
      .orderBy(asc(agents.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'categories', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(CATEGORY_COLUMNS).from(categories)
      .where(and(eq(categories.orgId, orgId), after ? gt(categories.id, after) : undefined))
      .orderBy(asc(categories.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'agent_category_policies', cursorKey: null, read: (tx, orgId, _a, offset) =>
    tx.select(CATEGORY_POLICY_COLUMNS).from(agentCategoryPolicies).where(eq(agentCategoryPolicies.orgId, orgId))
      .orderBy(asc(agentCategoryPolicies.agentId), asc(agentCategoryPolicies.categoryId))
      .limit(EXPORT_PAGE_ROWS).offset(offset) },
  { name: 'agent_model_config', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(MODEL_CONFIG_COLUMNS).from(agentModelConfig)
      .where(and(eq(agentModelConfig.orgId, orgId), after ? gt(agentModelConfig.id, after) : undefined))
      .orderBy(asc(agentModelConfig.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'llm_credentials', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(CREDENTIAL_COLUMNS).from(llmCredentials)
      .where(and(eq(llmCredentials.orgId, orgId), after ? gt(llmCredentials.id, after) : undefined))
      .orderBy(asc(llmCredentials.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'mailbox_connections', cursorKey: null, read: (tx, orgId, _a, offset) =>
    tx.select(CONNECTION_COLUMNS).from(mailboxConnections).where(eq(mailboxConnections.orgId, orgId))
      .orderBy(asc(mailboxConnections.id)).limit(EXPORT_PAGE_ROWS).offset(offset) },
  { name: 'tickets', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(TICKET_COLUMNS).from(tickets)
      .where(and(eq(tickets.orgId, orgId), after ? gt(tickets.id, after) : undefined))
      .orderBy(asc(tickets.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'messages', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(MESSAGE_COLUMNS).from(messages)
      .where(and(eq(messages.orgId, orgId), after ? gt(messages.id, after) : undefined))
      .orderBy(asc(messages.id)).limit(EXPORT_PAGE_ROWS) },
  // Decided drafts only: a `pending` one is a proposal the owner has not seen through, and the
  // export is a record of what the workspace DID.
  { name: 'drafts', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(DRAFT_COLUMNS).from(drafts)
      .where(and(eq(drafts.orgId, orgId), isNotNull(drafts.decidedAt), after ? gt(drafts.id, after) : undefined))
      .orderBy(asc(drafts.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'resolved_answers', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(ANSWER_COLUMNS).from(resolvedAnswers)
      .where(and(eq(resolvedAnswers.orgId, orgId), after ? gt(resolvedAnswers.id, after) : undefined))
      .orderBy(asc(resolvedAnswers.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'guidance_suggestions', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(GUIDANCE_COLUMNS).from(guidanceSuggestions)
      .where(and(eq(guidanceSuggestions.orgId, orgId), after ? gt(guidanceSuggestions.id, after) : undefined))
      .orderBy(asc(guidanceSuggestions.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'knowledge_sources', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(SOURCE_COLUMNS).from(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, orgId), after ? gt(knowledgeSources.id, after) : undefined))
      .orderBy(asc(knowledgeSources.id)).limit(EXPORT_PAGE_ROWS) },
  { name: 'category_stats_daily', cursorKey: null, read: (tx, orgId, _a, offset) =>
    tx.select(STATS_COLUMNS).from(categoryStatsDaily).where(eq(categoryStatsDaily.orgId, orgId))
      .orderBy(asc(categoryStatsDaily.day), asc(categoryStatsDaily.agentId), asc(categoryStatsDaily.categoryId))
      .limit(EXPORT_PAGE_ROWS).offset(offset) },
  { name: 'usage_counters', cursorKey: null, read: (tx, orgId, _a, offset) =>
    tx.select(COUNTER_COLUMNS).from(usageCounters).where(eq(usageCounters.orgId, orgId))
      .orderBy(asc(usageCounters.day), asc(usageCounters.meter)).limit(EXPORT_PAGE_ROWS).offset(offset) },
  { name: 'audit_log', cursorKey: 'id', read: (tx, orgId, after) =>
    tx.select(AUDIT_COLUMNS).from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), after ? gt(auditLog.id, sql`${after}::bigint`) : undefined))
      .orderBy(asc(auditLog.id)).limit(EXPORT_PAGE_ROWS) },
]

/** The manifest's `tables` array, and the order the bundle walks them in. */
export const EXPORT_TABLE_NAMES: readonly string[] = EXPORT_TABLES.map((t) => t.name)

/** The importable definition: the api's `workspace.requestExport` `enqueue()`s against this. */
export const workspaceExportJob: RegisteredJobDefinition<WorkspaceExportPayload> = defineJob({
  name: JOB_NAMES.workspaceExport,
  schema: WorkspaceExportPayload,
  handler: async () => {
    throw new Error('workspace.export: this definition has no bound deps — register it through registerWorkspaceExport(boss, deps)')
  },
})

export interface WorkspaceExportDeps {
  db: Db
  store: ObjectStore
  logger: pino.Logger
  /** index.ts wires this to `enqueueNotifyDispatch`. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  now?: () => Date
}

/** Thrown by the builder when the bundle passes `EXPORT_MAX_BYTES`; caught and landed as `failed`. */
class ExportTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`workspace export exceeded ${EXPORT_MAX_BYTES} bytes`)
    this.name = 'ExportTooLarge'
  }
}

/** What the claim check found. `key_mismatch` is the only one that WRITES — see `runWorkspaceExport`. */
type ExportClaim =
  | { outcome: 'claimed' }
  | { outcome: 'not_queued' }
  | { outcome: 'key_mismatch'; actualKey: string | null }

interface Bundle {
  bytes: Buffer
  rows: number
}

/** Walks every table, a page (and one short `withOrg`) at a time, into one NDJSON buffer. */
async function buildBundle(deps: WorkspaceExportDeps, orgId: string, now: Date, signal: AbortSignal): Promise<Bundle> {
  const chunks: Buffer[] = []
  let bytes = 0
  let rows = 0

  const write = (obj: unknown): void => {
    const line = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8')
    if (bytes + line.byteLength > EXPORT_MAX_BYTES) throw new ExportTooLarge(bytes + line.byteLength)
    bytes += line.byteLength
    chunks.push(line)
  }

  write({ kind: 'manifest', orgId, exportedAt: now.toISOString(), tables: EXPORT_TABLE_NAMES })

  for (const table of EXPORT_TABLES) {
    let after: string | null = null
    let offset = 0
    for (;;) {
      signal.throwIfAborted()
      const page: Record<string, unknown>[] = await withOrg(deps.db, orgId, (tx) => table.read(tx, orgId, after, offset))
      for (const row of page) {
        write({ kind: table.name, row })
        rows += 1
      }
      if (page.length < EXPORT_PAGE_ROWS) break
      if (table.cursorKey) {
        const last = page[page.length - 1]![table.cursorKey]
        // A keyset table with no cursor value on its last row cannot page safely — stop rather than
        // loop forever on the same page.
        if (typeof last !== 'string') break
        after = last
      } else {
        offset += page.length
      }
    }
  }

  return { bytes: Buffer.concat(chunks), rows }
}

export async function runWorkspaceExport(
  deps: WorkspaceExportDeps,
  payload: WorkspaceExportPayload,
  signal: AbortSignal,
): Promise<'ready' | 'failed' | 'skipped'> {
  const now = deps.now?.() ?? new Date()
  const { orgId, exportId } = payload
  const key = exportObjectKey(orgId, exportId)

  // --- Claim check. Anything but "still queued, and queued for THIS export id" stops here.
  const claim = await withOrg<ExportClaim>(deps.db, orgId, async (tx) => {
    const [ws] = await tx
      .select({ exportState: workspaces.exportState, exportKey: workspaces.exportKey })
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId))
    if (!ws || ws.exportState !== 'queued') return { outcome: 'not_queued' }
    if (ws.exportKey === key) return { outcome: 'claimed' }
    // `queued` for a DIFFERENT key than this payload implies. Both sides derive it from ONE function
    // (`exportObjectKey`, `@aesa/contracts`), so this cannot happen by configuration — it is a
    // programming error between the api that minted the key and this job. Land it `failed` in the
    // SAME transaction, guarded, so the owner sees a failure instead of a spinner that never
    // resolves; a silent skip here is a request that never completes and never says why.
    const landed = await tx
      .update(workspaces)
      .set({ exportState: 'failed', exportReadyAt: null })
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.exportState, 'queued')))
      .returning({ orgId: workspaces.orgId })
    if (landed.length > 0) {
      await audit(tx, {
        actor: EXPORT_ACTOR, action: 'workspace.export_failed', entityType: 'workspace', entityId: orgId,
        detail: { exportId, error: 'export_key_mismatch' },
      })
    }
    return { outcome: 'key_mismatch', actualKey: ws.exportKey }
  })

  if (claim.outcome === 'key_mismatch') {
    // Task 11 replaces this with `alert('export_failed', { orgId, exportId })`. No push: the owner
    // has nothing to act on, and the state they can already see reads `failed`. This line is for
    // whoever has to fix the mint/validate pair, which is why it carries BOTH keys verbatim.
    deps.logger.error(
      { alert: true, kind: 'export_failed', orgId, exportId, expectedKey: key, actualKey: claim.actualKey },
      'workspace.export: the workspace row names a different export key than this job\'s payload — landed failed',
    )
    return 'skipped'
  }
  if (claim.outcome === 'not_queued') {
    deps.logger.info({ orgId, exportId }, 'workspace_export_skipped')
    return 'skipped'
  }

  let bundle: Bundle
  try {
    bundle = await buildBundle(deps, orgId, now, signal)
    // The ONE store write, outside every transaction.
    await deps.store.put(key, bundle.bytes, 'application/x-ndjson')
  } catch (err) {
    await landFailed(deps, orgId, exportId, key, err)
    return 'failed'
  }

  const landing = await withOrg(deps.db, orgId, async (tx) => {
    const landed = await tx
      .update(workspaces)
      .set({ exportState: 'ready', exportReadyAt: now })
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.exportState, 'queued')))
      .returning({ orgId: workspaces.orgId })
    // Zero rows is the soft outcome a guarded write is allowed to have: a concurrent cancel or a
    // newer request moved `export_state` while the bundle was building, and it wins.
    if (landed.length === 0) return null
    await audit(tx, {
      actor: EXPORT_ACTOR, action: 'workspace.exported', entityType: 'workspace', entityId: orgId,
      detail: { exportId, bytes: bundle.bytes.byteLength, rows: bundle.rows },
    })
    const [note] = await tx
      .insert(notifications)
      .values({
        orgId, kind: 'workspace', title: 'Your export is ready',
        body: 'Download it from Settings → Workspace within 7 days.',
        dedupeKey: `workspace:export:${exportId}`, payload: { kind: 'export_ready' },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return { notificationId: note?.id ?? null }
  })

  if (!landing) {
    deps.logger.info({ orgId, exportId }, 'workspace_export_landing_lost')
    return 'skipped'
  }
  if (landing.notificationId) await notify(deps, orgId, landing.notificationId)
  deps.logger.info({ orgId, exportId, bytes: bundle.bytes.byteLength, rows: bundle.rows }, 'workspace_exported')
  return 'ready'
}

/** The failure landing: guarded `failed`, the partial object removed, the owner paged once. */
async function landFailed(
  deps: WorkspaceExportDeps, orgId: string, exportId: string, key: string, err: unknown,
): Promise<void> {
  // Task 11 replaces this with `alert('export_failed', { orgId, exportId })`.
  deps.logger.error(
    { alert: true, kind: 'export_failed', orgId, exportId, error: errorMessage(err) },
    'workspace.export: building or storing the bundle failed; the workspace is marked failed',
  )
  try {
    await deps.store.delete(key)
  } catch (deleteErr) {
    deps.logger.warn({ orgId, exportId, key, error: errorMessage(deleteErr) }, 'workspace_export_partial_delete_failed')
  }

  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const landed = await tx
      .update(workspaces)
      .set({ exportState: 'failed', exportReadyAt: null })
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.exportState, 'queued')))
      .returning({ orgId: workspaces.orgId })
    if (landed.length === 0) return null
    await audit(tx, {
      actor: EXPORT_ACTOR, action: 'workspace.export_failed', entityType: 'workspace', entityId: orgId,
      detail: { exportId, error: errorMessage(err) },
    })
    // The SAME dedupe key the success would have used: one request pages the owner exactly once,
    // whichever way it ended.
    const [note] = await tx
      .insert(notifications)
      .values({
        orgId, kind: 'workspace', title: 'Your export could not be finished',
        body: 'Try it again from Settings → Workspace.',
        dedupeKey: `workspace:export:${exportId}`, payload: { kind: 'export_failed' },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return note?.id ?? null
  })

  if (notificationId) await notify(deps, orgId, notificationId)
}

/** A failed push must never turn a finished export back into a failure — the row already landed. */
async function notify(deps: WorkspaceExportDeps, orgId: string, notificationId: string): Promise<void> {
  try {
    await deps.enqueueNotify(orgId, notificationId)
  } catch (err) {
    deps.logger.warn({ orgId, notificationId, error: errorMessage(err) }, 'workspace_export_notify_enqueue_failed')
  }
}

export async function registerWorkspaceExport(boss: PgBoss, deps: WorkspaceExportDeps): Promise<void> {
  const wired: RegisteredJobDefinition<WorkspaceExportPayload> = {
    ...workspaceExportJob,
    handler: async (ctx) => {
      await runWorkspaceExport(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}
