import { sql } from 'drizzle-orm'
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'
import { agents, tickets } from './support.ts'

/** One row per model invocation loop: triage, a draft attempt, or a sandbox test-question run. */
export const agentRuns = pgTable('agent_runs', {
  id: id(), orgId: orgId(),
  kind: text('kind').notNull(),                                            // triage | draft | sandbox (CHECK, 0011)
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  provider: text('provider').notNull(), model: text('model').notNull(),
  status: text('status').notNull().default('running'),                    // running | succeeded | failed | aborted (CHECK)
  input: jsonb('input').notNull().default(sql`'{}'::jsonb`),               // sandbox: { subject, question }; draft: { redraft: boolean, feedbackChars }
  output: jsonb('output'),                                                 // the decision summary — never a customer body except for sandbox runs
  errorCode: text('error_code'), errorMessage: text('error_message'),      // scrubbed
  inputTokens: integer('input_tokens').notNull().default(0), outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0), cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  apiCalls: integer('api_calls').notNull().default(0), costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index('agent_runs_org_ticket_idx').on(t.orgId, t.ticketId, t.startedAt),
  index('agent_runs_org_status_idx').on(t.orgId, t.status, t.startedAt),
  ...tenantPolicies(t.orgId, 'agent_runs'),
])

/** Append-only trace of one agent_runs row: prompt/call/guardrail/decision/error, in emission order. */
export const agentRunEvents = pgTable('agent_run_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(), orgId: orgId(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(), kind: text('kind').notNull(),             // prompt | call | guardrail | decision | error
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('agent_run_events_run_seq_uidx').on(t.runId, t.seq),
  index('agent_run_events_org_created_idx').on(t.orgId, t.createdAt),
  ...tenantPolicies(t.orgId, 'agent_run_events'),
])

/** One row per LLM API call, for metering and cost; runId/agentId/credentialId are loose FKs —
 * metering must never fail on a missing (or since-deleted) parent. `mode`/`credentialId` are
 * Phase 6's BYOK routing (which meter — managed or byok — the cost bump goes to); `costUnknown`
 * marks a call whose model matched no pricing row (so `cost_micros` is 0, not a real zero). */
export const llmCalls = pgTable('llm_calls', {
  id: id(), orgId: orgId(),
  runId: uuid('run_id'), agentId: uuid('agent_id'),                         // loose: metering must never fail on a missing parent
  role: text('role').notNull(), provider: text('provider').notNull(), model: text('model').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  inputTokens: integer('input_tokens').notNull(), outputTokens: integer('output_tokens').notNull(),
  cacheReadTokens: integer('cache_read_tokens').notNull(), cacheWriteTokens: integer('cache_write_tokens').notNull(),
  apiCalls: integer('api_calls').notNull(), costMicros: bigint('cost_micros', { mode: 'number' }).notNull(),
  latencyMs: integer('latency_ms').notNull(), finish: text('finish').notNull(), parseStrategy: text('parse_strategy').notNull(),
  errorCode: text('error_code'),
  credentialId: uuid('credential_id'),                                      // loose: no FK — metering must never fail on a deleted credential
  mode: text('mode').notNull().default('managed'),                         // 'managed' | 'byok' (CHECK, 0020)
  costUnknown: boolean('cost_unknown').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('llm_calls_idempotency_uidx').on(t.idempotencyKey),
  index('llm_calls_org_created_idx').on(t.orgId, t.createdAt),
  index('llm_calls_org_credential_idx').on(t.orgId, t.credentialId, t.createdAt),
  ...tenantPolicies(t.orgId, 'llm_calls'),
])
