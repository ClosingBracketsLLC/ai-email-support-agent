# Phase 4 external setup — Robert's checklist

Everything in this file happens OUTSIDE the codebase: two new third-party accounts (Voyage AI and
an object store), environment values on the deployed replicas, one live walk through the Knowledge
screen in a real browser and on a real phone, and one privacy-policy edit. Phase 4's code is
complete and gated without any of it — the E2E (`apps/worker/test/e2e-phase4.test.ts`) drives all
eight verification scenarios through the real api knowledge service and the real pg-boss knowledge
jobs with a deterministic hash embedder and an in-memory object store, and nothing here blocks
`pnpm test`. What it blocks is a real customer document ever being embedded, stored or retrieved.

Read `docs/runbooks/2026-09-phase-3-external-setup.md` first if the send side is not already live:
the `send`-role environment, the `MAIL_FROM` / `APP_BASE_URL` / `APP_WEB_ORIGIN` identity rule and
the Anthropic Console spend limit are all Phase 3 steps this phase assumes are done.

**The precondition that is neither code nor config: the `vector` extension.**
`packages/db/migrations/0012_pgvector.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` as the
non-superuser `aesa_owner` and CANNOT install it itself. Install it once, as the cluster
superuser, on the production database BEFORE deploying Phase 4's migrations:

    psql "<superuser url>" -c 'CREATE EXTENSION IF NOT EXISTS vector'

Locally it is installed by `scripts/db-init/001-roles.sql`, which only runs on a fresh volume — a
dev volume created before Phase 4 needs `pnpm db:down && pnpm db:up` once.

## 1. Voyage AI — the embeddings account

1. **Create the account** at <https://www.voyageai.com> and mint an API key. It is a separate
   vendor from Anthropic (Anthropic owns Voyage, but the billing, the console and the key are
   their own).
2. **Set `VOYAGE_API_KEY`** in `apps/worker/.env` on every replica whose `WORKER_ROLES` includes
   **`knowledge`** (`knowledge.embed-batch` writes every chunk's vector) or **`agent`**
   (`ticket.draft` / `agent.sandbox` embed every retrieval query). `loadConfig` refuses to boot a
   production replica with either role and no key — deliberately loud, because the dev/test
   fallback is a deterministic hash embedder whose vectors are NOT comparable with Voyage's: a
   production box that silently fell back would write a knowledge base its own retrieval could
   never score. The api needs no Voyage key at all.
3. **`KNOWLEDGE_EMBED_MODEL`** — `voyage-4` (the default) or `voyage-4-lite`. The value is stored
   on every chunk as `embedding_model` and is part of the vector leg's `WHERE`, so **changing it on
   a live workspace hides every existing chunk from the vector leg** until Phase 6's re-embed job
   runs (the tsvector leg keeps answering meanwhile). Pick one before the first customer document
   is ingested.

   **It must be IDENTICAL on every `knowledge` and every `agent` replica** — the same
   deploy-wide identity rule `MAIL_FROM` / `APP_BASE_URL` / `APP_WEB_ORIGIN` already have. The
   `knowledge` role writes the model onto each chunk; the `agent` role embeds the query with its
   own model and filters the vector leg by it, so a replica set to a different value retrieves
   nothing from that leg and every draft it makes silently degrades to lexical-only grounding.
   Nothing refuses the mismatch at boot. The one signal is a warning the retriever logs once per
   process per org when its vector leg comes back empty and the org has chunks stored under a
   different `embedding_model` — worth an alert on:

       knowledge vector leg returned nothing and the org has chunks embedded under a different model: KNOWLEDGE_EMBED_MODEL differs across replicas
4. **`KNOWLEDGE_RERANK`** — leave it `off`. `on` adds a Voyage `rerank-2.5` cross-encoder pass over
   the fused top-20 candidates: one extra API call per retrieval, for a better top-6 order. It is
   inert without `VOYAGE_API_KEY`. Turn it on only with a measurement to compare against.
5. **Rate and token limits.** Voyage's per-key limits are requests-per-minute and tokens-per-minute
   on the free tier and are raised on a paid plan — check the current numbers in their console
   before the first bulk crawl, because a 200-page crawl is a burst. Our side already batches under
   **128 texts and ~100,000 estimated tokens per request** (`batchTexts`) and retries a 429 through
   pg-boss (`knowledge.embed-batch`: `retryLimit: 5`, backoff on), resuming from whatever is still
   unembedded.
6. **The daily spend cap lives in OUR database, not theirs.** `knowledge.daily_embed_tokens_cap`
   (5,000,000 tokens per org per UTC day) is read per org by `knowledge.embed-batch` before its
   first call.

   **Plan-tier resolution is not live yet.** `packages/core/src/plans.ts` carries per-plan values,
   but nothing calls `planSettingDefaults`: every `resolveSetting` site passes `{ org }` only, so
   **today every org sits on the settings-catalog defaults — 100 sources, 200 crawl pages,
   5,000,000 embed tokens a day — unless an `org_settings` row overrides it.** Plan tiers arrive
   with Phase 7's billing, which owns the org's `plan` column and the `{ plan }` argument. Until
   then, an `org_settings` row is the ONLY way to give one org a different cap.
   Over the cap, the source records `cap_reached` and the owner sees a failed source that resumes
   after midnight UTC. Override it for one org with a row in `org_settings`. Set a **billing limit
   in the Voyage console too**, as the platform-wide backstop — the same relationship the Anthropic
   Console spend limit has to `autonomy.daily_llm_usd_cap`.

## 2. Object storage — Cloudflare R2 (or S3)

Uploaded files are the one thing that never touches our database. The browser (or the phone) PUTs
them straight into the bucket with a presigned URL the api issues; the worker's `knowledge` role is
the only process that ever reads the bytes back.

1. **Create the bucket.** In Cloudflare R2, create a bucket (e.g. `aesa-prod`) in the location
   nearest the worker. Then **create an R2 API token** scoped to that bucket with **Object Read &
   Write** — the token gives you an Access Key ID and a Secret Access Key, and the account-scoped
   S3 endpoint `https://<account id>.r2.cloudflarestorage.com`.
2. **Set the six `S3_*` variables in BOTH `apps/api/.env` and `apps/worker/.env`, pointing at ONE
   bucket.** They are read by the same `parseS3Env` in both apps and are **all-or-none**: a
   half-configured set throws at boot.

   | variable | R2 value | local minio value |
   | --- | --- | --- |
   | `S3_ENDPOINT` | `https://<account id>.r2.cloudflarestorage.com` | `http://localhost:9000` |
   | `S3_REGION` | `auto` | `us-east-1` |
   | `S3_BUCKET` | `aesa-prod` | `aesa-dev` |
   | `S3_ACCESS_KEY_ID` | the R2 token's access key id | `aesa` |
   | `S3_SECRET_ACCESS_KEY` | the R2 token's secret (a `Secret`; never logged, never returned) | `aesaaesa` |
   | `S3_FORCE_PATH_STYLE` | `false` | `true` |

   Required in production for the **api** (the presigned PUT has nowhere else to point) and for any
   **worker** replica whose `WORKER_ROLES` includes `knowledge` (`knowledge.ingest` reads each
   uploaded file's bytes). In dev/test a missing set falls back to an in-memory store with one
   warning: paste and crawl sources still work, every upload fails "object missing".
3. **The bucket's CORS rule is what makes the browser upload work.** The presigned PUT is issued to
   the owner's own session and hit by *their browser*, cross-origin, so the bucket must allow it.
   Set, on the bucket, the rule `scripts/s3-init.ts` issues locally:

       AllowedOrigins: [ <APP_WEB_ORIGIN> ]     e.g. https://app.example.com
       AllowedMethods: [ PUT, GET ]
       AllowedHeaders: [ * ]
       ExposeHeaders:  [ ETag ]
       MaxAgeSeconds:  3000

   A real S3/R2 bucket supports `PutBucketCors`, so `pnpm s3:init` will set it — or set it by hand
   in the R2 dashboard. **`S3_CORS_ORIGIN` is what the script writes into `AllowedOrigins`, and it
   is NOT one of the six `S3_*` variables the apps read**: it is read by `scripts/s3-init.ts` alone
   and defaults to `http://localhost:8081`, so exporting only the six would quietly point a
   production bucket's CORS rule at a localhost dev server. Export it with the rest:

       S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com \
       S3_REGION=auto \
       S3_BUCKET=aesa-prod \
       S3_ACCESS_KEY_ID=<id> \
       S3_SECRET_ACCESS_KEY=<secret> \
       S3_FORCE_PATH_STYLE=false \
       S3_CORS_ORIGIN=<APP_WEB_ORIGIN> \
       pnpm s3:init

   **MinIO does not**: `PutBucketCors` always
   answers `501 NotImplemented` there, which is why local and CI CORS is server-wide instead, via
   `MINIO_API_CORS_ALLOW_ORIGIN` on the minio container (`compose.yaml`, and the CI `docker run`
   step). `s3:init` tolerates ONLY that 501 and rethrows everything else.
   Symptom of a missing rule: the Knowledge screen's upload sits at 0 % and the browser console
   shows a CORS preflight failure — no server-side error anywhere, because the request never
   reached us.
4. **Object keys and lifecycle.** Every upload lands at `orgs/<orgId>/uploads/<sourceId>/<filename>`.
   Deleting a source deletes its object; an upload over the 20 MiB cap is deleted by
   `knowledge.ingest` before the bytes are ever downloaded. There is no lifecycle rule and no
   bucket-level expiry — an abandoned presign (the owner picked a file and never completed the
   upload) leaves a `queued` source row and no object; a daily sweep for those is a Phase 7
   carry-over.
5. **Local and CI are already wired.** `pnpm db:up` starts minio alongside Postgres (API on
   :9000, console on :9001, `aesa`/`aesaaesa`), and `pnpm s3:init` creates the `aesa-dev` bucket
   (idempotent, safe to re-run). The console at <http://localhost:9001> is the fastest way to see
   whether a browser upload actually landed.

## 3. Tell site owners who we are

The crawler identifies itself on every request with

    User-Agent: aesa-crawler/1.0 (+https://aesa.app)

and matches robots.txt rules against the product token **`aesa-crawler`**
(`CRAWLER_USER_AGENT`, `packages/knowledge/src/crawler/robots.ts`). A customer who wants to keep us
out of part of their site adds

    User-agent: aesa-crawler
    Disallow: /members

to their robots.txt; we honour it (a disallowed URL is never fetched, and counts as skipped). The
crawl starts its requests at least 250 ms apart per host with at most two in flight, https only,
same-site only,
at most 3 redirect hops — each one re-validated against the SSRF guard — and capped by the
workspace's `knowledge.max_crawl_pages` plan setting. **Put that User-Agent string and this
paragraph on the public site** before the first customer crawl: it is the answer to "what is this
bot in my logs?" and it is what makes the opt-out discoverable.

## 4. The live verification walk

Do this once with real credentials, in a real browser, on a real workspace.

1. **Crawl a real site.** In Settings → Knowledge, add the workspace's own public site with a page
   budget. Watch the counter move: the first 20 pages are persisted and embedded as one batch while
   the crawl is still walking, so sources go `queued → processing` with a fetched/ingested/skipped
   progress line within a minute, and land `ready`. Check the site's access log afterwards for
   `aesa-crawler/1.0` and confirm the request rate looks polite.
2. **Upload a real PDF and a real DOCX — from the web app AND from a phone.** Web: drag them onto
   the drop zone (this is the path that exercises the presigned PUT's CORS preflight, section 2.3).
   Phone: the native document picker. Both should reach `ready` with a chunk count. Then try the
   refusals on purpose: a file over 20 MiB, and a `.pages`/`.key` file — the first is refused by the
   api before presigning, the second by the picker's type filter; a file whose *object* is over the
   cap is caught by `knowledge.ingest`'s HEAD and fails the source `too_large` with the object
   deleted.
   **An image-only (scanned) PDF has no text layer and fails `no_text`** — there is no OCR. That is
   the expected answer, and it is worth knowing before a customer asks.
3. **Paste a policy** (returns, shipping, warranty) as a third source and confirm it lands `ready`.
4. **Ask the agent a question the document answers.** Send an ordinary support email to a connected
   agent address, phrased so only the uploaded document can answer it. Then open the draft and check
   the **"Why"** data — `drafts.confidence_breakdown.grounding`:

       select confidence_breakdown->'grounding', cited_chunk_ids, retrieved_chunk_ids
       from drafts where id = '<draft id>';

   - `retrieved` > 0 and `cited` > 0,
   - `score` is the best validated citation's retrieval score (an id the model invented is filtered
     out before it can raise it),
   - `mode` is **`hybrid`** — if it says `lexical`, the embedder failed and retrieval fell back to
     the tsvector leg alone: check the worker log for "knowledge retrieval degraded to lexical" and
     the Voyage key/limits before going further,
   - `knowledgeVersion` matches `workspaces.knowledge_version` for that org.
   Then confirm the answer in the draft body actually comes from the document, not from the
   workspace profile.
5. **Check the metering.**

       select meter, sum(value) from usage_counters
       where org_id = '<org>' and day = current_date group by meter;

   `embed_tokens` and `crawl_pages` should both be non-zero and in the right order of magnitude for
   what you just ingested.
6. **Check the flagged-chunk view.** If the crawled site or a document contains anything that reads
   like an instruction ("ignore the above…"), it is stored flagged and never retrieved, and shows in
   the Knowledge screen's flagged list with its reason. Clear one and confirm it becomes
   retrievable; delete one and confirm it does not.
7. **Delete a source** and confirm its chunks disappear from the next draft's `retrieved_chunk_ids`,
   the object is gone from the bucket, and `workspaces.knowledge_version` moved.

## 5. Privacy and the DPA

**Voyage AI is a new sub-processor.** Every chunk of a customer's uploaded documents and crawled
pages, and every retrieval query derived from a customer email, is sent to Voyage for embedding.
Before the first real customer document:

- add Voyage to the **sub-processor list** in the privacy policy and in any DPA template, alongside
  Anthropic, Resend, the mail providers and the hosting/storage vendors;
- confirm the **data-processing terms** Voyage publishes cover what we need (no training on
  submitted data, retention window, region) and keep a copy;
- add **Cloudflare R2** (or whichever store you chose) as the storage sub-processor — customer
  documents are stored there at rest, which is a stronger statement than "we process email";
- say plainly in the product copy what the Knowledge screen does with a crawl: it fetches public
  pages of the site the owner names, identifying itself as `aesa-crawler`.

## 6. Operator notes

- **A source stuck `processing`.** A crawl holds a 300-second lease; the next attempt re-claims a
  source whose `updated_at` is older than that and re-walks from the start URL (unchanged pages cost
  a fetch and then skip on their content hash). `knowledge.ingest` has **no lease** — a hard death
  mid-parse strands the source at `processing` and the owner has to delete and re-add it; the claim
  token keeps the dead attempt from clobbering anything, and a sweep for stranded sources is a
  Phase 7 carry-over.
- **`cap_reached` on a source** is the workspace's daily embedding budget, not a failure of the
  file. Raise `knowledge.daily_embed_tokens_cap` for that org in `org_settings`, or re-add the
  source after midnight UTC.
- **A crawl that ends `crawl_no_pages`** fetched pages but extracted no text from any of them —
  usually a JavaScript-rendered site (we fetch HTML, we do not run a browser). Ask for a sitemap or
  have the owner paste the content instead.
- **Retrieval never fails a draft.** A Voyage outage degrades retrieval to the tsvector leg
  (`mode: 'lexical'`, one warn line) rather than failing the run — the draft still lands, with
  weaker grounding. That is deliberate, and section 4.4's `mode` check is how you notice it.
- **No global vector index, by design.** Scoring is an exact cosine scan inside one org's rows over
  the `(org_id, document_id)` btree; a shared HNSW index across tenants is what we are refusing.
  It is why retrieval stays per-org fast without a per-tenant index to maintain.
