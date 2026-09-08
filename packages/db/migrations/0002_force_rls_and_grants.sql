ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_data_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "aesa_app", "aesa_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspaces", "org_settings", "usage_counters", "audit_log", "org_data_keys" TO "aesa_app", "aesa_platform";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "audit_log_id_seq" TO "aesa_app", "aesa_platform";--> statement-breakpoint
GRANT SELECT ON "platform_state" TO "aesa_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_state" TO "aesa_platform";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "aesa_app", "aesa_platform";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "aesa_app", "aesa_platform";--> statement-breakpoint
GRANT USAGE ON SCHEMA drizzle TO "aesa_app", "aesa_platform";--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO "aesa_app", "aesa_platform";--> statement-breakpoint
-- INHERIT FALSE: membership is only for SET ROLE; the migration role must NOT inherit aesa_platform's
-- USING (true) policy (see scripts/db-init/001-roles.sql).
DO $$ BEGIN
  EXECUTE 'GRANT "aesa_app", "aesa_platform" TO ' || quote_ident(CURRENT_USER) || ' WITH INHERIT FALSE';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
