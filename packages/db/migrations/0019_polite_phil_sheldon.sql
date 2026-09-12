CREATE TABLE "agent_model_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"role" text NOT NULL,
	"mode" text DEFAULT 'managed' NOT NULL,
	"credential_id" uuid,
	"model" text,
	"effort" text,
	"fallback_to_managed" boolean DEFAULT false NOT NULL,
	"model_generation" integer DEFAULT 1 NOT NULL,
	"model_generation_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_config_role_check" CHECK ("agent_model_config"."role" IN ('draft','triage')),
	CONSTRAINT "agent_model_config_mode_check" CHECK ("agent_model_config"."mode" IN ('managed','byok')),
	CONSTRAINT "agent_model_config_effort_check" CHECK ("agent_model_config"."effort" IS NULL OR "agent_model_config"."effort" IN ('low','medium','high'))
);
--> statement-breakpoint
ALTER TABLE "agent_model_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_credential_secrets" (
	"credential_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key_ciphertext" "bytea" NOT NULL,
	"encryption" text NOT NULL,
	"data_key_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_credential_secrets_encryption_check" CHECK ("llm_credential_secrets"."encryption" IN ('sealed','dek'))
);
--> statement-breakpoint
ALTER TABLE "llm_credential_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"key_fingerprint" text NOT NULL,
	"probe_model" text,
	"transport" text DEFAULT 'direct' NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_probe" jsonb,
	"last_probed_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_credentials_provider_check" CHECK ("llm_credentials"."provider" IN ('anthropic','openai','deepseek','groq','together','openrouter','custom')),
	CONSTRAINT "llm_credentials_health_check" CHECK ("llm_credentials"."health_status" IN ('unknown','healthy','degraded','dead')),
	CONSTRAINT "llm_credentials_transport_check" CHECK ("llm_credentials"."transport" IN ('direct'))
);
--> statement-breakpoint
ALTER TABLE "llm_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" text NOT NULL,
	"provider" text NOT NULL,
	"pattern" text NOT NULL,
	"input_per_mtok" double precision NOT NULL,
	"output_per_mtok" double precision NOT NULL,
	"cache_read_per_mtok" double precision NOT NULL,
	"cache_write_5m_per_mtok" double precision NOT NULL,
	"cache_write_1h_per_mtok" double precision NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "mode" text DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cost_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_model_config" ADD CONSTRAINT "agent_model_config_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_config" ADD CONSTRAINT "agent_model_config_credential_id_llm_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."llm_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_credential_secrets" ADD CONSTRAINT "llm_credential_secrets_credential_id_llm_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."llm_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_credential_secrets_org_idx" ON "llm_credential_secrets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "llm_credentials_org_idx" ON "llm_credentials" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_pricing_id_effective_uidx" ON "model_pricing" USING btree ("id","effective_from");--> statement-breakpoint
CREATE INDEX "llm_calls_org_credential_idx" ON "llm_calls" USING btree ("org_id","credential_id","created_at");--> statement-breakpoint
CREATE POLICY "agent_model_config_org_isolation" ON "agent_model_config" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("agent_model_config"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("agent_model_config"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_model_config_platform_all" ON "agent_model_config" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "llm_credential_secrets_org_isolation" ON "llm_credential_secrets" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("llm_credential_secrets"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("llm_credential_secrets"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "llm_credential_secrets_platform_all" ON "llm_credential_secrets" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "llm_credentials_org_isolation" ON "llm_credentials" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("llm_credentials"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("llm_credentials"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "llm_credentials_platform_all" ON "llm_credentials" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);