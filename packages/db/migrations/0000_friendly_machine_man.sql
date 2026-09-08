CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_data_keys" (
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_version" integer NOT NULL,
	"box_public_key" "bytea" NOT NULL,
	"box_private_key_ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_data_keys_org_id_version_pk" PRIMARY KEY("org_id","version")
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_settings_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"meter" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_org_id_day_meter_pk" PRIMARY KEY("org_id","day","meter")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"business_name" text NOT NULL,
	"website_url" text,
	"description" text,
	"tone" text DEFAULT 'friendly' NOT NULL,
	"timezone" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"contact_phone" text,
	"contact_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_url_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_email_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"tripwire_extra_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"operating_guidance" text DEFAULT '' NOT NULL,
	"agent_enabled" boolean DEFAULT false NOT NULL,
	"agent_enabled_at" timestamp with time zone,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"onboarding_step" text DEFAULT 'profile' NOT NULL,
	"retention_days" integer DEFAULT 180 NOT NULL,
	"knowledge_version" integer DEFAULT 0 NOT NULL,
	"box_public_key" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_tone_check" CHECK ("workspaces"."tone" IN ('friendly','formal','concise')),
	CONSTRAINT "workspaces_onboarding_step_check" CHECK ("workspaces"."onboarding_step" IN ('profile','mailbox','knowledge','go_live','done')),
	CONSTRAINT "workspaces_retention_days_check" CHECK ("workspaces"."retention_days" BETWEEN 30 AND 730)
);
--> statement-breakpoint
CREATE TABLE "platform_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_org_entity_idx" ON "audit_log" USING btree ("org_id","entity_type","entity_id");