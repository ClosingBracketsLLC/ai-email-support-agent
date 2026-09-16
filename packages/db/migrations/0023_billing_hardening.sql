ALTER TABLE "billing_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_customer_uidx" ON "billing_subscriptions" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_subscription_uidx" ON "billing_subscriptions" ("stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL;
--> statement-breakpoint
-- Every existing workspace gets its trial row (deviation 1); a workspace already switched on gets its
-- trial clock from the first enable, exactly as setAgentEnabled stamps it from Phase 7 on (deviation 2).
INSERT INTO "billing_subscriptions" ("org_id", "trial_ends_at")
  SELECT "org_id", "agent_enabled_at" + interval '14 days' FROM "workspaces"
  ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_export_state_check" CHECK ("export_state" IN ('none','queued','ready','failed'));
--> statement-breakpoint
-- Idempotency for "Remember this reply" (deviation 16): one answer per remembered message.
CREATE UNIQUE INDEX "resolved_answers_source_message_uidx" ON "resolved_answers" ("org_id", "source_message_id") WHERE "source_message_id" IS NOT NULL;
--> statement-breakpoint
-- The retention sweep's work lists (deviation 12): unpurged bodies by age, per org.
CREATE INDEX "messages_org_unpurged_idx" ON "messages" ("org_id", "created_at") WHERE "body_purged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "drafts_org_unpurged_idx" ON "drafts" ("org_id", "created_at") WHERE "body_purged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" ("created_at");
--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" ("created_at");
--> statement-breakpoint
-- The re-embed sweep's work list (Task 7): chunks embedded by a model that is no longer the configured one.
CREATE INDEX "knowledge_chunks_embedding_model_idx" ON "knowledge_chunks" ("embedding_model") WHERE "embedding" IS NOT NULL;
--> statement-breakpoint
-- Phase 7's two new notification kinds (contracts NOTIFICATION_KINDS already carries 'billing' and 'workspace').
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" IN ('escalation','mailbox_reauth','digest','draft_review','auto_send','graduation','demotion','memory_sample','provider_health','billing','workspace'));
--> statement-breakpoint
-- The api's cross-org read for the Stripe webhook (spec, tenancy net 1): customer id → org. Same shape and
-- the same ACL-then-owner order as resolve_mailbox_connection (0006) — see that migration's comments.
CREATE OR REPLACE FUNCTION resolve_stripe_customer(p_customer_id text)
RETURNS TABLE (org_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT org_id FROM billing_subscriptions WHERE stripe_customer_id = p_customer_id LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_stripe_customer(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_stripe_customer(text) TO "aesa_app";
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO "aesa_platform";
--> statement-breakpoint
ALTER FUNCTION resolve_stripe_customer(text) OWNER TO "aesa_platform";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM "aesa_platform";
