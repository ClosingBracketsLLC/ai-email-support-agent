-- Phase 7: the platform-wide audit retention arm scans by age across every org, so it needs an index
-- that does not lead with org_id (audit_log_org_created_idx cannot serve it — PG 17 has no btree skip
-- scan). Completes the set migration 0023 started for llm_calls and notifications.
CREATE INDEX IF NOT EXISTS "audit_log_created_idx" ON "audit_log" ("created_at");
