ALTER TABLE "resolved_answers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "category_stats_daily" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guidance_suggestions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Fixed vocabularies, spelled by hand (0008 pattern; contracts RESOLVED_ANSWER_STATUSES / GUIDANCE_SUGGESTION_STATUSES).
ALTER TABLE "resolved_answers" ADD CONSTRAINT "resolved_answers_status_check" CHECK ("status" IN ('candidate','active','needs_review','retired'));
--> statement-breakpoint
ALTER TABLE "guidance_suggestions" ADD CONSTRAINT "guidance_suggestions_status_check" CHECK ("status" IN ('pending','accepted','dismissed'));
--> statement-breakpoint
-- Phase 5's four notification kinds (contracts NOTIFICATION_KINDS).
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" IN ('escalation','mailbox_reauth','digest','draft_review','auto_send','graduation','demotion','memory_sample'));
--> statement-breakpoint
-- The rollup's and the demotion checks' work lists (partial indexes live in hand-written SQL, 0011 pattern).
CREATE INDEX "drafts_org_agent_category_decided_idx" ON "drafts" ("org_id", "agent_id", "category_id", "decided_at") WHERE "decided_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "drafts_org_auto_decided_idx" ON "drafts" ("org_id", "auto_decided_at") WHERE "auto_decided_at" IS NOT NULL;
--> statement-breakpoint
-- memory.capture's idempotency probe and the sampling queue.
CREATE INDEX "resolved_answers_org_expires_idx" ON "resolved_answers" ("org_id", "expires_at") WHERE "status" IN ('active','needs_review');
