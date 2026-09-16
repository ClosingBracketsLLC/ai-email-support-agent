-- Phase 7 fix wave (ruling R33): migration 0023's billing backfill was a silent no-op. Migrations run
-- as aesa_owner, and every tenant table is FORCE ROW LEVEL SECURITY with no policy for that role
-- (client.ts), so 0023's `INSERT … SELECT FROM "workspaces"` saw zero workspaces and inserted nothing
-- — every pre-existing workspace sat on a trial with no clock, which never expires. Re-run it under
-- the platform role.
--
-- SET ROLE, not SET LOCAL ROLE: drizzle runs every pending migration inside ONE transaction, so a
-- SET LOCAL would also be scoped to that transaction — but the explicit RESET ROLE below is what
-- hands the rest of the batch back to aesa_owner either way, and the pair reads as the guarded
-- block it is. migrations.test.ts's guard makes any later data write against a tenant table
-- require the same pair.
--
-- DO UPDATE, not DO NOTHING (0023's shape): a workspace that has already been touched since Phase 7
-- landed has a row minted by ensureBillingRow with a NULL clock, and DO NOTHING would leave that
-- NULL in place. COALESCE keeps a clock that IS set (setAgentEnabled's own stamp) and fills only the
-- missing ones; the WHERE keeps a row that has moved past `trialing` (a paid or cancelled
-- workspace) untouched. A workspace whose `agent_enabled_at` is NULL gets a NULL clock either way:
-- the trial only starts when the agent is first switched on.
SET ROLE aesa_platform;
--> statement-breakpoint
INSERT INTO "billing_subscriptions" ("org_id", "trial_ends_at")
  SELECT "org_id", "agent_enabled_at" + interval '14 days' FROM "workspaces"
  ON CONFLICT ("org_id") DO UPDATE
    SET "trial_ends_at" = COALESCE("billing_subscriptions"."trial_ends_at", EXCLUDED."trial_ends_at")
    WHERE "billing_subscriptions"."status" = 'trialing';
--> statement-breakpoint
RESET ROLE;
