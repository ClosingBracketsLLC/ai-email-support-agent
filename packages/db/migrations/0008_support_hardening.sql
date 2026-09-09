-- FORCE RLS on the six new tenant tables (drizzle never emits FORCE)
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_category_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Pin the fixed-vocabulary text columns, matching how workspaces pins its enums (workspaces_tone_check etc).
-- The literals below spell @aesa/core's TICKET_STATUSES by hand: @aesa/db has no dependency on @aesa/core,
-- so the CHECK is the single source of truth at the DB layer; the state-transition matrix that governs which
-- transitions are legal lives at the worker layer and is exercised by @aesa/core's own tests, not here.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_check"
  CHECK ("status" IN ('new','triaged','awaiting_review','auto_sending','needs_owner','waiting_on_customer','resolved'));
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_direction_check"
  CHECK ("direction" IN ('inbound','outbound'));
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_status_check"
  CHECK ("status" IN ('pending_verification','active','disabled'));
--> statement-breakpoint
-- Matches @aesa/contracts' PERSONA_PRESETS (agents.ts); kept in sync by hand for the same reason as above.
ALTER TABLE "agents" ADD CONSTRAINT "agents_persona_preset_check"
  CHECK ("persona_preset" IN ('support','sales','concierge','billing'));
--> statement-breakpoint
ALTER TABLE "agent_category_policies" ADD CONSTRAINT "agent_category_policies_mode_check"
  CHECK ("mode" IN ('off','review','auto'));
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" IN ('escalation','mailbox_reauth','digest'));
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_check"
  CHECK ("status" IN ('pending','sent','collapsed','failed'));
