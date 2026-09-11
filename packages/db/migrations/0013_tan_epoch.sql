CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"embedding_version" integer,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
	"injection_flagged" boolean DEFAULT false NOT NULL,
	"injection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_content_check" CHECK (char_length("knowledge_chunks"."content") <= 3000)
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"uri" text NOT NULL,
	"title" text,
	"content_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"embedded_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"title" text NOT NULL,
	"storage_key" text,
	"mime" text,
	"byte_size" integer,
	"url" text,
	"crawl_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pasted_text" text,
	"content_hash" text,
	"document_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"failure_detail" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_document_ordinal_uidx" ON "knowledge_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_org_document_idx" ON "knowledge_chunks" USING btree ("org_id","document_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_source_uri_uidx" ON "knowledge_documents" USING btree ("source_id","uri");--> statement-breakpoint
CREATE INDEX "knowledge_documents_org_source_idx" ON "knowledge_documents" USING btree ("org_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_org_status_idx" ON "knowledge_sources" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_sources_org_created_idx" ON "knowledge_sources" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "knowledge_chunks_org_isolation" ON "knowledge_chunks" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("knowledge_chunks"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("knowledge_chunks"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "knowledge_chunks_platform_all" ON "knowledge_chunks" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "knowledge_documents_org_isolation" ON "knowledge_documents" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("knowledge_documents"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("knowledge_documents"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "knowledge_documents_platform_all" ON "knowledge_documents" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "knowledge_sources_org_isolation" ON "knowledge_sources" AS PERMISSIVE FOR ALL TO "aesa_app" USING ("knowledge_sources"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("knowledge_sources"."org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "knowledge_sources_platform_all" ON "knowledge_sources" AS PERMISSIVE FOR ALL TO "aesa_platform" USING (true) WITH CHECK (true);