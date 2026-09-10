import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { drafts } from './drafts.ts'
import { createdAt, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'
import { mailboxConnections } from './mail.ts'
import { agents, tickets } from './support.ts'

/** One row per approved draft's delivery attempt; the atomic pre-send UPDATE matches on claim_token. */
export const outboundSends = pgTable('outbound_sends', {
  id: id(), orgId: orgId(),
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => mailboxConnections.id),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('queued'),                      // OUTBOUND_SEND_STATUSES (CHECK)
  sendAfter: timestamp('send_after', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
  claimToken: uuid('claim_token'),                                         // fresh per claim; the atomic pre-send UPDATE matches on it
  providerDraftId: text('provider_draft_id'),                              // Graph createReply id, persisted BEFORE the send
  providerMessageId: text('provider_message_id'), providerThreadId: text('provider_thread_id'),
  rfcMessageId: text('rfc_message_id'),
  attempts: integer('attempts').notNull().default(0), lastError: text('last_error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('outbound_sends_draft_uidx').on(t.draftId),
  index('outbound_sends_org_due_idx').on(t.orgId, t.status, t.sendAfter),
  ...tenantPolicies(t.orgId, 'outbound_sends'),
])
