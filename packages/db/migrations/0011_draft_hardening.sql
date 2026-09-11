-- FORCE RLS on the six new tenant tables (drizzle never emits FORCE)
ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_run_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "llm_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "drafts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "draft_action_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outbound_sends" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Fixed vocabularies, spelled by hand (0008 pattern: @aesa/db has no @aesa/core dependency).
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_status_check"
  CHECK ("status" IN ('pending','approved','held','sending','sent','rejected','superseded','expired','failed'));
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_decision_check" CHECK ("decision" IN ('send','review','escalate'));
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_decision_source_check"
  CHECK ("decision_source" IS NULL OR "decision_source" IN ('app','email','auto'));
--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_status_check"
  CHECK ("status" IN ('queued','held','claimed','sent','failed'));
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_kind_check" CHECK ("kind" IN ('triage','draft','sandbox'));
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_status_check"
  CHECK ("status" IN ('running','succeeded','failed','aborted'));
--> statement-breakpoint
-- One live draft per ticket (spec: "one live draft per ticket via partial unique"). Partial uniques live in
-- hand-written SQL, as 0006 chose for mailbox_connections.
CREATE UNIQUE INDEX "drafts_live_per_ticket_uidx" ON "drafts" ("ticket_id")
  WHERE "status" IN ('pending','approved','held','sending');
--> statement-breakpoint
-- Phase 2 carry-over: poll-sweep's sub-sweep (a) and the Graph webhook resolver filter on this column.
CREATE INDEX "mailbox_connections_push_subscription_idx" ON "mailbox_connections" ("push_subscription_id")
  WHERE "push_subscription_id" IS NOT NULL;
--> statement-breakpoint
-- The draft_review push kind (contracts NOTIFICATION_KINDS).
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" IN ('escalation','mailbox_reauth','digest','draft_review'));
--> statement-breakpoint
-- The api's fourth fixed-signature SECURITY DEFINER resolver (spec net 1): a session-less /a/:draftId?t=
-- review page has no org until the token's hash is resolved. Same ACL-then-owner order as 0006/0009,
-- for the reasons documented there in full.
CREATE OR REPLACE FUNCTION resolve_draft_action_token(p_token_hash text)
RETURNS TABLE (token_id uuid, org_id uuid, draft_id uuid, user_id uuid, expires_at timestamptz, consumed_at timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT id, org_id, draft_id, user_id, expires_at, consumed_at
  FROM draft_action_tokens
  WHERE token_hash = p_token_hash
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_draft_action_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_draft_action_token(text) TO "aesa_app";
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO "aesa_platform";
--> statement-breakpoint
ALTER FUNCTION resolve_draft_action_token(text) OWNER TO "aesa_platform";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM "aesa_platform";
