import { AUTH_TABLES } from '../../src/index.ts'

/**
 * Every table `runMigrations` creates, sorted. Pinned by `migrations.test.ts`'s "creates exactly the
 * Phase 0 tables" and reused by `rls.test.ts` (the RLS invariant superset) and `purge.test.ts` (the
 * purge-coverage pin) so the three lists can never quietly drift apart from one another.
 */
export const EXPECTED_TABLES = ['account', 'agent_category_policies', 'agent_model_config', 'agent_run_events', 'agent_runs', 'agents', 'audit_log', 'billing_subscriptions', 'categories', 'category_stats_daily', 'draft_action_tokens', 'drafts', 'gmail_access_requests', 'guidance_suggestions', 'invitation', 'knowledge_chunks', 'knowledge_documents', 'knowledge_sources', 'llm_calls', 'llm_credential_secrets', 'llm_credentials', 'mailbox_connections', 'mailbox_credentials', 'member', 'messages', 'model_pricing', 'notification_devices', 'notifications', 'oauth_flows', 'org_data_keys', 'org_settings', 'organization', 'outbound_sends', 'platform_state', 'resolved_answers', 'session', 'tickets', 'usage_counters', 'user', 'verification', 'webhook_events', 'workspaces']

/** Tables that legitimately carry no org_id. Every other ordinary table in `public` must be tenant-scoped
 *  (rls.test.ts's RLS invariant) and covered by a `PURGE_ORDER` entry (purge.test.ts). */
export const RLS_EXEMPT = ['platform_state', 'webhook_events', 'model_pricing', ...AUTH_TABLES]
