CREATE TABLE "gmail_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gmail_access_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mailbox_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email_address" text NOT NULL,
	"status" text DEFAULT 'pending_claim' NOT NULL,
	"cursor" jsonb,
	"resync_state" jsonb,
	"push_subscription_id" text,
	"push_expires_at" timestamp with time zone,
	"push_client_state_hash" text,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"poll_lease_until" timestamp with time zone,
	"connected_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_connections_provider_check" CHECK ("mailbox_connections"."provider" IN ('gmail','microsoft')),
	CONSTRAINT "mailbox_connections_status_check" CHECK ("mailbox_connections"."status" IN ('pending_claim','connected','reauth_required','disabled'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mailbox_credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"refresh_token_ciphertext" "bytea" NOT NULL,
	"access_token_ciphertext" "bytea",
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_hash" text,
	"refresh_lock_until" timestamp with time zone,
	"encryption" text NOT NULL,
	"data_key_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_credentials_encryption_check" CHECK ("mailbox_credentials"."encryption" IN ('sealed','dek'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"pkce_ciphertext" "bytea" NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"connection_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_flows_provider_check" CHECK ("oauth_flows"."provider" IN ('gmail','microsoft')),
	CONSTRAINT "oauth_flows_platform_check" CHECK ("oauth_flows"."platform" IN ('native','web')),
	CONSTRAINT "oauth_flows_status_check" CHECK ("oauth_flows"."status" IN ('pending','consumed','failed'))
);
--> statement-breakpoint
ALTER TABLE "oauth_flows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "organization_slug_uidx";--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_credentials" ADD CONSTRAINT "mailbox_credentials_connection_id_mailbox_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_access_requests_org_email_uidx" ON "gmail_access_requests" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "mailbox_connections_org_idx" ON "mailbox_connections" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "mailbox_credentials_org_idx" ON "mailbox_credentials" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_flows_nonce_hash_uidx" ON "oauth_flows" USING btree ("nonce_hash");--> statement-breakpoint
CREATE INDEX "oauth_flows_org_idx" ON "oauth_flows" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_external_uidx" ON "webhook_events" USING btree ("provider","external_id");--> statement-breakpoint
CREATE POLICY "gmail_access_requests_org_isolation" ON "gmail_access_requests" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("gmail_access_requests"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("gmail_access_requests"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "gmail_access_requests_platform_all" ON "gmail_access_requests" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "mailbox_connections_org_isolation" ON "mailbox_connections" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("mailbox_connections"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("mailbox_connections"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mailbox_connections_platform_all" ON "mailbox_connections" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "mailbox_credentials_org_isolation" ON "mailbox_credentials" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("mailbox_credentials"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("mailbox_credentials"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mailbox_credentials_platform_all" ON "mailbox_credentials" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "oauth_flows_org_isolation" ON "oauth_flows" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("oauth_flows"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("oauth_flows"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "oauth_flows_platform_all" ON "oauth_flows" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);