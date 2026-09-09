-- The api's second fixed-signature SECURITY DEFINER resolver (spec net 1), same shape and same
-- REVOKE/GRANT/ALTER-OWNER pattern as 0006_mail_hardening.sql's resolve_mailbox_connection /
-- resolve_mailbox_subscription. The OAuth callback (Task 17) carries no session — the system browser
-- hits it directly — so the pending oauth_flows row has to be found by flow id alone, before any org is
-- known. search_path pinned against search_path hijacking, same as 0006's pair.
CREATE OR REPLACE FUNCTION resolve_oauth_flow(p_flow_id uuid)
RETURNS TABLE (flow_id uuid, org_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT id, org_id
  FROM oauth_flows
  WHERE id = p_flow_id
  LIMIT 1
$$;
--> statement-breakpoint
-- ACL first, ownership transfer second — deliberately in this order, for the same reason 0006 documents
-- in full: REVOKE/GRANT issued by a non-owner, non-superuser role are silently downgraded to a no-op
-- WARNING once the function is owned by aesa_platform, so the lockdown has to land while aesa_owner (the
-- migration role) still owns the function.
REVOKE ALL ON FUNCTION resolve_oauth_flow(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_oauth_flow(uuid) TO "aesa_app";
--> statement-breakpoint
-- oauth_flows has FORCE ROW LEVEL SECURITY (0005). A SECURITY DEFINER function left owned by aesa_owner
-- would run its body as a role with zero matching policies and return nothing — see 0006's comment for
-- the full explanation ("the table owner sees nothing without a policy match", tenant.test.ts). Re-own to
-- aesa_platform so the body runs under "oauth_flows_platform_all USING (true)".
--
-- ALTER ... OWNER TO on a schema object additionally requires the NEW owner to hold CREATE on the
-- containing schema (not just USAGE, which 0002 granted aesa_platform) — grant it only for the transfer,
-- then take it back so aesa_platform gains no standing ability to create objects.
GRANT CREATE ON SCHEMA public TO "aesa_platform";
--> statement-breakpoint
ALTER FUNCTION resolve_oauth_flow(uuid) OWNER TO "aesa_platform";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM "aesa_platform";
