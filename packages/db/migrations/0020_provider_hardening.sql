ALTER TABLE "llm_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_credential_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_model_config" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The key never reaches the api: same rule as mailbox_credentials (0006). Platform role only.
REVOKE ALL ON "llm_credential_secrets" FROM "aesa_app";
--> statement-breakpoint
-- Platform data: every role reads it (migration 0002's default privileges already grant aesa_app
-- full DML on new tables), only migrations write it — so REVOKE the write privileges rather than
-- GRANT SELECT (which would be a no-op) to make that actually true.
REVOKE INSERT, UPDATE, DELETE ON "model_pricing" FROM "aesa_app";
--> statement-breakpoint
-- Two facts drizzle's builder cannot express: NULLS NOT DISTINCT needs the table-level `unique()`
-- constraint builder, which has no `.on()` for a multi-column composite in this drizzle version;
-- `uniqueIndex()` has no `.nullsNotDistinct()` at all (packages/db/src/schema/llm.ts's header).
CREATE UNIQUE INDEX "agent_model_config_org_agent_role_uidx" ON "agent_model_config" ("org_id","agent_id","role") NULLS NOT DISTINCT;
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_mode_check" CHECK ("mode" IN ('managed','byok'));
--> statement-breakpoint
-- Phase 6's provider_health notification kind (contracts NOTIFICATION_KINDS already carries it).
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" IN ('escalation','mailbox_reauth','digest','draft_review','auto_send','graduation','demotion','memory_sample','provider_health'));
--> statement-breakpoint
-- Seed (USD per MTok, 2026-09-12). Anthropic rows mirror packages/llm/src/pricing/seed.ts (already
-- verified there against Anthropic's published rates). Re-verified against each provider's current
-- pricing page/announcement at implementation time (2026-09-12 web check):
--   - gpt-5 (1.25 / 10, cache read 0.125) and gpt-5-mini (0.25 / 2, cache read 0.025): CONFIRMED,
--     unchanged from the plan author's seed — OpenAI prices cached input at ~10% of the input rate.
--   - llama-3.3-70b-versatile (0.59 / 0.79) and llama-3.1-8b-instant (0.05 / 0.08): CONFIRMED,
--     unchanged from the plan author's seed — Groq's current on-demand per-token rates.
--   - deepseek-chat / deepseek-reasoner: UNVERIFIED and left as the plan author's seed. The current
--     DeepSeek pricing page no longer lists these two model ids at all — the live catalog has moved
--     to a peak/off-peak `deepseek-flash` / `deepseek-v4-pro` scheme, and a 2026-09 search reports
--     `deepseek-chat`/`deepseek-reasoner` as legacy aliases retired 2026-07-24. Since Task 1's
--     provider catalog (packages/contracts/src/llm.ts, out of this task's scope) still names these
--     two ids as DeepSeek's suggested models, and llm-tables.test.ts pins their presence, the ROWS
--     stay; only the runbook (a later task) should tell Robert to re-verify or retire them.
-- A BYOK row prices the OWNER's spend for the dashboard only, never a platform bill. Cache-write
-- rates for providers with no automatic prompt caching are 0.
INSERT INTO "model_pricing" ("id","provider","pattern","input_per_mtok","output_per_mtok","cache_read_per_mtok","cache_write_5m_per_mtok","cache_write_1h_per_mtok","effective_from") VALUES
  ('claude-opus-5','anthropic','^claude-opus-5(-|$)',5,25,0.5,6.25,10,'2026-09-09T00:00:00Z'),
  ('claude-sonnet-5','anthropic','^claude-sonnet-5(-|$)',2,10,0.2,2.5,4,'2026-09-09T00:00:00Z'),
  ('claude-haiku-4-5','anthropic','^claude-haiku-4-5(-|$)',1,5,0.1,1.25,2,'2026-09-09T00:00:00Z'),
  ('gpt-5','openai','^gpt-5(-|$)',1.25,10,0.125,0,0,'2026-09-12T00:00:00Z'),
  ('gpt-5-mini','openai','^gpt-5-mini(-|$)',0.25,2,0.025,0,0,'2026-09-12T00:00:00Z'),
  ('deepseek-chat','deepseek','^deepseek-chat(-|$)',0.27,1.1,0.07,0,0,'2026-09-12T00:00:00Z'),
  ('deepseek-reasoner','deepseek','^deepseek-reasoner(-|$)',0.55,2.19,0.14,0,0,'2026-09-12T00:00:00Z'),
  ('llama-3.3-70b-versatile','groq','^llama-3\.3-70b-versatile(-|$)',0.59,0.79,0,0,0,'2026-09-12T00:00:00Z'),
  ('llama-3.1-8b-instant','groq','^llama-3\.1-8b-instant(-|$)',0.05,0.08,0,0,0,'2026-09-12T00:00:00Z');
