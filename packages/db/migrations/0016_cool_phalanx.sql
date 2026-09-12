CREATE TABLE "resolved_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"category_id" uuid,
	"question_text" text NOT NULL,
	"question_embedding" vector(1024),
	"embedding_model" text,
	"embedding_version" integer,
	"answer_body" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"approvals" integer DEFAULT 0 NOT NULL,
	"strikes" integer DEFAULT 0 NOT NULL,
	"reuse_count" integer DEFAULT 0 NOT NULL,
	"was_edited" boolean DEFAULT false NOT NULL,
	"cited_chunk_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"knowledge_version" integer DEFAULT 0 NOT NULL,
	"source_ticket_id" uuid,
	"source_draft_id" uuid,
	"source_customer_hash" text,
	"supersedes_id" uuid,
	"review_reason" text,
	"retired_reason" text,
	"last_approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resolved_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "category_stats_daily" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"day" date NOT NULL,
	"drafted" integer DEFAULT 0 NOT NULL,
	"approved_unchanged" integer DEFAULT 0 NOT NULL,
	"approved_edited" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"auto_sent" integer DEFAULT 0 NOT NULL,
	"auto_sent_confirmed" integer DEFAULT 0 NOT NULL,
	"auto_sent_flagged" integer DEFAULT 0 NOT NULL,
	"held" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_stats_daily_agent_id_category_id_day_pk" PRIMARY KEY("agent_id","category_id","day")
);
--> statement-breakpoint
ALTER TABLE "category_stats_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "guidance_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"category_id" uuid,
	"source_draft_id" uuid,
	"text" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid
);
--> statement-breakpoint
ALTER TABLE "guidance_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "customer_hash_salt" "bytea";--> statement-breakpoint
ALTER TABLE "agent_category_policies" ADD COLUMN "suggested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_category_policies" ADD COLUMN "suggested_would_send" integer;--> statement-breakpoint
ALTER TABLE "agent_category_policies" ADD COLUMN "suggested_of" integer;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "auto_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "auto_held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "flagged_by" uuid;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "memory_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resolved_answers" ADD CONSTRAINT "resolved_answers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolved_answers" ADD CONSTRAINT "resolved_answers_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolved_answers" ADD CONSTRAINT "resolved_answers_source_ticket_id_tickets_id_fk" FOREIGN KEY ("source_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolved_answers" ADD CONSTRAINT "resolved_answers_source_draft_id_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolved_answers" ADD CONSTRAINT "resolved_answers_supersedes_id_resolved_answers_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."resolved_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_stats_daily" ADD CONSTRAINT "category_stats_daily_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_stats_daily" ADD CONSTRAINT "category_stats_daily_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_suggestions" ADD CONSTRAINT "guidance_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_suggestions" ADD CONSTRAINT "guidance_suggestions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_suggestions" ADD CONSTRAINT "guidance_suggestions_source_draft_id_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guidance_suggestions" ADD CONSTRAINT "guidance_suggestions_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resolved_answers_org_status_idx" ON "resolved_answers" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "resolved_answers_org_customer_idx" ON "resolved_answers" USING btree ("org_id","source_customer_hash");--> statement-breakpoint
CREATE INDEX "resolved_answers_org_agent_category_idx" ON "resolved_answers" USING btree ("org_id","agent_id","category_id");--> statement-breakpoint
CREATE INDEX "resolved_answers_org_source_draft_idx" ON "resolved_answers" USING btree ("org_id","source_draft_id");--> statement-breakpoint
CREATE INDEX "category_stats_daily_org_day_idx" ON "category_stats_daily" USING btree ("org_id","day");--> statement-breakpoint
CREATE INDEX "guidance_suggestions_org_status_idx" ON "guidance_suggestions" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_flagged_by_user_id_fk" FOREIGN KEY ("flagged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "resolved_answers_org_isolation" ON "resolved_answers" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("resolved_answers"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("resolved_answers"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "resolved_answers_platform_all" ON "resolved_answers" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "category_stats_daily_org_isolation" ON "category_stats_daily" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("category_stats_daily"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("category_stats_daily"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "category_stats_daily_platform_all" ON "category_stats_daily" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "guidance_suggestions_org_isolation" ON "guidance_suggestions" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("guidance_suggestions"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("guidance_suggestions"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "guidance_suggestions_platform_all" ON "guidance_suggestions" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);