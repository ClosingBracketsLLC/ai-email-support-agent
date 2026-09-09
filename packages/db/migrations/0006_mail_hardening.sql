-- FORCE RLS on the four new tenant tables (drizzle never emits FORCE)
ALTER TABLE "oauth_flows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mailbox_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mailbox_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gmail_access_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Credential tokens are worker-only (deviation 2): the api never touches this table — sealed blobs
-- reach the worker through a job payload. Migration 0002's default privileges granted aesa_app full DML;
-- take it all back. aesa_platform keeps its default grant.
REVOKE ALL ON "mailbox_credentials" FROM "aesa_app";
--> statement-breakpoint
-- webhook_events is a platform table: the api (aesa_app) inserts/dedupes, the platform role prunes.
-- Default privileges already grant both roles DML; nothing to revoke. Kept as a comment so the next
-- reader knows the omission is deliberate.
-- One connected/claimable row per (provider, address); a disabled row must not block a reconnect.
CREATE UNIQUE INDEX "mailbox_connections_provider_email_uidx"
  ON "mailbox_connections" ("provider", "email_address") WHERE "status" <> 'disabled';
--> statement-breakpoint
-- Phase 1 residual: organization.slug carried both .unique() and organization_slug_uidx (Better Auth CLI copy)
DROP INDEX IF EXISTS "organization_slug_uidx";
--> statement-breakpoint
-- The api's only cross-org read path (spec, tenancy net 1). Fixed signatures, no dynamic SQL, search_path
-- pinned against search_path hijacking.
CREATE OR REPLACE FUNCTION resolve_mailbox_connection(p_provider text, p_email text)
RETURNS TABLE (connection_id uuid, org_id uuid, client_state_hash text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT id, org_id, push_client_state_hash
  FROM mailbox_connections
  WHERE provider = p_provider AND email_address = lower(p_email) AND status <> 'disabled'
  LIMIT 1
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_mailbox_subscription(p_subscription_id text)
RETURNS TABLE (connection_id uuid, org_id uuid, client_state_hash text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT id, org_id, push_client_state_hash
  FROM mailbox_connections
  WHERE push_subscription_id = p_subscription_id AND status <> 'disabled'
  LIMIT 1
$$;
--> statement-breakpoint
-- Deviation from the brief: SECURITY DEFINER runs the function body AS ITS OWNER for every purpose,
-- including row-level security. migrations run under role=aesa_owner (see client.ts), and aesa_owner is
-- the table owner — but mailbox_connections has FORCE ROW LEVEL SECURITY, which (per tenant.test.ts's
-- "the table owner sees nothing without a policy match") applies RLS to the owner exactly like any other
-- role. Neither tenant policy's TO clause names aesa_owner, so a function left owned by aesa_owner would
-- see zero rows — silently defeating the whole point of the resolver. Re-own both functions to
-- aesa_platform (aesa_owner is already a WITH INHERIT FALSE member of it, so it may transfer ownership)
-- so the body runs under "..._platform_all USING (true)" — the api's only cross-org bypass, deliberately
-- scoped to exactly these two lookups instead of full aesa_platform membership.
--
-- ALTER ... OWNER TO on a schema object additionally requires the NEW owner to hold CREATE on the
-- containing schema (not just USAGE, which is all migration 0002 granted aesa_platform) — grant it only
-- for the transfer, then take it back so aesa_platform gains no standing ability to create objects.
GRANT CREATE ON SCHEMA public TO "aesa_platform";
--> statement-breakpoint
ALTER FUNCTION resolve_mailbox_connection(text, text) OWNER TO "aesa_platform";
--> statement-breakpoint
ALTER FUNCTION resolve_mailbox_subscription(text) OWNER TO "aesa_platform";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM "aesa_platform";
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_mailbox_connection(text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_mailbox_subscription(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_mailbox_connection(text, text) TO "aesa_app";
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_mailbox_subscription(text) TO "aesa_app";
