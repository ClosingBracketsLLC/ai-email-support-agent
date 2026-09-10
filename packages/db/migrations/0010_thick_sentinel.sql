CREATE TABLE "agent_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ticket_id" uuid,
	"agent_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_id" uuid,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"api_calls" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"latency_ms" integer NOT NULL,
	"finish" text NOT NULL,
	"parse_strategy" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "draft_action_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_action_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"agent_id" uuid,
	"agent_run_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"body" text NOT NULL,
	"final_body" text,
	"category_id" uuid,
	"model_confidence" real,
	"confidence" real,
	"confidence_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"guardrail_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" text NOT NULL,
	"decision_reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retrieved_chunk_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"cited_chunk_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"retrieved_answer_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"used_answer_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"memory_conflict_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"rationale" text,
	"unresolved_questions" text[] DEFAULT '{}'::text[] NOT NULL,
	"customer_language" text,
	"thread_snapshot_at" timestamp with time zone NOT NULL,
	"is_redraft" boolean DEFAULT false NOT NULL,
	"viewed_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_source" text,
	"reject_reason" text,
	"reject_action" text,
	"edit_distance_ratio" real,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbound_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"agent_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"claim_token" uuid,
	"provider_draft_id" text,
	"provider_message_id" text,
	"provider_thread_id" text,
	"rfc_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_action_tokens" ADD CONSTRAINT "draft_action_tokens_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_action_tokens" ADD CONSTRAINT "draft_action_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_connection_id_mailbox_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_seq_uidx" ON "agent_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_run_events_org_created_idx" ON "agent_run_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_org_ticket_idx" ON "agent_runs" USING btree ("org_id","ticket_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_org_status_idx" ON "agent_runs" USING btree ("org_id","status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_calls_idempotency_uidx" ON "llm_calls" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "llm_calls_org_created_idx" ON "llm_calls" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_action_tokens_hash_uidx" ON "draft_action_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "draft_action_tokens_org_draft_idx" ON "draft_action_tokens" USING btree ("org_id","draft_id");--> statement-breakpoint
CREATE INDEX "drafts_org_ticket_idx" ON "drafts" USING btree ("org_id","ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "drafts_org_status_idx" ON "drafts" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_sends_draft_uidx" ON "outbound_sends" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "outbound_sends_org_due_idx" ON "outbound_sends" USING btree ("org_id","status","send_after");--> statement-breakpoint
CREATE POLICY "agent_run_events_org_isolation" ON "agent_run_events" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("agent_run_events"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("agent_run_events"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_run_events_platform_all" ON "agent_run_events" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agent_runs_org_isolation" ON "agent_runs" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("agent_runs"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("agent_runs"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_runs_platform_all" ON "agent_runs" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "llm_calls_org_isolation" ON "llm_calls" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("llm_calls"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("llm_calls"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "llm_calls_platform_all" ON "llm_calls" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "draft_action_tokens_org_isolation" ON "draft_action_tokens" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("draft_action_tokens"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("draft_action_tokens"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "draft_action_tokens_platform_all" ON "draft_action_tokens" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "drafts_org_isolation" ON "drafts" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("drafts"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("drafts"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "drafts_platform_all" ON "drafts" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "outbound_sends_org_isolation" ON "outbound_sends" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("outbound_sends"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("outbound_sends"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "outbound_sends_platform_all" ON "outbound_sends" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);