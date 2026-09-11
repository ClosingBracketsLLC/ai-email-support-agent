-- FORCE RLS on the three knowledge tables (drizzle never emits FORCE)
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Fixed vocabularies, spelled by hand (0008 pattern: @aesa/db has no @aesa/core dependency; contracts KNOWLEDGE_*).
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_kind_check" CHECK ("kind" IN ('upload','paste','crawl'));
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_status_check" CHECK ("status" IN ('queued','processing','ready','failed'));
--> statement-breakpoint
-- The embed-batch work list: every chunk still waiting for a vector, per org (partial indexes live in
-- hand-written SQL, 0006/0011 pattern).
CREATE INDEX "knowledge_chunks_unembedded_idx" ON "knowledge_chunks" ("org_id", "document_id") WHERE "embedding" IS NULL;
