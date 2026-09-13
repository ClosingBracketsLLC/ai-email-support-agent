-- Phase 4 residual: the source cap's read-then-insert and `refreshCrawl`'s resurrect race — one live crawl per URL per org.
CREATE UNIQUE INDEX "knowledge_sources_org_crawl_url_uidx" ON "knowledge_sources" ("org_id", "url") WHERE "kind" = 'crawl' AND "status" <> 'failed';
