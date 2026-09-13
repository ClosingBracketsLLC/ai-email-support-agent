-- Phase 7: the platform-wide age sweeps need an index that does not lead with org_id.
-- agent_runs gained one row per inbound email in Phase 6 (triage runs) and nothing pruned it.
CREATE INDEX IF NOT EXISTS "agent_runs_started_idx" ON "agent_runs" ("started_at");
