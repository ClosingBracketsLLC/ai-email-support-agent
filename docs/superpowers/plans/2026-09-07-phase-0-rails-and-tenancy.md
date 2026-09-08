# Phase 0 — Rails and Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable pnpm monorepo skeleton (db, crypto, core, queue packages; api + worker apps; CI) in which cross-organization data access is impossible by construction before any product feature exists.

**Architecture:** One Postgres 17 + pgvector database with every tenant table carrying `org_id` and forced row-level security; all tenant access goes through `withOrg(orgId)` which switches to the `aesa_app` role and sets `app.org_id` inside a transaction; platform sweeps use `withPlatform()`; jobs are defined with zod payloads that require `orgId` and receive an `AbortSignal`; secrets are envelope-encrypted per organization with a sealed-box enrollment path so the internet-facing api never holds the master key.

**Tech Stack:** Node 22, TypeScript 5.9 (strict, NodeNext ESM, `tsx` runtime, no build step), pnpm 10 workspaces, Postgres 17 (`pgvector/pgvector:pg17` image), drizzle-orm 0.44 + drizzle-kit 0.31, pg-boss 10.4, Fastify 5, zod 4, vitest 3, libsodium-wrappers, undici 7, ESLint 9 + typescript-eslint.

**Spec:** `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md` — sections *Architecture → Where tenancy is enforced*, *Queue and job model*, *Data model*, *LLM provider adapter → Security*, *Build phases → Phase 0*, and *Exploration findings → Cross-cutting rules*.

## Global Constraints

- Node `>=22`; every package is `"type": "module"`; imports carry explicit `.ts` extensions; `tsconfig.base.json` is copied verbatim from doge-buddy (`strict`, `nodenext`, `noUncheckedIndexedAccess`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `noEmit`).
- Runtime dependencies live in `dependencies` (never `devDependencies`) — the spec fixes doge-buddy's drizzle-in-devDeps trap; production runs `tsx src/index.ts`.
- Package names: `@aesa/db`, `@aesa/crypto`, `@aesa/core`, `@aesa/queue`, `@aesa/api`, `@aesa/worker`. Codename `aesa` is the working name; renaming is a find-and-replace.
- Every tenant table: `org_id uuid NOT NULL` leads every index and unique; RLS policy `USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)`; RLS is ENABLED and FORCED; roles `aesa_app` (tenant traffic) and `aesa_platform` (sweeps, `USING (true)`).
- A `withOrg` transaction never spans network I/O; the app role has `idle_in_transaction_session_timeout = '5s'` and `statement_timeout = '30s'`.
- Job payloads always carry `orgId`; `singletonKey` is always `${orgId}:${entityId}`; `defineJob` injects an `AbortSignal` whose deadline is `expireInSeconds - 30`.
- Secrets: never logged, never returned by an API; the `Secret` type serializes as `[redacted]`; log redaction covers every query-string value and any base64url path segment of 32+ chars.
- Local Postgres on port **5434** (doge-buddy already uses 5433); credentials `aesa:aesa`, database `aesa_dev`; tests default `DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev`.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; work on branch `spec/2026-09-07-design` (or a `phase-0` branch off it).

## Deviations from the spec's Phase 0 list (flagged; the spec wins on everything else)

1. **Better Auth tables move to Phase 1.** They are generated from the auth config (`npx @better-auth/cli generate`) that Phase 1 creates; Phase 0 leaves `workspaces.org_id` as `uuid` **without** a foreign key, and Phase 1 adds the FK after generating Better Auth's tables with `advanced.database.generateId: false` and `uuid` id columns.
2. **`SECURITY DEFINER` resolvers move to Phase 2** with the first table they resolve (`mailbox_connections`); Phase 0 establishes the role split they rely on and proves it in the isolation suite.
3. **`agent.orphan-sweep` moves to Phase 3** (it needs `agent_runs`); Phase 0's worker registers a `platform.heartbeat` cron instead to prove the cron rails, `WORKER_ROLES` partitioning and `withPlatform()`.
4. **Role model:** one `DATABASE_URL` (the migration/owner role); app pools run `SET ROLE aesa_app` on every checked-out connection, and `withPlatform()` uses `SET LOCAL ROLE aesa_platform`. Separate LOGIN roles per process are a production hardening step documented in the README, not code.

## File structure

```
ai-email-support-agent/
├── package.json · pnpm-workspace.yaml · tsconfig.base.json · compose.yaml · eslint.config.js · .gitignore · README.md
├── scripts/check-migration-drift.sh
├── .github/workflows/ci.yml
├── packages/
│   ├── db/            drizzle schema (src/schema/*.ts), roles + policies, migrations/, client.ts (createDb, runMigrations), tenant.ts (withOrg, OrgTx, withPlatform), raw.ts (createDb re-export gated by ESLint), keys.ts (org data-key rows)
│   ├── crypto/        secret.ts, tokens.ts, envelope.ts, sealed-box.ts, ssrf/{ranges,resolve-public,pinned-fetch}.ts
│   ├── core/          tripwire.ts, transitions.ts (+ ticket/draft matrices), settings-catalog.ts, plans.ts, invariants.ts
│   └── queue/         pg-boss.ts (createQueueRetrying, registerCron), define-job.ts, enqueue.ts, fair-select.ts
└── apps/
    ├── api/           config.ts, load-env.ts, redact.ts, server.ts (/healthz), index.ts
    └── worker/        config.ts, load-env.ts, roles.ts, jobs/platform-heartbeat.ts, index.ts
```

Each task below is self-contained: it lists the exact files, the failing test first, the implementation, the verification command, and the commit.

---

### Task 1: Workspace scaffold (pnpm, tsconfig, compose, root scripts)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `compose.yaml`, `.gitignore`, `.npmrc`, `README.md` (dev section)
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/vitest.config.ts`, `packages/core/test/smoke.test.ts`

**Interfaces:**
- Produces: the root scripts `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm db:up`, `pnpm db:down`, `pnpm db:check`; the shared `tsconfig.base.json`; the local Postgres at `localhost:5434`.

- [ ] **Step 1: Write the failing smoke test**

`packages/core/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.ts'

describe('workspace smoke', () => {
  it('resolves the core package', () => {
    expect(PACKAGE_NAME).toBe('@aesa/core')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/core test`
Expected: FAIL — the package (and pnpm workspace) do not exist yet.

- [ ] **Step 3: Create the workspace files**

`package.json`:
```json
{
  "name": "ai-email-support-agent",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.12.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "lint": "eslint .",
    "db:up": "docker compose up -d db --wait",
    "db:down": "docker compose down -v",
    "db:check": "bash scripts/check-migration-drift.sh"
  },
  "devDependencies": {
    "@eslint/js": "^9.30.0",
    "eslint": "^9.30.0",
    "typescript": "^5.9.2",
    "typescript-eslint": "^8.35.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`.npmrc`:
```
auto-install-peers=true
strict-peer-dependencies=false
```

`tsconfig.base.json` (verbatim from doge-buddy):
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2023"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "declaration": false,
    "noEmit": true
  }
}
```

`compose.yaml`:
```yaml
services:
  db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: aesa
      POSTGRES_PASSWORD: aesa
      POSTGRES_DB: aesa_dev
    ports:
      - "5434:5432"
    volumes:
      - ./scripts/db-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aesa -d aesa_dev"]
      interval: 2s
      timeout: 3s
      retries: 15
```

`scripts/db-init/001-roles.sql` (runs once at container init; the compose user `aesa` is a superuser, which bypasses RLS, so migrations and tests run as the non-superuser owner `aesa_owner` — CI creates the same roles with `psql`, Task 16):
```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_owner') THEN CREATE ROLE aesa_owner NOLOGIN CREATEROLE CREATEDB; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_app') THEN CREATE ROLE aesa_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_platform') THEN CREATE ROLE aesa_platform NOLOGIN; END IF;
END $$;
GRANT aesa_app, aesa_platform TO aesa_owner;
ALTER DATABASE aesa_dev OWNER TO aesa_owner;
```

`.gitignore`:
```
node_modules/
.env
.env.*
!.env.example
dist/
coverage/
*.tsbuildinfo
.DS_Store
```

`packages/core/package.json`:
```json
{
  "name": "@aesa/core",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": { "@types/node": "^22", "tsx": "^4.20.0", "typescript": "^5.9.2", "vitest": "^3.2.0" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"] }
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

`packages/core/src/index.ts`:
```ts
export const PACKAGE_NAME = '@aesa/core'
```

`README.md` — append a **Development** section:

    ## Development

    Requires Node >= 22, pnpm 10, Docker.

        corepack enable
        pnpm install
        pnpm db:up                                   # Postgres 17 + pgvector on :5434
        DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev pnpm --filter @aesa/db migrate
        pnpm typecheck && pnpm test && pnpm lint

    Layout: `apps/api` (Fastify), `apps/worker` (pg-boss), `packages/{db,crypto,core,queue}`.
    Design spec: `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md`.

- [ ] **Step 4: Install and run the smoke test**

Run: `corepack enable && pnpm install && pnpm db:up && pnpm --filter @aesa/core test && pnpm typecheck`
Expected: `pnpm install` succeeds; the compose container reports healthy; the smoke test PASSES; typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json compose.yaml .gitignore README.md packages/core
git commit -m "chore: pnpm workspace, base tsconfig, local Postgres compose, core package smoke test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `@aesa/db` — client, tenant tables, first migration

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/vitest.config.ts`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema/helpers.ts`, `packages/db/src/schema/tenancy.ts`, `packages/db/src/schema/platform.ts`, `packages/db/src/schema/index.ts`
- Create: `packages/db/src/client.ts`, `packages/db/src/raw.ts`, `packages/db/src/index.ts`, `packages/db/scripts/migrate.ts`
- Create: `packages/db/test/helpers/test-db.ts`, `packages/db/test/migrations.test.ts`
- Generated: `packages/db/migrations/0000_*.sql` + `migrations/meta/*` (by `drizzle-kit generate`)

**Interfaces:**
- Produces: `createDb(connectionString, opts?: { role?: 'owner' | 'app' })` → `{ db: Db; pool: pg.Pool }` (exported ONLY from `@aesa/db/raw`); `runMigrations(url)`; schema exports `workspaces`, `orgSettings`, `usageCounters`, `auditLog`, `orgDataKeys`, `platformState`; type `Db`; `bytea` custom type; test helper `createTestDatabase()` → `{ url, drop() }`.

- [ ] **Step 1: Write the failing migrations test**

`packages/db/test/helpers/test-db.ts`:
```ts
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { runMigrations } from '../../src/raw.ts'

export const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'

/** Creates a fresh database in the local cluster, migrates it, and returns its URL + a drop() hook. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `aesa_test_${Date.now()}_${randomBytes(3).toString('hex')}`
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name} OWNER aesa_owner`)
  await admin.end()
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`)
  await runMigrations(url)
  return {
    url,
    drop: async () => {
      const c = new pg.Client({ connectionString: ADMIN_URL })
      await c.connect()
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await c.end()
    },
  }
}
```

`packages/db/test/migrations.test.ts`:
```ts
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { workspaces } from '../src/index.ts'
import { createDb, runMigrations } from '../src/raw.ts'
import { createTestDatabase } from './helpers/test-db.ts'

const EXPECTED_TABLES = ['audit_log', 'org_data_keys', 'org_settings', 'platform_state', 'usage_counters', 'workspaces']

describe('migrations', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  beforeAll(async () => { t = await createTestDatabase() })
  afterAll(async () => { await t.drop() })

  it('creates exactly the Phase 0 tables', async () => {
    const c = new pg.Client({ connectionString: t.url })
    await c.connect()
    const res = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\' ORDER BY table_name`,
    )
    await c.end()
    expect(res.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)
  })

  it('is idempotent', async () => {
    await expect(runMigrations(t.url)).resolves.not.toThrow()
  })

  // platform_state (not a tenant table) so this test keeps passing after Task 3 forces RLS on tenant tables.
  it('bumps updated_at through $onUpdate', async () => {
    const { db, pool } = createDb(t.url, { role: 'owner' })
    try {
      await db.insert(platformState).values({ key: 'onupdate-test', value: { n: 1 } })
      const [before] = await db.select().from(platformState).where(eq(platformState.key, 'onupdate-test'))
      await new Promise((r) => setTimeout(r, 20))
      await db.update(platformState).set({ value: { n: 2 } }).where(eq(platformState.key, 'onupdate-test'))
      const [after] = await db.select().from(platformState).where(eq(platformState.key, 'onupdate-test'))
      expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime())
    } finally {
      await pool.end()
    }
  })
})
```
(import `platformState` instead of `workspaces` from `../src/index.ts`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/db test`
Expected: FAIL — package not found.

- [ ] **Step 3: Create the package, schema and client**

`packages/db/package.json`:
```json
{
  "name": "@aesa/db",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./raw": "./src/raw.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "generate": "drizzle-kit generate",
    "migrate": "tsx scripts/migrate.ts"
  },
  "dependencies": { "drizzle-orm": "^0.44.0", "pg": "^8.16.0" },
  "devDependencies": { "@types/node": "^22", "@types/pg": "^8.15.0", "drizzle-kit": "^0.31.0", "tsx": "^4.20.0", "typescript": "^5.9.2", "vitest": "^3.2.0" }
}
```

`packages/db/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "scripts", "drizzle.config.ts", "vitest.config.ts"] }`

`packages/db/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
// Every db test file creates its own database; files may run in parallel safely.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 } })
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  // Roles (aesa_app / aesa_platform, Task 3) are managed by drizzle-kit so CREATE ROLE and
  // ENABLE ROW LEVEL SECURITY land in generated migrations instead of by hand.
  entities: { roles: true },
})
```

`packages/db/src/schema/helpers.ts`:
```ts
import { sql } from 'drizzle-orm'
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core'

export const id = () => uuid('id').primaryKey().defaultRandom()
export const orgId = () => uuid('org_id').notNull()
export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())

/** drizzle-orm has no bytea column; ciphertexts and keys use this. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea' },
})

export const emptyTextArray = () => sql`'{}'::text[]`
```

`packages/db/src/schema/tenancy.ts`:
```ts
import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, check, date, index, inet, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core'
import { bytea, createdAt, emptyTextArray, orgId, updatedAt } from './helpers.ts'

export const ONBOARDING_STEPS = ['profile', 'mailbox', 'knowledge', 'go_live', 'done'] as const
export const TONES = ['friendly', 'formal', 'concise'] as const

/** One row per organization: business identity, guardrail allowlists, guidance, switches. */
export const workspaces = pgTable('workspaces', {
  orgId: uuid('org_id').primaryKey(),               // FK to Better Auth's organization.id lands in Phase 1
  businessName: text('business_name').notNull(),
  websiteUrl: text('website_url'),
  description: text('description'),
  tone: text('tone').notNull().default('friendly'),
  timezone: text('timezone').notNull(),
  locale: text('locale').notNull().default('en'),
  contactPhone: text('contact_phone'),
  contactUrls: text('contact_urls').array().notNull().default(emptyTextArray()),
  allowedUrlHosts: text('allowed_url_hosts').array().notNull().default(emptyTextArray()),
  allowedEmailDomains: text('allowed_email_domains').array().notNull().default(emptyTextArray()),
  tripwireExtraKeywords: text('tripwire_extra_keywords').array().notNull().default(emptyTextArray()),
  operatingGuidance: text('operating_guidance').notNull().default(''),
  agentEnabled: boolean('agent_enabled').notNull().default(false),
  agentEnabledAt: timestamp('agent_enabled_at', { withTimezone: true }),
  killSwitch: boolean('kill_switch').notNull().default(false),
  onboardingStep: text('onboarding_step').notNull().default('profile'),
  retentionDays: integer('retention_days').notNull().default(180),
  knowledgeVersion: integer('knowledge_version').notNull().default(0),
  /** X25519 public key the api seals new secrets to (Task 7); the private key lives in org_data_keys. */
  boxPublicKey: bytea('box_public_key'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('workspaces_tone_check', sql`${t.tone} IN ('friendly','formal','concise')`),
  check('workspaces_onboarding_step_check', sql`${t.onboardingStep} IN ('profile','mailbox','knowledge','go_live','done')`),
  check('workspaces_retention_days_check', sql`${t.retentionDays} BETWEEN 30 AND 730`),
])

/** Per-org typed key/value overrides; resolution is org override > plan default > code default. */
export const orgSettings = pgTable('org_settings', {
  orgId: orgId(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.key] })])

/** The metering table every cap and every bill reads. Meters are plain text so adding one needs no migration. */
export const usageCounters = pgTable('usage_counters', {
  orgId: orgId(),
  day: date('day').notNull(),
  meter: text('meter').notNull(),
  value: bigint('value', { mode: 'number' }).notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.day, t.meter] })])

/** Append-only trail with real actor identity: user:<id> | agent:<run_id> | system:<job>. Never bodies. */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  orgId: uuid('org_id'),                               // NULL only for platform events
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
}, (t) => [
  index('audit_log_org_created_idx').on(t.orgId, t.createdAt.desc()),
  index('audit_log_org_entity_idx').on(t.orgId, t.entityType, t.entityId),
])

/** Per-org data-encryption keys (Task 6/7): the DEK wrapped by a versioned KEK, and the sealed-box keypair. */
export const orgDataKeys = pgTable('org_data_keys', {
  orgId: orgId(),
  version: integer('version').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  kekVersion: integer('kek_version').notNull(),
  boxPublicKey: bytea('box_public_key').notNull(),
  boxPrivateKeyCiphertext: bytea('box_private_key_ciphertext').notNull(),   // encrypted under the DEK
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.version] })])
```

`packages/db/src/schema/platform.ts`:
```ts
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { updatedAt } from './helpers.ts'

/** Platform switches and provider backoff shared by all workers (killswitch.global, *.backoff_until …). No RLS. */
export const platformState = pgTable('platform_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})
```

`packages/db/src/schema/index.ts`:
```ts
export * from './helpers.ts'
export * from './tenancy.ts'
export * from './platform.ts'
```

`packages/db/src/client.ts`:
```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import * as schema from './schema/index.ts'

export type Db = NodePgDatabase<typeof schema>

export interface CreateDbOptions {
  /**
   * 'app' (the default for api/worker): every checked-out connection runs `SET ROLE aesa_app` plus the
   * app-role timeouts, so even a raw handle is subject to forced RLS and sees no tenant rows without
   * `withOrg`. 'owner': the migration/test-admin role — no SET ROLE, bypasses nothing by policy but
   * is the table owner (RLS is FORCED, so it still sees nothing without a policy match).
   */
  role?: 'owner' | 'app'
  pool?: Omit<pg.PoolConfig, 'connectionString'>
}

export function createDb(connectionString: string, opts: CreateDbOptions = {}): { db: Db; pool: pg.Pool } {
  // The connection user is the cluster admin (locally a superuser, which bypasses RLS). Every connection
  // STARTS in a non-superuser role via libpq startup options (`-c role=…` is applied by the server before
  // the first query — no client-side SET ROLE race, nothing for pg's deprecated query queuing to order):
  // 'app' → aesa_app (forced RLS + the app timeouts), 'owner' → aesa_owner (owns the tables; migrations
  // run as it; FORCE RLS applies to it too). The login user must be a member of both roles.
  const startupOptions =
    (opts.role ?? 'app') === 'app'
      ? '-c role=aesa_app -c idle_in_transaction_session_timeout=5s -c statement_timeout=30s'
      : '-c role=aesa_owner'
  const pool = new pg.Pool({ ...opts.pool, connectionString, options: startupOptions })
  return { db: drizzle(pool, { schema }), pool }
}
```
And `migrations.test.ts` gains one assertion that the role switch really happened:
```ts
  it('owner pool connections run as aesa_owner from the first query', async () => {
    const { pool } = createDb(t.url, { role: 'owner' })
    try {
      const res = await pool.query<{ current_user: string }>('SELECT current_user')
      expect(res.rows[0]!.current_user).toBe('aesa_owner')
    } finally {
      await pool.end()
    }
  })
```
(The `app` pool's `current_user = 'aesa_app'` assertion lives in Task 4, once grants exist.)
```ts

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString, { role: 'owner' })
  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await pool.end()
  }
}
```

`packages/db/src/raw.ts` — the ONLY module allowed to hand out an unscoped handle (ESLint-gated in Task 15):
```ts
export { createDb, runMigrations, type CreateDbOptions, type Db } from './client.ts'
```

`packages/db/src/index.ts`:
```ts
export * from './schema/index.ts'
export type { Db } from './client.ts'
```

`packages/db/scripts/migrate.ts`:
```ts
import { runMigrations } from '../src/raw.ts'

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL is required'); process.exit(1) }
await runMigrations(url)
console.log('migrations applied')
```

- [ ] **Step 4: Generate the migration and run the tests**

Run: `pnpm install && pnpm --filter @aesa/db generate && pnpm --filter @aesa/db test && pnpm --filter @aesa/db typecheck`
Expected: `migrations/0000_*.sql` + `migrations/meta/0000_snapshot.json` + `_journal.json` are created; all three tests PASS. (The roles `aesa_owner`/`aesa_app`/`aesa_platform` already exist locally from the compose init script in Task 1; if the container predates that script, run `pnpm db:down && pnpm db:up` once.)

- [ ] **Step 5: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): drizzle client, Phase 0 tenant tables, first migration, fresh-database test helper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Roles, RLS policies, forced RLS and grants

**Files:**
- Create: `packages/db/src/schema/roles.ts`, `packages/db/test/rls.test.ts`
- Modify: `packages/db/src/schema/helpers.ts` (add `tenantPolicies`), `packages/db/src/schema/tenancy.ts` (attach policies), `packages/db/src/schema/index.ts` (export roles)
- Generated then hand-edited: `packages/db/migrations/0001_*.sql` (idempotent `CREATE ROLE`)
- Create (custom migration): `packages/db/migrations/0002_force_rls_and_grants.sql`

**Interfaces:**
- Produces: `aesaApp`, `aesaPlatform` (`pgRole`s); `tenantPolicies(orgIdColumn, tableName)` → two `pgPolicy`s; the SQL predicate constant `ORG_ID_PREDICATE_SQL = "org_id = NULLIF(current_setting('app.org_id', true), '')::uuid"`.

- [ ] **Step 1: Write the failing RLS test**

`packages/db/test/rls.test.ts`:
```ts
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from './helpers/test-db.ts'

const TENANT_TABLES = ['workspaces', 'org_settings', 'usage_counters', 'audit_log', 'org_data_keys']

describe('row-level security', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let c: pg.Client
  beforeAll(async () => {
    t = await createTestDatabase()
    c = new pg.Client({ connectionString: t.url })
    await c.connect()
  })
  afterAll(async () => { await c.end(); await t.drop() })

  it('creates both runtime roles', async () => {
    const res = await c.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('aesa_app','aesa_platform') ORDER BY 1`)
    expect(res.rows.map((r) => r.rolname)).toEqual(['aesa_app', 'aesa_platform'])
  })

  it.each(TENANT_TABLES)('%s has RLS enabled AND forced', async (table) => {
    const res = await c.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table])
    expect(res.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  })

  it.each(TENANT_TABLES)('%s has an org-isolation policy for aesa_app and a platform policy for aesa_platform', async (table) => {
    const res = await c.query(
      `SELECT policyname, roles::text[] AS roles, qual FROM pg_policies WHERE tablename = $1 ORDER BY policyname`, [table],
    )
    const byName = Object.fromEntries(res.rows.map((r) => [r.policyname, r]))
    expect(byName[`${table}_org_isolation`].roles).toEqual(['aesa_app'])
    expect(byName[`${table}_org_isolation`].qual).toContain("NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid")
    expect(byName[`${table}_platform_all`].roles).toEqual(['aesa_platform'])
  })

  it('platform_state has no RLS, is readable by aesa_app and writable only by aesa_platform', async () => {
    const rls = await c.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'platform_state'`)
    expect(rls.rows[0]).toEqual({ relrowsecurity: false })
    const grants = await c.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'platform_state' AND grantee IN ('aesa_app','aesa_platform') ORDER BY 1, 2`,
    )
    const appPrivs = grants.rows.filter((r) => r.grantee === 'aesa_app').map((r) => r.privilege_type)
    const platformPrivs = grants.rows.filter((r) => r.grantee === 'aesa_platform').map((r) => r.privilege_type)
    expect(appPrivs).toEqual(['SELECT'])
    expect(platformPrivs).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']))
  })

  it('migrates a SECOND database in the same cluster (CREATE ROLE is idempotent)', async () => {
    const second = await createTestDatabase()
    await second.drop()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/db test -- rls`
Expected: FAIL — no roles, no policies.

- [ ] **Step 3: Define roles and policies in the schema**

`packages/db/src/schema/roles.ts`:
```ts
import { pgRole } from 'drizzle-orm/pg-core'

/** Tenant traffic: forced RLS, sees only rows where org_id matches the transaction's app.org_id. */
export const aesaApp = pgRole('aesa_app')
/** Platform sweeps and crons: policy USING (true); reached only through withPlatform(). */
export const aesaPlatform = pgRole('aesa_platform')
```

Append to `packages/db/src/schema/helpers.ts`:
```ts
import { pgPolicy, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { aesaApp, aesaPlatform } from './roles.ts'

export const ORG_ID_PREDICATE_SQL = "org_id = NULLIF(current_setting('app.org_id', true), '')::uuid"

/**
 * The two policies every tenant table gets. NULLIF matters: a pooled connection that ran SET LOCAL in an
 * earlier transaction leaves app.org_id as '' (not NULL) and ''::uuid would raise instead of matching nothing.
 */
export function tenantPolicies(orgIdColumn: AnyPgColumn, table: string) {
  const predicate = sql`${orgIdColumn} = NULLIF(current_setting('app.org_id', true), '')::uuid`
  return [
    pgPolicy(`${table}_org_isolation`, { as: 'permissive', for: 'all', to: aesaApp, using: predicate, withCheck: predicate }),
    pgPolicy(`${table}_platform_all`, { as: 'permissive', for: 'all', to: aesaPlatform, using: sql`true`, withCheck: sql`true` }),
  ]
}
```
(`sql` is already imported at the top of helpers.ts.)

Modify `packages/db/src/schema/tenancy.ts` — add `...tenantPolicies(t.orgId, '<table>')` to each table's extras array, e.g. for workspaces:
```ts
}, (t) => [
  check('workspaces_tone_check', sql`${t.tone} IN ('friendly','formal','concise')`),
  check('workspaces_onboarding_step_check', sql`${t.onboardingStep} IN ('profile','mailbox','knowledge','go_live','done')`),
  check('workspaces_retention_days_check', sql`${t.retentionDays} BETWEEN 30 AND 730`),
  ...tenantPolicies(t.orgId, 'workspaces'),
])
```
and likewise `...tenantPolicies(t.orgId, 'org_settings')`, `'usage_counters'`, `'audit_log'`, `'org_data_keys'`. Import `tenantPolicies` from `./helpers.ts`. Add `export * from './roles.ts'` to `schema/index.ts` (before `helpers.ts`, since helpers imports roles).

- [ ] **Step 4: Generate migration 0001 and make CREATE ROLE idempotent**

Run: `pnpm --filter @aesa/db generate`
Expected: `migrations/0001_*.sql` contains `CREATE ROLE "aesa_app";`, `CREATE ROLE "aesa_platform";`, `ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;` (×5) and ten `CREATE POLICY` statements.

Hand-edit `0001_*.sql`: replace the two `CREATE ROLE` lines with
```sql
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_app') THEN CREATE ROLE "aesa_app"; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_platform') THEN CREATE ROLE "aesa_platform"; END IF; END $$;
--> statement-breakpoint
```
(Roles are cluster-wide; every fresh test database in the same cluster re-runs this migration. Editing the SQL does not cause drift: `drizzle-kit generate` diffs snapshots, not SQL text.)

- [ ] **Step 5: Write the custom migration for FORCE RLS and grants**

Run: `pnpm --filter @aesa/db exec drizzle-kit generate --custom --name force_rls_and_grants`
Fill the generated `migrations/0002_force_rls_and_grants.sql` with:
```sql
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
GRANT "aesa_app", "aesa_platform" TO CURRENT_USER;
```
(The two `drizzle` grants let `/healthz` (Task 13) report the applied migration count while connected as `aesa_app`.)
The last line lets the connection's owner role `SET ROLE` to either runtime role (a superuser can anyway; a production owner role needs the membership). Every later migration that adds a tenant table must add its `FORCE ROW LEVEL SECURITY` line — `tenantPolicies` covers ENABLE, but Postgres has no default for FORCE; Task 4's isolation suite catches an omission (the owner would see rows).

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @aesa/db test && pnpm db:check`
Expected: `rls.test.ts` and `migrations.test.ts` PASS; the drift check prints `migrations in sync with schema` (Task 16 adds the script — until then run `pnpm --filter @aesa/db generate && git status --porcelain packages/db/migrations` and expect no output).

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): aesa_app/aesa_platform roles, per-table org-isolation policies, forced RLS and grants

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `withOrg` / `OrgTx` / `withPlatform` and the isolation suite

**Files:**
- Create: `packages/db/src/tenant.ts`, `packages/db/test/tenant.test.ts`
- Modify: `packages/db/src/index.ts` (export tenant helpers)

**Interfaces:**
- Produces: `withOrg<T>(db: Db, orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T>`; `withPlatform<T>(db: Db, reason: string, fn: (tx: PlatformTx) => Promise<T>): Promise<T>`; branded types `OrgTx` (carries `.orgId`) and `PlatformTx`; `isUuid(s)`. Repositories in later phases accept only `OrgTx`/`PlatformTx`, never `Db`.

- [ ] **Step 1: Write the failing isolation suite**

`packages/db/test/tenant.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { orgSettings, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { withOrg, withPlatform } from '../src/tenant.ts'
import { createTestDatabase } from './helpers/test-db.ts'

describe('tenant isolation', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let owner: ReturnType<typeof createDb>
  const orgA = crypto.randomUUID()
  const orgB = crypto.randomUUID()

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url, { role: 'app', pool: { max: 1 } })   // max 1 forces connection reuse (GUC-leak test)
    owner = createDb(t.url, { role: 'owner' })
    for (const [orgId, name] of [[orgA, 'A'], [orgB, 'B']] as const) {
      await withOrg(app.db, orgId, async (tx) => {
        await tx.insert(workspaces).values({ orgId, businessName: name, timezone: 'UTC' })
        await tx.insert(orgSettings).values({ orgId, key: 'k', value: name })
      })
    }
  })
  afterAll(async () => { await app.pool.end(); await owner.pool.end(); await t.drop() })

  it('a raw app handle (no withOrg) sees zero tenant rows', async () => {
    expect(await app.db.select().from(workspaces)).toHaveLength(0)
  })

  it('withOrg sees only its own organization', async () => {
    const a = await withOrg(app.db, orgA, (tx) => tx.select().from(workspaces))
    const b = await withOrg(app.db, orgB, (tx) => tx.select().from(orgSettings))
    expect(a.map((r) => r.businessName)).toEqual(['A'])
    expect(b.map((r) => r.value)).toEqual(['B'])
  })

  it('withOrg cannot write a row for another organization (WITH CHECK)', async () => {
    await expect(
      withOrg(app.db, orgA, (tx) => tx.insert(orgSettings).values({ orgId: orgB, key: 'x', value: 1 })),
    ).rejects.toThrow(/row-level security/)
  })

  it('withOrg cannot update or delete another organization even by primary key', async () => {
    const updated = await withOrg(app.db, orgA, (tx) =>
      tx.update(workspaces).set({ businessName: 'pwned' }).where(eq(workspaces.orgId, orgB)).returning(),
    )
    expect(updated).toHaveLength(0)
    const deleted = await withOrg(app.db, orgA, (tx) => tx.delete(orgSettings).where(eq(orgSettings.orgId, orgB)).returning())
    expect(deleted).toHaveLength(0)
  })

  it('a pooled connection does not leak app.org_id into the next raw query', async () => {
    await withOrg(app.db, orgA, (tx) => tx.select().from(workspaces))
    // same physical connection (pool max 1); the earlier SET LOCAL left app.org_id = '' at session level
    expect(await app.db.select().from(workspaces)).toHaveLength(0)
  })

  it('the table owner sees nothing without a policy match (FORCE ROW LEVEL SECURITY)', async () => {
    expect(await owner.db.select().from(workspaces)).toHaveLength(0)
  })

  it('withPlatform sees every organization', async () => {
    const rows = await withPlatform(app.db, 'test:list-all', (tx) => tx.select().from(workspaces))
    expect(rows.map((r) => r.businessName).sort()).toEqual(['A', 'B'])
  })

  it('withOrg rejects a non-uuid org id before touching the database', async () => {
    await expect(withOrg(app.db, 'not-a-uuid', async () => 1)).rejects.toThrow(/uuid/i)
  })
})
```
Add `import { eq } from 'drizzle-orm'` at the top.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/db test -- tenant`
Expected: FAIL — `../src/tenant.ts` does not exist.

- [ ] **Step 3: Implement the wrappers**

`packages/db/src/tenant.ts`:
```ts
import { sql } from 'drizzle-orm'
import type { Db } from './client.ts'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

declare const orgTxBrand: unique symbol
declare const platformTxBrand: unique symbol

/** A transaction handle whose queries are scoped to one organization by RLS. Only withOrg() produces one. */
export type OrgTx = Tx & { readonly [orgTxBrand]: true; readonly orgId: string }
/** A transaction handle running as aesa_platform (policy USING true). Only withPlatform() produces one. */
export type PlatformTx = Tx & { readonly [platformTxBrand]: true }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isUuid = (s: string): boolean => UUID_RE.test(s)

/**
 * Runs `fn` inside one transaction with `app.org_id` set for the duration (set_config(..., true) is
 * SET LOCAL, and parametrizable). The pool connection is already `aesa_app`, so RLS scopes every
 * statement to `orgId`. RULE: never await network I/O inside `fn` — the transaction holds a connection
 * and the role's idle_in_transaction_session_timeout (5 s) will kill it.
 */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T> {
  if (!isUuid(orgId)) throw new TypeError(`withOrg: orgId must be a uuid, got ${JSON.stringify(orgId)}`)
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`)
    return fn(Object.assign(tx, { orgId }) as OrgTx)
  })
}

/**
 * Cross-organization access for sweeps and crons. `reason` is required so every call site documents
 * why it needs to see all tenants (grep `withPlatform(` to audit). Switches the transaction's role to
 * aesa_platform; the session user (owner/admin) is a member of it via migration 0002.
 */
export async function withPlatform<T>(db: Db, reason: string, fn: (tx: PlatformTx) => Promise<T>): Promise<T> {
  if (!reason) throw new TypeError('withPlatform: reason is required')
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE aesa_platform`)
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`)
    return fn(tx as PlatformTx)
  })
}
```

Append to `packages/db/src/index.ts`:
```ts
export { withOrg, withPlatform, isUuid, type OrgTx, type PlatformTx } from './tenant.ts'
```

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @aesa/db test && pnpm --filter @aesa/db typecheck`
Expected: all `tenant.test.ts` cases PASS (the WITH CHECK case throws Postgres error 42501 whose message contains "row-level security"); `rls` and `migrations` suites still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): withOrg/withPlatform transaction wrappers with branded handles and the isolation suite

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `@aesa/crypto` — `Secret` type and domain-separated token hashing

**Files:**
- Create: `packages/crypto/package.json`, `packages/crypto/tsconfig.json`, `packages/crypto/vitest.config.ts`, `packages/crypto/src/index.ts`
- Create: `packages/crypto/src/secret.ts`, `packages/crypto/src/tokens.ts`, `packages/crypto/test/secret.test.ts`, `packages/crypto/test/tokens.test.ts`

**Interfaces:**
- Produces: `class Secret { expose(): string }` (serializes/logs as `[redacted]`); `type TokenKind = 'action' | 'login' | 'session' | 'oauth_nonce'`; `generateToken(kind): { token: string; hash: string }`; `hashToken(kind, token): string`; `hashesEqual(a, b): boolean` (constant time).

- [ ] **Step 1: Write the failing tests**

`packages/crypto/test/secret.test.ts`:
```ts
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Secret } from '../src/secret.ts'

describe('Secret', () => {
  const s = new Secret('sk-live-abc123')
  it('exposes the value only through expose()', () => {
    expect(s.expose()).toBe('sk-live-abc123')
  })
  it('never leaks through string, JSON or inspect', () => {
    expect(String(s)).toBe('[redacted]')
    expect(`${s}`).toBe('[redacted]')
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}')
    expect(inspect(s)).toBe('Secret([redacted])')
    expect(Object.keys(s)).toEqual([])
  })
})
```

`packages/crypto/test/tokens.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { generateToken, hashToken, hashesEqual } from '../src/tokens.ts'

describe('tokens', () => {
  it('generates a 32-byte base64url token and its hash', () => {
    const { token, hash } = generateToken('action')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('action', token)).toBe(hash)
  })
  it('domain-separates kinds so one token can never satisfy another lookup', () => {
    const { token } = generateToken('login')
    expect(hashToken('login', token)).not.toBe(hashToken('session', token))
  })
  it('compares hashes in constant time and rejects length mismatches', () => {
    const { hash } = generateToken('session')
    expect(hashesEqual(hash, hash)).toBe(true)
    expect(hashesEqual(hash, hash.slice(0, 63) + '0')).toBe(false)
    expect(hashesEqual(hash, 'short')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/crypto test` → FAIL (package missing).

- [ ] **Step 3: Implement**

`packages/crypto/package.json`:
```json
{
  "name": "@aesa/crypto",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "libsodium-wrappers": "^0.7.15", "undici": "^7.10.0" },
  "devDependencies": { "@types/libsodium-wrappers": "^0.7.14", "@types/node": "^22", "tsx": "^4.20.0", "typescript": "^5.9.2", "vitest": "^3.2.0" }
}
```
`tsconfig.json` and `vitest.config.ts`: same shape as `packages/core` (Task 1).

`packages/crypto/src/secret.ts`:
```ts
import { inspect } from 'node:util'

/** Wraps a secret string so accidental logging, JSON serialization or template interpolation prints [redacted]. */
export class Secret {
  readonly #value: string
  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Secret requires a non-empty string')
    this.#value = value
  }
  expose(): string { return this.#value }
  toString(): string { return '[redacted]' }
  toJSON(): string { return '[redacted]' }
  [inspect.custom](): string { return 'Secret([redacted])' }
}
```

`packages/crypto/src/tokens.ts`:
```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Every stored hash is domain-separated by kind ('action:' + token, …) so kinds can never satisfy each other's lookups. */
export type TokenKind = 'action' | 'login' | 'session' | 'oauth_nonce'

export function hashToken(kind: TokenKind, token: string): string {
  return createHash('sha256').update(`${kind}:${token}`).digest('hex')
}

export function generateToken(kind: TokenKind): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(kind, token) }
}

export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
```

`packages/crypto/src/index.ts`:
```ts
export { Secret } from './secret.ts'
export { generateToken, hashToken, hashesEqual, type TokenKind } from './tokens.ts'
```

- [ ] **Step 4: Run** — `pnpm install && pnpm --filter @aesa/crypto test && pnpm --filter @aesa/crypto typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/crypto pnpm-lock.yaml
git commit -m "feat(crypto): Secret wrapper and domain-separated token hashing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `@aesa/crypto` — envelope encryption (per-org DEK under a versioned KEK ring)

**Files:**
- Create: `packages/crypto/src/envelope.ts`, `packages/crypto/test/envelope.test.ts`
- Modify: `packages/crypto/src/index.ts`

**Interfaces:**
- Produces: `loadKekRing(env): KekRing` (`AESA_KEK_V<n>` base64 32-byte keys + `AESA_KEK_ACTIVE`); `generateDek(): Buffer`; `wrapDek(dek, ring): { kekVersion: number; wrapped: Buffer }`; `unwrapDek(wrapped, kekVersion, ring): Buffer`; `rewrapDek(wrapped, kekVersion, ring)`; `encrypt(dek, plaintext: Buffer, aad: string): Buffer`; `decrypt(dek, ciphertext: Buffer, aad: string): Buffer`. Ciphertext layout: `[0x01][nonce 12][tag 16][ct]`.

- [ ] **Step 1: Write the failing test**

`packages/crypto/test/envelope.test.ts`:
```ts
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, generateDek, loadKekRing, rewrapDek, unwrapDek, wrapDek } from '../src/envelope.ts'

const env = {
  AESA_KEK_V1: randomBytes(32).toString('base64'),
  AESA_KEK_V2: randomBytes(32).toString('base64'),
  AESA_KEK_ACTIVE: '2',
}

describe('envelope encryption', () => {
  const ring = loadKekRing(env)

  it('wraps a DEK under the active KEK and unwraps it', () => {
    const dek = generateDek()
    const { kekVersion, wrapped } = wrapDek(dek, ring)
    expect(kekVersion).toBe(2)
    expect(unwrapDek(wrapped, kekVersion, ring).equals(dek)).toBe(true)
  })

  it('encrypts and decrypts with AAD binding', () => {
    const dek = generateDek()
    const ct = encrypt(dek, Buffer.from('refresh-token-value'), 'org-1:row-9')
    expect(decrypt(dek, ct, 'org-1:row-9').toString()).toBe('refresh-token-value')
    expect(() => decrypt(dek, ct, 'org-2:row-9')).toThrow()          // transplanted row
    const tampered = Buffer.from(ct); tampered[tampered.length - 1] ^= 0x01
    expect(() => decrypt(dek, tampered, 'org-1:row-9')).toThrow()
  })

  it('re-wraps from a retired KEK version to the active one', () => {
    const dek = generateDek()
    const v1 = wrapDek(dek, loadKekRing({ ...env, AESA_KEK_ACTIVE: '1' }))
    const v2 = rewrapDek(v1.wrapped, v1.kekVersion, ring)
    expect(v2.kekVersion).toBe(2)
    expect(unwrapDek(v2.wrapped, 2, ring).equals(dek)).toBe(true)
    expect(() => unwrapDek(v2.wrapped, 1, ring)).toThrow()
  })

  it('rejects a malformed ring', () => {
    expect(() => loadKekRing({ AESA_KEK_V1: 'short', AESA_KEK_ACTIVE: '1' })).toThrow(/32 bytes/)
    expect(() => loadKekRing({ AESA_KEK_V1: env.AESA_KEK_V1, AESA_KEK_ACTIVE: '3' })).toThrow(/AESA_KEK_ACTIVE/)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/crypto test -- envelope` → FAIL.

- [ ] **Step 3: Implement**

`packages/crypto/src/envelope.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 0x01
const NONCE_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

export interface KekRing { readonly active: number; readonly keys: ReadonlyMap<number, Buffer> }

/** Reads AESA_KEK_V<n> (base64, 32 bytes each) and AESA_KEK_ACTIVE from the environment. Worker-only in production. */
export function loadKekRing(env: Record<string, string | undefined>): KekRing {
  const keys = new Map<number, Buffer>()
  for (const [name, value] of Object.entries(env)) {
    const m = /^AESA_KEK_V(\d+)$/.exec(name)
    if (!m || !value) continue
    const key = Buffer.from(value, 'base64')
    if (key.length !== KEY_LEN) throw new Error(`${name} must decode to 32 bytes`)
    keys.set(Number(m[1]), key)
  }
  const active = Number(env.AESA_KEK_ACTIVE)
  if (!Number.isInteger(active) || !keys.has(active)) throw new Error('AESA_KEK_ACTIVE must name a configured AESA_KEK_V<n>')
  return { active, keys }
}

export function generateDek(): Buffer { return randomBytes(KEY_LEN) }

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ct])
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob[0] !== VERSION) throw new Error('unsupported ciphertext version')
  const nonce = blob.subarray(1, 1 + NONCE_LEN)
  const tag = blob.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN)
  const ct = blob.subarray(1 + NONCE_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])   // throws on tag/AAD mismatch
}

export function wrapDek(dek: Buffer, ring: KekRing): { kekVersion: number; wrapped: Buffer } {
  const kek = ring.keys.get(ring.active)!
  return { kekVersion: ring.active, wrapped: seal(kek, dek, `kek:${ring.active}`) }
}

export function unwrapDek(wrapped: Buffer, kekVersion: number, ring: KekRing): Buffer {
  const kek = ring.keys.get(kekVersion)
  if (!kek) throw new Error(`KEK version ${kekVersion} is not configured`)
  return open(kek, wrapped, `kek:${kekVersion}`)
}

export function rewrapDek(wrapped: Buffer, kekVersion: number, ring: KekRing): { kekVersion: number; wrapped: Buffer } {
  return wrapDek(unwrapDek(wrapped, kekVersion, ring), ring)
}

/** Row-level encryption under an org DEK. `aad` MUST be `${orgId}:${rowId}` so a ciphertext cannot be transplanted. */
export function encrypt(dek: Buffer, plaintext: Buffer, aad: string): Buffer { return seal(dek, plaintext, aad) }
export function decrypt(dek: Buffer, ciphertext: Buffer, aad: string): Buffer { return open(dek, ciphertext, aad) }
```
Export everything from `index.ts`.

- [ ] **Step 4: Run** — `pnpm --filter @aesa/crypto test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/crypto
git commit -m "feat(crypto): envelope encryption with a versioned KEK ring and AAD-bound row ciphertexts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Sealed-box enrollment and per-org key provisioning

The api must be able to *store* a new secret (an OAuth refresh token, a BYOK key) without ever holding the KEK. It seals the secret to the org's public key; the worker opens it and re-encrypts under the org DEK.

**Files:**
- Create: `packages/crypto/src/sealed-box.ts`, `packages/crypto/test/sealed-box.test.ts`
- Create: `packages/db/src/keys.ts`, `packages/db/test/keys.test.ts`
- Modify: `packages/crypto/src/index.ts`, `packages/db/src/index.ts`, `packages/db/package.json` (add `"@aesa/crypto": "workspace:*"`)

**Interfaces:**
- Produces (crypto): `generateBoxKeypair(): Promise<{ publicKey: Buffer; privateKey: Buffer }>`, `sealTo(publicKey, plaintext): Promise<Buffer>`, `openSealed(ciphertext, publicKey, privateKey): Promise<Buffer>`.
- Produces (db): `provisionOrgKeys(tx: OrgTx, ring: KekRing): Promise<{ version: number; boxPublicKey: Buffer }>`; `loadOrgDek(tx: OrgTx, ring: KekRing): Promise<{ version: number; dek: Buffer }>`; `openSealedForOrg(tx: OrgTx, ring: KekRing, sealed: Buffer): Promise<Buffer>`; `getOrgBoxPublicKey(tx: OrgTx): Promise<Buffer>`.

- [ ] **Step 1: Write the failing tests**

`packages/crypto/test/sealed-box.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { generateBoxKeypair, openSealed, sealTo } from '../src/sealed-box.ts'

describe('sealed box', () => {
  it('seals with only the public key and opens with the private key', async () => {
    const { publicKey, privateKey } = await generateBoxKeypair()
    const sealed = await sealTo(publicKey, Buffer.from('1//0g-refresh-token'))
    expect(sealed.equals(Buffer.from('1//0g-refresh-token'))).toBe(false)
    expect((await openSealed(sealed, publicKey, privateKey)).toString()).toBe('1//0g-refresh-token')
  })
  it('cannot be opened with another keypair', async () => {
    const a = await generateBoxKeypair(); const b = await generateBoxKeypair()
    const sealed = await sealTo(a.publicKey, Buffer.from('x'))
    await expect(openSealed(sealed, b.publicKey, b.privateKey)).rejects.toThrow()
  })
})
```

`packages/db/test/keys.test.ts`:
```ts
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKekRing, sealTo, decrypt, encrypt } from '@aesa/crypto'
import { orgDataKeys, withOrg, workspaces } from '../src/index.ts'
import { getOrgBoxPublicKey, loadOrgDek, openSealedForOrg, provisionOrgKeys } from '../src/keys.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase } from './helpers/test-db.ts'

const ring = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

describe('org keys', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  const orgId = crypto.randomUUID()
  beforeAll(async () => {
    t = await createTestDatabase(); app = createDb(t.url)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'A', timezone: 'UTC' }))
  })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  it('provisions a wrapped DEK and a box keypair, publishing only the public key on the workspace', async () => {
    const { version, boxPublicKey } = await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))
    expect(version).toBe(1)
    const [ws] = await withOrg(app.db, orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, orgId)))
    expect(ws!.boxPublicKey!.equals(boxPublicKey)).toBe(true)
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(orgDataKeys))
    expect(row!.kekVersion).toBe(1)
    expect(row!.wrappedDek.length).toBeGreaterThan(32)
  })

  it('api-side seal → worker-side open → re-encrypt under the DEK', async () => {
    const pub = await withOrg(app.db, orgId, (tx) => getOrgBoxPublicKey(tx))     // what the api may read
    const sealed = await sealTo(pub, Buffer.from('provider-refresh-token'))
    const { plaintext, dek } = await withOrg(app.db, orgId, async (tx) => ({
      plaintext: await openSealedForOrg(tx, ring, sealed),
      dek: (await loadOrgDek(tx, ring)).dek,
    }))
    expect(plaintext.toString()).toBe('provider-refresh-token')
    const stored = encrypt(dek, plaintext, `${orgId}:cred-1`)
    expect(decrypt(dek, stored, `${orgId}:cred-1`).toString()).toBe('provider-refresh-token')
  })

  it('refuses to provision twice for the same version', async () => {
    await expect(withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))).rejects.toThrow(/already provisioned/)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/crypto test -- sealed && pnpm --filter @aesa/db test -- keys` → FAIL.

- [ ] **Step 3: Implement**

`packages/crypto/src/sealed-box.ts`:
```ts
import sodium from 'libsodium-wrappers'

/** X25519 keypair for libsodium sealed boxes (anonymous sender, receiver-only decryption). */
export async function generateBoxKeypair(): Promise<{ publicKey: Buffer; privateKey: Buffer }> {
  await sodium.ready
  const kp = sodium.crypto_box_keypair()
  return { publicKey: Buffer.from(kp.publicKey), privateKey: Buffer.from(kp.privateKey) }
}

export async function sealTo(publicKey: Buffer, plaintext: Buffer): Promise<Buffer> {
  await sodium.ready
  return Buffer.from(sodium.crypto_box_seal(plaintext, publicKey))
}

export async function openSealed(ciphertext: Buffer, publicKey: Buffer, privateKey: Buffer): Promise<Buffer> {
  await sodium.ready
  return Buffer.from(sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey))   // throws on failure
}
```
Add `export * from './sealed-box.ts'` to the crypto `index.ts`.

`packages/db/src/keys.ts`:
```ts
import { decrypt, encrypt, generateBoxKeypair, generateDek, openSealed, unwrapDek, wrapDek, type KekRing } from '@aesa/crypto'
import { desc, eq } from 'drizzle-orm'
import { orgDataKeys, workspaces } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

const boxAad = (orgId: string, version: number) => `${orgId}:box:v${version}`

/** Creates key version 1 for the org: DEK wrapped by the active KEK, box keypair with the private key under the DEK. */
export async function provisionOrgKeys(tx: OrgTx, ring: KekRing): Promise<{ version: number; boxPublicKey: Buffer }> {
  const existing = await tx.select({ v: orgDataKeys.version }).from(orgDataKeys).limit(1)
  if (existing.length > 0) throw new Error(`org ${tx.orgId} already provisioned`)
  const version = 1
  const dek = generateDek()
  const { kekVersion, wrapped } = wrapDek(dek, ring)
  const box = await generateBoxKeypair()
  await tx.insert(orgDataKeys).values({
    orgId: tx.orgId, version, wrappedDek: wrapped, kekVersion,
    boxPublicKey: box.publicKey,
    boxPrivateKeyCiphertext: encrypt(dek, box.privateKey, boxAad(tx.orgId, version)),
  })
  await tx.update(workspaces).set({ boxPublicKey: box.publicKey }).where(eq(workspaces.orgId, tx.orgId))
  return { version, boxPublicKey: box.publicKey }
}

export async function loadOrgDek(tx: OrgTx, ring: KekRing): Promise<{ version: number; dek: Buffer }> {
  const [row] = await tx.select().from(orgDataKeys).orderBy(desc(orgDataKeys.version)).limit(1)
  if (!row) throw new Error(`org ${tx.orgId} has no data key`)
  return { version: row.version, dek: unwrapDek(row.wrappedDek, row.kekVersion, ring) }
}

export async function getOrgBoxPublicKey(tx: OrgTx): Promise<Buffer> {
  const [ws] = await tx.select({ pk: workspaces.boxPublicKey }).from(workspaces).where(eq(workspaces.orgId, tx.orgId))
  if (!ws?.pk) throw new Error(`org ${tx.orgId} has no box public key`)
  return ws.pk
}

/** Worker side: open a secret the api sealed to the org's public key. */
export async function openSealedForOrg(tx: OrgTx, ring: KekRing, sealed: Buffer): Promise<Buffer> {
  const [row] = await tx.select().from(orgDataKeys).orderBy(desc(orgDataKeys.version)).limit(1)
  if (!row) throw new Error(`org ${tx.orgId} has no data key`)
  const dek = unwrapDek(row.wrappedDek, row.kekVersion, ring)
  const privateKey = decrypt(dek, row.boxPrivateKeyCiphertext, boxAad(tx.orgId, row.version))
  return openSealed(sealed, row.boxPublicKey, privateKey)
}
```
Export these four from `packages/db/src/index.ts`; add `"@aesa/crypto": "workspace:*"` to `packages/db/package.json` dependencies.

- [ ] **Step 4: Run** — `pnpm install && pnpm --filter @aesa/crypto test && pnpm --filter @aesa/db test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/crypto packages/db pnpm-lock.yaml
git commit -m "feat(crypto,db): sealed-box enrollment and per-org DEK provisioning

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `@aesa/crypto` — SSRF-safe resolution and pinned fetch

**Files:**
- Create: `packages/crypto/src/ssrf/ranges.ts`, `packages/crypto/src/ssrf/resolve-public.ts`, `packages/crypto/src/ssrf/pinned-fetch.ts`, `packages/crypto/test/ssrf.test.ts`
- Modify: `packages/crypto/src/index.ts`

**Interfaces:**
- Produces: `isBlockedAddress(ip: string): boolean`; `resolvePublic(hostname, opts?: { resolver?: (host) => Promise<{ address: string; family: 4 | 6 }[]> }): Promise<{ address: string; family: 4 | 6 }>`; `validateOutboundUrl(url: string, opts?: { allowNonstandardPort?: boolean }): URL`; `buildPinnedDispatcher(ip, family)`; `pinnedFetch(url, init?: { method?; headers?; body?; timeoutMs?; resolver? }): Promise<Response>` (https only, hostname required, no redirects, 30 s timeout).

- [ ] **Step 1: Write the failing test**

`packages/crypto/test/ssrf.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isBlockedAddress } from '../src/ssrf/ranges.ts'
import { resolvePublic } from '../src/ssrf/resolve-public.ts'
import { buildPinnedDispatcher, pinnedFetch, validateOutboundUrl } from '../src/ssrf/pinned-fetch.ts'

describe('ssrf ranges', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true))
  it.each(['8.8.8.8', '104.18.0.1', '2606:4700::1111'])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false))
})

describe('resolvePublic', () => {
  it('rejects a host with ANY private answer (DNS rebinding defence)', async () => {
    const resolver = async () => [{ address: '104.18.0.1', family: 4 as const }, { address: '10.0.0.1', family: 4 as const }]
    await expect(resolvePublic('evil.example', { resolver })).rejects.toThrow(/private|blocked/i)
  })
  it('returns the first public answer', async () => {
    const resolver = async () => [{ address: '104.18.0.1', family: 4 as const }]
    await expect(resolvePublic('api.example', { resolver })).resolves.toEqual({ address: '104.18.0.1', family: 4 })
  })
})

describe('validateOutboundUrl / pinnedFetch', () => {
  it('requires https, a hostname (no IP literal) and port 443', () => {
    expect(() => validateOutboundUrl('http://api.example/v1')).toThrow(/https/)
    expect(() => validateOutboundUrl('https://104.18.0.1/v1')).toThrow(/hostname/)
    expect(() => validateOutboundUrl('https://api.example:8443/v1')).toThrow(/port/)
    expect(validateOutboundUrl('https://api.example:8443/v1', { allowNonstandardPort: true }).port).toBe('8443')
  })
  it('pins the vetted IP in the dispatcher lookup', async () => {
    const dispatcher = buildPinnedDispatcher('104.18.0.1', 4)
    const lookup = (dispatcher as unknown as { pinnedLookup: (h: string, o: unknown, cb: (e: null, a: string, f: number) => void) => void }).pinnedLookup
    await new Promise<void>((resolve) => lookup('api.example', {}, (err, address, family) => { expect(err).toBeNull(); expect(address).toBe('104.18.0.1'); expect(family).toBe(4); resolve() }))
  })
  it('refuses a private target before any connection is made', async () => {
    const resolver = async () => [{ address: '169.254.169.254', family: 4 as const }]
    await expect(pinnedFetch('https://metadata.example/latest', { resolver })).rejects.toThrow(/blocked/i)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/crypto test -- ssrf` → FAIL.

- [ ] **Step 3: Implement**

`packages/crypto/src/ssrf/ranges.ts`:
```ts
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96]] as const)
  blocked.addSubnet(addr, prefix, 'ipv6')

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved and v4-mapped addresses. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  if (family === 6 && ip.toLowerCase().startsWith('::ffff:')) {
    const v4 = ip.slice(7)
    return isIP(v4) === 4 ? isBlockedAddress(v4) : true
  }
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}
```

`packages/crypto/src/ssrf/resolve-public.ts`:
```ts
import { lookup } from 'node:dns/promises'
import { isBlockedAddress } from './ranges.ts'

export type Resolved = { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<Resolved[]>

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family as 4 | 6 }))

/** Resolves every A/AAAA answer and refuses the host if ANY answer is blocked — a rebinding host must not get a foothold. */
export async function resolvePublic(hostname: string, opts: { resolver?: Resolver } = {}): Promise<Resolved> {
  const answers = await (opts.resolver ?? defaultResolver)(hostname)
  if (answers.length === 0) throw new Error(`${hostname} did not resolve`)
  const bad = answers.find((a) => isBlockedAddress(a.address))
  if (bad) throw new Error(`${hostname} resolves to a blocked/private address (${bad.address})`)
  return answers[0]!
}
```

`packages/crypto/src/ssrf/pinned-fetch.ts`:
```ts
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { resolvePublic, type Resolver } from './resolve-public.ts'

export function validateOutboundUrl(input: string, opts: { allowNonstandardPort?: boolean } = {}): URL {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new Error('outbound URL must use https')
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new Error('outbound URL must use a hostname, not an IP literal')
  if (url.port && url.port !== '443' && !opts.allowNonstandardPort) throw new Error('outbound URL port must be 443')
  if (url.username || url.password) throw new Error('outbound URL must not carry credentials')
  return url
}

/** An undici Agent whose connector ignores DNS and connects only to the vetted IP (defeats DNS rebinding between check and use). */
export function buildPinnedDispatcher(address: string, family: 4 | 6): Dispatcher {
  const pinnedLookup = (_host: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) =>
    cb(null, address, family)
  const agent = new Agent({ connect: { lookup: pinnedLookup as never, timeout: 10_000 } })
  return Object.assign(agent, { pinnedLookup })
}

export interface PinnedFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  resolver?: Resolver
  allowNonstandardPort?: boolean
}

/** fetch() for customer-supplied endpoints: https only, resolved to a public IP, pinned, no redirects, bounded time. */
export async function pinnedFetch(input: string, init: PinnedFetchInit = {}): Promise<Response> {
  const url = validateOutboundUrl(input, { allowNonstandardPort: init.allowNonstandardPort })
  const { address, family } = await resolvePublic(url.hostname, { resolver: init.resolver })
  const dispatcher = buildPinnedDispatcher(address, family)
  try {
    const res = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
    if (res.status >= 300 && res.status < 400) throw new Error(`redirects are not followed for outbound URLs (${res.status})`)
    return res as unknown as Response
  } finally {
    await dispatcher.close()
  }
}
```
Export `isBlockedAddress`, `resolvePublic`, `validateOutboundUrl`, `pinnedFetch`, `buildPinnedDispatcher` and the `Resolver` type from the crypto `index.ts`.

- [ ] **Step 4: Run** — `pnpm --filter @aesa/crypto test && pnpm --filter @aesa/crypto typecheck` → PASS. (If undici's `connect.lookup` typing rejects the callback shape, keep the `as never` cast — the runtime contract is Node's `dns.lookup` callback `(err, address, family)`.)

- [ ] **Step 5: Commit**
```bash
git add packages/crypto
git commit -m "feat(crypto): SSRF guard — blocked ranges, all-answers public resolution, pinned-IP fetch without redirects

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `@aesa/core` — platform tripwire (word-boundary phrases)

**Files:**
- Create: `packages/core/src/tripwire.ts`, `packages/core/test/tripwire.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `TRIPWIRE_BASELINE: readonly string[]`; `tripwireHit(text: string, extraPhrases?: readonly string[]): string | null` (returns the matched phrase or null); `normalizeForMatch(text): string`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/tripwire.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { TRIPWIRE_BASELINE, tripwireHit } from '../src/tripwire.ts'

describe('tripwire', () => {
  it.each([
    ['I will sue you if this is not fixed', 'sue you'],
    ['My attorney will be in touch', 'attorney'],
    ['CHARGEBACK filed with my bank', 'chargeback'],
    ['the toy hurt my dog', 'hurt'],
    ['Please delete my data under GDPR', 'delete my data'],
    ['I am a journalist writing a story', 'journalist'],
    ['ｌａｗｙｅｒ', 'lawyer'],                          // NFKC fullwidth
    ['legal\n  action', 'legal action'],                // whitespace inside a phrase
  ])('hits: %s → %s', (text, phrase) => expect(tripwireHit(text)).toBe(phrase))

  it.each([
    'I have an issue with my order',                    // "issue" contains "sue"
    'Can I get express shipping?',                      // "express" contains "press"
    'There is a minor scratch on the box',              // "minor"
    'I will pursue the tracking number myself',         // "pursue"
    'Very impressed with the tissue paper wrapping',    // "impressed", "tissue"
    'The minority of orders arrive late',
    'Hurting for a discount code',                      // "hurting" ≠ "hurt"
  ])('does NOT trip on ordinary mail: %s', (text) => expect(tripwireHit(text)).toBeNull())

  it('adds workspace phrases but never removes baseline ones', () => {
    expect(tripwireHit('my vet said the leash is unsafe', ['vet'])).toBe('vet')
    expect(tripwireHit('a veteran customer here', ['vet'])).toBeNull()
    expect(tripwireHit('I will sue you', [])).toBe('sue you')
  })

  it('baseline contains no bare short tokens that collide with ordinary words', () => {
    for (const bad of ['sue', 'press', 'minor']) expect(TRIPWIRE_BASELINE).not.toContain(bad)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/core test -- tripwire` → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/tripwire.ts`:
```ts
/**
 * Deterministic escalation floor evaluated at ingest on every first-inserted inbound, before any model.
 * Phrases match on WORD BOUNDARIES after NFKC + lowercase + whitespace collapse — the reference's substring
 * matcher tripped "issue"/"express"/"minor" (adversarial review, blocker #1). Baseline phrases can never be
 * removed by a workspace; workspaces may add phrases (`workspaces.tripwire_extra_keywords`).
 */
export const TRIPWIRE_BASELINE: readonly string[] = [
  'chargeback', 'dispute', 'lawsuit', 'attorney', 'lawyer', 'legal action', 'sue you', 'suing', 'small claims',
  'injury', 'injured', 'hurt', 'hospital', 'recall', 'harass', 'harassment', 'threat', 'threaten', 'threatening',
  'police', 'subpoena', 'fraud', 'identity theft', 'suicide', 'self-harm', 'kill myself', 'under 18', 'my child',
  'delete my data', 'data deletion', 'gdpr', 'ccpa', 'press inquiry', 'journalist', 'reporter',
]

export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cache = new Map<string, RegExp>()
function phraseRegex(phrase: string): RegExp {
  let re = cache.get(phrase)
  if (!re) {
    const words = normalizeForMatch(phrase).split(' ').map(escape).join('\\s+')
    re = new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'u')
    cache.set(phrase, re)
  }
  return re
}

/** Returns the first baseline-or-extra phrase found in `text`, or null. */
export function tripwireHit(text: string, extraPhrases: readonly string[] = []): string | null {
  const haystack = normalizeForMatch(text)
  for (const phrase of [...TRIPWIRE_BASELINE, ...extraPhrases]) {
    if (phrase.trim() && phraseRegex(phrase).test(haystack)) return normalizeForMatch(phrase)
  }
  return null
}
```
Export from `index.ts`.

- [ ] **Step 4: Run** — `pnpm --filter @aesa/core test` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/core
git commit -m "feat(core): platform tripwire with word-boundary phrase matching and a no-false-trip table test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `@aesa/core` — transition matrices, settings catalog, plans, invariants

**Files:**
- Create: `packages/core/src/transitions.ts`, `packages/core/src/settings-catalog.ts`, `packages/core/src/plans.ts`, `packages/core/src/invariants.ts`
- Create: `packages/core/test/transitions.test.ts`, `packages/core/test/settings-catalog.test.ts`, `packages/core/test/invariants.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `defineTransitions(matrix)` → `{ can(from, to), assert(from, to) }` + `IllegalTransitionError`; `TICKET_STATUSES`, `ticketTransitions`, `DRAFT_STATUSES`, `draftTransitions`; `SETTINGS_CATALOG`, `SettingKey`, `SettingValue<K>`, `resolveSetting(key, { org?, plan? })`; `PLANS`, `PlanId`, `planSettingDefaults(plan)`; `INVARIANTS` constants and `assertInvariants()` / `checkInvariants(values)`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/transitions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { IllegalTransitionError, defineTransitions, draftTransitions, ticketTransitions } from '../src/transitions.ts'

describe('transitions', () => {
  it('self-transitions are always illegal', () => {
    for (const s of ['new', 'triaged', 'resolved'] as const) expect(ticketTransitions.can(s, s)).toBe(false)
  })
  it('ticket happy path: new → triaged → awaiting_review → waiting_on_customer → new (reopen)', () => {
    expect(ticketTransitions.can('new', 'triaged')).toBe(true)
    expect(ticketTransitions.can('triaged', 'awaiting_review')).toBe(true)
    expect(ticketTransitions.can('awaiting_review', 'waiting_on_customer')).toBe(true)
    expect(ticketTransitions.can('waiting_on_customer', 'new')).toBe(true)
    expect(ticketTransitions.can('resolved', 'triaged')).toBe(false)
  })
  it('draft terminal states have no exits', () => {
    for (const s of ['sent', 'rejected', 'superseded', 'expired', 'failed'] as const)
      expect(draftTransitions.can(s, 'pending')).toBe(false)
    expect(() => draftTransitions.assert('sent', 'pending')).toThrow(IllegalTransitionError)
  })
  it('defineTransitions rejects a matrix that lists a self-transition', () => {
    expect(() => defineTransitions({ a: ['a'], b: [] } as const)).toThrow(/self/)
  })
})
```

`packages/core/test/settings-catalog.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { resolveSetting } from '../src/settings-catalog.ts'
import { planSettingDefaults } from '../src/plans.ts'

describe('settings resolution: org override > plan default > code default', () => {
  it('falls back through the three levels', () => {
    expect(resolveSetting('autonomy.daily_draft_cap', {})).toBe(2000)
    expect(resolveSetting('autonomy.daily_draft_cap', { plan: planSettingDefaults('trial') })).toBe(50)
    expect(resolveSetting('autonomy.daily_draft_cap', { plan: planSettingDefaults('trial'), org: { 'autonomy.daily_draft_cap': 75 } })).toBe(75)
  })
  it('rejects a wrongly-typed override instead of returning it', () => {
    expect(() => resolveSetting('autonomy.daily_draft_cap', { org: { 'autonomy.daily_draft_cap': 'lots' } })).toThrow(/expected number/)
    expect(() => resolveSetting('support.spam_shortcircuit.always', { org: { 'support.spam_shortcircuit.always': 1 } })).toThrow(/expected boolean/)
  })
})
```

`packages/core/test/invariants.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { INVARIANTS, assertInvariants, checkInvariants } from '../src/invariants.ts'

describe('invariants', () => {
  it('the shipped constants satisfy every invariant', () => {
    expect(() => assertInvariants()).not.toThrow()
    expect(checkInvariants(INVARIANTS)).toEqual([])
  })
  it('names the violated rule', () => {
    expect(checkInvariants({ ...INVARIANTS, REDRAFT_MAX: 3 })).toEqual([
      '1 + REDRAFT_MAX (3) must be <= AGENT_MAX_RUNS_PER_TICKET_PER_DAY (3)',
    ])
    expect(checkInvariants({ ...INVARIANTS, SEND_CLAIM_HORIZON_SECONDS: 500 })).toEqual([
      'SEND_CLAIM_HORIZON_SECONDS (500) must equal SEND_QUEUE_EXPIRE_SECONDS (600)',
    ])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/core test` → FAIL on the three new files.

- [ ] **Step 3: Implement**

`packages/core/src/transitions.ts`:
```ts
export class IllegalTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`Illegal transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/** Pure legal-transition matrix (ported from doge-buddy's proposals/transitions.ts). Guarded UPDATEs live in each repository. */
export function defineTransitions<S extends string>(matrix: Record<S, readonly S[]>) {
  for (const [from, tos] of Object.entries(matrix) as [S, readonly S[]][]) {
    if (tos.includes(from)) throw new Error(`transition matrix lists a self-transition for ${from}`)
  }
  return {
    can: (from: S, to: S): boolean => matrix[from].includes(to),
    assert: (from: S, to: S): void => { if (!matrix[from].includes(to)) throw new IllegalTransitionError(from, to) },
  }
}

export const TICKET_STATUSES = ['new', 'triaged', 'awaiting_review', 'auto_sending', 'needs_owner', 'waiting_on_customer', 'resolved'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export const ticketTransitions = defineTransitions<TicketStatus>({
  new: ['triaged', 'needs_owner', 'resolved'],
  triaged: ['awaiting_review', 'auto_sending', 'needs_owner', 'resolved'],
  awaiting_review: ['waiting_on_customer', 'triaged', 'needs_owner', 'resolved'],
  auto_sending: ['waiting_on_customer', 'awaiting_review', 'triaged', 'needs_owner'],
  needs_owner: ['triaged', 'resolved', 'waiting_on_customer'],
  waiting_on_customer: ['new', 'resolved'],
  resolved: ['new'],
})

export const DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending', 'sent', 'rejected', 'superseded', 'expired', 'failed'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]
export const draftTransitions = defineTransitions<DraftStatus>({
  pending: ['approved', 'rejected', 'superseded', 'expired'],
  approved: ['sending', 'held', 'failed', 'superseded'],
  held: ['pending', 'expired'],
  sending: ['sent', 'failed'],
  sent: [], rejected: [], superseded: [], expired: [], failed: [],
})
```

`packages/core/src/settings-catalog.ts`:
```ts
/** Every per-org setting: its type and code default. Plan defaults (plans.ts) and org rows override in that order. */
export const SETTINGS_CATALOG = {
  'notifications.digest_minutes': { kind: 'number', default: 15 },
  'autonomy.daily_draft_cap': { kind: 'number', default: 2000 },
  'autonomy.daily_auto_send_cap': { kind: 'number', default: 100 },
  'autonomy.daily_llm_usd_cap': { kind: 'number', default: 60 },
  'triage.daily_cap': { kind: 'number', default: 6000 },
  'sandbox.daily_cap': { kind: 'number', default: 100 },
  'mailboxes.max_connections': { kind: 'number', default: 5 },
  'support.spam_shortcircuit.always': { kind: 'boolean', default: false },
} as const satisfies Record<string, { kind: 'number' | 'boolean' | 'string'; default: number | boolean | string }>

export type SettingKey = keyof typeof SETTINGS_CATALOG
type KindOf<K extends SettingKey> = (typeof SETTINGS_CATALOG)[K]['kind']
export type SettingValue<K extends SettingKey> = KindOf<K> extends 'number' ? number : KindOf<K> extends 'boolean' ? boolean : string

export function resolveSetting<K extends SettingKey>(
  key: K,
  sources: { org?: Partial<Record<SettingKey, unknown>>; plan?: Partial<Record<SettingKey, unknown>> },
): SettingValue<K> {
  const entry = SETTINGS_CATALOG[key]
  const candidate = sources.org?.[key] ?? sources.plan?.[key] ?? entry.default
  if (typeof candidate !== entry.kind) throw new TypeError(`setting ${key}: expected ${entry.kind}, got ${typeof candidate}`)
  return candidate as SettingValue<K>
}
```

`packages/core/src/plans.ts`:
```ts
import type { SettingKey } from './settings-catalog.ts'

export const PLANS = {
  trial: { dailyDraftCap: 50, dailyLlmUsdCap: 3, sandboxDailyCap: 10, maxConnections: 1, maxAgentsPerDomain: 3, includedConversationsPerDomain: 0, trialDays: 14 },
  standard: { dailyDraftCap: 2000, dailyLlmUsdCap: 60, sandboxDailyCap: 100, maxConnections: 5, maxAgentsPerDomain: 3, includedConversationsPerDomain: 300, trialDays: 0 },
} as const
export type PlanId = keyof typeof PLANS

export function planSettingDefaults(plan: PlanId): Partial<Record<SettingKey, number | boolean>> {
  const p = PLANS[plan]
  return {
    'autonomy.daily_draft_cap': p.dailyDraftCap,
    'autonomy.daily_llm_usd_cap': p.dailyLlmUsdCap,
    'triage.daily_cap': p.dailyDraftCap * 3,
    'sandbox.daily_cap': p.sandboxDailyCap,
    'mailboxes.max_connections': p.maxConnections,
  }
}
```

`packages/core/src/invariants.ts`:
```ts
/** Coupled constants the reference enforced only by comment. Asserted at api/worker boot; tested here. */
export const INVARIANTS = {
  REDRAFT_MAX: 2,
  AGENT_MAX_RUNS_PER_TICKET_PER_DAY: 3,
  AGENT_FAILURE_ESCALATE_AT: 2,
  SEND_QUEUE_EXPIRE_SECONDS: 600,
  SEND_CLAIM_HORIZON_SECONDS: 600,
  DRAFT_JOB_EXPIRE_SECONDS: 600,
  DRAFT_WATCHDOG_SECONDS: 240,
  JOB_SIGNAL_MARGIN_SECONDS: 30,
} as const

export function checkInvariants(v: typeof INVARIANTS): string[] {
  const violations: string[] = []
  if (1 + v.REDRAFT_MAX > v.AGENT_MAX_RUNS_PER_TICKET_PER_DAY)
    violations.push(`1 + REDRAFT_MAX (${v.REDRAFT_MAX}) must be <= AGENT_MAX_RUNS_PER_TICKET_PER_DAY (${v.AGENT_MAX_RUNS_PER_TICKET_PER_DAY})`)
  if (v.SEND_CLAIM_HORIZON_SECONDS !== v.SEND_QUEUE_EXPIRE_SECONDS)
    violations.push(`SEND_CLAIM_HORIZON_SECONDS (${v.SEND_CLAIM_HORIZON_SECONDS}) must equal SEND_QUEUE_EXPIRE_SECONDS (${v.SEND_QUEUE_EXPIRE_SECONDS})`)
  if (v.DRAFT_WATCHDOG_SECONDS + v.JOB_SIGNAL_MARGIN_SECONDS >= v.DRAFT_JOB_EXPIRE_SECONDS)
    violations.push(`DRAFT_WATCHDOG_SECONDS + JOB_SIGNAL_MARGIN_SECONDS must be < DRAFT_JOB_EXPIRE_SECONDS`)
  return violations
}

export function assertInvariants(): void {
  const violations = checkInvariants(INVARIANTS)
  if (violations.length) throw new Error(`invariant violations:\n- ${violations.join('\n- ')}`)
}
```
Export all four modules from `index.ts`.

- [ ] **Step 4: Run** — `pnpm --filter @aesa/core test && pnpm --filter @aesa/core typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/core
git commit -m "feat(core): transition matrices, three-level settings catalog, plan limits, startup invariants

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `@aesa/queue` — ported pg-boss helpers, the stately-behaviour test, fair selection

**Files:**
- Create: `packages/queue/package.json`, `packages/queue/tsconfig.json`, `packages/queue/vitest.config.ts`, `packages/queue/src/index.ts`
- Create: `packages/queue/src/pg-boss.ts`, `packages/queue/src/fair-select.ts`
- Create: `packages/queue/test/helpers/boss.ts`, `packages/queue/test/register-cron.test.ts`, `packages/queue/test/pg-boss-behaviour.test.ts`, `packages/queue/test/fair-select.test.ts`

**Interfaces:**
- Produces: `createQueueRetrying(boss, name, options?)`; `registerCron(boss, name, cron, handler, opts?: { retryLimit?, expireInSeconds?, policy?: 'standard' | 'singleton' | 'stately', singletonKey? })`; `startBoss(connectionString): Promise<PgBoss>`; `fairSelectSql({ from, where, orderBy, limit })` (SQL fragment: `ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY …)` then `ORDER BY rn`).

- [ ] **Step 1: Write the failing tests**

`packages/queue/test/helpers/boss.ts`:
```ts
import PgBoss from 'pg-boss'
export const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
export async function startTestBoss(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: DB_URL, schema: 'pgboss_test' })
  boss.on('error', (e) => console.error('[pg-boss test]', e))
  await boss.start()
  return boss
}
export const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
```

`packages/queue/test/register-cron.test.ts` — port doge-buddy's `apps/ops/test/queue-register-cron.test.ts` verbatim (the four `fakeBoss` cases), importing `registerCron` from `../src/pg-boss.ts`, plus one new case:
```ts
  it('opts.policy stately: createQueue and updateQueue both carry stately', async () => {
    const boss = fakeBoss({ policy: 'stately' })
    await registerCron(boss, 'test.stately', '* * * * *', async () => {}, { policy: 'stately', singletonKey: 'k' })
    expect(boss.updateQueue).toHaveBeenCalledWith('test.stately', { name: 'test.stately', policy: 'stately' })
    expect(boss.schedule).toHaveBeenCalledWith('test.stately', '* * * * *', {}, { singletonKey: 'k' })
  })
```

`packages/queue/test/pg-boss-behaviour.test.ts` — pins the behaviour the spec's job model depends on (adversarial review finding: "stately is not a mutex"):
```ts
import type PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createQueueRetrying } from '../src/pg-boss.ts'
import { startTestBoss, uniqueName } from './helpers/boss.ts'

describe('pg-boss 10 behaviour we rely on', () => {
  let boss: PgBoss
  beforeAll(async () => { boss = await startTestBoss() })
  afterAll(async () => { await boss.stop({ graceful: false, wait: true }) })

  async function withQueue(policy: 'singleton' | 'stately' | 'standard', fn: (name: string) => Promise<void>) {
    const name = uniqueName(`test.${policy}`)
    await createQueueRetrying(boss, name, { name, policy })
    try { await fn(name) } finally { await boss.purgeQueue(name); await boss.deleteQueue(name) }
  }

  it("policy 'singleton' does NOT dedupe two queued sends with the same key", () =>
    withQueue('singleton', async (name) => {
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
    }))

  it("policy 'stately' dedupes a queued duplicate while the first is still created", () =>
    withQueue('stately', async (name) => {
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonKey: 'a' })).toBeNull()
    }))

  it("policy 'stately' ACCEPTS a new send while a job with the same key is ACTIVE (so it is not a mutex)", () =>
    withQueue('stately', async (name) => {
      const first = await boss.send(name, {}, { singletonKey: 'a' })
      const fetched = await boss.fetch(name)          // moves it to active
      expect(fetched?.[0]?.id).toBe(first)
      const second = await boss.send(name, {}, { singletonKey: 'a' })
      // Pinned observation (pg-boss 10.4.x indexes one job PER STATE): a created twin is accepted next to an active one.
      expect(second).not.toBeNull()
    }))

  it("'singletonSeconds' debounces bursts on a standard queue", () =>
    withQueue('standard', async (name) => {
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).toBeNull()
    }))
})
```

`packages/queue/test/fair-select.test.ts`:
```ts
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fairSelectSql } from '../src/fair-select.ts'
import { DB_URL } from './helpers/boss.ts'

describe('fairSelectSql', () => {
  const c = new pg.Client({ connectionString: DB_URL })
  beforeAll(async () => {
    await c.connect()
    await c.query(`CREATE TEMP TABLE fair_t (org_id uuid, n int)`)
    const a = crypto.randomUUID(), b = crypto.randomUUID(), d = crypto.randomUUID()
    const rows = [[a, 1], [a, 2], [a, 3], [a, 4], [a, 5], [b, 1], [d, 1]]
    for (const [o, n] of rows) await c.query(`INSERT INTO fair_t VALUES ($1, $2)`, [o, n])
  })
  afterAll(async () => { await c.end() })

  it('round-robins across organizations before taking a second row from any', async () => {
    const { text, values } = fairSelectSql({ from: 'fair_t', where: 'n > 0', orderBy: 'n ASC', limit: 4 })
    const res = await c.query(text, values)
    const orgs = res.rows.map((r) => r.org_id)
    expect(new Set(orgs.slice(0, 3)).size).toBe(3)      // one row from each of the three orgs first
    expect(res.rows).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/queue test` → FAIL (package missing).

- [ ] **Step 3: Implement**

`packages/queue/package.json`: name `@aesa/queue`, exports `./src/index.ts`, dependencies `{ "pg-boss": "^10.4.2", "zod": "^4.0.0" }`, devDependencies as in the other packages plus `"pg": "^8.16.0"`, `"@types/pg": "^8.15.0"`. `vitest.config.ts` sets `fileParallelism: false` (pg-boss test files share one Postgres; doge-buddy documented the cross-file job-stealing race).

`packages/queue/src/pg-boss.ts` — port `createQueueRetrying` and `registerCron` from `doge-buddy/apps/ops/src/queue.ts` verbatim (drop the doge-buddy `startQueue` and its deps), widening `CronJobOptions.policy` to `'standard' | 'singleton' | 'stately'`, and add:
```ts
export async function startBoss(connectionString: string, schema = 'pgboss'): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema })
  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()
  return boss
}
```

`packages/queue/src/fair-select.ts`:
```ts
/**
 * Round-robin selection across organizations: number rows per org, then take by rank so no org can
 * occupy a whole sweep. `from`, `where` and `orderBy` are TRUSTED SQL fragments written by our code,
 * never user input; `limit` is a bound parameter.
 */
export function fairSelectSql(p: { from: string; where: string; orderBy: string; limit: number }): { text: string; values: unknown[] } {
  return {
    text: `SELECT * FROM (
             SELECT t.*, ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY ${p.orderBy}) AS rn
             FROM ${p.from} t WHERE ${p.where}
           ) s ORDER BY rn, ${p.orderBy} LIMIT $1`,
    values: [p.limit],
  }
}
```
`index.ts` exports everything from both files.

- [ ] **Step 4: Run** — `pnpm install && pnpm --filter @aesa/queue test && pnpm --filter @aesa/queue typecheck` → PASS. If the ACTIVE-twin case FAILS (pg-boss changed), keep the test and update its expectation with a comment — the point is a pinned, observed behaviour, and Task 12 never relies on stately as a mutex either way.

- [ ] **Step 5: Commit**
```bash
git add packages/queue pnpm-lock.yaml
git commit -m "feat(queue): ported pg-boss helpers, pinned stately/singleton behaviour, fair per-org selection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: `@aesa/queue` — `defineJob` with an injected `AbortSignal`, org-keyed `enqueue`

**Files:**
- Create: `packages/queue/src/define-job.ts`, `packages/queue/src/enqueue.ts`, `packages/queue/test/define-job.test.ts`
- Modify: `packages/queue/src/index.ts`

**Interfaces:**
- Produces: `defineJob<T extends { orgId: string }>(def: { name; schema: z.ZodObject<…>; queue: { policy?; retryLimit?; retryDelay?; retryBackoff?; expireInSeconds: number }; handler(ctx: { data: T; signal: AbortSignal; job: PgBoss.JobWithMetadata<T> }) })` → `JobDefinition<T>`; `registerJob(boss, def, opts?: { batchSize?: number })`; `enqueue(boss, def, data, opts: { entityId: string; startAfter?: Date | number; priority?: number; debounceSeconds?: number })` → `Promise<string | null>` (null = deduped).

- [ ] **Step 1: Write the failing test**

`packages/queue/test/define-job.test.ts`:
```ts
import type PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineJob, registerJob } from '../src/define-job.ts'
import { enqueue } from '../src/enqueue.ts'
import { startTestBoss, uniqueName } from './helpers/boss.ts'

describe('defineJob / enqueue', () => {
  it('refuses a schema without orgId at definition time', () => {
    expect(() => defineJob({ name: 'x', schema: z.object({ ticketId: z.string() }) as never, queue: { expireInSeconds: 60 }, handler: async () => {} }))
      .toThrow(/orgId/)
  })

  it('enqueue validates the payload and sets the org-scoped singletonKey', async () => {
    const def = defineJob({ name: 'test.enq', schema: z.object({ orgId: z.uuid(), ticketId: z.string() }), queue: { expireInSeconds: 60 }, handler: async () => {} })
    const boss = { send: vi.fn().mockResolvedValue('job-1') } as unknown as PgBoss
    const orgId = crypto.randomUUID()
    await enqueue(boss, def, { orgId, ticketId: 't1' }, { entityId: 't1', priority: 5 })
    expect(boss.send).toHaveBeenCalledWith('test.enq', { orgId, ticketId: 't1' }, expect.objectContaining({ singletonKey: `${orgId}:t1`, priority: 5 }))
    await expect(enqueue(boss, def, { ticketId: 't1' } as never, { entityId: 't1' })).rejects.toThrow(/orgId/)
  })

  describe('with a real boss', () => {
    let boss: PgBoss
    beforeAll(async () => { boss = await startTestBoss() })
    afterAll(async () => { await boss.stop({ graceful: false, wait: true }) })

    it('hands the handler an AbortSignal that fires at expireInSeconds - 30', async () => {
      const name = uniqueName('test.signal')
      let observed: { aborted: boolean } | null = null
      const done = new Promise<void>((resolve) => {
        const def = defineJob({
          name, schema: z.object({ orgId: z.uuid() }), queue: { expireInSeconds: 31, retryLimit: 0 },
          handler: async ({ signal }) => {
            await new Promise<void>((r) => { signal.addEventListener('abort', () => r(), { once: true }); setTimeout(r, 5_000) })
            observed = { aborted: signal.aborted }
            resolve()
          },
        })
        registerJob(boss, def).then(() => enqueue(boss, def, { orgId: crypto.randomUUID() }, { entityId: 'e' }))
      })
      await done
      expect(observed).toEqual({ aborted: true })       // aborted after ~1 s, well before the 5 s fallback
      await boss.purgeQueue(name); await boss.deleteQueue(name)
    }, 15_000)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/queue test -- define-job` → FAIL.

- [ ] **Step 3: Implement**

`packages/queue/src/define-job.ts`:
```ts
import type PgBoss from 'pg-boss'
import type { z } from 'zod'
import { createQueueRetrying } from './pg-boss.ts'

export const JOB_SIGNAL_MARGIN_SECONDS = 30

export interface JobQueueOptions {
  policy?: 'standard' | 'singleton' | 'stately'
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  /** Required: it sizes the AbortSignal deadline (expire - 30 s). pg-boss does NOT cancel a running handler on expiry. */
  expireInSeconds: number
}

export interface JobContext<T> { data: T; signal: AbortSignal; job: PgBoss.JobWithMetadata<T> }

export interface JobDefinition<T extends { orgId: string }> {
  name: string
  schema: z.ZodType<T>
  queue: JobQueueOptions
  handler: (ctx: JobContext<T>) => Promise<void>
}

export function defineJob<T extends { orgId: string }>(def: JobDefinition<T>): JobDefinition<T> {
  const shape = (def.schema as unknown as { shape?: Record<string, unknown> }).shape
  if (!shape || !('orgId' in shape)) throw new Error(`job ${def.name}: payload schema must be a z.object with an orgId field`)
  if (def.queue.expireInSeconds <= JOB_SIGNAL_MARGIN_SECONDS) throw new Error(`job ${def.name}: expireInSeconds must exceed ${JOB_SIGNAL_MARGIN_SECONDS}`)
  return def
}

/** Creates/updates the queue with the definition's options and registers a worker that validates, times and aborts. */
export async function registerJob<T extends { orgId: string }>(boss: PgBoss, def: JobDefinition<T>, opts: { batchSize?: number } = {}): Promise<void> {
  const { policy = 'standard', ...queueOpts } = def.queue
  await createQueueRetrying(boss, def.name, { name: def.name, policy, ...queueOpts })
  await boss.updateQueue(def.name, { name: def.name, policy, ...queueOpts })   // createQueue is a no-op on an existing queue
  await boss.work<T>(def.name, { batchSize: opts.batchSize ?? 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const data = def.schema.parse(job.data)                                    // invalid payload → job fails loudly
      const controller = new AbortController()
      const deadlineMs = (def.queue.expireInSeconds - JOB_SIGNAL_MARGIN_SECONDS) * 1000
      const timer = setTimeout(() => controller.abort(new Error(`job ${def.name} ${job.id} hit its deadline`)), deadlineMs)
      try {
        await def.handler({ data, signal: controller.signal, job: job as PgBoss.JobWithMetadata<T> })
      } finally {
        clearTimeout(timer)
      }
    }
  })
}
```

`packages/queue/src/enqueue.ts`:
```ts
import type PgBoss from 'pg-boss'
import type { JobDefinition } from './define-job.ts'

export interface EnqueueOptions {
  /** The entity this job is about (ticket id, connection id…). singletonKey becomes `${orgId}:${entityId}`. */
  entityId: string
  startAfter?: Date | number
  priority?: number
  /** For push-triggered jobs: collapse bursts within N seconds (pg-boss singletonSeconds) instead of relying on policy. */
  debounceSeconds?: number
}

/** The only way jobs are sent. Validates the payload (orgId required) and always sets an org-scoped singletonKey. */
export async function enqueue<T extends { orgId: string }>(boss: PgBoss, def: JobDefinition<T>, data: T, opts: EnqueueOptions): Promise<string | null> {
  const parsed = def.schema.parse(data)
  const sendOpts: PgBoss.SendOptions = { singletonKey: `${parsed.orgId}:${opts.entityId}` }
  if (opts.startAfter !== undefined) sendOpts.startAfter = opts.startAfter
  if (opts.priority !== undefined) sendOpts.priority = opts.priority
  if (opts.debounceSeconds !== undefined) sendOpts.singletonSeconds = opts.debounceSeconds
  return boss.send(def.name, parsed, sendOpts)
}
```
Export both from `index.ts`.

- [ ] **Step 4: Run** — `pnpm --filter @aesa/queue test && pnpm --filter @aesa/queue typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/queue
git commit -m "feat(queue): defineJob with validated payloads and an expiry-bound AbortSignal; org-keyed enqueue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: `@aesa/api` skeleton — config, redaction, `/healthz`

**Files:**
- Modify: `packages/db/package.json` (add export `"./testing": "./src/testing.ts"`), Create `packages/db/src/testing.ts` (move `createTestDatabase` here; `packages/db/test/helpers/test-db.ts` becomes `export * from '../../src/testing.ts'`)
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/.env.example`
- Create: `apps/api/src/load-env.ts`, `apps/api/src/config.ts`, `apps/api/src/redact.ts`, `apps/api/src/server.ts`, `apps/api/src/index.ts`
- Create: `apps/api/test/config.test.ts`, `apps/api/test/redact.test.ts`, `apps/api/test/healthz.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): ApiConfig` (`{ databaseUrl, port, host, appBaseUrl?, logLevel }`; THROWS if any `AESA_KEK_*` variable is present — the api never holds key material); `redactUrl(url): string`; `buildServer(deps: { db: Db; pool: pg.Pool }): FastifyInstance` with `GET /healthz` → `{ status, db, migrations: { count, latest }, uptimeSeconds }`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('api config', () => {
  it('parses defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' })
    expect(c).toMatchObject({ databaseUrl: 'postgres://x', port: 3001, host: '0.0.0.0', logLevel: 'info' })
  })
  it('refuses key material — the api never holds the KEK', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', AESA_KEK_V1: 'abc' })).toThrow(/api must not/)
  })
  it('validates APP_BASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', APP_BASE_URL: 'nope' })).toThrow(/APP_BASE_URL/)
  })
})
```

`apps/api/test/redact.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { redactUrl } from '../src/redact.ts'

describe('redactUrl', () => {
  it('redacts every query value, not only t=', () => {
    expect(redactUrl('/a/123?t=SECRET&code=ABC&x=')).toBe('/a/123?t=[redacted]&code=[redacted]&x=[redacted]')
  })
  it('redacts long base64url path segments (tokens in paths) but keeps ids and words', () => {
    const tok = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'   // 35 chars
    expect(redactUrl(`/a/${tok}/approve`)).toBe('/a/[redacted]/approve')
    expect(redactUrl('/tickets/0190f7a2-1c3e-7e2a-9b1a-3c5d6e7f8a9b')).toBe('/tickets/0190f7a2-1c3e-7e2a-9b1a-3c5d6e7f8a9b')
  })
})
```

`apps/api/test/healthz.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { buildServer } from '../src/server.ts'

describe('GET /healthz', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  beforeAll(async () => { t = await createTestDatabase(); handle = createDb(t.url) })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  it('reports db ok and the applied migration count', async () => {
    const app = buildServer(handle)
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.db).toBe('ok')
    expect(body.migrations.count).toBeGreaterThanOrEqual(3)
    await app.close()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/api test` → FAIL.

- [ ] **Step 3: Implement**

`packages/db/src/testing.ts`: the `createTestDatabase` function from Task 2 (unchanged) — it is test-only but lives in `src/` so apps can import it via `@aesa/db/testing`. Add `"./testing": "./src/testing.ts"` to the db `exports`.

`apps/api/package.json`:
```json
{
  "name": "@aesa/api",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run", "dev": "tsx watch src/index.ts", "start": "tsx src/index.ts" },
  "dependencies": {
    "@aesa/core": "workspace:*", "@aesa/crypto": "workspace:*", "@aesa/db": "workspace:*",
    "fastify": "^5.4.0", "pg": "^8.16.0", "tsx": "^4.20.0", "zod": "^4.0.0"
  },
  "devDependencies": { "@types/node": "^22", "@types/pg": "^8.15.0", "typescript": "^5.9.2", "vitest": "^3.2.0" }
}
```
`apps/api/.env.example`:
```
DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev
PORT=3001
APP_BASE_URL=http://localhost:3001
LOG_LEVEL=info
```

`apps/api/src/load-env.ts`: port `doge-buddy/apps/ops/src/load-env.ts` verbatim (reads `../.env` relative to the caller, never overrides real env).

`apps/api/src/config.ts`:
```ts
import { z } from 'zod'

const isHttpUrl = (v: string) => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  APP_BASE_URL: z.string().refine(isHttpUrl, { message: 'APP_BASE_URL must be an http(s) URL' }).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export interface ApiConfig { databaseUrl: string; port: number; host: string; appBaseUrl?: string; logLevel: string }

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const kek = Object.keys(env).filter((k) => k.startsWith('AESA_KEK_'))
  if (kek.length) throw new Error(`api must not be configured with key material (${kek.join(', ')}); only the worker holds the KEK`)
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const d = parsed.data
  return { databaseUrl: d.DATABASE_URL, port: d.PORT, host: d.HOST, logLevel: d.LOG_LEVEL, ...(d.APP_BASE_URL ? { appBaseUrl: d.APP_BASE_URL } : {}) }
}
```

`apps/api/src/redact.ts`:
```ts
/** Every query value and any path segment that looks like a token (base64url, 32+ chars) is masked before logging. */
export function redactUrl(url: string): string {
  const [path, query] = url.split('?', 2)
  const safePath = path!.split('/').map((seg) => (/^[A-Za-z0-9_-]{32,}$/.test(seg) && !/^[0-9a-f-]{36}$/i.test(seg) ? '[redacted]' : seg)).join('/')
  if (query === undefined) return safePath
  const safeQuery = query.split('&').map((pair) => { const i = pair.indexOf('='); return i === -1 ? pair : `${pair.slice(0, i)}=[redacted]` }).join('&')
  return `${safePath}?${safeQuery}`
}
```

`apps/api/src/server.ts`:
```ts
import { sql } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { Db } from '@aesa/db'
import { redactUrl } from './redact.ts'

export interface ServerDeps { db: Db; pool: pg.Pool; logLevel?: string }

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? 'info',
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'], censor: '[redacted]' },
      serializers: { req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }) },
    },
  })
  const startedAt = Date.now()

  app.get('/healthz', async (_req, reply) => {
    let db: 'ok' | 'error' = 'ok'
    let migrations = { count: 0, latest: null as string | null }
    try {
      await deps.pool.query('SELECT 1')
      const res = await deps.pool.query<{ count: number; latest: string | null }>(
        'SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations',
      )
      migrations = res.rows[0] ?? migrations
    } catch { db = 'error' }
    return reply.code(db === 'ok' ? 200 : 503).send({ status: db === 'ok' ? 'ok' : 'degraded', db, migrations, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
  })
  void sql
  return app
}
```
(`drizzle.__drizzle_migrations` is drizzle-kit's default migrations table; `pool.query` runs as `aesa_app`, which Task 3's migration 0002 granted SELECT on it — the healthz test proves it.)

`apps/api/src/index.ts`:
```ts
import { assertInvariants } from '@aesa/core'
import { createDb } from '@aesa/db/raw'
import { loadConfig } from './config.ts'
import { loadDotEnv } from './load-env.ts'
import { buildServer } from './server.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()
const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
const app = buildServer({ db, pool, logLevel: config.logLevel })
await app.listen({ port: config.port, host: config.host })
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0) })
}
```

- [ ] **Step 4: Run** — `pnpm install && pnpm --filter @aesa/api test && pnpm --filter @aesa/api typecheck`, then `pnpm --filter @aesa/api dev` and `curl -s localhost:3001/healthz` → JSON with `"status":"ok"`.

- [ ] **Step 5: Commit**
```bash
git add apps/api packages/db pnpm-lock.yaml
git commit -m "feat(api): Fastify skeleton with KEK-free config, full query/path redaction and /healthz migration status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: `@aesa/worker` skeleton — roles partition, KEK ring, `platform.heartbeat` cron

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/vitest.config.ts`, `apps/worker/.env.example`
- Create: `apps/worker/src/load-env.ts` (same port as the api), `apps/worker/src/config.ts`, `apps/worker/src/roles.ts`, `apps/worker/src/jobs/platform-heartbeat.ts`, `apps/worker/src/index.ts`
- Create: `apps/worker/test/roles.test.ts`, `apps/worker/test/platform-heartbeat.test.ts`

**Interfaces:**
- Produces: `WORKER_ROLES = ['sync','agent','send','knowledge','cron']`, `parseWorkerRoles(value?: string): Set<WorkerRole>`; `loadConfig(env): WorkerConfig` (`{ databaseUrl, roles, kekRing: KekRing | null }`); `runHeartbeat(db: Db, now: () => Date): Promise<void>` and `registerPlatformHeartbeat(boss, db)`.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/roles.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseWorkerRoles } from '../src/roles.ts'

describe('parseWorkerRoles', () => {
  it('defaults to every role', () => expect([...parseWorkerRoles(undefined)]).toEqual(['sync', 'agent', 'send', 'knowledge', 'cron']))
  it('parses a comma list and trims', () => expect([...parseWorkerRoles(' sync, cron ')]).toEqual(['sync', 'cron']))
  it('rejects unknown roles', () => expect(() => parseWorkerRoles('sync,mailer')).toThrow(/unknown worker role/))
})
```

`apps/worker/test/platform-heartbeat.test.ts`:
```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformState } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { runHeartbeat } from '../src/jobs/platform-heartbeat.ts'

describe('platform.heartbeat', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let h: ReturnType<typeof createDb>
  beforeAll(async () => { t = await createTestDatabase(); h = createDb(t.url) })
  afterAll(async () => { await h.pool.end(); await t.drop() })

  it('upserts worker.last_heartbeat_at through withPlatform and the app role can read it', async () => {
    await runHeartbeat(h.db, () => new Date('2026-09-07T12:00:00Z'))
    await runHeartbeat(h.db, () => new Date('2026-09-07T12:01:00Z'))
    const [row] = await h.db.select().from(platformState).where(eq(platformState.key, 'worker.last_heartbeat_at'))
    expect(row?.value).toBe('2026-09-07T12:01:00.000Z')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @aesa/worker test` → FAIL.

- [ ] **Step 3: Implement**

`apps/worker/package.json`: name `@aesa/worker`; scripts `typecheck`, `test`, `dev: tsx watch src/index.ts`, `start: tsx src/index.ts`; dependencies `@aesa/core`, `@aesa/crypto`, `@aesa/db`, `@aesa/queue` (all `workspace:*`), `pg-boss ^10.4.2`, `pg ^8.16.0`, `tsx ^4.20.0`, `zod ^4.0.0`; devDependencies as the api. `.env.example`:
```
DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev
WORKER_ROLES=sync,agent,send,knowledge,cron
# base64 of 32 random bytes: `openssl rand -base64 32`
AESA_KEK_V1=
AESA_KEK_ACTIVE=1
```

`apps/worker/src/roles.ts`:
```ts
export const WORKER_ROLES = ['sync', 'agent', 'send', 'knowledge', 'cron'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

/** WORKER_ROLES partitions one image into role-specific replicas so a knowledge burst can never starve sends. */
export function parseWorkerRoles(value: string | undefined): Set<WorkerRole> {
  if (!value || !value.trim()) return new Set(WORKER_ROLES)
  const roles = new Set<WorkerRole>()
  for (const raw of value.split(',')) {
    const r = raw.trim()
    if (!r) continue
    if (!(WORKER_ROLES as readonly string[]).includes(r)) throw new Error(`unknown worker role: ${r}`)
    roles.add(r as WorkerRole)
  }
  return roles
}
```

`apps/worker/src/config.ts`:
```ts
import { loadKekRing, type KekRing } from '@aesa/crypto'
import { z } from 'zod'
import { parseWorkerRoles, type WorkerRole } from './roles.ts'

const EnvSchema = z.object({ DATABASE_URL: z.string().min(1), WORKER_ROLES: z.string().optional(), LOG_LEVEL: z.string().default('info') })

export interface WorkerConfig { databaseUrl: string; roles: Set<WorkerRole>; kekRing: KekRing | null; logLevel: string }

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const hasKek = Object.keys(env).some((k) => /^AESA_KEK_V\d+$/.test(k))
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    roles: parseWorkerRoles(parsed.data.WORKER_ROLES),
    kekRing: hasKek ? loadKekRing(env as Record<string, string | undefined>) : null,   // required from Phase 2 (mailbox credentials)
    logLevel: parsed.data.LOG_LEVEL,
  }
}
```

`apps/worker/src/jobs/platform-heartbeat.ts`:
```ts
import type PgBoss from 'pg-boss'
import { platformState, withPlatform, type Db } from '@aesa/db'
import { registerCron } from '@aesa/queue'

export const HEARTBEAT_KEY = 'worker.last_heartbeat_at'

/** Proves the cron rails end to end: a platform-role write every minute that /healthz and alerts can read. */
export async function runHeartbeat(db: Db, now: () => Date = () => new Date()): Promise<void> {
  await withPlatform(db, 'cron:platform.heartbeat', async (tx) => {
    await tx.insert(platformState).values({ key: HEARTBEAT_KEY, value: now().toISOString() })
      .onConflictDoUpdate({ target: platformState.key, set: { value: now().toISOString() } })
  })
}

export async function registerPlatformHeartbeat(boss: PgBoss, db: Db): Promise<void> {
  await registerCron(boss, 'platform.heartbeat', '* * * * *', async () => { await runHeartbeat(db) },
    { policy: 'singleton', singletonKey: 'platform.heartbeat', retryLimit: 0, expireInSeconds: 50 })
}
```

`apps/worker/src/index.ts`:
```ts
import { assertInvariants } from '@aesa/core'
import { createDb } from '@aesa/db/raw'
import { startBoss } from '@aesa/queue'
import { loadConfig } from './config.ts'
import { registerPlatformHeartbeat } from './jobs/platform-heartbeat.ts'
import { loadDotEnv } from './load-env.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()
const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
const boss = await startBoss(config.databaseUrl)
console.log(`[worker] roles: ${[...config.roles].join(',')}; kek: ${config.kekRing ? `v${config.kekRing.active}` : 'none'}`)

if (config.roles.has('cron')) await registerPlatformHeartbeat(boss, db)
// Phase 2+: registerJob(boss, mailboxSync) when roles.has('sync'), etc.

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await boss.stop({ graceful: true, wait: true }); await pool.end(); process.exit(0) })
}
```

- [ ] **Step 4: Run** — `pnpm install && pnpm --filter @aesa/worker test && pnpm --filter @aesa/worker typecheck`; then `pnpm --filter @aesa/worker dev` for ~70 s and `psql "$DATABASE_URL" -c "select * from platform_state"` shows `worker.last_heartbeat_at` advancing.

- [ ] **Step 5: Commit**
```bash
git add apps/worker pnpm-lock.yaml
git commit -m "feat(worker): pg-boss boot with WORKER_ROLES partitioning, KEK ring loading and a platform heartbeat cron

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: ESLint gate — the raw DB handle is importable only where tenancy is enforced

**Files:**
- Create: `eslint.config.js`
- Modify: root `package.json` (already has `lint`), each package/app `package.json` gets `"lint": "eslint ."` (optional; root lint covers all)

**Interfaces:**
- Produces: a lint error for `import … from '@aesa/db/raw'` anywhere except `packages/db/**`, `apps/*/src/index.ts` (composition roots), and any `**/test/**` file.

- [ ] **Step 1: Write the failing check (a fixture file that must be rejected)**

```bash
mkdir -p apps/api/src/tmp && printf "import { createDb } from '@aesa/db/raw'\nexport const x = createDb\n" > apps/api/src/tmp/bad.ts
pnpm lint
```
Expected now: `pnpm lint` does not exist yet or passes (no rule) — the gate is missing.

- [ ] **Step 2: Implement**

`eslint.config.js`:
```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const RAW_DB_MESSAGE =
  "Import from '@aesa/db' and use withOrg()/withPlatform(). The raw handle is allowed only in packages/db, composition roots (apps/*/src/index.ts) and tests."

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/migrations/**', '**/.expo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: '@aesa/db/raw', message: RAW_DB_MESSAGE }] }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/db/**/*.ts', 'apps/*/src/index.ts', '**/test/**/*.ts', '**/scripts/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
)
```

- [ ] **Step 3: Verify the gate rejects the fixture and passes the real tree**

```bash
pnpm lint; echo "exit=$?"          # Expected: error in apps/api/src/tmp/bad.ts mentioning "raw handle", exit=1
rm -r apps/api/src/tmp
pnpm lint                          # Expected: clean, exit 0
```
Fix any pre-existing lint findings in the tree (unused imports, `void sql` in server.ts → remove the unused import instead).

- [ ] **Step 4: Commit**
```bash
git add eslint.config.js package.json apps packages
git commit -m "chore(lint): ESLint flat config with the raw-DB-handle import gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: CI, migration drift check, README

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/check-migration-drift.sh`
- Modify: `README.md` (role model + production hardening notes)

**Interfaces:**
- Produces: `pnpm db:check` (fails when the schema has changes not captured by a committed migration); a CI run that executes typecheck → lint → migrate → tests → drift check against a pgvector service container with the same roles as local.

- [ ] **Step 1: Write the drift script (ported from doge-buddy)**

`scripts/check-migration-drift.sh`:
```bash
#!/usr/bin/env bash
# Fails if the Drizzle schema has changes not captured in a committed migration.
set -euo pipefail
pnpm --filter @aesa/db generate
drift_status=$(git status --porcelain packages/db/migrations)
if [ -n "$drift_status" ]; then
  echo "ERROR: schema drift — 'drizzle-kit generate' produced uncommitted migration changes:" >&2
  echo "$drift_status" >&2
  git checkout -- packages/db/migrations || true
  git clean -fd packages/db/migrations >/dev/null || true
  exit 1
fi
echo "migrations in sync with schema"
```
Run: `chmod +x scripts/check-migration-drift.sh && pnpm db:check` → `migrations in sync with schema`. Then prove it fails: add a throwaway column to `platformState` in `schema/platform.ts`, run `pnpm db:check` → exits 1 with the drift message; revert the column.

- [ ] **Step 2: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_USER: aesa
          POSTGRES_PASSWORD: aesa
          POSTGRES_DB: aesa_dev
        ports: ["5434:5432"]
        options: >-
          --health-cmd "pg_isready -U aesa -d aesa_dev"
          --health-interval 2s --health-timeout 3s --health-retries 15
    env:
      DATABASE_URL: postgres://aesa:aesa@localhost:5434/aesa_dev
      PGPASSWORD: aesa
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - name: Create database roles (mirrors scripts/db-init for the service container)
        run: psql -h localhost -p 5434 -U aesa -d aesa_dev -v ON_ERROR_STOP=1 -f scripts/db-init/001-roles.sql
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm --filter @aesa/db migrate
      - run: pnpm test
      - run: pnpm db:check
```

- [ ] **Step 3: README additions**

Append to `README.md`:

    ## Database roles

    One `DATABASE_URL` (the cluster admin locally; the migration owner in production). Every pool
    connection immediately switches role: `aesa_owner` for migrations, `aesa_app` for api/worker
    traffic (forced row-level security — a handle without `withOrg()` sees no tenant rows), and
    `aesa_platform` only inside `withPlatform()`. Local roles come from `scripts/db-init/001-roles.sql`
    (run once by the compose container); CI runs the same file with `psql`.

    Production hardening (not code): create `aesa_app` and `aesa_platform` as LOGIN roles with their
    own passwords and point the api/worker `DATABASE_URL` at `aesa_app`; keep the owner URL for
    migrations only. `SET ROLE` to the same role is a no-op, so no code changes.

    ## CI

    `.github/workflows/ci.yml`: typecheck → lint → migrate → tests (fresh database per test file) →
    migration drift check. Run the same locally with `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check`.

- [ ] **Step 4: Verify locally exactly what CI runs**

Run: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm --filter @aesa/db migrate && pnpm test && pnpm db:check`
Expected: every step exits 0. Push the branch and confirm the GitHub Actions run is green.

- [ ] **Step 5: Commit**
```bash
git add .github scripts README.md
git commit -m "ci: GitHub Actions pipeline with pgvector service, role bootstrap and migration drift check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review against the spec

**Spec coverage (Build phases → Phase 0):**
- pnpm workspace, `tsconfig.base`, `compose.yaml`, `ci.yml` → Tasks 1, 16.
- `packages/db`: tenant tables (`workspaces`, `org_settings`, `platform_state`, `audit_log`, `usage_counters`) → Task 2; roles + RLS with the `NULLIF` predicate → Task 3; `withOrg`/`OrgTx`/`withPlatform` → Task 4; migrations + drift check → Tasks 2, 16. Better Auth tables and `SECURITY DEFINER` resolvers → deferred (flagged at the top).
- `packages/crypto`: sealed-box enrollment + per-org DEK envelope → Tasks 6, 7; token hashing → Task 5; SSRF `resolvePublic` + `pinnedFetch` → Task 8.
- `packages/core`: status enums + transition matrices, settings catalog, plans, `invariants.ts`, tripwire with the "does not trip" table test → Tasks 9, 10. Zod DTO contracts arrive with the first tRPC router in Phase 1 (nothing consumes them in Phase 0).
- `packages/queue`: `defineJob` with injected `AbortSignal`, `enqueue`, `fairSelect`, ported `createQueueRetrying`/`registerCron`, the pg-boss stately-behaviour test → Tasks 11, 12.
- api + worker skeletons with `WORKER_ROLES` → Tasks 13, 14; ESLint raw-`Db` ban → Task 15.
- Verification list: isolation suite (two orgs, RLS + branded types, missing `SET LOCAL`, pooled-connection GUC leak) → Task 4; envelope round-trip with KEK rotation → Task 6; enqueue rejects payloads without `orgId` → Task 12; CI → Task 16; `/healthz` reports migration version → Task 13.

**Placeholder scan:** no TBD/TODO; every code step carries the code. **Type consistency:** `createDb(url, { role })` (Tasks 2, 4, 13, 14); `OrgTx`/`withOrg`/`withPlatform` names identical across Tasks 4, 7, 14; `KekRing`/`loadKekRing` across Tasks 6, 7, 14; `createQueueRetrying`/`registerCron` (Tasks 11, 12, 14); `createTestDatabase` moved to `@aesa/db/testing` in Task 13 — Tasks 2–4 and 7 import it from `./helpers/test-db.ts`, which re-exports it after the move.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-07-phase-0-rails-and-tenancy.md`. Two execution options:

1. **Subagent-driven (recommended)** — a fresh subagent per task with review between tasks (superpowers:subagent-driven-development).
2. **Inline execution** — execute tasks in this session with checkpoints (superpowers:executing-plans).
