DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_app') THEN CREATE ROLE "aesa_app"; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_platform') THEN CREATE ROLE "aesa_platform"; END IF; END $$;
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_data_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_log_org_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("audit_log"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("audit_log"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_platform_all" ON "audit_log" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "org_data_keys_org_isolation" ON "org_data_keys" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("org_data_keys"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_data_keys"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "org_data_keys_platform_all" ON "org_data_keys" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "org_settings_org_isolation" ON "org_settings" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("org_settings"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_settings"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "org_settings_platform_all" ON "org_settings" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "usage_counters_org_isolation" ON "usage_counters" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("usage_counters"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("usage_counters"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "usage_counters_platform_all" ON "usage_counters" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "workspaces_org_isolation" ON "workspaces" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("workspaces"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("workspaces"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "workspaces_platform_all" ON "workspaces" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);