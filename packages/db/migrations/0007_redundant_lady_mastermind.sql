CREATE TABLE "agent_category_policies" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"mode" text DEFAULT 'review' NOT NULL,
	"auto_send_min_confidence" integer,
	"graduated_at" timestamp with time zone,
	"demoted_at" timestamp with time zone,
	"demoted_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_category_policies_agent_id_category_id_pk" PRIMARY KEY("agent_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "agent_category_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"address" text NOT NULL,
	"reply_from_address" text,
	"domain" text NOT NULL,
	"display_name" text NOT NULL,
	"signature" text DEFAULT '' NOT NULL,
	"persona_preset" text DEFAULT 'support' NOT NULL,
	"persona_text" text DEFAULT '' NOT NULL,
	"guidance_extra" text DEFAULT '' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_verification' NOT NULL,
	"verification_code_hash" text,
	"verification_expires_at" timestamp with time zone,
	"consent_required_from_user_id" uuid,
	"auto_graduate" boolean DEFAULT false NOT NULL,
	"auto_send_delay_min" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"direction" text NOT NULL,
	"from_address" text,
	"to_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"cc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text,
	"body_text" text,
	"rfc_message_id" text,
	"in_reply_to" text,
	"refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"auth_results" text,
	"dmarc_pass" boolean,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_id" uuid,
	"sent_at" timestamp with time zone,
	"body_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"agent_id" uuid,
	"provider_thread_id" text NOT NULL,
	"customer_email" text,
	"customer_name" text,
	"subject" text,
	"status" text DEFAULT 'new' NOT NULL,
	"needs_owner_reason" text,
	"category_id" uuid,
	"language" text,
	"sentiment" text,
	"spam_flagged" boolean DEFAULT false NOT NULL,
	"is_spam" boolean,
	"is_automated" boolean,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"inbound_count" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_triaged_at" timestamp with time zone,
	"triage_failure_count" integer DEFAULT 0 NOT NULL,
	"triage_questions" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_agent_run_at" timestamp with time zone,
	"last_agent_prompted_at" timestamp with time zone,
	"last_agent_finished_at" timestamp with time zone,
	"agent_failure_count" integer DEFAULT 0 NOT NULL,
	"owner_redraft_feedback" text,
	"redraft_count" integer DEFAULT 0 NOT NULL,
	"escalation_notified_at" timestamp with time zone,
	"ai_handled_month" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_category_policies" ADD CONSTRAINT "agent_category_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_category_policies" ADD CONSTRAINT "agent_category_policies_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_connection_id_mailbox_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_consent_required_from_user_id_user_id_fk" FOREIGN KEY ("consent_required_from_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_connection_id_mailbox_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_category_policies_org_idx" ON "agent_category_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_address_uidx" ON "agents" USING btree ("org_id","address");--> statement-breakpoint
CREATE INDEX "agents_org_connection_idx" ON "agents" USING btree ("org_id","connection_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_key_uidx" ON "categories" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_connection_provider_uidx" ON "messages" USING btree ("connection_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_org_ticket_idx" ON "messages" USING btree ("org_id","ticket_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_org_rfc_idx" ON "messages" USING btree ("org_id","rfc_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_connection_thread_uidx" ON "tickets" USING btree ("connection_id","provider_thread_id");--> statement-breakpoint
CREATE INDEX "tickets_org_status_idx" ON "tickets" USING btree ("org_id","status","last_inbound_at");--> statement-breakpoint
CREATE INDEX "tickets_org_customer_idx" ON "tickets" USING btree ("org_id","customer_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uidx" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_org_status_idx" ON "notifications" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE POLICY "agent_category_policies_org_isolation" ON "agent_category_policies" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("agent_category_policies"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("agent_category_policies"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_category_policies_platform_all" ON "agent_category_policies" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "agents_org_isolation" ON "agents" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("agents"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("agents"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agents_platform_all" ON "agents" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "categories_org_isolation" ON "categories" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("categories"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("categories"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "categories_platform_all" ON "categories" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "messages_org_isolation" ON "messages" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("messages"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("messages"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messages_platform_all" ON "messages" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tickets_org_isolation" ON "tickets" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("tickets"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("tickets"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tickets_platform_all" ON "tickets" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "notifications_org_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("notifications"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("notifications"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "notifications_platform_all" ON "notifications" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);