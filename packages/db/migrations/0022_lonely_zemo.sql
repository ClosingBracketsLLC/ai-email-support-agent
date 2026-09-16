CREATE TABLE "billing_subscriptions" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_domain_item_id" text,
	"stripe_overage_item_id" text,
	"domain_quantity" integer DEFAULT 0 NOT NULL,
	"included_conversations_per_domain" integer DEFAULT 300 NOT NULL,
	"overage_mode" text DEFAULT 'automatic' NOT NULL,
	"overage_unit_cents" integer DEFAULT 12 NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"overage_reported" integer DEFAULT 0 NOT NULL,
	"overage_reported_period_start" timestamp with time zone,
	"last_stripe_event_created" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_plan_check" CHECK ("billing_subscriptions"."plan" IN ('trial','standard')),
	CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" IN ('trialing','active','past_due','canceled')),
	CONSTRAINT "billing_subscriptions_overage_mode_check" CHECK ("billing_subscriptions"."overage_mode" IN ('automatic','blocked'))
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deletion_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "export_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "export_key" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "export_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "export_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "body_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "sweep_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resolved_answers" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
CREATE POLICY "billing_subscriptions_org_isolation" ON "billing_subscriptions" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("billing_subscriptions"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("billing_subscriptions"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "billing_subscriptions_platform_all" ON "billing_subscriptions" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);