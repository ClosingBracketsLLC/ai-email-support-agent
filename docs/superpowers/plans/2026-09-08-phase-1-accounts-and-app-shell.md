# Phase 1 — Accounts and the App Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business owner can sign up (email one-time code, Google or Microsoft), create a workspace, walk a resumable four-step onboarding scaffold, invite teammates, and register a phone for push — on iOS, Android and web from one Expo codebase, against the Phase 0 tenancy rails.

**Architecture:** Better Auth (email OTP + organization + expo plugins) runs inside the existing Fastify api on the `aesa_app` handle; its seven tables are the only non-tenant tables besides `platform_state`. tRPC (`/trpc`) derives the organization from the session's active organization and the caller's membership, never from input, and every mutation writes an `audit_log` row with actor `user:<id>`. The Expo app (`apps/app`, Expo Router, SDK 57) talks to the api with the Better Auth client (SecureStore cookie on native, browser cookie on web) and a tRPC + TanStack Query client; a new browser-safe package `@aesa/contracts` carries the zod inputs and enums shared by api, db and app. No worker change: push registration only stores tokens.

**Tech Stack:** Node 22, TypeScript 5.9, pnpm 10, Postgres 17 + drizzle 0.44, Fastify 5, better-auth 1.7.3 + @better-auth/expo 1.7.3, @trpc/server 11.18 + @trpc/tanstack-react-query 11.18 + @tanstack/react-query 5, superjson 2, resend 6, Expo SDK 57 (expo 57.0.x, expo-router 57, react-native 0.86, react 19.2), expo-secure-store, expo-notifications, jest-expo 57 + @testing-library/react-native 14 (+ `test-renderer`), @playwright/test 1.63, vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-07-ai-email-support-agent-design.md` — sections *Product → The owner's journey*, *UX: native vs web*, *Architecture → Deployables* and *Where tenancy is enforced (net 3)*, *Data model → Identity & tenancy* and *Billing, audit, notifications*, *Build phases → Phase 1*, *Verification → tier 4*. Read `docs/STATUS.md` (rulings, carry-overs) and `docs/superpowers/reviews/2026-09-08-phase-0-final-review.md` first.

## Global Constraints

- Node `>=22`; every server package is `"type": "module"`, strict NodeNext ESM with explicit `.ts` imports, `tsx` at runtime, runtime deps in `dependencies`, zod 4, vitest 3. `apps/app` is the exception: it extends `expo/tsconfig.base` (bundler resolution, JSX), is bundled by Metro, tested with jest-expo, and keeps extensionless imports inside `src/`.
- Tenancy: every tenant table carries `org_id uuid NOT NULL` first in its indexes, declares `...tenantPolicies(t.orgId, '<table>')`, and gets `ALTER TABLE ... FORCE ROW LEVEL SECURITY` in a custom migration. `packages/db/test/rls.test.ts` enforces it for every ordinary or partitioned table in `public` outside `RLS_EXEMPT`.
- **Ruling (STATUS.md):** Better Auth's tables `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` are not tenant tables: they join `RLS_EXEMPT`, keep the default `aesa_app` DML grants, and the api reaches them only through Better Auth's adapter on the app-role handle. The api never holds `aesa_platform` or the KEK.
- Data access: tenant reads/writes go through `withOrg` / `withPlatform`; raw handles only from `@aesa/db/raw` in `packages/db`, `apps/*/src/index.ts`, tests and scripts (ESLint-enforced). A `withOrg` transaction never spans network I/O.
- tRPC: `orgId` comes from the session's active organization plus a membership check; no procedure accepts an org id in its input; cross-org ids 404 by construction.
- Secrets (`BETTER_AUTH_SECRET`, `RESEND_API_KEY`, OAuth client secrets) are `Secret` instances, never logged, never returned. The api error handler keeps stripping SQL parameters and URLs.
- **Ruling (STATUS.md):** Expo packages are installed with `npx expo install <pkg>` (it uses pnpm and pins SDK-compatible versions); everything else with `pnpm add`. `apps/app` extends `expo/tsconfig.base`; the root ESLint TypeScript block gains `**/*.tsx`.
- `apps/app` must never import `@aesa/db`, `@aesa/core`, `@aesa/crypto`, `@aesa/queue`, `pg` or `drizzle-orm` as values (Metro would bundle Node code); `@aesa/api` only as `import type` (ESLint-enforced from Task 8).
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; work on branch `phase-1` off `main`; never push, merge or open a PR without Robert. Commit migrations before running `pnpm db:check`.
- Verified in a scratch workspace on 2026-09-08 (pnpm 10.34.5, Node 22.23.2): Expo SDK 57 exports for web with `web.output: 'server'` inside a plain pnpm workspace with no metro config; `expo serve` hosts that export; jest-expo 57 + @testing-library/react-native 14 pass when `render` is awaited and the `test-renderer` peer is installed; an app file type-checks against a workspace package with `.ts`-extension imports and against the api's `AppRouter` type when the app tsconfig sets `allowImportingTsExtensions`, `noEmit` and `types: ["node", "jest"]`; Better Auth 1.7.3 with `advanced.database.generateId: false` and uuid columns signs in via OTP, creates an organization (hook fires, session gets `activeOrganizationId`), resolves `getActiveMember` and creates an invitation against real Postgres.

## Deviations from the spec's Phase 1 list (flagged; the spec wins on everything else)

1. **Business name is asked on the create-workspace screen, not on the sign-in screen.** Email OTP and social sign-in have no separate sign-up form: a returning owner or an invited teammate must never see a business-name field. The screen immediately after first sign-in asks for it (one screen, still minute one).
2. **Org data keys are not provisioned at workspace creation.** `provisionOrgKeys` needs the KEK, which only the worker holds; the api enqueues nothing yet. `workspaces.box_public_key` stays NULL through Phase 1; Phase 2 provisions keys in the worker before the first mailbox credential is written.
3. **Microsoft sign-in requests `openid profile email` only** (`disableDefaultScope`, `disableProfilePhoto`): Better Auth reads the profile from the id token and only needs `User.Read` for the avatar. Google keeps its default `openid email profile`; no `accessType: offline`.
4. **Roles are Better Auth's defaults** (`owner`, `admin`, `member`); owner/admin may edit the workspace and manage the team, member is read-only. No custom access-control statements yet.
5. **Screen tests are minimal** (two RNTL component tests prove the runner); the Playwright signup smoke and the Expo web export are the app's real gates, as the spec's Phase 1 verification says.
6. **EAS dev builds, EAS Hosting deploys, store/consent-screen verifications and the Resend domain are Robert's manual steps.** Task 14 writes the runbook with exact commands and values; CI cannot run them.
7. The sign-in screen offers Google and Microsoft buttons only when the api reports those providers as configured (`GET /api/auth/config` is not a Better Auth endpoint; the app reads `GET /meta` from Task 5). Without client ids the buttons are hidden, so local development works with OTP alone.

## Phase 1 pre-flight carry-overs (from `docs/STATUS.md`)

Folded into the task that touches the file: the api error handler fixes (`err.headers`, `err.status`, deliberate 502/503, `err.code` allow-list) → Task 5; the `ServerDeps` facade → Task 5; `rls.test.ts` `relkind IN ('r','p')` → Task 2. Not touched by Phase 1 and deferred again with a reason: `pinned-fetch.ts` HEAD `content-length` (Phase 2 is the first consumer), `platform.access` audit-row retention (Phase 7's retention sweep), the worker's logger and `defineJob` zod fail-fast (no worker change in Phase 1; first Phase 2 task that opens `apps/worker`), `keys.test.ts` order dependence (Task 2 edits its `beforeAll` only), the non-superuser CI login role (needs `CREATEDB` + `aesa_owner` membership semantics that deserve their own task; Phase 2's `mailbox_credentials` worker-only grants make it load-bearing — do it there).

## File structure

```
packages/contracts/                 NEW @aesa/contracts — zod inputs + enums shared by api, db, app; zod only, no Node imports
  src/index.ts · onboarding.ts · workspace.ts · devices.ts · team.ts · test/*.test.ts
packages/db/
  src/schema/auth.ts                NEW Better Auth tables (uuid ids) + authSchema + AUTH_TABLES
  src/schema/notifications.ts       NEW notification_devices (tenant table)
  src/schema/tenancy.ts             MODIFY enums from contracts; workspaces.org_id → organization.id
  src/audit.ts                      NEW audit(tx, entry)
  src/testing.ts                    MODIFY createTestOrganization()
  migrations/0003_*.sql (generated) · 0004_force_rls_notification_devices.sql (custom)
apps/api/src/
  config.ts                         MODIFY auth/mail/origin variables
  mail/transport.ts · mail/templates.ts   NEW MailTransport (resend | devsink) + the two emails
  auth.ts                           NEW createAuth() — Better Auth instance
  deps.ts                           NEW ApiFacade + ServerDeps (no raw handle)
  server.ts                         MODIFY error-handler fixes, CORS, /api/auth/*, /trpc, /meta, /__dev/mail
  trpc/context.ts · trpc/init.ts · trpc/router.ts · trpc/routers/workspace.ts · trpc/routers/devices.ts   NEW
  index.ts                          MODIFY composition root
apps/app/                           NEW Expo universal app (@aesa/app)
  app.json · eas.json · package.json · tsconfig.json · jest.config.js · playwright.config.ts · .env.example
  src/app/                          routes only (see Task 8)
  src/lib/                          api-url · auth-client · trpc · session-gate · use-gate · push
  src/components/                   theme primitives + responsive-shell
  src/screens/                      screen bodies
  e2e/signup.spec.ts                Playwright smoke
docs/runbooks/2026-09-phase-1-external-setup.md   NEW Robert's checklist
eslint.config.js · .github/workflows/ci.yml · README.md · CLAUDE.md · docs/STATUS.md   MODIFY
```

---

### Task 1: Branch and `@aesa/contracts`

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/vitest.config.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/onboarding.ts`, `packages/contracts/src/workspace.ts`, `packages/contracts/src/devices.ts`, `packages/contracts/src/team.ts`, `packages/contracts/test/onboarding.test.ts`, `packages/contracts/test/workspace.test.ts`, `packages/contracts/test/devices.test.ts`
- Modify: `packages/db/package.json` (dependency), `packages/db/src/schema/tenancy.ts:7-8` (enums come from contracts)

**Interfaces:**
- Produces: `ONBOARDING_STEPS`, `OnboardingStep`, `isOnboardingStep(s): s is OnboardingStep`, `nextOnboardingStep(step): OnboardingStep`; `TONES`, `Tone`, `HttpUrl`, `CreateWorkspaceInput` (`{ businessName, timezone }`), `UpdateProfileInput` (`{ websiteUrl: string|null, description, tone, contactPhone: string|null, contactUrls: string[] }`), `deriveAllowedHosts(websiteUrl, contactUrls): string[]`, `slugify(name): string`; `EXPO_PUSH_TOKEN_RE`, `RegisterDeviceInput` (`{ expoPushToken, platform: 'ios'|'android', deviceName? }`), `UnregisterDeviceInput`; `ORG_ROLES`, `OrgRole`, `canManageWorkspace(role)`.

- [ ] **Step 1: Create the branch and commit this plan**

```bash
git checkout -b phase-1 main
git add docs/superpowers/plans/2026-09-08-phase-1-accounts-and-app-shell.md
git commit -m "docs(plan): Phase 1 — accounts and the app shell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing tests**

`packages/contracts/test/onboarding.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ONBOARDING_STEPS, isOnboardingStep, nextOnboardingStep } from '../src/index.ts'

describe('onboarding steps', () => {
  it('walks profile → mailbox → knowledge → go_live → done and stays at done', () => {
    expect(ONBOARDING_STEPS).toEqual(['profile', 'mailbox', 'knowledge', 'go_live', 'done'])
    expect(nextOnboardingStep('profile')).toBe('mailbox')
    expect(nextOnboardingStep('mailbox')).toBe('knowledge')
    expect(nextOnboardingStep('knowledge')).toBe('go_live')
    expect(nextOnboardingStep('go_live')).toBe('done')
    expect(nextOnboardingStep('done')).toBe('done')
  })
  it('narrows arbitrary strings', () => {
    expect(isOnboardingStep('mailbox')).toBe(true)
    expect(isOnboardingStep('billing')).toBe(false)
  })
})
```

`packages/contracts/test/workspace.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CreateWorkspaceInput, TONES, UpdateProfileInput, deriveAllowedHosts, slugify } from '../src/index.ts'

describe('workspace contracts', () => {
  it('CreateWorkspaceInput trims and bounds the business name', () => {
    expect(CreateWorkspaceInput.parse({ businessName: '  Acme ', timezone: 'Europe/Berlin' })).toEqual({ businessName: 'Acme', timezone: 'Europe/Berlin' })
    expect(CreateWorkspaceInput.safeParse({ businessName: '   ', timezone: 'UTC' }).success).toBe(false)
    expect(CreateWorkspaceInput.safeParse({ businessName: 'x'.repeat(121), timezone: 'UTC' }).success).toBe(false)
  })
  it('UpdateProfileInput accepts only http(s) URLs and known tones', () => {
    expect(TONES).toEqual(['friendly', 'formal', 'concise'])
    const ok = UpdateProfileInput.parse({ websiteUrl: 'https://acme.com', description: 'We sell socks', tone: 'formal', contactPhone: null, contactUrls: ['https://acme.com/contact'] })
    expect(ok.tone).toBe('formal')
    expect(UpdateProfileInput.safeParse({ websiteUrl: 'ftp://acme.com', description: '', tone: 'friendly', contactPhone: null, contactUrls: [] }).success).toBe(false)
    expect(UpdateProfileInput.safeParse({ websiteUrl: null, description: '', tone: 'shouty', contactPhone: null, contactUrls: [] }).success).toBe(false)
  })
  it('derives the guardrail host list: lowercased, www stripped, deduplicated, in first-seen order', () => {
    expect(deriveAllowedHosts('https://WWW.Acme.com/about', ['https://acme.com/contact', 'https://help.acme.com', 'https://help.acme.com/x'])).toEqual(['acme.com', 'help.acme.com'])
    expect(deriveAllowedHosts(null, [])).toEqual([])
  })
  it('slugify produces a url-safe base that never starts or ends with a dash', () => {
    expect(slugify('Acme & Sons, Ltd.')).toBe('acme-sons-ltd')
    expect(slugify('Ünïcödé Café')).toBe('unicode-cafe')
    expect(slugify('   ')).toBe('workspace')
    expect(slugify('a'.repeat(80))).toHaveLength(40)
  })
})
```

`packages/contracts/test/devices.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { RegisterDeviceInput, canManageWorkspace } from '../src/index.ts'

describe('device and team contracts', () => {
  it('accepts Expo push tokens only', () => {
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'ExponentPushToken[abc-DEF_123]', platform: 'ios' }).success).toBe(true)
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'ExpoPushToken[xyz]', platform: 'android', deviceName: 'Pixel' }).success).toBe(true)
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'fcm:abc', platform: 'android' }).success).toBe(false)
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'ExponentPushToken[abc]', platform: 'web' }).success).toBe(false)
  })
  it('owner and admin manage the workspace, member does not', () => {
    expect(canManageWorkspace('owner')).toBe(true)
    expect(canManageWorkspace('admin')).toBe(true)
    expect(canManageWorkspace('member')).toBe(false)
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @aesa/contracts test`
Expected: FAIL — no such package.

- [ ] **Step 4: Create the package**

`packages/contracts/package.json`:
```json
{
  "name": "@aesa/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": { "@types/node": "^22", "typescript": "^5.9.2", "vitest": "^3.2.0" }
}
```

`packages/contracts/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"] }
```

`packages/contracts/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

`packages/contracts/src/onboarding.ts`:
```ts
/** Server-tracked onboarding position (workspaces.onboarding_step). The app renders the step the server says. */
export const ONBOARDING_STEPS = ['profile', 'mailbox', 'knowledge', 'go_live', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export function isOnboardingStep(value: string): value is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(value)
}

/** Linear, forward only; `done` is absorbing. Skipping a step is the same call as finishing it. */
export function nextOnboardingStep(step: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(step)
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)]!
}
```

`packages/contracts/src/workspace.ts`:
```ts
import { z } from 'zod'

export const TONES = ['friendly', 'formal', 'concise'] as const
export type Tone = (typeof TONES)[number]

const isHttpUrl = (v: string) => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }
export const HttpUrl = z.string().trim().max(2048).refine(isHttpUrl, { message: 'must be an http(s) URL' })

export const CreateWorkspaceInput = z.object({
  businessName: z.string().trim().min(1).max(120),
  /** IANA zone from the device; the api validates it against Intl.supportedValuesOf('timeZone'). */
  timezone: z.string().trim().min(1).max(64),
})
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>

export const UpdateProfileInput = z.object({
  websiteUrl: HttpUrl.nullable(),
  description: z.string().trim().max(500),
  tone: z.enum(TONES),
  contactPhone: z.string().trim().min(3).max(40).nullable(),
  contactUrls: z.array(HttpUrl).max(10),
})
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>

/** The guardrail allowlist shown as "Replies may link only to …": hostnames of the website and contact URLs. */
export function deriveAllowedHosts(websiteUrl: string | null, contactUrls: readonly string[]): string[] {
  const hosts = new Set<string>()
  for (const raw of [websiteUrl, ...contactUrls]) {
    if (!raw) continue
    try { hosts.add(new URL(raw).hostname.toLowerCase().replace(/^www\./, '')) } catch { /* validated by HttpUrl upstream */ }
  }
  return [...hosts]
}

/** Base for the Better Auth organization slug; the api appends a random suffix and retries on collision. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD').replace(/\p{M}/gu, '')   // strip combining marks: Café → Cafe
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '')
  return base || 'workspace'
}
```

`packages/contracts/src/devices.ts`:
```ts
import { z } from 'zod'

export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/

export const RegisterDeviceInput = z.object({
  expoPushToken: z.string().regex(EXPO_PUSH_TOKEN_RE, 'not an Expo push token'),
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().trim().max(80).optional(),
})
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceInput>

export const UnregisterDeviceInput = z.object({ expoPushToken: z.string().regex(EXPO_PUSH_TOKEN_RE) })
```

`packages/contracts/src/team.ts`:
```ts
/** Better Auth organization plugin defaults. owner/admin manage the workspace and the team; member is read-only. */
export const ORG_ROLES = ['owner', 'admin', 'member'] as const
export type OrgRole = (typeof ORG_ROLES)[number]
export const canManageWorkspace = (role: OrgRole): boolean => role === 'owner' || role === 'admin'
```

`packages/contracts/src/index.ts`:
```ts
export * from './onboarding.ts'
export * from './workspace.ts'
export * from './devices.ts'
export * from './team.ts'
```

- [ ] **Step 5: Point `@aesa/db` at the shared enums**

`packages/db/package.json` — add `"@aesa/contracts": "workspace:*"` to `dependencies`.

`packages/db/src/schema/tenancy.ts` — replace lines 7–8 (`export const ONBOARDING_STEPS …` and `export const TONES …`) with:
```ts
// The check constraints below spell the same literals: drizzle-kit inlines sql`` parameters into DDL only
// partially, so building them from the arrays would change the snapshot. Keep both in sync by hand.
export { ONBOARDING_STEPS, TONES } from '@aesa/contracts'
```

Run: `pnpm install`

- [ ] **Step 6: Run the tests and the gate**

Run: `pnpm --filter @aesa/contracts test && pnpm typecheck && pnpm lint && pnpm --filter @aesa/db test && pnpm db:check`
Expected: contracts 3 files pass; db unchanged (`migrations in sync with schema`).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts packages/db/package.json packages/db/src/schema/tenancy.ts pnpm-lock.yaml
git commit -m "feat(contracts): @aesa/contracts — enums and zod inputs shared by api, db and app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Better Auth tables, `notification_devices`, the organization foreign key

**Files:**
- Create: `packages/db/src/schema/auth.ts`, `packages/db/src/schema/notifications.ts`, `packages/db/test/auth-schema.test.ts`, `packages/db/migrations/0003_<generated>.sql` (+ `meta/0003_snapshot.json`, journal entry), `packages/db/migrations/0004_force_rls_notification_devices.sql` (+ snapshot, journal)
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/schema/tenancy.ts:12` (FK), `packages/db/src/testing.ts`, `packages/db/test/rls.test.ts`, `packages/db/test/migrations.test.ts`, `packages/db/test/tenant.test.ts`, `packages/db/test/keys.test.ts`

**Interfaces:**
- Produces: tables `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` (uuid ids, `defaultRandom()`), `authSchema` (the object Better Auth's drizzle adapter receives), `AUTH_TABLES` (readonly table-name tuple), `notificationDevices`; `createTestOrganization(handle, name?): Promise<string>` in `@aesa/db/testing`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/auth-schema.test.ts`:
```ts
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_TABLES, notificationDevices, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('Better Auth tables and notification_devices', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let owner: pg.Client
  let app: ReturnType<typeof createDb>
  beforeAll(async () => {
    t = await createTestDatabase()
    owner = new pg.Client({ connectionString: t.url }); await owner.connect()
    app = createDb(t.url)
  })
  afterAll(async () => { await owner.end(); await app.pool.end(); await t.drop() })

  it('names the seven tables Better Auth 1.7 needs for email OTP + organization', () => {
    expect([...AUTH_TABLES].sort()).toEqual(['account', 'invitation', 'member', 'organization', 'session', 'user', 'verification'])
  })

  it('generates uuid ids in the database (generateId: false) and is writable by aesa_app', async () => {
    const { rows } = await app.pool.query<{ id: string }>(`INSERT INTO "user" (name, email) VALUES ('A', 'a@example.com') RETURNING id`)
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('has no row-level security on the auth tables (the api reaches them only through Better Auth)', async () => {
    const res = await owner.query(`SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity`, [[...AUTH_TABLES]])
    expect(res.rows).toEqual([])
  })

  it('id and organization columns are uuid, not text', async () => {
    const res = await owner.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE (table_name, column_name) IN (('user','id'),('session','user_id'),('session','active_organization_id'),('member','organization_id'),('invitation','inviter_id'))`)
    expect(res.rows).toHaveLength(5)
    expect(res.rows.every((r) => r.data_type === 'uuid')).toBe(true)
  })

  it('workspaces.org_id references organization.id', async () => {
    const orphan = crypto.randomUUID()
    await expect(withOrg(app.db, orphan, (tx) => tx.insert(workspaces).values({ orgId: orphan, businessName: 'x', timezone: 'UTC' })))
      .rejects.toMatchObject({ cause: { code: '23503' } })
    const orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'x', timezone: 'UTC' }))
  })

  it('notification_devices is a forced-RLS tenant table keyed per (org, user, token)', async () => {
    const orgId = await createTestOrganization(app)
    const { rows } = await app.pool.query<{ id: string }>(`INSERT INTO "user" (name, email) VALUES ('B', 'b@example.com') RETURNING id`)
    const userId = rows[0]!.id
    const token = 'ExponentPushToken[abc]'
    await withOrg(app.db, orgId, (tx) => tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: token, platform: 'ios' }))
    await expect(withOrg(app.db, orgId, (tx) => tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: token, platform: 'ios' })))
      .rejects.toMatchObject({ cause: { code: '23505' } })
    await expect(withOrg(app.db, orgId, (tx) => tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: 'ExponentPushToken[web]', platform: 'web' })))
      .rejects.toMatchObject({ cause: { code: '23514' } })
    expect(await app.db.select().from(notificationDevices)).toHaveLength(0)   // raw app handle: RLS hides the row
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/db test test/auth-schema.test.ts`
Expected: FAIL — `AUTH_TABLES` is not exported.

- [ ] **Step 3: Write the schema**

`packages/db/src/schema/auth.ts` (hand-written from `npx @better-auth/cli generate` output for better-auth 1.7.3 with the emailOTP, organization and expo plugins, with every id and reference switched from `text` to `uuid` and every timestamp made `timestamptz`; the export names must equal Better Auth's model names because the drizzle adapter looks them up by name):
```ts
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const ts = (name: string) => timestamp(name, { withTimezone: true })
const authId = () => uuid('id').primaryKey().defaultRandom()   // generateId: false → Postgres mints the id

/**
 * Better Auth's tables. NOT tenant tables (RLS_EXEMPT in test/rls.test.ts by ruling): the api reaches them
 * only through Better Auth's adapter on the aesa_app handle, and migration 0002's default privileges give
 * aesa_app full DML. Ids are uuid (advanced.database.generateId: false) so workspaces.org_id can reference
 * organization.id and audit actors read `user:<uuid>`.
 */
export const user = pgTable('user', {
  id: authId(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

export const session = pgTable('session', {
  id: authId(),
  expiresAt: ts('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  /** Set by the organization plugin (setActive / createOrganization). tRPC derives orgId from it. */
  activeOrganizationId: uuid('active_organization_id'),
}, (t) => [index('session_user_id_idx').on(t.userId)])

export const account = pgTable('account', {
  id: authId(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'),
  refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index('account_user_id_idx').on(t.userId)])

export const verification = pgTable('verification', {
  id: authId(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index('verification_identifier_idx').on(t.identifier)])

export const organization = pgTable('organization', {
  id: authId(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: ts('created_at').notNull().defaultNow(),
  metadata: text('metadata'),
}, (t) => [uniqueIndex('organization_slug_uidx').on(t.slug)])

export const member = pgTable('member', {
  id: authId(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('member_organization_id_idx').on(t.organizationId), index('member_user_id_idx').on(t.userId)])

export const invitation = pgTable('invitation', {
  id: authId(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  inviterId: uuid('inviter_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (t) => [index('invitation_organization_id_idx').on(t.organizationId), index('invitation_email_idx').on(t.email)])

/** What `drizzleAdapter(db, { provider: 'pg', schema: authSchema })` receives — keys are Better Auth model names. */
export const authSchema = { user, session, account, verification, organization, member, invitation } as const
export const AUTH_TABLES = ['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation'] as const
```

`packages/db/src/schema/notifications.ts`:
```ts
import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, id, orgId, tenantPolicies } from './helpers.ts'

/** One Expo push token per (org, user, device). The worker's notify.dispatch (Phase 2) reads these; the api only writes. */
export const notificationDevices = pgTable('notification_devices', {
  id: id(),
  orgId: orgId(),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expoPushToken: text('expo_push_token').notNull(),
  platform: text('platform').notNull(),
  deviceName: text('device_name'),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('notification_devices_org_user_token_uidx').on(t.orgId, t.userId, t.expoPushToken),
  check('notification_devices_platform_check', sql`${t.platform} IN ('ios','android')`),
  ...tenantPolicies(t.orgId, 'notification_devices'),
])
```

`packages/db/src/schema/index.ts` — add `export * from './auth.ts'` and `export * from './notifications.ts'` after the tenancy export.

`packages/db/src/schema/tenancy.ts` — add `import { organization } from './auth.ts'` and change the workspaces primary key line to:
```ts
  orgId: uuid('org_id').primaryKey().references(() => organization.id),   // Better Auth organization; deletion is disabled in the plugin
```

`packages/db/src/testing.ts` — append:
```ts
/** Tests only: inserts a Better Auth organization row so tenant rows can satisfy workspaces.org_id → organization.id. */
export async function createTestOrganization(handle: { pool: pg.Pool }, name = 'Test Org'): Promise<string> {
  const { rows } = await handle.pool.query<{ id: string }>(
    `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`, [name, `t-${randomBytes(4).toString('hex')}`])
  return rows[0]!.id
}
```

- [ ] **Step 4: Generate the migration, then add the FORCE line as a custom migration**

Run: `pnpm --filter @aesa/db generate`
Expected: `packages/db/migrations/0003_<adjective_noun>.sql` with `CREATE TABLE` for the seven auth tables and `notification_devices`, the `workspaces_org_id_organization_id_fk` constraint, the indexes, `ALTER TABLE "notification_devices" ENABLE ROW LEVEL SECURITY` and its two policies. Open it and check the FK and the policies are there; do not edit it.

Run: `pnpm --filter @aesa/db exec drizzle-kit generate --custom --name=force_rls_notification_devices`
Then write `packages/db/migrations/0004_force_rls_notification_devices.sql`:
```sql
ALTER TABLE "notification_devices" FORCE ROW LEVEL SECURITY;
```
(no REVOKE: the api writes device rows through `withOrg`; migration 0002's default privileges already grant `aesa_app` and `aesa_platform` DML on every new table, including the auth tables — that is the ruling.)

- [ ] **Step 5: Update the tests that now need a real organization**

`packages/db/test/rls.test.ts`:
- line 3: `import { AUTH_TABLES, ORG_ID_PREDICATE_SQL } from '../src/index.ts'`
- line 7: `const RLS_EXEMPT = ['platform_state', ...AUTH_TABLES]   // Better Auth tables are not tenant data (ruling, STATUS.md)`
- line 33: `WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relname = ANY($1::text[])) ORDER BY 1` (carry-over: partitioned tables count too)
- line 38: add `'notification_devices'` to the `arrayContaining` list.

`packages/db/test/migrations.test.ts` line 8:
```ts
const EXPECTED_TABLES = ['account', 'audit_log', 'invitation', 'member', 'notification_devices', 'org_data_keys', 'org_settings', 'organization', 'platform_state', 'session', 'usage_counters', 'user', 'verification', 'workspaces']
```

`packages/db/test/tenant.test.ts`: import `createTestOrganization` from `./helpers/test-db.ts`; replace `const orgA = crypto.randomUUID()` / `const orgB = …` with `let orgA: string` / `let orgB: string`, and at the top of `beforeAll` after `owner = createDb(...)` add `orgA = await createTestOrganization(app); orgB = await createTestOrganization(app)`.

`packages/db/test/keys.test.ts`: same import; `const orgId = crypto.randomUUID()` becomes `let orgId: string`, set with `orgId = await createTestOrganization(app)` right after `app = createDb(t.url)`.

- [ ] **Step 6: Run the db suite and the gate**

Run: `pnpm --filter @aesa/db test && pnpm typecheck && pnpm lint`
Expected: PASS, including the RLS invariant over 14 tables and the FK test.

- [ ] **Step 7: Commit the migrations first, then check drift**

```bash
git add packages/db
git commit -m "feat(db): Better Auth tables (uuid ids), notification_devices, workspaces.org_id → organization.id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm db:check
```
Expected: `migrations in sync with schema`.

---

### Task 3: `audit()` — one way to write an audit row

**Files:**
- Create: `packages/db/src/audit.ts`, `packages/db/test/audit.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces: `type AuditActor = \`user:${string}\` | \`agent:${string}\` | \`system:${string}\``, `interface AuditEntry { actor: AuditActor; action: string; entityType: string; entityId: string; detail?: Record<string, unknown>; ip?: string | null; userAgent?: string | null }`, `audit(tx: OrgTx, entry: AuditEntry): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/audit.test.ts`:
```ts
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { audit, auditLog, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('audit()', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  beforeAll(async () => {
    t = await createTestDatabase(); app = createDb(t.url); orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'A', timezone: 'UTC' }))
  })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  it('writes a row for the transaction organization with the given actor and a redacted detail', async () => {
    const userId = crypto.randomUUID()
    await withOrg(app.db, orgId, (tx) => audit(tx, { actor: `user:${userId}`, action: 'workspace.create', entityType: 'workspace', entityId: orgId, detail: { businessName: 'A' }, ip: '203.0.113.9', userAgent: 'test' }))
    const rows = await withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.create')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ orgId, actor: `user:${userId}`, entityType: 'workspace', entityId: orgId, detail: { businessName: 'A' }, ip: '203.0.113.9', userAgent: 'test' })
  })

  it('refuses an actor that is not user:/agent:/system:', async () => {
    await expect(withOrg(app.db, orgId, (tx) => audit(tx, { actor: 'owner' as never, action: 'x', entityType: 'x', entityId: 'x' }))).rejects.toThrow(/actor must be/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/db test test/audit.test.ts`
Expected: FAIL — `audit` is not exported.

- [ ] **Step 3: Implement**

`packages/db/src/audit.ts`:
```ts
import { auditLog } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

export type AuditActor = `user:${string}` | `agent:${string}` | `system:${string}`
const ACTOR_RE = /^(user|agent|system):[A-Za-z0-9._:-]+$/

export interface AuditEntry {
  actor: AuditActor
  action: string
  entityType: string
  entityId: string
  /** Already redacted by the caller: never bodies, never secrets, never tokens. */
  detail?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

/** Appends one audit_log row for the transaction's organization. The only tenant-side writer of audit_log. */
export async function audit(tx: OrgTx, entry: AuditEntry): Promise<void> {
  if (!ACTOR_RE.test(entry.actor)) throw new TypeError(`audit: actor must be user:<id> | agent:<run_id> | system:<job>, got ${JSON.stringify(entry.actor)}`)
  await tx.insert(auditLog).values({
    orgId: tx.orgId, actor: entry.actor, action: entry.action, entityType: entry.entityType, entityId: entry.entityId,
    detail: entry.detail ?? {}, ip: entry.ip ?? null, userAgent: entry.userAgent ?? null,
  })
}
```

`packages/db/src/index.ts` — add `export { audit, type AuditActor, type AuditEntry } from './audit.ts'`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @aesa/db test test/audit.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/audit.ts packages/db/src/index.ts packages/db/test/audit.test.ts
git commit -m "feat(db): audit() writes one org-scoped audit_log row with a validated actor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: api config for auth and mail, and the `MailTransport`

**Files:**
- Create: `apps/api/src/mail/transport.ts`, `apps/api/src/mail/templates.ts`, `apps/api/test/mail.test.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/test/config.test.ts`, `apps/api/.env.example`, `apps/api/package.json`

**Interfaces:**
- Produces: `ApiConfig` gains `env`, `appBaseUrl` (required; the api's own public origin), `appWebOrigin` (the Expo web origin), `trustedOrigins: string[]`, `betterAuthSecret: Secret`, `authRateLimit: boolean`, `crossSiteCookies: boolean`, `google: OAuthClient | null`, `microsoft: OAuthClient | null`, `mail: { transport: 'resend'; apiKey: Secret; from: string } | { transport: 'devsink'; from: string }`; `OutgoingMail { to; subject; text }`; `MailTransport = ResendTransport | DevSink` (discriminated on `kind`); `DevSink.latestTo(email)`, `DevSink.all()`; `createDevSink(max?)`, `createResendTransport(apiKey, from, client?)`, `createMailTransport(config.mail)`; `otpMail(to, otp)`, `invitationMail({ to, inviterName, orgName, url })`.

- [ ] **Step 1: Write the failing tests**

Replace `apps/api/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const BASE = { DATABASE_URL: 'postgres://x', APP_BASE_URL: 'http://localhost:3001', APP_WEB_ORIGIN: 'http://localhost:8081', BETTER_AUTH_SECRET: 's'.repeat(32) }

describe('api config', () => {
  it('parses defaults: devsink mail outside production, aesa:// and exp:// trusted', () => {
    const c = loadConfig(BASE)
    expect(c).toMatchObject({ databaseUrl: 'postgres://x', port: 3001, host: '0.0.0.0', logLevel: 'info', env: 'development', authRateLimit: true, crossSiteCookies: false, google: null, microsoft: null })
    expect(c.mail).toEqual({ transport: 'devsink', from: 'aesa <onboarding@resend.dev>' })
    expect(c.trustedOrigins).toEqual(['http://localhost:8081', 'aesa://', 'exp://'])
  })
  it('refuses key material — the api never holds the KEK', () => {
    expect(() => loadConfig({ ...BASE, AESA_KEK_V1: 'abc' })).toThrow(/api must not/)
  })
  it('requires APP_BASE_URL, APP_WEB_ORIGIN and a 32+ character BETTER_AUTH_SECRET', () => {
    expect(() => loadConfig({ ...BASE, APP_BASE_URL: 'nope' })).toThrow(/APP_BASE_URL/)
    expect(() => loadConfig({ ...BASE, APP_WEB_ORIGIN: undefined })).toThrow(/APP_WEB_ORIGIN/)
    expect(() => loadConfig({ ...BASE, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/)
  })
  it('wraps every secret so it never prints', () => {
    const c = loadConfig({ ...BASE, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', RESEND_API_KEY: 're_key', EMAIL_TRANSPORT: 'resend', MAIL_FROM: 'aesa <no-reply@mail.example.com>' })
    const printed = JSON.stringify(c) + String(c.betterAuthSecret)
    expect(printed).not.toContain('gsecret'); expect(printed).not.toContain('re_key'); expect(printed).not.toContain('s'.repeat(32))
    expect(c.google?.clientSecret.expose()).toBe('gsecret')
    expect(c.mail.transport === 'resend' && c.mail.apiKey.expose()).toBe('re_key')
  })
  it('an OAuth client id and secret are all-or-none', () => {
    expect(() => loadConfig({ ...BASE, MICROSOFT_CLIENT_ID: 'x' })).toThrow(/MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET/)
  })
  it('production defaults to resend, needs its key and from address, and refuses devsink', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/)
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production', RESEND_API_KEY: 're_x' })).toThrow(/MAIL_FROM/)
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production', EMAIL_TRANSPORT: 'devsink' })).toThrow(/devsink/)
    const c = loadConfig({ ...BASE, NODE_ENV: 'production', RESEND_API_KEY: 're_x', MAIL_FROM: 'aesa <no-reply@mail.example.com>', AUTH_TRUSTED_ORIGINS: 'https://app.example.com, https://staging.example.com' })
    expect(c.mail.transport).toBe('resend')
    expect(c.trustedOrigins).toEqual(['http://localhost:8081', 'aesa://', 'https://app.example.com', 'https://staging.example.com'])
  })
})
```

`apps/api/test/mail.test.ts`:
```ts
import { Secret } from '@aesa/crypto'
import { describe, expect, it } from 'vitest'
import { invitationMail, otpMail } from '../src/mail/templates.ts'
import { createDevSink, createResendTransport } from '../src/mail/transport.ts'

describe('mail transports', () => {
  it('devsink keeps the newest message per recipient (case-insensitive) and caps memory', async () => {
    const sink = createDevSink(3)
    await sink.send({ to: 'a@x.test', subject: '1', text: 'one' })
    await sink.send({ to: 'a@x.test', subject: '2', text: 'two' })
    await sink.send({ to: 'b@x.test', subject: '3', text: 'three' })
    await sink.send({ to: 'c@x.test', subject: '4', text: 'four' })
    expect(sink.kind).toBe('devsink')
    expect(sink.latestTo('A@X.TEST')?.subject).toBe('2')
    expect(sink.all()).toHaveLength(3)
    expect(sink.latestTo('nobody@x.test')).toBeUndefined()
  })

  it('resend transport sends with the configured from and reports failures without the recipient', async () => {
    const calls: unknown[] = []
    const ok = createResendTransport(new Secret('re_key'), 'aesa <no-reply@x.test>', { emails: { send: async (m) => { calls.push(m); return { data: { id: 'e_1' }, error: null } } } })
    await ok.send({ to: 'a@x.test', subject: 'Hi', text: 'body' })
    expect(ok.kind).toBe('resend')
    expect(calls[0]).toEqual({ from: 'aesa <no-reply@x.test>', to: 'a@x.test', subject: 'Hi', text: 'body' })
    const failing = createResendTransport(new Secret('re_key'), 'f', { emails: { send: async () => ({ data: null, error: { name: 'validation_error', message: 'bad a@x.test' } }) } })
    await expect(failing.send({ to: 'a@x.test', subject: 's', text: 't' })).rejects.toThrow(/^resend: validation_error$/)
  })

  it('templates carry the code and the invitation link', () => {
    const otp = otpMail('a@x.test', '123456')
    expect(otp.to).toBe('a@x.test'); expect(otp.subject).toContain('123456'); expect(otp.text).toContain('123456'); expect(otp.text).toContain('10 minutes')
    const inv = invitationMail({ to: 'b@x.test', inviterName: 'Robert', orgName: 'Acme', url: 'http://localhost:8081/invite/abc' })
    expect(inv.subject).toContain('Acme'); expect(inv.text).toContain('Robert'); expect(inv.text).toContain('http://localhost:8081/invite/abc'); expect(inv.text).toContain('48 hours')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @aesa/api test`
Expected: FAIL — `appWebOrigin` missing, `../src/mail/transport.ts` missing.

- [ ] **Step 3: Add the dependencies**

`apps/api/package.json` `dependencies` gains `"@aesa/contracts": "workspace:*"`, `"@aesa/crypto": "workspace:*"`, `"resend": "^6.26.0"`. Run `pnpm install`.

- [ ] **Step 4: Rewrite `apps/api/src/config.ts`**

```ts
import { Secret } from '@aesa/crypto'
import { z } from 'zod'

const isHttpUrl = (v: string) => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }
const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const httpUrl = (name: string) => z.string({ error: `${name} is required` }).refine(isHttpUrl, { message: `${name} must be an http(s) URL` })

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Public origin of THIS api: Better Auth's baseURL and the base of every OAuth redirect URI. */
  APP_BASE_URL: httpUrl('APP_BASE_URL'),
  /** Origin the Expo web app is served from: CORS allow-list, Better Auth trusted origin, invitation links. */
  APP_WEB_ORIGIN: httpUrl('APP_WEB_ORIGIN'),
  /** Extra Better Auth trusted origins (comma-separated), e.g. a staging web origin. */
  AUTH_TRUSTED_ORIGINS: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  AUTH_RATE_LIMIT: z.enum(['on', 'off']).default('on'),
  /** Set when the web app and the api live on different registrable domains (cookies need SameSite=None; Secure). */
  AUTH_CROSS_SITE_COOKIES: z.enum(['true', 'false']).default('false'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** resend in production; devsink (in-memory, read back through GET /__dev/mail/latest) for dev, tests and Playwright. */
  EMAIL_TRANSPORT: z.enum(['resend', 'devsink']).optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
})

export interface OAuthClient { clientId: string; clientSecret: Secret }
export type MailConfig = { transport: 'resend'; apiKey: Secret; from: string } | { transport: 'devsink'; from: string }

export interface ApiConfig {
  env: 'development' | 'test' | 'production'
  databaseUrl: string
  port: number
  host: string
  logLevel: string
  appBaseUrl: string
  appWebOrigin: string
  trustedOrigins: string[]
  betterAuthSecret: Secret
  authRateLimit: boolean
  crossSiteCookies: boolean
  google: OAuthClient | null
  microsoft: OAuthClient | null
  mail: MailConfig
}

function oauthPair(name: 'GOOGLE' | 'MICROSOFT', id: string | undefined, secret: string | undefined): OAuthClient | null {
  if (!id && !secret) return null
  if (!id || !secret) throw new Error(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be set together`)
  return { clientId: id, clientSecret: new Secret(secret) }
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const kek = Object.keys(env).filter((k) => k.startsWith('AESA_KEK_'))
  if (kek.length) throw new Error(`api must not be configured with key material (${kek.join(', ')}); only the worker holds the KEK`)
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const d = parsed.data
  const production = d.NODE_ENV === 'production'

  const transport = d.EMAIL_TRANSPORT ?? (production ? 'resend' : 'devsink')
  if (transport === 'devsink' && production) throw new Error('EMAIL_TRANSPORT=devsink is not allowed in production')
  let mail: MailConfig
  if (transport === 'resend') {
    if (!d.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when EMAIL_TRANSPORT=resend')
    if (!d.MAIL_FROM) throw new Error('MAIL_FROM is required when EMAIL_TRANSPORT=resend')
    mail = { transport, apiKey: new Secret(d.RESEND_API_KEY), from: d.MAIL_FROM }
  } else {
    mail = { transport, from: d.MAIL_FROM ?? 'aesa <onboarding@resend.dev>' }
  }

  // aesa:// is the native deep-link scheme (OAuth callbacks land there); exp:// covers Expo Go in development.
  const trustedOrigins = [...new Set([d.APP_WEB_ORIGIN, 'aesa://', ...(production ? [] : ['exp://']), ...csv(d.AUTH_TRUSTED_ORIGINS)])]

  return {
    env: d.NODE_ENV, databaseUrl: d.DATABASE_URL, port: d.PORT, host: d.HOST, logLevel: d.LOG_LEVEL,
    appBaseUrl: d.APP_BASE_URL.replace(/\/+$/, ''), appWebOrigin: d.APP_WEB_ORIGIN.replace(/\/+$/, ''), trustedOrigins,
    betterAuthSecret: new Secret(d.BETTER_AUTH_SECRET), authRateLimit: d.AUTH_RATE_LIMIT === 'on', crossSiteCookies: d.AUTH_CROSS_SITE_COOKIES === 'true',
    google: oauthPair('GOOGLE', d.GOOGLE_CLIENT_ID, d.GOOGLE_CLIENT_SECRET),
    microsoft: oauthPair('MICROSOFT', d.MICROSOFT_CLIENT_ID, d.MICROSOFT_CLIENT_SECRET),
    mail,
  }
}
```

- [ ] **Step 5: Write the transport and the templates**

`apps/api/src/mail/transport.ts`:
```ts
import { Resend } from 'resend'
import type { Secret } from '@aesa/crypto'
import type { MailConfig } from '../config.ts'

/** Platform mail only (sign-in codes, invitations, later digests). Customer mail never goes through here. */
export interface OutgoingMail { to: string; subject: string; text: string }

export interface ResendTransport { readonly kind: 'resend'; send(mail: OutgoingMail): Promise<void> }
export interface DevSink {
  readonly kind: 'devsink'
  send(mail: OutgoingMail): Promise<void>
  /** Newest message for a recipient; what tests and the Playwright smoke read the OTP from. */
  latestTo(email: string): OutgoingMail | undefined
  all(): OutgoingMail[]
}
export type MailTransport = ResendTransport | DevSink

/** In-memory ring buffer. Only constructed when EMAIL_TRANSPORT=devsink, which loadConfig refuses in production. */
export function createDevSink(max = 200): DevSink {
  const box: OutgoingMail[] = []
  return {
    kind: 'devsink',
    async send(mail) { box.push({ ...mail }); if (box.length > max) box.splice(0, box.length - max) },
    latestTo(email) { const key = email.toLowerCase(); for (let i = box.length - 1; i >= 0; i--) if (box[i]!.to.toLowerCase() === key) return { ...box[i]! }; return undefined },
    all() { return box.map((m) => ({ ...m })) },
  }
}

/** The slice of the Resend SDK we use; injectable so the transport is testable without the network. */
export interface ResendLike {
  emails: { send(mail: { from: string; to: string; subject: string; text: string }): Promise<{ data: { id: string } | null; error: { name: string; message: string } | null }> }
}

export function createResendTransport(apiKey: Secret, from: string, client: ResendLike = new Resend(apiKey.expose())): ResendTransport {
  return {
    kind: 'resend',
    async send(mail) {
      const { error } = await client.emails.send({ from, to: mail.to, subject: mail.subject, text: mail.text })
      if (error) throw new Error(`resend: ${error.name}`)   // error.message can echo the address; the name is enough to triage
    },
  }
}

export function createMailTransport(config: MailConfig): MailTransport {
  return config.transport === 'resend' ? createResendTransport(config.apiKey, config.from) : createDevSink()
}
```

`apps/api/src/mail/templates.ts`:
```ts
import type { OutgoingMail } from './transport.ts'

export function otpMail(to: string, otp: string): OutgoingMail {
  return {
    to,
    subject: `${otp} is your aesa sign-in code`,
    text: `Your sign-in code is ${otp}\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.`,
  }
}

export function invitationMail(p: { to: string; inviterName: string; orgName: string; url: string }): OutgoingMail {
  return {
    to: p.to,
    subject: `${p.inviterName} invited you to ${p.orgName} on aesa`,
    text: `${p.inviterName} invited you to join the ${p.orgName} workspace on aesa.\n\nOpen this link to accept:\n${p.url}\n\nThe invitation expires in 48 hours. If you were not expecting it, ignore this email.`,
  }
}
```

- [ ] **Step 6: Update `.env.example`**

`apps/api/.env.example`:
```
DATABASE_URL=postgres://aesa:aesa@localhost:5434/aesa_dev
PORT=3001
LOG_LEVEL=info
# Public origin of this api (Better Auth baseURL; OAuth redirect URIs are <APP_BASE_URL>/api/auth/callback/<provider>)
APP_BASE_URL=http://localhost:3001
# Origin the Expo web app is served from (CORS, trusted origin, invitation links). Expo dev server = 8081.
APP_WEB_ORIGIN=http://localhost:8081
# `openssl rand -base64 48`
BETTER_AUTH_SECRET=
# Optional social sign-in; leave blank to hide the buttons
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
# devsink (default outside production): codes are readable at GET /__dev/mail/latest?to=<email>
EMAIL_TRANSPORT=devsink
RESEND_API_KEY=
MAIL_FROM=
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @aesa/api test test/config.test.ts test/mail.test.ts && pnpm --filter @aesa/api typecheck`
Expected: PASS (other api suites still fail to compile against the new config shape until Task 5; that is expected — run only these two files).

- [ ] **Step 8: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): auth and mail configuration, MailTransport with a devsink for tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Better Auth on Fastify, the `ServerDeps` facade, error-handler carry-overs

**Files:**
- Create: `apps/api/src/auth.ts`, `apps/api/src/deps.ts`, `apps/api/test/helpers/app.ts`, `apps/api/test/auth.test.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/index.ts`, `apps/api/package.json`, `apps/api/test/error-handler.test.ts`, `apps/api/test/healthz.test.ts`

**Interfaces:**
- Consumes: `ApiConfig`, `MailTransport`, `otpMail`, `invitationMail` (Task 4); `authSchema`, `audit`, `AuditEntry`, `withOrg`, `withPlatform` (Tasks 2–3).
- Produces: `createAuth({ db, config, mail, audit }): Auth`, `type Auth`; `ApiFacade { withOrg, withPlatform, health }`, `createApiFacade(handle)`, `ServerDeps { config, auth, api, mail, logLevel?, logStream? }`; `buildServer(deps)` mounting `/api/auth/*`, `/meta` (`{ providers: { google, microsoft } }`), `/healthz`, and `/__dev/mail/latest?to=` when the transport is the devsink; test helpers `createTestApi()`, `stubDeps()`, `signInWithOtp(app, mail, email, name?)`, `listen(app)`, `WEB`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/helpers/app.ts`:
```ts
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { audit } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { expect } from 'vitest'
import { createAuth } from '../../src/auth.ts'
import { loadConfig } from '../../src/config.ts'
import { createApiFacade, type ServerDeps } from '../../src/deps.ts'
import { createDevSink, type DevSink } from '../../src/mail/transport.ts'
import { buildServer } from '../../src/server.ts'

export const WEB = 'http://localhost:8081'
export const TEST_ENV = {
  DATABASE_URL: 'postgres://unused', APP_BASE_URL: 'http://localhost:3001', APP_WEB_ORIGIN: WEB,
  BETTER_AUTH_SECRET: 'test-secret-'.repeat(4), AUTH_RATE_LIMIT: 'off',
} as const

/** A complete api over a throwaway database; `close()` drops it. */
export async function createTestApi(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const t = await createTestDatabase()
  const config = loadConfig({ ...TEST_ENV, ...overrides, DATABASE_URL: t.url })
  const handle = createDb(t.url, { role: 'app' })
  const api = createApiFacade(handle)
  const mail = createDevSink()
  const auth = createAuth({ db: handle.db, config, mail, audit: (orgId, entry) => api.withOrg(orgId, (tx) => audit(tx, entry)) })
  const lines: string[] = []
  const app = buildServer({ config, auth, api, mail, logLevel: 'warn', logStream: { write: (line: string) => void lines.push(line) } })
  return { app, config, mail, api, handle, lines, close: async () => { await app.close(); await handle.pool.end(); await t.drop() } }
}

/** Deps for suites that never touch the database (error handler, redaction, /meta). */
export function stubDeps(env: Partial<NodeJS.ProcessEnv> = {}): ServerDeps {
  const config = loadConfig({ ...TEST_ENV, ...env })
  const auth = { handler: async () => new Response(null, { status: 404 }), api: {} } as unknown as ServerDeps['auth']
  const api: ServerDeps['api'] = {
    withOrg: async () => { throw new Error('no database in stubDeps') },
    withPlatform: async () => { throw new Error('no database in stubDeps') },
    health: async () => ({ db: 'error', migrations: { count: 0, latest: null } }),
  }
  return { config, auth, api, mail: createDevSink() }
}

/** Email OTP sign-in through the real routes. Returns the session cookie (name=value) and the user. */
export async function signInWithOtp(app: FastifyInstance, mail: DevSink, email: string, name = 'Robert') {
  const headers = { origin: WEB, 'content-type': 'application/json' }
  const sent = await app.inject({ method: 'POST', url: '/api/auth/email-otp/send-verification-otp', headers, payload: { email, type: 'sign-in' } })
  expect(sent.statusCode).toBe(200)
  const otp = mail.latestTo(email)?.text.match(/\b(\d{6})\b/)?.[1]
  expect(otp).toBeDefined()
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email-otp', headers, payload: { email, otp, name } })
  expect(res.statusCode).toBe(200)
  const raw = res.headers['set-cookie']
  const first = (Array.isArray(raw) ? raw : [raw]).find((c) => c?.includes('session_token'))
  expect(first).toBeDefined()
  return { cookie: first!.split(';')[0]!, user: res.json().user as { id: string; email: string; name: string } }
}

/** Binds to a random port for suites that need real HTTP (the tRPC client). */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}
```

`apps/api/test/auth.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { WEB, createTestApi, signInWithOtp, stubDeps } from './helpers/app.ts'

describe('Better Auth on Fastify', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  beforeAll(async () => { t = await createTestApi() })
  afterAll(async () => { await t.close() })

  it('emails a 6-digit code, signs in with it, and the session survives a get-session round trip', async () => {
    const { cookie, user } = await signInWithOtp(t.app, t.mail, 'robert@example.com')
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.mail.latestTo('robert@example.com')?.subject).toMatch(/\d{6} is your aesa sign-in code/)
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ user: { email: 'robert@example.com', name: 'Robert' }, session: { activeOrganizationId: null } })
  })

  it('stores the code hashed, never in clear', async () => {
    await t.app.inject({ method: 'POST', url: '/api/auth/email-otp/send-verification-otp', headers: { origin: WEB, 'content-type': 'application/json' }, payload: { email: 'hash@example.com', type: 'sign-in' } })
    const otp = t.mail.latestTo('hash@example.com')!.text.match(/\b(\d{6})\b/)![1]!
    const { rows } = await t.handle.pool.query<{ value: string }>(`SELECT value FROM verification WHERE identifier LIKE '%hash@example.com%'`)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.value).not.toContain(otp)
  })

  it('rejects a state-changing request from an untrusted origin', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/email-otp/send-verification-otp', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: { email: 'x@example.com', type: 'sign-in' } })
    expect(res.statusCode).toBe(403)
  })

  it('get-session without a cookie is null, and a forged cookie is null', async () => {
    const a = await t.app.inject({ method: 'GET', url: '/api/auth/get-session' })
    expect(a.statusCode).toBe(200); expect(a.json()).toBeNull()
    const b = await t.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie: 'better-auth.session_token=nope' } })
    expect(b.json()).toBeNull()
  })

  it('answers CORS preflight only for the web origin, with credentials', async () => {
    const ok = await t.app.inject({ method: 'OPTIONS', url: '/api/auth/get-session', headers: { origin: WEB, 'access-control-request-method': 'GET' } })
    expect(ok.headers['access-control-allow-origin']).toBe(WEB)
    expect(ok.headers['access-control-allow-credentials']).toBe('true')
    const no = await t.app.inject({ method: 'OPTIONS', url: '/api/auth/get-session', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
    expect(no.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('exposes the latest devsink mail for the Playwright smoke and 404s otherwise', async () => {
    await t.mail.send({ to: 'pw@example.com', subject: 'hello', text: 'world' })
    const hit = await t.app.inject({ method: 'GET', url: '/__dev/mail/latest?to=pw@example.com' })
    expect(hit.json()).toEqual({ to: 'pw@example.com', subject: 'hello', text: 'world' })
    expect((await t.app.inject({ method: 'GET', url: '/__dev/mail/latest?to=none@example.com' })).statusCode).toBe(404)
  })
})

describe('/meta', () => {
  it('reports which social providers are configured', async () => {
    const off = buildServer(stubDeps())
    expect((await off.inject({ method: 'GET', url: '/meta' })).json()).toEqual({ providers: { google: false, microsoft: false } })
    await off.close()
    const on = buildServer(stubDeps({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' }))
    expect((await on.inject({ method: 'GET', url: '/meta' })).json()).toEqual({ providers: { google: true, microsoft: false } })
    await on.close()
  })
})
```

Append to `apps/api/test/error-handler.test.ts` (and change `buildCapturingServer` to build with `{ ...stubDeps(), logLevel: 'trace', logStream }` — import `stubDeps` from `./helpers/app.ts`):
```ts
  it('copies err.headers onto the reply and honours err.status (Better Auth throws status + headers)', async () => {
    const { app } = buildCapturingServer()
    app.get('/rl', async () => { throw Object.assign(new Error('slow down'), { status: 429, headers: { 'retry-after': '7' } }) })
    const res = await app.inject({ method: 'GET', url: '/rl' })
    await app.close()
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe('7')
    expect(res.json()).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Too Many Requests' })
  })

  it('lets a deliberate 502/503 through and collapses every other 5xx to 500', async () => {
    const { app } = buildCapturingServer()
    app.get('/down', async () => { throw Object.assign(new Error('db gone'), { statusCode: 503 }) })
    app.get('/odd', async () => { throw Object.assign(new Error('x'), { statusCode: 507 }) })
    const a = await app.inject({ method: 'GET', url: '/down' })
    const b = await app.inject({ method: 'GET', url: '/odd' })
    await app.close()
    expect(a.statusCode).toBe(503); expect(a.json()).toEqual({ statusCode: 503, error: 'Service Unavailable' })
    expect(b.statusCode).toBe(500); expect(b.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
  })

  it('keeps a short error code (Postgres SQLSTATE) in the log line but never the cause message', async () => {
    const { app, log } = buildCapturingServer()
    app.get('/pg', async () => { throw new DrizzleQueryError(QUERY, [SECRET], Object.assign(new Error(`duplicate key ${SECRET}`), { code: '23505' })) })
    const res = await app.inject({ method: 'GET', url: '/pg' })
    await app.close()
    expect(res.statusCode).toBe(500)
    expect(log()).toContain('"code":"23505"')
    expect(log()).not.toContain(SECRET)
  })
```

Rewrite `apps/api/test/healthz.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApi } from './helpers/app.ts'

describe('GET /healthz', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  beforeAll(async () => { t = await createTestApi() })
  afterAll(async () => { await t.close() })

  it('reports db ok and the applied migration count through the facade', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' })
    expect(res.json().migrations.count).toBeGreaterThanOrEqual(5)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @aesa/api test`
Expected: FAIL — `../src/auth.ts` and `../src/deps.ts` do not exist.

- [ ] **Step 3: Add dependencies**

`apps/api/package.json` `dependencies` gains `"better-auth": "1.7.3"`, `"@better-auth/expo": "1.7.3"`, `"@fastify/cors": "^11.3.0"` (exact pins on better-auth: its minor releases change endpoint shapes). Run `pnpm install`.

- [ ] **Step 4: Write `apps/api/src/auth.ts`**

```ts
import { expo } from '@better-auth/expo'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP, organization } from 'better-auth/plugins'
import { authSchema, type AuditEntry, type Db } from '@aesa/db'
import type { ApiConfig } from './config.ts'
import { invitationMail, otpMail } from './mail/templates.ts'
import type { MailTransport } from './mail/transport.ts'

export interface AuthDeps {
  /** The app-role handle. Better Auth's tables are RLS-exempt; this is the only code that queries them directly. */
  db: Db
  config: ApiConfig
  mail: MailTransport
  /** Writes an org-scoped audit row from a Better Auth hook (hooks run outside any request transaction). */
  audit: (orgId: string, entry: AuditEntry) => Promise<void>
}

export function createAuth({ db, config, mail, audit }: AuthDeps) {
  return betterAuth({
    appName: 'aesa',
    baseURL: config.appBaseUrl,
    basePath: '/api/auth',
    secret: config.betterAuthSecret.expose(),
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    advanced: {
      database: { generateId: false },   // Postgres mints uuid ids (packages/db/src/schema/auth.ts)
      ...(config.crossSiteCookies ? { defaultCookieAttributes: { sameSite: 'none' as const, secure: true } } : {}),
    },
    trustedOrigins: config.trustedOrigins,
    rateLimit: {
      enabled: config.authRateLimit,
      window: 60, max: 60,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/sign-in/email-otp': { window: 60, max: 10 },
      },
    },
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(config.google ? { google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret.expose(), prompt: 'select_account' as const } } : {}),
      ...(config.microsoft ? {
        microsoft: {
          clientId: config.microsoft.clientId, clientSecret: config.microsoft.clientSecret.expose(), tenantId: 'common', prompt: 'select_account' as const,
          // Minimal scopes: the profile comes from the id token; User.Read is only needed for the avatar (deviation 3).
          disableDefaultScope: true, scope: ['openid', 'profile', 'email'], disableProfilePhoto: true,
        },
      } : {}),
    },
    plugins: [
      emailOTP({
        otpLength: 6, expiresIn: 600, allowedAttempts: 3, storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in') return   // no password reset, no separate email verification in this product
          await mail.send(otpMail(email, otp))
        },
      }),
      organization({
        creatorRole: 'owner',
        disableOrganizationDeletion: true,   // deletion is a soft-delete + 30-day job (Phase 7)
        invitationExpiresIn: 48 * 60 * 60,
        cancelPendingInvitationsOnReInvite: true,
        async sendInvitationEmail(data) {
          await mail.send(invitationMail({ to: data.email, inviterName: data.inviter.user.name, orgName: data.organization.name, url: `${config.appWebOrigin}/invite/${data.id}` }))
        },
        organizationHooks: {
          // The accepting user is unambiguous here; invitations, role changes and removals are audited by the
          // tRPC team router (Task 7), which knows the acting user.
          async afterAcceptInvitation({ invitation, member, user, organization: org }) {
            await audit(org.id, { actor: `user:${user.id}`, action: 'team.join', entityType: 'member', entityId: member.id, detail: { invitationId: invitation.id, role: member.role } })
          },
        },
      }),
      expo(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
```

- [ ] **Step 5: Write `apps/api/src/deps.ts`**

```ts
import type pg from 'pg'
import { withOrg, withPlatform, type Db, type OrgTx, type PlatformTx } from '@aesa/db'
import type { Auth } from './auth.ts'
import type { ApiConfig } from './config.ts'
import type { MailTransport } from './mail/transport.ts'

export interface HealthReport { db: 'ok' | 'error'; migrations: { count: number; latest: string | null } }

/**
 * Everything a request handler may touch. No Db, no Pool (Phase 0 review I9): tenancy is enforced by
 * construction because the only data paths are withOrg (branded OrgTx) and withPlatform (audited).
 */
export interface ApiFacade {
  withOrg<T>(orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T>
  withPlatform<T>(reason: string, fn: (tx: PlatformTx) => Promise<T>): Promise<T>
  health(): Promise<HealthReport>
}

/** Called only by the composition root (src/index.ts) and test helpers — the two places that hold a raw handle. */
export function createApiFacade(handle: { db: Db; pool: pg.Pool }): ApiFacade {
  return {
    withOrg: (orgId, fn) => withOrg(handle.db, orgId, fn),
    withPlatform: (reason, fn) => withPlatform(handle.db, reason, fn),
    async health() {
      try {
        await handle.pool.query('SELECT 1')
        const res = await handle.pool.query<{ count: number; latest: string | null }>(
          'SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations')
        return { db: 'ok', migrations: res.rows[0] ?? { count: 0, latest: null } }
      } catch {
        return { db: 'error', migrations: { count: 0, latest: null } }
      }
    },
  }
}

export interface ServerDeps {
  config: ApiConfig
  auth: Auth
  api: ApiFacade
  mail: MailTransport
  logLevel?: string
  /** Test seam: a pino destination so a suite can assert on the real log output. Production logs to stdout. */
  logStream?: { write(line: string): void }
}
```

- [ ] **Step 6: Rewrite `apps/api/src/server.ts`**

```ts
import { STATUS_CODES } from 'node:http'
import cors from '@fastify/cors'
import { fromNodeHeaders } from 'better-auth/node'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { ServerDeps } from './deps.ts'
import { redactUrl } from './redact.ts'

export type { ServerDeps } from './deps.ts'

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g
/** Short machine codes are safe to log: Postgres SQLSTATEs, Fastify FST_*, Node ECONN*. Never a message. */
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/

interface SerializedError { [key: string]: unknown; type: string; message: string; stack: string; code?: string }

/**
 * pino `err` serializer. Emits type/message/stack (+ a short code) only — never `params`, `query` or `cause`
 * messages: drizzle's DrizzleQueryError message is `Failed query: <sql>\nparams: <bound values>` (session tokens,
 * verification codes) and a pg `cause` repeats the offending value in its own `detail`.
 */
function serializeError(err: Error & { code?: unknown; cause?: unknown }): SerializedError {
  const type = err?.constructor?.name ?? 'Error'
  const raw = err instanceof DrizzleQueryError ? 'Failed query: [redacted]' : String(err?.message ?? err)
  const message = raw.replace(URL_IN_TEXT, (url) => redactUrl(url))
  const frames = String(err?.stack ?? '').split('\n').filter((line) => /^\s*at /.test(line))
  const candidate = typeof err?.code === 'string' ? err.code : typeof (err?.cause as { code?: unknown })?.code === 'string' ? (err.cause as { code: string }).code : undefined
  const code = candidate && SAFE_CODE.test(candidate) ? candidate : undefined
  return { type, message, stack: [`${type}: ${message}`, ...frames].join('\n'), ...(code ? { code } : {}) }
}

type ThrownError = FastifyError & { status?: number; headers?: Record<string, string> }

export function buildServer(deps: ServerDeps): FastifyInstance {
  const logger: FastifyServerOptions['logger'] = {
    level: deps.logLevel ?? 'info',
    // Defence in depth: the `req` serializer never emits headers, so these paths cannot match today; they stay so
    // that adding a header to that serializer cannot silently start leaking one.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'], censor: '[redacted]' },
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }),
      err: serializeError,
    },
    ...(deps.logStream ? { stream: deps.logStream } : {}),
  }
  const app = Fastify({ logger })
  const startedAt = Date.now()

  // Better Auth's client posts JSON; some calls carry no body. Fastify's stock parser 400s an empty JSON body.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined)
    try { done(null, JSON.parse(body as string)) } catch { done(Object.assign(new Error('Bad Request'), { statusCode: 400 }), undefined) }
  })

  // Browser callers: only the Expo web origin, with credentials. Native callers send no Origin and are not CORS.
  app.register(cors, { origin: [deps.config.appWebOrigin], credentials: true })

  // Fastify's default handler puts err.message in the body and logs the raw error; both leak query parameters.
  // 5xx answers with a bare body (a deliberate 502/503 survives, everything else is a 500); 4xx keeps Fastify's
  // shape but only Fastify's own message. err.headers (WWW-Authenticate, Retry-After) and err.status are honoured.
  app.setErrorHandler((err: ThrownError, req, reply) => {
    const raw = typeof err.statusCode === 'number' ? err.statusCode : typeof err.status === 'number' ? err.status : 500
    const status = raw >= 400 && raw < 600 ? raw : 500
    if (err.headers) for (const [name, value] of Object.entries(err.headers)) reply.header(name, value)
    if (status >= 500) {
      req.log.error({ err }, 'request failed')
      const sent = status === 502 || status === 503 ? status : 500
      return reply.code(sent).send({ statusCode: sent, error: STATUS_CODES[sent] ?? 'Error' })
    }
    req.log.warn({ err }, 'request rejected')
    const generic = STATUS_CODES[status] ?? 'Error'
    const fastifyCode = typeof err.code === 'string' && err.code.startsWith('FST_') ? err.code : undefined
    return reply.code(status).send({ statusCode: status, ...(fastifyCode ? { code: fastifyCode } : {}), error: generic, message: fastifyCode ? err.message : generic })
  })

  // Better Auth: build a fetch Request from the Fastify request (URL rooted at the configured base, never the Host
  // header) and copy the Response back. Cookies are copied through getSetCookie so several Set-Cookie lines survive.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, deps.config.appBaseUrl)
      const headers = fromNodeHeaders(request.headers)
      const init: RequestInit = { method: request.method, headers }
      if (request.body !== undefined && request.body !== null) init.body = JSON.stringify(request.body)
      const response = await deps.auth.handler(new Request(url, init))
      reply.status(response.status)
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value) })
      const cookies = response.headers.getSetCookie()
      if (cookies.length) reply.header('set-cookie', cookies)
      return reply.send(response.body ? await response.text() : null)
    },
  })

  app.get('/meta', async () => ({ providers: { google: deps.config.google !== null, microsoft: deps.config.microsoft !== null } }))

  app.get('/healthz', async (_req, reply) => {
    const h = await deps.api.health()
    return reply.code(h.db === 'ok' ? 200 : 503).send({ status: h.db === 'ok' ? 'ok' : 'degraded', db: h.db, migrations: h.migrations, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
  })

  // Only exists with the devsink transport, which loadConfig refuses in production.
  if (deps.mail.kind === 'devsink') {
    const sink = deps.mail
    app.get<{ Querystring: { to?: string } }>('/__dev/mail/latest', async (req, reply) => {
      const mail = req.query.to ? sink.latestTo(req.query.to) : undefined
      return mail ? reply.send(mail) : reply.code(404).send({ statusCode: 404, error: 'Not Found' })
    })
  }

  return app
}
```

- [ ] **Step 7: Rewrite the composition root `apps/api/src/index.ts`**

```ts
import { assertInvariants, loadDotEnv } from '@aesa/core'
import { audit } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createAuth } from './auth.ts'
import { loadConfig } from './config.ts'
import { createApiFacade } from './deps.ts'
import { createMailTransport } from './mail/transport.ts'
import { buildServer } from './server.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()

// The only raw handle in the api. Everything below sees the facade or Better Auth, never db/pool.
const handle = createDb(config.databaseUrl, { role: 'app' })
const api = createApiFacade(handle)
const mail = createMailTransport(config.mail)
const auth = createAuth({ db: handle.db, config, mail, audit: (orgId, entry) => api.withOrg(orgId, (tx) => audit(tx, entry)) })
const app = buildServer({ config, auth, api, mail, logLevel: config.logLevel })

await app.listen({ port: config.port, host: config.host })
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await app.close(); await handle.pool.end(); process.exit(0) })
}
```

- [ ] **Step 8: Run the api suite and the gate**

Run: `pnpm --filter @aesa/api test && pnpm typecheck && pnpm lint`
Expected: PASS — auth (6 + 1), error handler (7), healthz, config, mail, redact.

- [ ] **Step 9: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): Better Auth (email OTP, organization, expo) on Fastify; ServerDeps facade; error-handler carry-overs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: tRPC — context, org-scoped procedures, the `workspace` router

**Files:**
- Create: `apps/api/src/trpc/context.ts`, `apps/api/src/trpc/init.ts`, `apps/api/src/trpc/router.ts`, `apps/api/src/trpc/routers/workspace.ts`, `apps/api/test/workspace.test.ts`
- Modify: `apps/api/src/server.ts` (mount `/trpc` + the origin guard), `apps/api/package.json` (deps + `exports`)

**Interfaces:**
- Consumes: `ServerDeps`, `Auth`, test helpers (Task 5); `CreateWorkspaceInput`, `UpdateProfileInput`, `deriveAllowedHosts`, `slugify`, `nextOnboardingStep`, `isOnboardingStep`, `canManageWorkspace` (Task 1); `audit`, `workspaces` (Tasks 2–3).
- Produces: `createContextFactory(deps)`; `router`, `publicProcedure`, `authedProcedure` (ctx gains `session`, `user`, `actor`), `orgProcedure` (ctx gains `orgId`, `member: { id, role }`), `managerProcedure`; `appRouter`, `type AppRouter` (exported from the package root `@aesa/api`); `workspace.create({ businessName, timezone }) → { orgId }`, `workspace.get() → WorkspaceView & { role }`, `workspace.updateProfile(UpdateProfileInput) → WorkspaceView`, `workspace.advanceOnboarding() → { from, to }`; `WorkspaceView` (`orgId, businessName, websiteUrl, description, tone, timezone, locale, contactPhone, contactUrls, allowedUrlHosts, operatingGuidance, agentEnabled, onboardingStep, createdAt`).

- [ ] **Step 1: Write the failing test**

`apps/api/test/workspace.test.ts`:
```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

describe('workspace router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let a: ReturnType<typeof client>
  let userA: { id: string }
  let cookieA: string
  beforeAll(async () => {
    t = await createTestApi(); base = await listen(t.app)
    const s = await signInWithOtp(t.app, t.mail, 'a@example.com', 'Ann'); cookieA = s.cookie; userA = s.user
    a = client(base, cookieA)
  })
  afterAll(async () => { await t.close() })

  it('unauthenticated → UNAUTHORIZED; signed in without a workspace → PRECONDITION_FAILED', async () => {
    await expect(client(base).workspace.get.query()).rejects.toMatchObject({ data: { code: 'UNAUTHORIZED' } })
    await expect(a.workspace.get.query()).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('create: organization + workspace row at step profile, active organization set, audited as user:<id>', async () => {
    await expect(a.workspace.create.mutate({ businessName: 'Acme', timezone: 'Mars/Olympus' })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
    const { orgId } = await a.workspace.create.mutate({ businessName: 'Acme & Sons', timezone: 'Europe/Berlin' })
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/)
    const session = await t.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie: cookieA } })
    expect(session.json().session.activeOrganizationId).toBe(orgId)
    const ws = await a.workspace.get.query()
    expect(ws).toMatchObject({ orgId, businessName: 'Acme & Sons', timezone: 'Europe/Berlin', tone: 'friendly', onboardingStep: 'profile', role: 'owner', allowedUrlHosts: [] })
    expect(Object.keys(ws)).not.toContain('boxPublicKey')
    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.create')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: `user:${userA.id}`, entityType: 'workspace', entityId: orgId })
    const { rows: org } = await t.handle.pool.query<{ slug: string }>('SELECT slug FROM organization WHERE id = $1', [orgId])
    expect(org[0]!.slug).toMatch(/^acme-sons-[a-z0-9]{4}$/)
  })

  it('updateProfile derives the allowed hosts and moves profile → mailbox exactly once', async () => {
    const v = await a.workspace.updateProfile.mutate({ websiteUrl: 'https://www.acme.com', description: 'Socks', tone: 'concise', contactPhone: '+1 555 0100', contactUrls: ['https://acme.com/contact', 'https://shop.acme.com'] })
    expect(v).toMatchObject({ tone: 'concise', allowedUrlHosts: ['acme.com', 'shop.acme.com'], onboardingStep: 'mailbox' })
    const again = await a.workspace.updateProfile.mutate({ websiteUrl: null, description: '', tone: 'formal', contactPhone: null, contactUrls: [] })
    expect(again).toMatchObject({ allowedUrlHosts: [], onboardingStep: 'mailbox' })
  })

  it('advanceOnboarding walks mailbox → knowledge → go_live → done, stays at done, and audits each move', async () => {
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'mailbox', to: 'knowledge' })
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'knowledge', to: 'go_live' })
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'go_live', to: 'done' })
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'done', to: 'done' })
    const orgId = (await a.workspace.get.query()).orgId
    const moves = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.onboarding.advance')))
    expect(moves.map((m) => (m.detail as { to: string }).to)).toEqual(['knowledge', 'go_live', 'done'])
  })

  it('isolation: another owner sees only their own workspace and cannot activate someone else’s organization', async () => {
    const b = client(base, (await signInWithOtp(t.app, t.mail, 'b@example.com', 'Bob')).cookie)
    const { orgId: orgB } = await b.workspace.create.mutate({ businessName: 'Bobcorp', timezone: 'UTC' })
    expect((await b.workspace.get.query()).businessName).toBe('Bobcorp')
    const orgA = (await a.workspace.get.query()).orgId
    const cookieB = (await signInWithOtp(t.app, t.mail, 'b@example.com', 'Bob')).cookie
    const hijack = await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers: { origin: WEB, cookie: cookieB, 'content-type': 'application/json' }, payload: { organizationId: orgA } })
    expect(hijack.statusCode).toBeGreaterThanOrEqual(400)
    expect((await client(base, cookieB).workspace.get.query()).orgId).toBe(orgB)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/api test test/workspace.test.ts`
Expected: FAIL — `../src/trpc/router.ts` does not exist.

- [ ] **Step 3: Add dependencies and the package export**

`apps/api/package.json`: `dependencies` gains `"@trpc/server": "11.18.0"`, `"superjson": "^2.2.0"`; `devDependencies` gains `"@trpc/client": "11.18.0"`; add `"exports": { ".": "./src/trpc/router.ts" }` (the app imports `type AppRouter` from `@aesa/api`; nothing imports it as a value). Run `pnpm install`.

- [ ] **Step 4: Write the tRPC core**

`apps/api/src/trpc/context.ts`:
```ts
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { fromNodeHeaders } from 'better-auth/node'
import type { Auth } from '../auth.ts'
import type { ServerDeps } from '../deps.ts'

export type SessionBundle = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>

export interface TrpcContext {
  deps: ServerDeps
  /** The request headers as a fetch Headers object — what every auth.api.* call needs. */
  headers: Headers
  session: SessionBundle | null
  ip: string
  userAgent: string | null
}

export function createContextFactory(deps: ServerDeps) {
  return async ({ req }: CreateFastifyContextOptions): Promise<TrpcContext> => {
    const headers = fromNodeHeaders(req.headers)
    const session = await deps.auth.api.getSession({ headers })
    return { deps, headers, session, ip: req.ip, userAgent: req.headers['user-agent'] ?? null }
  }
}
```

`apps/api/src/trpc/init.ts`:
```ts
import { initTRPC, TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import superjson from 'superjson'
import { ORG_ROLES, canManageWorkspace, type OrgRole } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type { TrpcContext } from './context.ts'

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson })

export const router = t.router
export const publicProcedure = t.procedure

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' })
  const actor: AuditActor = `user:${ctx.session.user.id}`
  return next({ ctx: { ...ctx, session: ctx.session, user: ctx.session.user, actor } })
})

/**
 * The organization comes from the session's active organization AND a membership check (spec, tenancy net 3).
 * No procedure accepts an org id in its input; a stale or forged active organization ends here.
 */
export const orgProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const orgId = ctx.session.session.activeOrganizationId
  if (!orgId) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no active workspace' })
  let member: { id: string; organizationId: string; role: string } | null = null
  try {
    member = await ctx.deps.auth.api.getActiveMember({ headers: ctx.headers })
  } catch (e) {
    if (!(e instanceof APIError)) throw e
  }
  if (!member || member.organizationId !== orgId || !(ORG_ROLES as readonly string[]).includes(member.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not a member of the active workspace' })
  }
  return next({ ctx: { ...ctx, orgId, member: { id: member.id, role: member.role as OrgRole } } })
})

export const managerProcedure = orgProcedure.use(({ ctx, next }) => {
  if (!canManageWorkspace(ctx.member.role)) throw new TRPCError({ code: 'FORBIDDEN', message: 'owner or admin required' })
  return next()
})
```

`apps/api/src/trpc/routers/workspace.ts`:
```ts
import { TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import { CreateWorkspaceInput, UpdateProfileInput, deriveAllowedHosts, isOnboardingStep, nextOnboardingStep, slugify, type OnboardingStep, type Tone } from '@aesa/contracts'
import { audit, workspaces } from '@aesa/db'
import type { Auth } from '../../auth.ts'
import { authedProcedure, managerProcedure, orgProcedure, router } from '../init.ts'

const SUPPORTED_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'))

type WorkspaceRow = typeof workspaces.$inferSelect

export interface WorkspaceView {
  orgId: string; businessName: string; websiteUrl: string | null; description: string | null; tone: Tone
  timezone: string; locale: string; contactPhone: string | null; contactUrls: string[]; allowedUrlHosts: string[]
  operatingGuidance: string; agentEnabled: boolean; onboardingStep: OnboardingStep; createdAt: Date
}

/** The client-facing shape. Never the box key, never the kill switch internals. */
export function toWorkspaceView(w: WorkspaceRow): WorkspaceView {
  return {
    orgId: w.orgId, businessName: w.businessName, websiteUrl: w.websiteUrl, description: w.description, tone: w.tone as Tone,
    timezone: w.timezone, locale: w.locale, contactPhone: w.contactPhone, contactUrls: w.contactUrls, allowedUrlHosts: w.allowedUrlHosts,
    operatingGuidance: w.operatingGuidance, agentEnabled: w.agentEnabled,
    onboardingStep: isOnboardingStep(w.onboardingStep) ? w.onboardingStep : 'profile', createdAt: w.createdAt,
  }
}

/** Better Auth owns the organization row; the slug is unique, so retry with a fresh suffix on collision. */
async function createOrganizationWithFreshSlug(auth: Auth, headers: Headers, name: string): Promise<{ id: string }> {
  const base = slugify(name)
  for (let attempt = 1; attempt <= 5; attempt++) {
    const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
    try {
      const org = await auth.api.createOrganization({ body: { name, slug }, headers })
      if (!org) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'organization was not created' })
      return { id: org.id }
    } catch (e) {
      if (e instanceof APIError && attempt < 5 && /already exists|slug/i.test(e.message)) continue
      throw e
    }
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'could not allocate a workspace slug' })
}

export const workspaceRouter = router({
  /** First sign-in: organization (Better Auth) + workspaces row. The caller becomes the owner and the org goes active. */
  create: authedProcedure.input(CreateWorkspaceInput).mutation(async ({ ctx, input }) => {
    if (!SUPPORTED_TIMEZONES.has(input.timezone)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'unknown timezone' })
    const org = await createOrganizationWithFreshSlug(ctx.deps.auth, ctx.headers, input.businessName)
    await ctx.deps.api.withOrg(org.id, async (tx) => {
      await tx.insert(workspaces).values({ orgId: org.id, businessName: input.businessName, timezone: input.timezone })
      await audit(tx, { actor: ctx.actor, action: 'workspace.create', entityType: 'workspace', entityId: org.id, detail: { businessName: input.businessName }, ip: ctx.ip, userAgent: ctx.userAgent })
    })
    return { orgId: org.id }
  }),

  get: orgProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.deps.api.withOrg(ctx.orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, ctx.orgId)))
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
    return { ...toWorkspaceView(row), role: ctx.member.role }
  }),

  updateProfile: managerProcedure.input(UpdateProfileInput).mutation(async ({ ctx, input }) => {
    const allowedUrlHosts = deriveAllowedHosts(input.websiteUrl, input.contactUrls)
    const updated = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [current] = await tx.select({ step: workspaces.onboardingStep }).from(workspaces).where(eq(workspaces.orgId, ctx.orgId))
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
      const onboardingStep = current.step === 'profile' ? 'mailbox' : current.step
      const [row] = await tx.update(workspaces)
        .set({ websiteUrl: input.websiteUrl, description: input.description, tone: input.tone, contactPhone: input.contactPhone, contactUrls: input.contactUrls, allowedUrlHosts, onboardingStep })
        .where(eq(workspaces.orgId, ctx.orgId)).returning()
      await audit(tx, { actor: ctx.actor, action: 'workspace.profile.update', entityType: 'workspace', entityId: ctx.orgId, detail: { tone: input.tone, allowedUrlHosts, onboardingStep }, ip: ctx.ip, userAgent: ctx.userAgent })
      return row!
    })
    return toWorkspaceView(updated)
  }),

  /** "Continue" and "Skip for now" are the same call: the server owns the position, so it resumes on any device. */
  advanceOnboarding: managerProcedure.mutation(async ({ ctx }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [current] = await tx.select({ step: workspaces.onboardingStep }).from(workspaces).where(eq(workspaces.orgId, ctx.orgId))
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
      const from: OnboardingStep = isOnboardingStep(current.step) ? current.step : 'profile'
      const to = nextOnboardingStep(from)
      if (to !== from) {
        await tx.update(workspaces).set({ onboardingStep: to }).where(eq(workspaces.orgId, ctx.orgId))
        await audit(tx, { actor: ctx.actor, action: 'workspace.onboarding.advance', entityType: 'workspace', entityId: ctx.orgId, detail: { from, to }, ip: ctx.ip, userAgent: ctx.userAgent })
      }
      return { from, to }
    }),
  ),
})
```

`apps/api/src/trpc/router.ts`:
```ts
import { router } from './init.ts'
import { workspaceRouter } from './routers/workspace.ts'

export const appRouter = router({
  workspace: workspaceRouter,
})
export type AppRouter = typeof appRouter
```

- [ ] **Step 5: Mount tRPC in `apps/api/src/server.ts`**

Add the imports:
```ts
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'
import { createContextFactory } from './trpc/context.ts'
import { appRouter, type AppRouter } from './trpc/router.ts'
```
and, after the `/api/auth/*` route:
```ts
  // Browser CSRF guard for mutations: a POST that carries an Origin must come from the web app. Native clients
  // send no Origin (and no ambient cookies), so they pass; CORS already blocks other browsers' reads.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' || !req.url.startsWith('/trpc')) return
    if (req.headers.origin && req.headers.origin !== deps.config.appWebOrigin) return reply.code(403).send({ statusCode: 403, error: 'Forbidden' })
  })
  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: createContextFactory(deps),
      onError({ path, error }) {
        // Client errors are expected traffic; only unexpected failures deserve the (redacting) err serializer.
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error.cause ?? error, path }, 'trpc failed')
        else app.log.warn({ path, code: error.code }, 'trpc rejected')
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  })
```

- [ ] **Step 6: Run the tests and the gate**

Run: `pnpm --filter @aesa/api test && pnpm typecheck && pnpm lint`
Expected: PASS (5 workspace cases plus everything from Task 5).

- [ ] **Step 7: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): tRPC with org-scoped procedures; workspace create/get/updateProfile/advanceOnboarding

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `team` and `devices` routers

**Files:**
- Create: `apps/api/src/trpc/routers/team.ts`, `apps/api/src/trpc/routers/devices.ts`, `apps/api/test/team.test.ts`, `apps/api/test/devices.test.ts`
- Modify: `apps/api/src/trpc/router.ts`

**Interfaces:**
- Consumes: `orgProcedure`, `managerProcedure`, `router` (Task 6); `RegisterDeviceInput`, `UnregisterDeviceInput`, `OrgRole` (Task 1); `notificationDevices`, `audit` (Tasks 2–3).
- Produces: `team.list() → { members: { id, userId, role, name, email, createdAt }[], invitations: { id, email, role, expiresAt }[] }`, `team.invite({ email, role: 'admin'|'member' }) → { invitationId }`, `team.cancelInvitation({ invitationId })`, `team.changeRole({ memberId, role: 'admin'|'member' })`, `team.remove({ memberId })`; `devices.register(RegisterDeviceInput) → { id }`, `devices.unregister({ expoPushToken })`, `devices.list() → { id, platform, deviceName, lastSeenAt, disabledAt }[]`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/team.test.ts`:
```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, cookie }) })],
})
const PROFILE = { websiteUrl: null, description: '', tone: 'formal' as const, contactPhone: null, contactUrls: [] }

describe('team router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let owner: ReturnType<typeof client>
  let ownerId: string
  let orgId: string
  let cookieB: string
  let bob: ReturnType<typeof client>
  let bobId: string
  beforeAll(async () => {
    t = await createTestApi(); base = await listen(t.app)
    const a = await signInWithOtp(t.app, t.mail, 'ann@example.com', 'Ann'); ownerId = a.user.id; owner = client(base, a.cookie)
    orgId = (await owner.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })).orgId
    const b = await signInWithOtp(t.app, t.mail, 'bob@example.com', 'Bob'); cookieB = b.cookie; bobId = b.user.id; bob = client(base, cookieB)
  })
  afterAll(async () => { await t.close() })

  it('invite: emails a link to /invite/<id>, lists the pending invitation, audits team.invite as the inviter', async () => {
    const { invitationId } = await owner.team.invite.mutate({ email: 'Bob@Example.com', role: 'member' })
    const mail = t.mail.latestTo('bob@example.com')
    expect(mail?.subject).toBe('Ann invited you to Acme on aesa')
    expect(mail?.text).toContain(`${WEB}/invite/${invitationId}`)
    const list = await owner.team.list.query()
    expect(list.members).toEqual([expect.objectContaining({ userId: ownerId, role: 'owner', email: 'ann@example.com' })])
    expect(list.invitations).toEqual([expect.objectContaining({ id: invitationId, email: 'bob@example.com', role: 'member' })])
    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'team.invite')))
    expect(rows[0]).toMatchObject({ actor: `user:${ownerId}`, entityId: invitationId, detail: { role: 'member' } })
  })

  it('accept: the invitee joins as member (audited team.join as the joiner), can read but not edit the workspace', async () => {
    const invitationId = (await owner.team.list.query()).invitations[0]!.id
    const accept = await t.app.inject({ method: 'POST', url: '/api/auth/organization/accept-invitation', headers: { origin: WEB, cookie: cookieB, 'content-type': 'application/json' }, payload: { invitationId } })
    expect(accept.statusCode).toBe(200)
    await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers: { origin: WEB, cookie: cookieB, 'content-type': 'application/json' }, payload: { organizationId: orgId } })
    expect((await bob.workspace.get.query())).toMatchObject({ orgId, role: 'member' })
    await expect(bob.workspace.updateProfile.mutate(PROFILE)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
    await expect(bob.team.invite.mutate({ email: 'c@example.com', role: 'member' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
    const joins = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'team.join')))
    expect(joins[0]).toMatchObject({ actor: `user:${bobId}`, detail: { invitationId, role: 'member' } })
    expect((await owner.team.list.query()).members.map((m) => m.email).sort()).toEqual(['ann@example.com', 'bob@example.com'])
  })

  it('changeRole to admin lets Bob edit; remove revokes access; both audited by the acting user', async () => {
    const bobMember = (await owner.team.list.query()).members.find((m) => m.userId === bobId)!
    await owner.team.changeRole.mutate({ memberId: bobMember.id, role: 'admin' })
    expect((await bob.workspace.updateProfile.mutate(PROFILE)).tone).toBe('formal')
    await owner.team.remove.mutate({ memberId: bobMember.id })
    await expect(bob.workspace.get.query()).rejects.toMatchObject({ data: { code: expect.stringMatching(/FORBIDDEN|PRECONDITION_FAILED/) } })
    const actions = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog))
    expect(actions.filter((r) => r.action === 'team.role')[0]).toMatchObject({ actor: `user:${ownerId}`, entityId: bobMember.id, detail: { to: 'admin' } })
    expect(actions.filter((r) => r.action === 'team.remove')[0]).toMatchObject({ actor: `user:${ownerId}`, entityId: bobMember.id })
  })

  it('cancelInvitation removes a pending invitation', async () => {
    const { invitationId } = await owner.team.invite.mutate({ email: 'carol@example.com', role: 'admin' })
    await owner.team.cancelInvitation.mutate({ invitationId })
    expect((await owner.team.list.query()).invitations.find((i) => i.id === invitationId)).toBeUndefined()
  })
})
```

`apps/api/test/devices.test.ts`:
```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, cookie }) })],
})

describe('devices router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let ann: ReturnType<typeof client>
  beforeAll(async () => {
    t = await createTestApi(); const base = await listen(t.app)
    ann = client(base, (await signInWithOtp(t.app, t.mail, 'ann@example.com', 'Ann')).cookie)
    await ann.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
  })
  afterAll(async () => { await t.close() })

  it('register is an upsert per (org, user, token); list never returns the token; unregister disables', async () => {
    const first = await ann.devices.register.mutate({ expoPushToken: 'ExponentPushToken[aaa]', platform: 'ios', deviceName: 'Ann’s iPhone' })
    await new Promise((r) => setTimeout(r, 20))
    const second = await ann.devices.register.mutate({ expoPushToken: 'ExponentPushToken[aaa]', platform: 'ios' })
    expect(second.id).toBe(first.id)
    const list = await ann.devices.list.query()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: first.id, platform: 'ios', disabledAt: null })
    expect(JSON.stringify(list)).not.toContain('ExponentPushToken')
    await ann.devices.unregister.mutate({ expoPushToken: 'ExponentPushToken[aaa]' })
    expect((await ann.devices.list.query())[0]!.disabledAt).toBeInstanceOf(Date)
    await expect(ann.devices.register.mutate({ expoPushToken: 'fcm:nope', platform: 'android' })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @aesa/api test test/team.test.ts test/devices.test.ts`
Expected: FAIL — `team` / `devices` are not on the router (type errors, then runtime NOT_FOUND).

- [ ] **Step 3: Write the routers**

`apps/api/src/trpc/routers/team.ts`:
```ts
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { OrgRole } from '@aesa/contracts'
import { audit } from '@aesa/db'
import { managerProcedure, orgProcedure, router } from '../init.ts'

/** Owner transfer is not a v1 feature: invitations and role changes stop at admin. */
const GrantableRole = z.enum(['admin', 'member'])

export const teamRouter = router({
  list: orgProcedure.query(async ({ ctx }) => {
    const full = await ctx.deps.auth.api.getFullOrganization({ headers: ctx.headers, query: { organizationId: ctx.orgId } })
    if (!full) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not found' })
    return {
      members: full.members.map((m) => ({ id: m.id, userId: m.userId, role: m.role as OrgRole, name: m.user.name, email: m.user.email, createdAt: m.createdAt })),
      invitations: full.invitations
        .filter((i) => i.status === 'pending')
        .map((i) => ({ id: i.id, email: i.email, role: (i.role ?? 'member') as OrgRole, expiresAt: i.expiresAt })),
    }
  }),

  invite: managerProcedure.input(z.object({ email: z.email().max(254), role: GrantableRole })).mutation(async ({ ctx, input }) => {
    const email = input.email.toLowerCase()
    const inv = await ctx.deps.auth.api.createInvitation({ headers: ctx.headers, body: { email, role: input.role, organizationId: ctx.orgId, resend: true } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.invite', entityType: 'invitation', entityId: inv.id, detail: { role: input.role }, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { invitationId: inv.id }
  }),

  cancelInvitation: managerProcedure.input(z.object({ invitationId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.deps.auth.api.cancelInvitation({ headers: ctx.headers, body: { invitationId: input.invitationId } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.invite.cancel', entityType: 'invitation', entityId: input.invitationId, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { ok: true as const }
  }),

  changeRole: managerProcedure.input(z.object({ memberId: z.uuid(), role: GrantableRole })).mutation(async ({ ctx, input }) => {
    await ctx.deps.auth.api.updateMemberRole({ headers: ctx.headers, body: { memberId: input.memberId, role: input.role, organizationId: ctx.orgId } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.role', entityType: 'member', entityId: input.memberId, detail: { to: input.role }, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { ok: true as const }
  }),

  remove: managerProcedure.input(z.object({ memberId: z.uuid() })).mutation(async ({ ctx, input }) => {
    if (input.memberId === ctx.member.id) throw new TRPCError({ code: 'BAD_REQUEST', message: 'use Leave workspace to remove yourself' })
    await ctx.deps.auth.api.removeMember({ headers: ctx.headers, body: { memberIdOrEmail: input.memberId, organizationId: ctx.orgId } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.remove', entityType: 'member', entityId: input.memberId, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { ok: true as const }
  }),
})
```

`apps/api/src/trpc/routers/devices.ts`:
```ts
import { and, eq } from 'drizzle-orm'
import { RegisterDeviceInput, UnregisterDeviceInput } from '@aesa/contracts'
import { audit, notificationDevices } from '@aesa/db'
import { orgProcedure, router } from '../init.ts'

export const devicesRouter = router({
  /** Idempotent: the app calls it on every launch. Re-registering re-enables a device that was unregistered. */
  register: orgProcedure.input(RegisterDeviceInput).mutation(async ({ ctx, input }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [row] = await tx.insert(notificationDevices)
        .values({ orgId: ctx.orgId, userId: ctx.user.id, expoPushToken: input.expoPushToken, platform: input.platform, deviceName: input.deviceName ?? null })
        .onConflictDoUpdate({
          target: [notificationDevices.orgId, notificationDevices.userId, notificationDevices.expoPushToken],
          set: { lastSeenAt: new Date(), disabledAt: null, platform: input.platform, ...(input.deviceName ? { deviceName: input.deviceName } : {}) },
        })
        .returning({ id: notificationDevices.id })
      await audit(tx, { actor: ctx.actor, action: 'device.register', entityType: 'notification_device', entityId: row!.id, detail: { platform: input.platform }, ip: ctx.ip, userAgent: ctx.userAgent })
      return { id: row!.id }
    }),
  ),

  unregister: orgProcedure.input(UnregisterDeviceInput).mutation(async ({ ctx, input }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const rows = await tx.update(notificationDevices).set({ disabledAt: new Date() })
        .where(and(eq(notificationDevices.orgId, ctx.orgId), eq(notificationDevices.userId, ctx.user.id), eq(notificationDevices.expoPushToken, input.expoPushToken)))
        .returning({ id: notificationDevices.id })
      for (const r of rows) await audit(tx, { actor: ctx.actor, action: 'device.unregister', entityType: 'notification_device', entityId: r.id, ip: ctx.ip, userAgent: ctx.userAgent })
      return { disabled: rows.length }
    }),
  ),

  /** The caller's own devices. The token itself never leaves the database. */
  list: orgProcedure.query(async ({ ctx }) =>
    ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select({ id: notificationDevices.id, platform: notificationDevices.platform, deviceName: notificationDevices.deviceName, lastSeenAt: notificationDevices.lastSeenAt, disabledAt: notificationDevices.disabledAt })
        .from(notificationDevices)
        .where(and(eq(notificationDevices.orgId, ctx.orgId), eq(notificationDevices.userId, ctx.user.id))),
    ),
  ),
})
```

`apps/api/src/trpc/router.ts`:
```ts
import { router } from './init.ts'
import { devicesRouter } from './routers/devices.ts'
import { teamRouter } from './routers/team.ts'
import { workspaceRouter } from './routers/workspace.ts'

export const appRouter = router({
  workspace: workspaceRouter,
  team: teamRouter,
  devices: devicesRouter,
})
export type AppRouter = typeof appRouter
```

- [ ] **Step 4: Run the tests and the gate**

Run: `pnpm --filter @aesa/api test && pnpm typecheck && pnpm lint && pnpm db:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): team router (invite, accept audit, roles, remove) and devices router (push tokens)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `apps/app` — the Expo SDK 57 scaffold, theme primitives, jest, lint and CI wiring

**Files:**
- Create: `apps/app/package.json`, `apps/app/app.json`, `apps/app/tsconfig.json`, `apps/app/expo-env.d.ts`, `apps/app/.env.example`, `apps/app/.gitignore`, `apps/app/assets/{icon,adaptive-icon,splash-icon,favicon,notification-icon}.png`, `apps/app/src/theme.ts`, `apps/app/src/components/{screen,typography,button,text-field,card,list-row,banner,loading}.tsx`, `apps/app/src/components/button.test.tsx`, `apps/app/src/app/_layout.tsx`, `apps/app/src/app/index.tsx`, `apps/app/src/app/+not-found.tsx`
- Modify: `eslint.config.js`, `.github/workflows/ci.yml`, `.gitignore`

**Interfaces:**
- Produces: `useColors()`, `spacing`, `radius`, `typeScale`, `WIDE_BREAKPOINT` (`900`); `<Screen>` (safe area + scroll + centered 560px column on wide screens; prop `testID?`), `<Title>`, `<Heading>`, `<Body>`, `<Muted>`, `<Button label onPress variant?='primary'|'secondary'|'danger' loading? disabled? testID?>`, `<TextField label value onChangeText error? …TextInputProps>`, `<Card>`, `<ListRow title subtitle? onPress? badge? testID?>`, `<Banner tone='info'|'error'|'success'>`, `<Loading />`; scripts `dev`, `export:web`, `serve:web`, `typecheck`, `test`, `e2e`.

- [ ] **Step 1: Write the failing test**

`apps/app/src/components/button.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react-native'
import { Button } from './button'

test('renders its label, calls onPress, and ignores presses while loading', async () => {
  const onPress = jest.fn()
  await render(<Button label="Continue" onPress={onPress} />)
  fireEvent.press(screen.getByText('Continue'))
  expect(onPress).toHaveBeenCalledTimes(1)

  await render(<Button label="Saving" onPress={onPress} loading />)
  const saving = screen.getByRole('button', { name: 'Saving' })
  expect(saving.props.accessibilityState?.disabled ?? saving.props.disabled).toBe(true)
  fireEvent.press(saving)
  expect(onPress).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/app test`
Expected: FAIL — no such package.

- [ ] **Step 3: Scaffold the package by hand (versions from the SDK 57 template, verified 2026-09-08)**

`apps/app/package.json`:
```json
{
  "name": "@aesa/app",
  "private": true,
  "version": "0.1.0",
  "main": "expo-router/entry",
  "scripts": {
    "dev": "expo start",
    "web": "expo start --web",
    "export:web": "expo export --platform web",
    "serve:web": "expo serve --port 8081",
    "typecheck": "tsc --noEmit",
    "test": "jest --ci --passWithNoTests",
    "e2e": "playwright test"
  },
  "jest": {
    "preset": "jest-expo",
    "testMatch": ["<rootDir>/src/**/*.test.ts", "<rootDir>/src/**/*.test.tsx"]
  },
  "dependencies": {
    "@aesa/contracts": "workspace:*",
    "@better-auth/expo": "1.7.3",
    "@tanstack/react-query": "^5.102.0",
    "@trpc/client": "11.18.0",
    "@trpc/server": "11.18.0",
    "@trpc/tanstack-react-query": "11.18.0",
    "better-auth": "1.7.3",
    "expo": "~57.0.21",
    "expo-constants": "~57.0.17",
    "expo-font": "~57.0.3",
    "expo-linking": "~57.0.9",
    "expo-router": "~57.0.20",
    "expo-splash-screen": "~57.0.8",
    "expo-status-bar": "~57.0.1",
    "expo-system-ui": "~57.0.3",
    "expo-web-browser": "~57.0.2",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "react-native": "0.86.3",
    "react-native-gesture-handler": "~2.32.0",
    "react-native-reanimated": "4.5.1",
    "react-native-safe-area-context": "~5.7.0",
    "react-native-screens": "~4.26.0",
    "react-native-web": "~0.21.0",
    "react-native-worklets": "0.10.1",
    "superjson": "^2.2.0"
  },
  "devDependencies": {
    "@aesa/api": "workspace:*",
    "@playwright/test": "^1.63.0",
    "@testing-library/react-native": "^14.0.1",
    "@types/jest": "^29.5.14",
    "@types/node": "^22",
    "@types/react": "~19.2.2",
    "jest": "^29.7.0",
    "jest-expo": "~57.0.5",
    "test-renderer": "^1.0.0",
    "typescript": "^5.9.2"
  }
}
```
(`@aesa/api` is a devDependency for `import type { AppRouter }` only; `@types/node` is required because the api's source files enter the app's type program through that import.)

`apps/app/app.json`:
```json
{
  "expo": {
    "name": "aesa",
    "slug": "aesa",
    "scheme": "aesa",
    "version": "0.1.0",
    "orientation": "portrait",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "icon": "./assets/icon.png",
    "ios": { "bundleIdentifier": "com.closingbrackets.aesa", "supportsTablet": true },
    "android": {
      "package": "com.closingbrackets.aesa",
      "adaptiveIcon": { "foregroundImage": "./assets/adaptive-icon.png", "backgroundColor": "#0F172A" }
    },
    "web": { "output": "server", "favicon": "./assets/favicon.png" },
    "plugins": [
      "expo-router",
      "expo-secure-store",
      ["expo-splash-screen", { "backgroundColor": "#0F172A", "image": "./assets/splash-icon.png", "imageWidth": 120 }],
      ["expo-notifications", { "icon": "./assets/notification-icon.png", "color": "#0F172A" }]
    ],
    "experiments": { "typedRoutes": true }
  }
}
```

`apps/app/tsconfig.json`:
```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["node", "jest"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"],
  "exclude": ["node_modules", "dist", "playwright-report", "test-results"]
}
```

`apps/app/expo-env.d.ts`:
```ts
/// <reference types="expo/types" />
```

`apps/app/.env.example`:
```
# Where the api listens. On a physical phone use the machine's LAN address, e.g. http://192.168.1.20:3001
EXPO_PUBLIC_API_URL=http://localhost:3001
```

`apps/app/.gitignore`:
```
.expo/
dist/
playwright-report/
test-results/
```

Root `.gitignore` — add `apps/app/.expo/` is covered by the app file; add nothing else.

Placeholder art (Robert replaces it with real branding): scaffold the stock template into the scratch directory and copy its images:
```bash
tmp=$(mktemp -d) && (cd "$tmp" && npx --yes create-expo-app@latest art --template default --no-install >/dev/null)
mkdir -p apps/app/assets
cp "$tmp/art/assets/images/icon.png" apps/app/assets/icon.png
cp "$tmp/art/assets/images/android-icon-foreground.png" apps/app/assets/adaptive-icon.png
cp "$tmp/art/assets/images/splash-icon.png" apps/app/assets/splash-icon.png
cp "$tmp/art/assets/images/favicon.png" apps/app/assets/favicon.png
cp "$tmp/art/assets/images/splash-icon.png" apps/app/assets/notification-icon.png
rm -rf "$tmp"
```

Install: `pnpm install`, then the SDK-pinned extras with Expo's installer (ruling): `cd apps/app && npx expo install expo-secure-store expo-notifications expo-device expo-dev-client && npx expo install --check` (must print nothing to fix).

- [ ] **Step 4: Theme and primitives**

`apps/app/src/theme.ts`:
```ts
import { useColorScheme } from 'react-native'

const light = { bg: '#FFFFFF', surface: '#F8FAFC', text: '#0F172A', muted: '#64748B', border: '#E2E8F0', primary: '#2563EB', onPrimary: '#FFFFFF', danger: '#DC2626', success: '#16A34A', info: '#EFF6FF' }
const dark = { bg: '#0F172A', surface: '#1E293B', text: '#F8FAFC', muted: '#94A3B8', border: '#334155', primary: '#60A5FA', onPrimary: '#0F172A', danger: '#F87171', success: '#4ADE80', info: '#1E3A5F' }
export type Colors = typeof light

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const
export const radius = { sm: 6, md: 10, lg: 16 } as const
export const typeScale = {
  title: { fontSize: 28, fontWeight: '700' as const, lineHeight: 34 },
  heading: { fontSize: 20, fontWeight: '600' as const, lineHeight: 26 },
  body: { fontSize: 16, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 18 },
}
/** Tablet landscape and desktop get the sidebar shell; below this it is tabs. */
export const WIDE_BREAKPOINT = 900

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light
}
```

`apps/app/src/components/typography.tsx`:
```tsx
import { Text, type TextProps } from 'react-native'
import { typeScale, useColors } from '@/theme'

export function Title(p: TextProps) { const c = useColors(); return <Text accessibilityRole="header" {...p} style={[typeScale.title, { color: c.text }, p.style]} /> }
export function Heading(p: TextProps) { const c = useColors(); return <Text accessibilityRole="header" {...p} style={[typeScale.heading, { color: c.text }, p.style]} /> }
export function Body(p: TextProps) { const c = useColors(); return <Text {...p} style={[typeScale.body, { color: c.text }, p.style]} /> }
export function Muted(p: TextProps) { const c = useColors(); return <Text {...p} style={[typeScale.caption, { color: c.muted }, p.style]} /> }
```

`apps/app/src/components/screen.tsx`:
```tsx
import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WIDE_BREAKPOINT, spacing, useColors } from '@/theme'

/** Every screen body: safe area, scroll, and a centered 560px column once the window is wide. */
export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useColors()
  const { width } = useWindowDimensions()
  const wide = width >= WIDE_BREAKPOINT
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} testID={testID}>
      <ScrollView contentContainerStyle={[styles.content, wide && styles.wide]} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.md },
  wide: { alignItems: 'center', paddingTop: spacing.xl },
  column: { width: '100%', maxWidth: 560, gap: spacing.md },
})
```

`apps/app/src/components/button.tsx`:
```tsx
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export interface ButtonProps { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; loading?: boolean; disabled?: boolean; testID?: string }

export function Button({ label, onPress, variant = 'primary', loading = false, disabled = false, testID }: ButtonProps) {
  const c = useColors()
  const inactive = disabled || loading
  const bg = variant === 'primary' ? c.primary : variant === 'danger' ? c.danger : c.surface
  const fg = variant === 'secondary' ? c.text : c.onPrimary
  return (
    <Pressable
      role="button" accessibilityLabel={label} accessibilityState={{ disabled: inactive, busy: loading }} disabled={inactive} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.base, { backgroundColor: bg, borderColor: variant === 'secondary' ? c.border : bg, opacity: inactive ? 0.6 : pressed ? 0.85 : 1 }]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[typeScale.body, styles.label, { color: fg }]}>{label}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: { minHeight: 48, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600' },
})
```

`apps/app/src/components/text-field.tsx`:
```tsx
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export interface TextFieldProps extends TextInputProps { label: string; error?: string | null; hint?: string }

export function TextField({ label, error, hint, style, ...input }: TextFieldProps) {
  const c = useColors()
  return (
    <View style={styles.wrap}>
      <Text style={[typeScale.caption, { color: c.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label} placeholderTextColor={c.muted}
        style={[styles.input, typeScale.body, { color: c.text, borderColor: error ? c.danger : c.border, backgroundColor: c.bg }, style]}
        {...input}
      />
      {error ? <Text style={[typeScale.caption, { color: c.danger }]}>{error}</Text> : hint ? <Text style={[typeScale.caption, { color: c.muted }]}>{hint}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  input: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
})
```

`apps/app/src/components/card.tsx`:
```tsx
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { radius, spacing, useColors } from '@/theme'

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useColors()
  return <View testID={testID} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>{children}</View>
}
const styles = StyleSheet.create({ card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm } })
```

`apps/app/src/components/list-row.tsx`:
```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { spacing, typeScale, useColors } from '@/theme'

export interface ListRowProps { title: string; subtitle?: string; badge?: string; onPress?: () => void; testID?: string }

/** A settings-style row. Without onPress it renders inert (used for "arrives with Phase N" placeholders). */
export function ListRow({ title, subtitle, badge, onPress, testID }: ListRowProps) {
  const c = useColors()
  return (
    <Pressable role={onPress ? 'button' : undefined} accessibilityLabel={title} disabled={!onPress} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.row, { borderColor: c.border, opacity: onPress ? (pressed ? 0.7 : 1) : 0.55 }]}>
      <View style={styles.text}>
        <Text style={[typeScale.body, { color: c.text }]}>{title}</Text>
        {subtitle ? <Text style={[typeScale.caption, { color: c.muted }]}>{subtitle}</Text> : null}
      </View>
      {badge ? <Text style={[typeScale.caption, { color: c.muted }]}>{badge}</Text> : onPress ? <Text style={{ color: c.muted }}>›</Text> : null}
    </Pressable>
  )
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.md },
  text: { flex: 1, gap: 2 },
})
```

`apps/app/src/components/banner.tsx`:
```tsx
import { StyleSheet, Text, View } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export function Banner({ tone = 'info', children, testID }: { tone?: 'info' | 'error' | 'success'; children: string; testID?: string }) {
  const c = useColors()
  const color = tone === 'error' ? c.danger : tone === 'success' ? c.success : c.text
  return (
    <View accessibilityRole="alert" testID={testID} style={[styles.box, { backgroundColor: c.info, borderColor: color }]}>
      <Text style={[typeScale.body, { color }]}>{children}</Text>
    </View>
  )
}
const styles = StyleSheet.create({ box: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md } })
```

`apps/app/src/components/loading.tsx`:
```tsx
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useColors } from '@/theme'

export function Loading({ testID = 'loading' }: { testID?: string }) {
  const c = useColors()
  return <View testID={testID} style={[styles.box, { backgroundColor: c.bg }]}><ActivityIndicator color={c.primary} /></View>
}
const styles = StyleSheet.create({ box: { flex: 1, alignItems: 'center', justifyContent: 'center' } })
```

- [ ] **Step 5: A first route tree (replaced in Task 9)**

`apps/app/src/app/_layout.tsx`:
```tsx
import { Stack } from 'expo-router/stack'

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />
}
```

`apps/app/src/app/index.tsx`:
```tsx
import { Screen } from '@/components/screen'
import { Muted, Title } from '@/components/typography'

export default function Index() {
  return (
    <Screen testID="home">
      <Title>aesa</Title>
      <Muted>Accounts and the app shell land in the next tasks.</Muted>
    </Screen>
  )
}
```

`apps/app/src/app/+not-found.tsx`:
```tsx
import { Link } from 'expo-router'
import { Screen } from '@/components/screen'
import { Body, Title } from '@/components/typography'

export default function NotFound() {
  return (
    <Screen>
      <Title>Page not found</Title>
      <Link href="/"><Body>Go home</Body></Link>
    </Screen>
  )
}
```

- [ ] **Step 6: Root lint, ignores and CI**

`eslint.config.js` — replace the whole file:
```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const RAW_DB_MESSAGE =
  "Import from '@aesa/db' and use withOrg()/withPlatform(). A raw pool has no org scope: it runs as the LOGIN role with no `-c role`, which in production bypasses the app-role timeouts and locally bypasses RLS entirely. Allowed only in packages/db, composition roots (apps/*/src/index.ts) and tests; `import type` is always fine."

const APP_MESSAGE =
  "apps/app is bundled by Metro for iOS, Android and web: server packages (pg, drizzle, node:fs, libsodium) cannot ship in it. Share zod inputs and enums through @aesa/contracts; import the api's AppRouter with `import type` only."

const rawDbImports = {
  paths: [
    { name: '@aesa/db/raw', message: RAW_DB_MESSAGE, allowTypeImports: true },
    { name: 'pg', message: RAW_DB_MESSAGE, allowTypeImports: true },
    { name: 'drizzle-orm/node-postgres', message: RAW_DB_MESSAGE, allowTypeImports: true },
  ],
  patterns: [{ group: ['drizzle-orm/node-postgres/*'], message: RAW_DB_MESSAGE, allowTypeImports: true }],
}

const appImports = {
  paths: [
    ...rawDbImports.paths,
    ...['@aesa/db', '@aesa/core', '@aesa/crypto', '@aesa/queue', '@aesa/api', 'drizzle-orm', 'fastify', 'better-auth/node'].map((name) => ({ name, message: APP_MESSAGE, allowTypeImports: true })),
  ],
  patterns: [
    ...rawDbImports.patterns,
    { group: ['@aesa/db/*', '@aesa/api/*', 'drizzle-orm/*', 'node:*'], message: APP_MESSAGE, allowTypeImports: true },
  ],
}

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/migrations/**', '**/.expo/**', '**/playwright-report/**', '**/test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-imports': 'off',                                  // superseded by the type-aware version
      '@typescript-eslint/no-restricted-imports': ['error', rawDbImports],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/app/**/*.ts', 'apps/app/**/*.tsx'],
    rules: { '@typescript-eslint/no-restricted-imports': ['error', appImports] },
  },
  {
    files: ['packages/db/**/*.ts', 'apps/*/src/index.ts', '**/test/**/*.ts', '**/scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
)
```

`.github/workflows/ci.yml` — after `pnpm install --frozen-lockfile` add:
```yaml
      - name: Expo web export (also generates the typed-route declarations tsc reads)
        run: pnpm --filter @aesa/app export:web
        env:
          EXPO_PUBLIC_API_URL: http://localhost:3001
```
(`pnpm test` at the root now also runs the app's jest suite; it needs no database.)

- [ ] **Step 7: Run everything**

Run: `pnpm --filter @aesa/app test && pnpm --filter @aesa/app export:web && pnpm typecheck && pnpm lint && pnpm test`
Expected: jest 1 passed; export prints `Exported: dist` with `dist/client` and `dist/server`; typecheck and lint clean across all packages.

- [ ] **Step 8: Commit**

```bash
git add apps/app eslint.config.js .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat(app): Expo SDK 57 scaffold (@aesa/app) with theme primitives, jest-expo, lint bans and the CI web export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Auth client, tRPC client, the session gate, sign-in and code screens

**Files:**
- Create: `apps/app/src/lib/api-url.ts`, `apps/app/src/lib/auth-client.ts`, `apps/app/src/lib/trpc.ts`, `apps/app/src/lib/session-gate.ts`, `apps/app/src/lib/session-gate.test.ts`, `apps/app/src/lib/next-path.ts`, `apps/app/src/lib/use-gate.ts`, `apps/app/src/components/providers.tsx`, `apps/app/src/screens/sign-in.tsx`, `apps/app/src/screens/verify.tsx`, `apps/app/src/app/(auth)/_layout.tsx`, `apps/app/src/app/(auth)/sign-in.tsx`, `apps/app/src/app/(auth)/verify.tsx`, `apps/app/src/app/post-auth.tsx`
- Modify: `apps/app/src/app/_layout.tsx`, `apps/app/src/app/index.tsx`

**Interfaces:**
- Consumes: `AppRouter` (Task 6, type only); `/meta` (Task 5).
- Produces: `API_URL`; `authClient` (Better Auth React client with expo, emailOTP and organization plugins) and `getAuthCookie(): Promise<string | null>`; `TRPCProvider`, `useTRPC`, `createTrpcClient()`; `resolveGate(input): GateTarget`, `hrefFor(target): Href | null`; `setNextPath`, `takeNextPath`; `useGate(): GateTarget` (performs the "activate first organization" side effect); `<Providers>`; screens `SignInScreen`, `VerifyScreen`.

- [ ] **Step 1: Write the failing test**

`apps/app/src/lib/session-gate.test.ts`:
```ts
import { hrefFor, resolveGate } from './session-gate'

describe('resolveGate', () => {
  it('loads until the session is known, then sends anonymous users to sign-in', () => {
    expect(resolveGate({ session: undefined, organizations: undefined, workspace: undefined })).toEqual({ kind: 'loading' })
    expect(resolveGate({ session: null, organizations: undefined, workspace: undefined })).toEqual({ kind: 'sign-in' })
  })
  it('without an active organization: activates the first membership, otherwise creates a workspace', () => {
    const session = { activeOrganizationId: null }
    expect(resolveGate({ session, organizations: undefined, workspace: undefined })).toEqual({ kind: 'loading' })
    expect(resolveGate({ session, organizations: [{ id: 'o1' }, { id: 'o2' }], workspace: undefined })).toEqual({ kind: 'activate', orgId: 'o1' })
    expect(resolveGate({ session, organizations: [], workspace: undefined })).toEqual({ kind: 'create-workspace' })
  })
  it('with an active organization: missing workspace → create, unfinished onboarding → that step, else the app', () => {
    const session = { activeOrganizationId: 'o1' }
    expect(resolveGate({ session, organizations: [], workspace: undefined })).toEqual({ kind: 'loading' })
    expect(resolveGate({ session, organizations: [], workspace: 'missing' })).toEqual({ kind: 'create-workspace' })
    expect(resolveGate({ session, organizations: [], workspace: { onboardingStep: 'knowledge' } })).toEqual({ kind: 'onboarding', step: 'knowledge' })
    expect(resolveGate({ session, organizations: [], workspace: { onboardingStep: 'done' } })).toEqual({ kind: 'app' })
  })
  it('maps targets to routes', () => {
    expect(hrefFor({ kind: 'sign-in' })).toBe('/sign-in')
    expect(hrefFor({ kind: 'create-workspace' })).toBe('/create-workspace')
    expect(hrefFor({ kind: 'onboarding', step: 'mailbox' })).toBe('/onboarding/mailbox')
    expect(hrefFor({ kind: 'app' })).toBe('/inbox')
    expect(hrefFor({ kind: 'loading' })).toBeNull()
    expect(hrefFor({ kind: 'activate', orgId: 'o1' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/app test`
Expected: FAIL — `./session-gate` not found.

- [ ] **Step 3: The clients**

`apps/app/src/lib/api-url.ts`:
```ts
/** Inlined at bundle time by Expo (EXPO_PUBLIC_*). On a physical device this must be the machine's LAN address. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '')
```

`apps/app/src/lib/auth-client.ts`:
```ts
import { expoClient } from '@better-auth/expo/client'
import { emailOTPClient, organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { API_URL } from './api-url'

/**
 * Native: the session cookie lives in SecureStore and rides along as a `cookie` header (credentials: omit).
 * Web: the expo plugin steps aside and the browser keeps the cookie (credentials: include, CORS on the api).
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [expoClient({ scheme: 'aesa', storagePrefix: 'aesa', storage: SecureStore }), emailOTPClient(), organizationClient()],
})

/** The cookie header non-auth requests (tRPC) must carry on native. Null on web, where the browser does it. */
export async function getAuthCookie(): Promise<string | null> {
  if (Platform.OS === 'web') return null
  const cookie = await authClient.getCookie()
  return cookie || null
}

export type SessionData = typeof authClient.$Infer.Session
```

`apps/app/src/lib/trpc.ts`:
```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { Platform } from 'react-native'
import superjson from 'superjson'
import type { AppRouter } from '@aesa/api'
import { API_URL } from './api-url'
import { getAuthCookie } from './auth-client'

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

export function createTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${API_URL}/trpc`,
        transformer: superjson,
        async headers() { const cookie = await getAuthCookie(); return cookie ? { cookie } : {} },
        fetch: (url, options) => fetch(url, { ...options, credentials: Platform.OS === 'web' ? 'include' : 'omit' }),
      }),
    ],
  })
}

export async function fetchMeta(): Promise<{ providers: { google: boolean; microsoft: boolean } }> {
  const res = await fetch(`${API_URL}/meta`)
  if (!res.ok) throw new Error(`meta ${res.status}`)
  return res.json() as Promise<{ providers: { google: boolean; microsoft: boolean } }>
}
```

- [ ] **Step 4: The gate**

`apps/app/src/lib/session-gate.ts`:
```ts
import type { Href } from 'expo-router'
import type { OnboardingStep } from '@aesa/contracts'

export interface GateInput {
  /** undefined = still loading; null = signed out */
  session: { activeOrganizationId: string | null } | null | undefined
  /** Only consulted when the session has no active organization. */
  organizations: { id: string }[] | undefined
  /** Only consulted when there is an active organization. 'missing' = the org has no workspaces row. */
  workspace: { onboardingStep: OnboardingStep } | 'missing' | undefined
}

export type GateTarget =
  | { kind: 'loading' }
  | { kind: 'sign-in' }
  | { kind: 'activate'; orgId: string }
  | { kind: 'create-workspace' }
  | { kind: 'onboarding'; step: Exclude<OnboardingStep, 'done'> }
  | { kind: 'app' }

/** Pure routing decision. Every layout renders what this says; nothing else decides where a user goes. */
export function resolveGate(i: GateInput): GateTarget {
  if (i.session === undefined) return { kind: 'loading' }
  if (i.session === null) return { kind: 'sign-in' }
  if (!i.session.activeOrganizationId) {
    if (i.organizations === undefined) return { kind: 'loading' }
    const first = i.organizations[0]
    return first ? { kind: 'activate', orgId: first.id } : { kind: 'create-workspace' }
  }
  if (i.workspace === undefined) return { kind: 'loading' }
  if (i.workspace === 'missing') return { kind: 'create-workspace' }
  if (i.workspace.onboardingStep !== 'done') return { kind: 'onboarding', step: i.workspace.onboardingStep }
  return { kind: 'app' }
}

export function hrefFor(t: GateTarget): Href | null {
  switch (t.kind) {
    case 'sign-in': return '/sign-in'
    case 'create-workspace': return '/create-workspace'
    case 'onboarding': return `/onboarding/${t.step}` as Href
    case 'app': return '/inbox'
    default: return null
  }
}
```

`apps/app/src/lib/next-path.ts`:
```ts
/** Where to go after sign-in when the user arrived through a deep link (an invitation). Process-local on purpose. */
let next: string | null = null
export function setNextPath(path: string | undefined | null) { if (path && path.startsWith('/') && !path.startsWith('//')) next = path }
export function takeNextPath(): string | null { const n = next; next = null; return n }
```

`apps/app/src/lib/use-gate.ts`:
```ts
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { authClient } from './auth-client'
import { resolveGate, type GateTarget } from './session-gate'
import { useTRPC } from './trpc'

const MISSING_CODES = new Set(['NOT_FOUND', 'PRECONDITION_FAILED', 'FORBIDDEN'])

/** The one hook every layout calls. Also performs the single side effect the gate needs: activating a membership. */
export function useGate(): GateTarget {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: session, isPending: sessionPending, refetch } = authClient.useSession()
  const { data: organizations, isPending: orgsPending } = authClient.useListOrganizations()
  const active = session?.session.activeOrganizationId ?? null
  const workspace = useQuery({ ...trpc.workspace.get.queryOptions(), enabled: Boolean(session && active), retry: false })

  const target = resolveGate({
    session: sessionPending ? undefined : session ? { activeOrganizationId: active } : null,
    organizations: session && !active ? (orgsPending ? undefined : organizations ?? []) : [],
    workspace: !(session && active) ? undefined
      : workspace.isPending ? undefined
      : workspace.error ? (MISSING_CODES.has(workspace.error.data?.code ?? '') ? 'missing' : undefined)
      : { onboardingStep: workspace.data.onboardingStep },
  })

  const activating = useRef<string | null>(null)
  useEffect(() => {
    if (target.kind !== 'activate' || activating.current === target.orgId) return
    activating.current = target.orgId
    authClient.organization.setActive({ organizationId: target.orgId })
      .then(() => refetch())
      .then(() => queryClient.invalidateQueries())
      .finally(() => { activating.current = null })
  }, [target, refetch, queryClient])

  return target
}
```

`apps/app/src/components/providers.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { TRPCProvider, createTrpcClient } from '@/lib/trpc'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }))
  const [trpcClient] = useState(() => createTrpcClient())
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>{children}</TRPCProvider>
    </QueryClientProvider>
  )
}
```

- [ ] **Step 5: Screens and routes**

`apps/app/src/screens/sign-in.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query'
import { Link, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { setNextPath } from '@/lib/next-path'
import { fetchMeta } from '@/lib/trpc'

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

export function SignInScreen() {
  const router = useRouter()
  const { next } = useLocalSearchParams<{ next?: string }>()
  useEffect(() => { setNextPath(next) }, [next])
  const meta = useQuery({ queryKey: ['meta'], queryFn: fetchMeta, staleTime: Infinity })
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendCode() {
    const address = email.trim().toLowerCase()
    setBusy(true); setError(null)
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: address, type: 'sign-in' })
    setBusy(false)
    if (error) return setError(error.status === 429 ? 'Too many codes requested. Wait a minute and try again.' : 'We could not send a code to that address.')
    router.push({ pathname: '/verify', params: { email: address } })
  }

  async function social(provider: 'google' | 'microsoft') {
    setError(null)
    const callbackURL = Platform.OS === 'web' ? `${window.location.origin}/post-auth` : '/post-auth'
    const { error } = await authClient.signIn.social({ provider, callbackURL })
    if (error) setError(`${provider === 'google' ? 'Google' : 'Microsoft'} sign-in did not complete.`)
  }

  return (
    <Screen testID="sign-in">
      <Title>Sign in to aesa</Title>
      <Muted>We email you a 6-digit code. No password to remember.</Muted>
      <TextField label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" testID="email" onSubmitEditing={sendCode} />
      <Button label="Send code" onPress={sendCode} loading={busy} disabled={!looksLikeEmail(email)} testID="send-code" />
      {meta.data?.providers.google ? <Button variant="secondary" label="Continue with Google" onPress={() => social('google')} testID="google" /> : null}
      {meta.data?.providers.microsoft ? <Button variant="secondary" label="Continue with Microsoft" onPress={() => social('microsoft')} testID="microsoft" /> : null}
      {error ? <Banner tone="error" testID="sign-in-error">{error}</Banner> : null}
      <Muted>By continuing you agree to the <Link href="/terms">Terms</Link> and the <Link href="/privacy">Privacy Policy</Link>.</Muted>
    </Screen>
  )
}
```

`apps/app/src/screens/verify.tsx`:
```tsx
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'

export function VerifyScreen() {
  const router = useRouter()
  const { email = '' } = useLocalSearchParams<{ email?: string }>()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)

  async function verify() {
    setBusy(true); setError(null)
    const { error } = await authClient.signIn.emailOtp({ email, otp: code.trim() })
    setBusy(false)
    // On success the session appears and the (auth) layout's gate redirects; nothing to do here.
    if (error) setError('That code is not right or has expired.')
  }

  async function resend() {
    setError(null); setResent(false)
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })
    if (error) setError('Could not resend the code. Wait a minute and try again.'); else setResent(true)
  }

  return (
    <Screen testID="verify">
      <Title>Check your email</Title>
      <Muted>We sent a 6-digit code to {email}.</Muted>
      <TextField label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} testID="otp" onSubmitEditing={verify} />
      <Button label="Continue" onPress={verify} loading={busy} disabled={code.trim().length !== 6} testID="verify-code" />
      <Button variant="secondary" label="Send a new code" onPress={resend} />
      <Button variant="secondary" label="Use a different email" onPress={() => router.replace('/sign-in')} />
      {resent ? <Banner tone="success">A new code is on its way.</Banner> : null}
      {error ? <Banner tone="error" testID="verify-error">{error}</Banner> : null}
    </Screen>
  )
}
```

`apps/app/src/app/_layout.tsx`:
```tsx
import { Stack } from 'expo-router/stack'
import { Providers } from '@/components/providers'

export default function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  )
}
```

`apps/app/src/app/index.tsx`:
```tsx
import { Redirect } from 'expo-router'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function Index() {
  const href = hrefFor(useGate())
  return href ? <Redirect href={href} /> : <Loading />
}
```

`apps/app/src/app/(auth)/_layout.tsx`:
```tsx
import { Redirect } from 'expo-router'
import { Stack } from 'expo-router/stack'
import { Loading } from '@/components/loading'
import { takeNextPath } from '@/lib/next-path'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

/** Signed-out screens. As soon as a session exists the gate (or a pending deep link) takes over. */
export default function AuthLayout() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind !== 'sign-in') {
    const next = takeNextPath()
    return <Redirect href={(next as never) ?? hrefFor(gate)!} />
  }
  return <Stack screenOptions={{ headerShown: false }} />
}
```

`apps/app/src/app/(auth)/sign-in.tsx`:
```tsx
import { SignInScreen } from '@/screens/sign-in'
export default SignInScreen
```

`apps/app/src/app/(auth)/verify.tsx`:
```tsx
import { VerifyScreen } from '@/screens/verify'
export default VerifyScreen
```

`apps/app/src/app/post-auth.tsx` (where social sign-in lands, on web as a full URL and on native as `aesa:///post-auth`):
```tsx
import { Redirect } from 'expo-router'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function PostAuth() {
  const href = hrefFor(useGate())
  return href ? <Redirect href={href} /> : <Loading />
}
```

- [ ] **Step 6: Run the checks**

Run: `pnpm --filter @aesa/app test && pnpm --filter @aesa/app export:web && pnpm --filter @aesa/app typecheck && pnpm lint`
Expected: jest 2 files pass; export lists `/sign-in`, `/verify`, `/post-auth`; typecheck and lint clean. Then a manual smoke with the api running (`pnpm --filter @aesa/api dev`, `.env` from the example with a generated `BETTER_AUTH_SECRET`): `pnpm --filter @aesa/app web`, open http://localhost:8081, enter an email, read the code from `http://localhost:3001/__dev/mail/latest?to=<email>`, verify — the app must land on `/create-workspace` (a 404 there is expected until Task 10).

- [ ] **Step 7: Commit**

```bash
git add apps/app
git commit -m "feat(app): Better Auth + tRPC clients, the session gate, sign-in and code screens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Create-workspace and the four-step onboarding scaffold

**Files:**
- Create: `apps/app/src/screens/create-workspace.tsx`, `apps/app/src/screens/onboarding/stepper.tsx`, `apps/app/src/screens/onboarding/stepper.test.tsx`, `apps/app/src/screens/onboarding/profile-form.tsx`, `apps/app/src/screens/onboarding/profile.tsx`, `apps/app/src/screens/onboarding/mailbox.tsx`, `apps/app/src/screens/onboarding/knowledge.tsx`, `apps/app/src/screens/onboarding/go-live.tsx`, `apps/app/src/app/create-workspace.tsx`, `apps/app/src/app/onboarding/_layout.tsx`, `apps/app/src/app/onboarding/[step].tsx`

**Interfaces:**
- Consumes: `workspace.create`, `workspace.get`, `workspace.updateProfile`, `workspace.advanceOnboarding` (Task 6); `UpdateProfileInput`, `TONES`, `deriveAllowedHosts`, `ONBOARDING_STEPS` (Task 1); `useGate`, `authClient`, `useTRPC` (Task 9).
- Produces: `<Stepper current>`; `<ProfileForm initial onSaved>` (reused by Settings → Workspace in Task 11); route `/onboarding/[step]` that always renders the server's step.

- [ ] **Step 1: Write the failing test**

`apps/app/src/screens/onboarding/stepper.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react-native'
import { Stepper } from './stepper'

test('lists the four steps and marks the current one', async () => {
  await render(<Stepper current="knowledge" />)
  for (const label of ['Profile', 'Mailbox', 'Knowledge', 'Go live']) expect(screen.getByText(label)).toBeTruthy()
  expect(screen.getByTestId('step-knowledge').props.accessibilityState?.selected).toBe(true)
  expect(screen.getByTestId('step-profile').props.accessibilityState?.selected).toBe(false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/app test`
Expected: FAIL — `./stepper` not found.

- [ ] **Step 3: Stepper, profile form and step screens**

`apps/app/src/screens/onboarding/stepper.tsx`:
```tsx
import { StyleSheet, Text, View } from 'react-native'
import type { OnboardingStep } from '@aesa/contracts'
import { radius, spacing, typeScale, useColors } from '@/theme'

const STEPS: { key: Exclude<OnboardingStep, 'done'>; label: string }[] = [
  { key: 'profile', label: 'Profile' }, { key: 'mailbox', label: 'Mailbox' }, { key: 'knowledge', label: 'Knowledge' }, { key: 'go_live', label: 'Go live' },
]

export function Stepper({ current }: { current: OnboardingStep }) {
  const c = useColors()
  const at = STEPS.findIndex((s) => s.key === current)
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {STEPS.map((s, i) => {
        const selected = s.key === current
        const done = i < at || current === 'done'
        return (
          <View key={s.key} testID={`step-${s.key}`} accessibilityRole="tab" accessibilityState={{ selected }}
            style={[styles.pill, { backgroundColor: selected ? c.primary : done ? c.surface : c.bg, borderColor: selected ? c.primary : c.border }]}>
            <Text style={[typeScale.caption, { color: selected ? c.onPrimary : c.muted }]}>{i + 1}. {s.label}</Text>
          </View>
        )
      })}
    </View>
  )
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.lg, borderWidth: 1 },
})
```

`apps/app/src/screens/onboarding/profile-form.tsx`:
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { TONES, UpdateProfileInput, deriveAllowedHosts, type Tone } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'

export interface ProfileInitial { websiteUrl: string | null; description: string | null; tone: Tone; contactPhone: string | null; contactUrls: string[] }
const TONE_LABEL: Record<Tone, string> = { friendly: 'Friendly', formal: 'Formal', concise: 'Concise' }

/** Shared by onboarding step 1 and Settings → Workspace. Saves through workspace.updateProfile. */
export function ProfileForm({ initial, submitLabel, onSaved }: { initial: ProfileInitial; submitLabel: string; onSaved: () => void }) {
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [websiteUrl, setWebsiteUrl] = useState(initial.websiteUrl ?? '')
  const [description, setDescription] = useState(initial.description ?? '')
  const [tone, setTone] = useState<Tone>(initial.tone)
  const [contactPhone, setContactPhone] = useState(initial.contactPhone ?? '')
  const [contactUrls, setContactUrls] = useState(initial.contactUrls.join('\n'))
  const [error, setError] = useState<string | null>(null)

  const draft = useMemo(() => ({
    websiteUrl: websiteUrl.trim() ? websiteUrl.trim() : null,
    description: description.trim(),
    tone,
    contactPhone: contactPhone.trim() ? contactPhone.trim() : null,
    contactUrls: contactUrls.split('\n').map((u) => u.trim()).filter(Boolean),
  }), [websiteUrl, description, tone, contactPhone, contactUrls])
  const parsed = UpdateProfileInput.safeParse(draft)
  const hosts = parsed.success ? deriveAllowedHosts(parsed.data.websiteUrl, parsed.data.contactUrls) : []

  const save = useMutation(trpc.workspace.updateProfile.mutationOptions({
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() }); onSaved() },
    onError: () => setError('Could not save. Check the URLs and try again.'),
  }))

  return (
    <View style={styles.form}>
      <TextField label="Website" value={websiteUrl} onChangeText={setWebsiteUrl} placeholder="https://acme.com" autoCapitalize="none" keyboardType="url" testID="website" error={websiteUrl.trim() && !parsed.success && parsed.error.issues.some((i) => i.path[0] === 'websiteUrl') ? 'Must be an http(s) URL' : null} />
      <TextField label="One line about the business" value={description} onChangeText={setDescription} placeholder="We sell handmade socks and ship worldwide." maxLength={500} testID="description" />
      <View style={styles.tones}>
        <Muted>Tone</Muted>
        <View style={styles.toneRow}>
          {TONES.map((t) => (
            <Pressable key={t} role="radio" accessibilityState={{ checked: tone === t }} onPress={() => setTone(t)} testID={`tone-${t}`}
              style={[styles.tone, { borderColor: tone === t ? c.primary : c.border, backgroundColor: tone === t ? c.info : c.bg }]}>
              <Text style={[typeScale.body, { color: c.text }]}>{TONE_LABEL[t]}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <TextField label="Phone the agent may share (optional)" value={contactPhone} onChangeText={setContactPhone} keyboardType="phone-pad" testID="phone" />
      <TextField label="Links the agent may share (one per line, optional)" value={contactUrls} onChangeText={setContactUrls} multiline numberOfLines={3} autoCapitalize="none" placeholder={'https://acme.com/contact\nhttps://acme.com/returns'} testID="contact-urls" />
      <Card testID="guardrail-summary">
        <Muted>Guardrail</Muted>
        <Text style={[typeScale.body, { color: c.text }]}>{hosts.length ? `Replies may link only to ${hosts.join(', ')}.` : 'Replies will contain no links until you add a website or contact links.'}</Text>
      </Card>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Button label={submitLabel} onPress={() => { setError(null); if (parsed.success) save.mutate(parsed.data) }} loading={save.isPending} disabled={!parsed.success} testID="save-profile" />
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  tones: { gap: spacing.xs },
  toneRow: { flexDirection: 'row', gap: spacing.sm },
  tone: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
})
```

`apps/app/src/screens/onboarding/profile.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Muted, Title } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { ProfileForm } from './profile-form'
import { Stepper } from './stepper'

export function ProfileStep() {
  const trpc = useTRPC()
  const router = useRouter()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  if (!ws.data) return <Loading />
  return (
    <Screen testID="onboarding-profile">
      <Stepper current="profile" />
      <Title>Tell the agent about {ws.data.businessName}</Title>
      <Muted>About a minute. Everything here can be changed later in Settings.</Muted>
      <ProfileForm initial={ws.data} submitLabel="Continue" onSaved={() => router.replace('/onboarding/mailbox')} />
    </Screen>
  )
}
```

`apps/app/src/screens/onboarding/mailbox.tsx`, `knowledge.tsx`, `go-live.tsx` share one helper; write it at the top of `mailbox.tsx` and import it from the other two:
```tsx
// mailbox.tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Platform } from 'react-native'
import type { OnboardingStep } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'
import { hrefFor } from '@/lib/session-gate'
import { useTRPC } from '@/lib/trpc'
import { Stepper } from './stepper'

/** "Continue" and "Skip for now" both advance the server-side step, then follow it. */
export function useAdvance() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  return useMutation(trpc.workspace.advanceOnboarding.mutationOptions({
    onSuccess: async ({ to }) => {
      await queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() })
      router.replace(hrefFor(to === 'done' ? { kind: 'app' } : { kind: 'onboarding', step: to as Exclude<OnboardingStep, 'done'> })!)
    },
  }))
}

export function MailboxStep() {
  const advance = useAdvance()
  return (
    <Screen testID="onboarding-mailbox">
      <Stepper current="mailbox" />
      <Title>Connect a mailbox</Title>
      <Card>
        <Body>Gmail and Microsoft 365 connections arrive with the next release. When they do, you will pick which addresses the agent answers — nothing is read until you say so.</Body>
        <Muted>Until then, continue and connect later from Settings → Mailboxes.</Muted>
      </Card>
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      <Button label="Continue" onPress={() => advance.mutate()} loading={advance.isPending} testID="continue" />
    </Screen>
  )
}
```

```tsx
// knowledge.tsx
import { Platform } from 'react-native'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'
import { useAdvance } from './mailbox'
import { Stepper } from './stepper'

export function KnowledgeStep() {
  const advance = useAdvance()
  return (
    <Screen testID="onboarding-knowledge">
      <Stepper current="knowledge" />
      <Title>Give the agent knowledge</Title>
      <Card>
        <Body>Crawl your website, paste FAQs and policies, or upload files. Knowledge arrives in a later release; the agent is only as good as its grounding, so this step will be worth the five minutes.</Body>
        {Platform.OS !== 'web' ? <Muted>Tip: finish this step on a desktop to upload documents.</Muted> : null}
      </Card>
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      <Button label="Skip for now" variant="secondary" onPress={() => advance.mutate()} loading={advance.isPending} testID="skip" />
    </Screen>
  )
}
```

```tsx
// go-live.tsx
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'
import { useAdvance } from './mailbox'
import { Stepper } from './stepper'

export function GoLiveStep() {
  const advance = useAdvance()
  return (
    <Screen testID="onboarding-go-live">
      <Stepper current="go_live" />
      <Title>Almost there</Title>
      <Card>
        <Body>Every category starts in Review: the agent drafts, you approve. The master switch, the "send yourself a test email" box and the review queue arrive with the drafting release.</Body>
        <Muted>Finishing now takes you to your workspace; you will be nudged here again when the agent can go live.</Muted>
      </Card>
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      <Button label="Finish setup" onPress={() => advance.mutate()} loading={advance.isPending} testID="finish" />
    </Screen>
  )
}
```

`apps/app/src/screens/create-workspace.tsx`:
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { CreateWorkspaceInput } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { useTRPC } from '@/lib/trpc'

export function CreateWorkspaceScreen() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session, refetch } = authClient.useSession()
  const [yourName, setYourName] = useState(session?.user.name ?? '')
  const [businessName, setBusinessName] = useState('')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const input = CreateWorkspaceInput.safeParse({ businessName, timezone })

  const create = useMutation(trpc.workspace.create.mutationOptions({
    onSuccess: async () => {
      if (yourName.trim() && yourName.trim() !== session?.user.name) await authClient.updateUser({ name: yourName.trim() })
      await refetch()
      await queryClient.invalidateQueries()
      router.replace('/onboarding/profile')
    },
  }))

  return (
    <Screen testID="create-workspace">
      <Title>Create your workspace</Title>
      <Muted>One workspace per business. You can invite teammates afterwards.</Muted>
      {!session?.user.name ? <TextField label="Your name" value={yourName} onChangeText={setYourName} autoComplete="name" testID="your-name" /> : null}
      <TextField label="Business name" value={businessName} onChangeText={setBusinessName} placeholder="Acme Socks" testID="business-name" onSubmitEditing={() => input.success && create.mutate(input.data)} />
      <Muted>Time zone: {timezone}</Muted>
      {create.isError ? <Banner tone="error">Could not create the workspace. Try again.</Banner> : null}
      <Button label="Create workspace" onPress={() => input.success && create.mutate(input.data)} loading={create.isPending} disabled={!input.success} testID="create" />
    </Screen>
  )
}
```

- [ ] **Step 4: Routes**

`apps/app/src/app/create-workspace.tsx`:
```tsx
import { Redirect } from 'expo-router'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'
import { CreateWorkspaceScreen } from '@/screens/create-workspace'

export default function CreateWorkspaceRoute() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind !== 'create-workspace') return <Redirect href={hrefFor(gate)!} />
  return <CreateWorkspaceScreen />
}
```

`apps/app/src/app/onboarding/_layout.tsx`:
```tsx
import { Redirect, Slot } from 'expo-router'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function OnboardingLayout() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind !== 'onboarding') return <Redirect href={hrefFor(gate)!} />
  return <Slot />
}
```

`apps/app/src/app/onboarding/[step].tsx` (the URL step is a request; the server's step is the truth, so a phone that finished step 2 resumes at step 3 on the desktop):
```tsx
import { Redirect, useLocalSearchParams } from 'expo-router'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'
import { GoLiveStep } from '@/screens/onboarding/go-live'
import { KnowledgeStep } from '@/screens/onboarding/knowledge'
import { MailboxStep } from '@/screens/onboarding/mailbox'
import { ProfileStep } from '@/screens/onboarding/profile'

export default function OnboardingStepRoute() {
  const { step } = useLocalSearchParams<{ step: string }>()
  const gate = useGate()
  if (gate.kind !== 'onboarding') return <Loading />
  if (gate.step !== step) return <Redirect href={hrefFor(gate)!} />
  switch (gate.step) {
    case 'profile': return <ProfileStep />
    case 'mailbox': return <MailboxStep />
    case 'knowledge': return <KnowledgeStep />
    case 'go_live': return <GoLiveStep />
  }
}
```

- [ ] **Step 5: Run the checks and a manual walk**

Run: `pnpm --filter @aesa/app test && pnpm --filter @aesa/app export:web && pnpm --filter @aesa/app typecheck && pnpm lint`
Expected: PASS. Manual (api running with a `.env`): sign in on web → create workspace → profile form shows the guardrail summary as you type → Continue lands on Mailbox → reload the page → still Mailbox; open the same account in another browser profile → Mailbox as well (resume across devices) → Continue, Skip for now, Finish setup → `/inbox` (404 until Task 11 is expected).

- [ ] **Step 6: Commit**

```bash
git add apps/app
git commit -m "feat(app): create-workspace and the four-step onboarding scaffold that resumes from the server step

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `ResponsiveShell`, the tabs, the Settings skeleton, Team, and invitation acceptance

**Files:**
- Create: `apps/app/src/components/responsive-shell.tsx`, `apps/app/src/screens/placeholder.tsx`, `apps/app/src/screens/settings/index.tsx`, `apps/app/src/screens/settings/workspace.tsx`, `apps/app/src/screens/settings/team.tsx`, `apps/app/src/screens/settings/member-row.tsx`, `apps/app/src/screens/settings/member-row.test.tsx`, `apps/app/src/screens/invite.tsx`, `apps/app/src/app/(app)/_layout.tsx`, `apps/app/src/app/(app)/inbox.tsx`, `apps/app/src/app/(app)/activity.tsx`, `apps/app/src/app/(app)/settings/_layout.tsx`, `apps/app/src/app/(app)/settings/index.tsx`, `apps/app/src/app/(app)/settings/workspace.tsx`, `apps/app/src/app/(app)/settings/team.tsx`, `apps/app/src/app/invite/[id].tsx`
- Modify: `apps/app/package.json` (`@expo/vector-icons` via `npx expo install @expo/vector-icons`)

**Interfaces:**
- Consumes: `team.list/invite/cancelInvitation/changeRole/remove`, `workspace.get` (Tasks 6–7); `ProfileForm` (Task 10); `useGate`, `authClient`, `setNextPath` (Task 9); `canManageWorkspace`, `OrgRole` (Task 1).
- Produces: `<ResponsiveShell>` (tabs under `WIDE_BREAKPOINT`, sidebar + hidden tab bar above it); `<MemberRow member me canManage onChangeRole onRemove>`; routes `/inbox`, `/activity`, `/settings`, `/settings/workspace`, `/settings/team`, `/invite/[id]`. `/settings/notifications` is added in Task 12.

- [ ] **Step 1: Write the failing test**

`apps/app/src/screens/settings/member-row.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react-native'
import { MemberRow } from './member-row'

const ann = { id: 'm1', userId: 'u1', role: 'owner' as const, name: 'Ann', email: 'ann@example.com' }
const bob = { id: 'm2', userId: 'u2', role: 'member' as const, name: 'Bob', email: 'bob@example.com' }

test('a manager sees role and remove actions for others, never for the owner or themselves', async () => {
  const onChangeRole = jest.fn(); const onRemove = jest.fn()
  await render(<MemberRow member={bob} meUserId="u1" canManage onChangeRole={onChangeRole} onRemove={onRemove} />)
  fireEvent.press(screen.getByText('Make admin'))
  expect(onChangeRole).toHaveBeenCalledWith('m2', 'admin')
  fireEvent.press(screen.getByText('Remove'))
  fireEvent.press(screen.getByText('Confirm remove'))
  expect(onRemove).toHaveBeenCalledWith('m2')

  await render(<MemberRow member={ann} meUserId="u1" canManage onChangeRole={onChangeRole} onRemove={onRemove} />)
  expect(screen.queryByText('Remove')).toBeNull()
  expect(screen.getByText('Owner · you')).toBeTruthy()
})

test('a plain member sees no actions', async () => {
  await render(<MemberRow member={bob} meUserId="u3" canManage={false} onChangeRole={jest.fn()} onRemove={jest.fn()} />)
  expect(screen.queryByText('Make admin')).toBeNull()
  expect(screen.queryByText('Remove')).toBeNull()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/app test`
Expected: FAIL — `./member-row` not found.

- [ ] **Step 3: Install the icon set and write the shell**

Run: `cd apps/app && npx expo install @expo/vector-icons`

`apps/app/src/components/responsive-shell.tsx`:
```tsx
import Ionicons from '@expo/vector-icons/Ionicons'
import { Link, usePathname } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { WIDE_BREAKPOINT, radius, spacing, typeScale, useColors } from '@/theme'

type Glyph = keyof typeof Ionicons.glyphMap
const TABS: { name: 'inbox' | 'activity' | 'settings'; title: string; icon: Glyph; iconActive: Glyph; href: '/inbox' | '/activity' | '/settings' }[] = [
  { name: 'inbox', title: 'Inbox', icon: 'mail-outline', iconActive: 'mail', href: '/inbox' },
  { name: 'activity', title: 'Activity', icon: 'pulse-outline', iconActive: 'pulse', href: '/activity' },
  { name: 'settings', title: 'Settings', icon: 'settings-outline', iconActive: 'settings', href: '/settings' },
]

/**
 * One navigator, two compositions (spec, UX: native vs web): bottom tabs on phones, a sidebar with the tab bar
 * hidden on tablets-landscape and desktop. Must be rendered by app/(app)/_layout.tsx because it owns the <Tabs>.
 */
export function ResponsiveShell() {
  const c = useColors()
  const { width } = useWindowDimensions()
  const wide = width >= WIDE_BREAKPOINT
  const pathname = usePathname()

  const tabs = (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: c.primary, tabBarInactiveTintColor: c.muted, tabBarStyle: wide ? { display: 'none' } : { backgroundColor: c.bg, borderTopColor: c.border } }}>
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title, tabBarButtonTestID: `tab-${t.name}`, tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? t.iconActive : t.icon} size={22} color={color} /> }} />
      ))}
    </Tabs>
  )
  if (!wide) return tabs

  return (
    <View style={[styles.row, { backgroundColor: c.bg }]}>
      <View style={[styles.sidebar, { borderRightColor: c.border, backgroundColor: c.surface }]} accessibilityRole="menu">
        <Text style={[typeScale.heading, styles.brand, { color: c.text }]}>aesa</Text>
        {TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`)
          return (
            <Link key={t.name} href={t.href} asChild>
              {/* asChild hands onPress to the child, so it must be pressable — a View would swallow the navigation */}
              <Pressable accessibilityRole="menuitem" testID={`nav-${t.name}`} style={[styles.item, active && { backgroundColor: c.info }]}>
                <Ionicons name={active ? t.iconActive : t.icon} size={20} color={active ? c.primary : c.muted} />
                <Text style={[typeScale.body, { color: active ? c.primary : c.text }]}>{t.title}</Text>
              </Pressable>
            </Link>
          )
        })}
      </View>
      <View style={styles.main}>{tabs}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 240, borderRightWidth: StyleSheet.hairlineWidth, padding: spacing.md, gap: spacing.xs },
  brand: { paddingVertical: spacing.md, paddingHorizontal: spacing.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md },
  main: { flex: 1 },
})
```

`apps/app/src/app/(app)/_layout.tsx`:
```tsx
import { Redirect } from 'expo-router'
import { Loading } from '@/components/loading'
import { ResponsiveShell } from '@/components/responsive-shell'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function AppLayout() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind !== 'app') return <Redirect href={hrefFor(gate)!} />
  return <ResponsiveShell />
}
```

`apps/app/src/screens/placeholder.tsx`:
```tsx
import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'

export function PlaceholderScreen({ title, body, phase, testID }: { title: string; body: string; phase: string; testID: string }) {
  return (
    <Screen testID={testID}>
      <Title>{title}</Title>
      <Card><Body>{body}</Body><Muted>Arrives with {phase}.</Muted></Card>
    </Screen>
  )
}
```

`apps/app/src/app/(app)/inbox.tsx`:
```tsx
import { PlaceholderScreen } from '@/screens/placeholder'
export default function Inbox() {
  return <PlaceholderScreen testID="inbox" title="Inbox" body="Drafts waiting for review, mail that needs a human, and what was sent recently will appear here — three sections, one-word reasons." phase="the mailbox and drafting releases (Phases 2–3)" />
}
```

`apps/app/src/app/(app)/activity.tsx`:
```tsx
import { PlaceholderScreen } from '@/screens/placeholder'
export default function Activity() {
  return <PlaceholderScreen testID="activity" title="Activity" body="What the agent sent, with its sources and confidence, plus the questions it could not ground." phase="the drafting release (Phase 3)" />
}
```

- [ ] **Step 4: Settings**

`apps/app/src/app/(app)/settings/_layout.tsx`:
```tsx
import { Stack } from 'expo-router/stack'

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: true, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="workspace" options={{ title: 'Workspace' }} />
      <Stack.Screen name="team" options={{ title: 'Team' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
    </Stack>
  )
}
```

`apps/app/src/screens/settings/index.tsx`:
```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from 'expo-router'
import { useState } from 'react'
import { Button } from '@/components/button'
import { ListRow } from '@/components/list-row'
import { Screen } from '@/components/screen'
import { Heading, Muted } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { useTRPC } from '@/lib/trpc'

export function SettingsIndexScreen() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session, refetch } = authClient.useSession()
  const { data: organizations } = authClient.useListOrganizations()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const [switching, setSwitching] = useState<string | null>(null)

  async function switchTo(orgId: string) {
    setSwitching(orgId)
    await authClient.organization.setActive({ organizationId: orgId })
    await refetch(); await queryClient.invalidateQueries()
    setSwitching(null); router.replace('/')
  }
  async function signOut() {
    await authClient.signOut()
    queryClient.clear()
    router.replace('/sign-in')
  }

  return (
    <Screen testID="settings">
      <Heading>{ws.data?.businessName ?? 'Workspace'}</Heading>
      <ListRow title="Workspace profile" subtitle="Website, tone, links the agent may share" onPress={() => router.push('/settings/workspace')} testID="settings-workspace" />
      <ListRow title="Team" subtitle="Invite teammates, change roles" onPress={() => router.push('/settings/team')} testID="settings-team" />
      <ListRow title="Notifications" subtitle="Push on this device" onPress={() => router.push('/settings/notifications')} testID="settings-notifications" />
      <ListRow title="Mailboxes" subtitle="Connect Gmail or Microsoft 365" badge="Phase 2" />
      <ListRow title="Agents" subtitle="Personas, signatures, per-agent guidance" badge="Phase 2" />
      <ListRow title="Autopilot" subtitle="Off / Review / Auto per category" badge="Phase 5" />
      <ListRow title="AI" subtitle="Managed AI or your own provider" badge="Phase 6" />
      <ListRow title="Billing" subtitle="Plan, domains, usage" badge="Phase 7" />
      {organizations && organizations.length > 1 ? (
        <>
          <Heading>Switch workspace</Heading>
          {organizations.filter((o) => o.id !== session?.session.activeOrganizationId).map((o) => (
            <ListRow key={o.id} title={o.name} onPress={() => switchTo(o.id)} badge={switching === o.id ? '…' : undefined} />
          ))}
        </>
      ) : null}
      <Heading>Account</Heading>
      <Muted>Signed in as {session?.user.email}</Muted>
      <Button variant="secondary" label="Sign out" onPress={signOut} testID="sign-out" />
      <Muted><Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link></Muted>
    </Screen>
  )
}
```

`apps/app/src/screens/settings/workspace.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Muted } from '@/components/typography'
import { canManageWorkspace } from '@aesa/contracts'
import { useTRPC } from '@/lib/trpc'
import { ProfileForm } from '@/screens/onboarding/profile-form'

export function WorkspaceSettingsScreen() {
  const trpc = useTRPC()
  const router = useRouter()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const [saved, setSaved] = useState(false)
  if (!ws.data) return <Loading />
  if (!canManageWorkspace(ws.data.role)) return <Screen><Banner>Only owners and admins can edit the workspace profile.</Banner></Screen>
  return (
    <Screen testID="settings-workspace-screen">
      <Muted>{ws.data.businessName} · {ws.data.timezone}</Muted>
      {saved ? <Banner tone="success">Saved.</Banner> : null}
      <ProfileForm initial={ws.data} submitLabel="Save" onSaved={() => { setSaved(true); router.back() }} />
    </Screen>
  )
}
```

`apps/app/src/screens/settings/member-row.tsx`:
```tsx
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { OrgRole } from '@aesa/contracts'
import { Button } from '@/components/button'
import { spacing, typeScale, useColors } from '@/theme'

export interface MemberLike { id: string; userId: string; role: OrgRole; name: string; email: string }
const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

export function MemberRow({ member, meUserId, canManage, onChangeRole, onRemove }: {
  member: MemberLike; meUserId: string; canManage: boolean
  onChangeRole: (memberId: string, role: 'admin' | 'member') => void; onRemove: (memberId: string) => void
}) {
  const c = useColors()
  const [confirming, setConfirming] = useState(false)
  const me = member.userId === meUserId
  const actionable = canManage && !me && member.role !== 'owner'
  return (
    <View style={[styles.row, { borderBottomColor: c.border }]} testID={`member-${member.id}`}>
      <View style={styles.text}>
        <Text style={[typeScale.body, { color: c.text }]}>{member.name || member.email}</Text>
        <Text style={[typeScale.caption, { color: c.muted }]}>{member.email} · {ROLE_LABEL[member.role]}{me ? ' · you' : ''}</Text>
      </View>
      {actionable ? (
        <View style={styles.actions}>
          <Button variant="secondary" label={member.role === 'admin' ? 'Make member' : 'Make admin'} onPress={() => onChangeRole(member.id, member.role === 'admin' ? 'member' : 'admin')} />
          <Button variant={confirming ? 'danger' : 'secondary'} label={confirming ? 'Confirm remove' : 'Remove'} onPress={() => (confirming ? onRemove(member.id) : setConfirming(true))} />
        </View>
      ) : null}
    </View>
  )
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  text: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', gap: spacing.xs },
})
```

`apps/app/src/screens/settings/team.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { canManageWorkspace } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { ListRow } from '@/components/list-row'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'
import { MemberRow } from './member-row'

export function TeamScreen() {
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const team = useQuery(trpc.team.list.queryOptions())
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [error, setError] = useState<string | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.team.list.queryKey() })
  const invite = useMutation(trpc.team.invite.mutationOptions({ onSuccess: () => { setEmail(''); refresh() }, onError: () => setError('Could not send the invitation.') }))
  const cancel = useMutation(trpc.team.cancelInvitation.mutationOptions({ onSuccess: refresh }))
  const changeRole = useMutation(trpc.team.changeRole.mutationOptions({ onSuccess: refresh, onError: () => setError('Could not change the role.') }))
  const remove = useMutation(trpc.team.remove.mutationOptions({ onSuccess: refresh, onError: () => setError('Could not remove the member.') }))

  if (!ws.data || !team.data || !session) return <Loading />
  const canManage = canManageWorkspace(ws.data.role)
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  return (
    <Screen testID="team">
      <Heading>Members</Heading>
      {team.data.members.map((m) => (
        <MemberRow key={m.id} member={m} meUserId={session.user.id} canManage={canManage}
          onChangeRole={(memberId, r) => changeRole.mutate({ memberId, role: r })} onRemove={(memberId) => remove.mutate({ memberId })} />
      ))}
      {team.data.invitations.length ? <Heading>Pending invitations</Heading> : null}
      {team.data.invitations.map((i) => (
        <ListRow key={i.id} title={i.email} subtitle={`${i.role} · expires ${i.expiresAt.toLocaleDateString()}`} badge={canManage ? 'Cancel' : undefined} onPress={canManage ? () => cancel.mutate({ invitationId: i.id }) : undefined} testID={`invitation-${i.id}`} />
      ))}
      {canManage ? (
        <Card testID="invite-form">
          <Heading>Invite a teammate</Heading>
          <TextField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" testID="invite-email" />
          <View style={styles.roles}>
            {(['member', 'admin'] as const).map((r) => (
              <Pressable key={r} role="radio" accessibilityState={{ checked: role === r }} onPress={() => setRole(r)} testID={`invite-role-${r}`}
                style={[styles.role, { borderColor: role === r ? c.primary : c.border, backgroundColor: role === r ? c.info : c.bg }]}>
                <Text style={[typeScale.body, { color: c.text }]}>{r === 'admin' ? 'Admin — can edit settings and manage the team' : 'Member — can review, cannot change settings'}</Text>
              </Pressable>
            ))}
          </View>
          <Button label="Send invitation" onPress={() => { setError(null); invite.mutate({ email: email.trim(), role }) }} loading={invite.isPending} disabled={!emailOk} testID="send-invite" />
        </Card>
      ) : <Muted>Only owners and admins can invite teammates.</Muted>}
      {error ? <Banner tone="error">{error}</Banner> : null}
    </Screen>
  )
}
const styles = StyleSheet.create({
  roles: { gap: spacing.sm },
  role: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
})
```

Routes: `apps/app/src/app/(app)/settings/index.tsx` → `export { SettingsIndexScreen as default } from '@/screens/settings/index'`; `workspace.tsx` → `export { WorkspaceSettingsScreen as default } from '@/screens/settings/workspace'`; `team.tsx` → `export { TeamScreen as default } from '@/screens/settings/team'`.

- [ ] **Step 5: Invitation acceptance**

`apps/app/src/screens/invite.tsx`:
```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'

export function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session, isPending, refetch } = authClient.useSession()
  const invitation = useQuery({
    queryKey: ['invitation', id], enabled: Boolean(session && id), retry: false,
    queryFn: async () => { const { data, error } = await authClient.organization.getInvitation({ query: { id } }); if (error || !data) throw new Error(error?.message ?? 'not found'); return data },
  })
  const [yourName, setYourName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (isPending) return <Loading />
  if (!session) return <Redirect href={{ pathname: '/sign-in', params: { next: `/invite/${id}` } }} />
  if (invitation.isPending) return <Loading />
  if (invitation.error || !invitation.data) return <Screen testID="invite"><Title>Invitation not found</Title><Muted>It may have expired or been cancelled. Ask for a new one.</Muted></Screen>
  const inv = invitation.data

  async function accept() {
    setBusy(true); setError(null)
    if (!session?.user.name && yourName.trim()) await authClient.updateUser({ name: yourName.trim() })
    const { error } = await authClient.organization.acceptInvitation({ invitationId: id })
    if (error) { setBusy(false); return setError(error.message?.includes('email') ? `This invitation was sent to ${inv.email}. Sign in with that address.` : 'Could not accept the invitation.') }
    await authClient.organization.setActive({ organizationId: inv.organizationId })
    await refetch(); await queryClient.invalidateQueries()
    router.replace('/')
  }

  return (
    <Screen testID="invite">
      <Title>Join {inv.organizationName}</Title>
      <Muted>{inv.inviterEmail} invited you as {inv.role ?? 'member'}. Signed in as {session.user.email}.</Muted>
      {!session.user.name ? <TextField label="Your name" value={yourName} onChangeText={setYourName} autoComplete="name" /> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Button label="Accept invitation" onPress={accept} loading={busy} testID="accept-invite" />
    </Screen>
  )
}
```

`apps/app/src/app/invite/[id].tsx`:
```tsx
import { InviteScreen } from '@/screens/invite'
export default InviteScreen
```

- [ ] **Step 6: Run the checks and a manual walk**

Run: `pnpm --filter @aesa/app test && pnpm --filter @aesa/app export:web && pnpm --filter @aesa/app typecheck && pnpm lint`
Expected: PASS. Manual: finish onboarding → Inbox placeholder; widen the browser past 900px → sidebar appears, tab bar disappears; Settings → Team → invite a second address → open the link from `/__dev/mail/latest?to=<address>` in another browser profile → sign in → Accept → that user lands on the Inbox with the member role and cannot open Workspace profile for editing.

- [ ] **Step 7: Commit**

```bash
git add apps/app pnpm-lock.yaml
git commit -m "feat(app): ResponsiveShell tabs/sidebar, Settings skeleton, Team management and invitation acceptance

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Push registration

**Files:**
- Create: `apps/app/src/lib/push.ts`, `apps/app/src/lib/push.test.ts`, `apps/app/src/lib/use-push-registration.ts`, `apps/app/src/screens/settings/notifications.tsx`, `apps/app/src/app/(app)/settings/notifications.tsx`
- Modify: `apps/app/src/app/(app)/_layout.tsx`

**Interfaces:**
- Consumes: `devices.register/unregister/list` (Task 7); `RegisterDeviceInput` (Task 1).
- Produces: `registerForPush({ ask }): Promise<PushResult>` where `PushResult = { kind: 'unsupported' } | { kind: 'denied' } | { kind: 'no-project' } | { kind: 'ok'; expoPushToken; platform; deviceName? }`; `usePushRegistration()` (silent re-registration on every app launch when permission was already granted).

- [ ] **Step 1: Write the failing test**

`apps/app/src/lib/push.test.ts`:
```ts
jest.mock('expo-device', () => ({ isDevice: true, deviceName: 'Test Phone' }))
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'proj_123' } } } } }))
// babel-jest hoists jest.mock above imports and only lets the factory close over variables named mock*.
const mockNotifications = {
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), getExpoPushTokenAsync: jest.fn(), setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
}
jest.mock('expo-notifications', () => mockNotifications)
// jest-expo's default preset runs as iOS, so Platform.OS is already 'ios'; no Platform mock is needed.

import { registerForPush } from './push'

beforeEach(() => jest.clearAllMocks())

test('does not prompt when not asked and permission is missing', async () => {
  mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' })
  expect(await registerForPush({ ask: false })).toEqual({ kind: 'denied' })
  expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled()
})

test('prompts when asked, then returns the Expo token with the EAS project id', async () => {
  mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' })
  mockNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'granted' })
  mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[abc]' })
  expect(await registerForPush({ ask: true })).toEqual({ kind: 'ok', expoPushToken: 'ExponentPushToken[abc]', platform: 'ios', deviceName: 'Test Phone' })
  expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj_123' })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aesa/app test`
Expected: FAIL — `./push` not found.

- [ ] **Step 3: Implement**

`apps/app/src/lib/push.ts`:
```ts
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

export type PushResult =
  | { kind: 'unsupported' }   // web, simulators, Expo Go
  | { kind: 'denied' }
  | { kind: 'no-project' }    // app.json has no extra.eas.projectId yet (run `eas init`)
  | { kind: 'ok'; expoPushToken: string; platform: 'ios' | 'android'; deviceName?: string }

/** Native only. `ask: false` never shows the system prompt — the Notifications settings screen does that on tap. */
export async function registerForPush({ ask }: { ask: boolean }): Promise<PushResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return { kind: 'unsupported' }
  if (!Device.isDevice) return { kind: 'unsupported' }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Review needed', importance: Notifications.AndroidImportance.HIGH })
  }
  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return { kind: 'denied' }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined
  if (!projectId) return { kind: 'no-project' }
  const token = await Notifications.getExpoPushTokenAsync({ projectId })
  return { kind: 'ok', expoPushToken: token.data, platform: Platform.OS, ...(Device.deviceName ? { deviceName: Device.deviceName } : {}) }
}
```

`apps/app/src/lib/use-push-registration.ts`:
```ts
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { registerForPush } from './push'
import { useTRPC } from './trpc'

/** Once per launch, after the gate says `app`: re-register silently if permission was already granted. */
export function usePushRegistration() {
  const trpc = useTRPC()
  const register = useMutation(trpc.devices.register.mutationOptions())
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    registerForPush({ ask: false }).then((r) => { if (r.kind === 'ok') register.mutate({ expoPushToken: r.expoPushToken, platform: r.platform, ...(r.deviceName ? { deviceName: r.deviceName } : {}) }) }).catch(() => { /* never block the app on push */ })
  }, [register])
}
```

`apps/app/src/app/(app)/_layout.tsx` — add `import { usePushRegistration } from '@/lib/use-push-registration'` and split the component so the hook runs only once the gate is `app`:
```tsx
export default function AppLayout() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind !== 'app') return <Redirect href={hrefFor(gate)!} />
  return <Shell />
}
function Shell() { usePushRegistration(); return <ResponsiveShell /> }
```

`apps/app/src/screens/settings/notifications.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { ListRow } from '@/components/list-row'
import { Screen } from '@/components/screen'
import { Body, Heading, Muted } from '@/components/typography'
import { registerForPush, type PushResult } from '@/lib/push'
import { useTRPC } from '@/lib/trpc'

export function NotificationsScreen() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const devices = useQuery(trpc.devices.list.queryOptions())
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() })
  const register = useMutation(trpc.devices.register.mutationOptions({ onSuccess: refresh }))
  const unregister = useMutation(trpc.devices.unregister.mutationOptions({ onSuccess: refresh }))
  const [state, setState] = useState<PushResult | null>(null)
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => { registerForPush({ ask: false }).then((r) => { setState(r); if (r.kind === 'ok') setToken(r.expoPushToken) }) }, [])

  async function enable() {
    const r = await registerForPush({ ask: true })
    setState(r)
    if (r.kind === 'ok') { setToken(r.expoPushToken); register.mutate({ expoPushToken: r.expoPushToken, platform: r.platform, ...(r.deviceName ? { deviceName: r.deviceName } : {}) }) }
  }

  return (
    <Screen testID="notifications">
      <Card>
        <Heading>This device</Heading>
        {Platform.OS === 'web' ? <Body>Push notifications are for the phone app. On the web you will get in-app notices and the email digest.</Body>
          : state?.kind === 'ok' ? <Body>Push is on. You will be told when a draft needs review or a customer needs a human.</Body>
          : state?.kind === 'no-project' ? <Body>This build is not linked to an EAS project yet, so push tokens cannot be issued.</Body>
          : state?.kind === 'unsupported' ? <Body>Push needs a development build on a real device.</Body>
          : <Body>Get a push when a draft is ready to review — never for routine sends.</Body>}
        {Platform.OS !== 'web' && state?.kind !== 'ok' && state?.kind !== 'unsupported' ? <Button label="Enable push notifications" onPress={enable} loading={register.isPending} testID="enable-push" /> : null}
        {state?.kind === 'ok' && token ? <Button variant="secondary" label="Stop notifications on this device" onPress={() => unregister.mutate({ expoPushToken: token })} loading={unregister.isPending} /> : null}
      </Card>
      {devices.data?.length ? <Heading>Registered devices</Heading> : null}
      {devices.data?.map((d) => (
        <ListRow key={d.id} title={d.deviceName ?? d.platform} subtitle={d.disabledAt ? `Stopped ${d.disabledAt.toLocaleDateString()}` : `Last seen ${d.lastSeenAt.toLocaleString()}`} badge={d.platform} />
      ))}
      {state?.kind === 'denied' ? <Banner>Notifications are off for aesa in the system settings. Turn them on there, then come back.</Banner> : null}
      <Muted>Review and escalation pushes only. Auto-sent replies fold into the daily digest.</Muted>
    </Screen>
  )
}
```

`apps/app/src/app/(app)/settings/notifications.tsx`:
```tsx
export { NotificationsScreen as default } from '@/screens/settings/notifications'
```

- [ ] **Step 4: Run the checks**

Run: `pnpm --filter @aesa/app test && pnpm --filter @aesa/app export:web && pnpm --filter @aesa/app typecheck && pnpm lint`
Expected: PASS (jest 5 files). On a device this needs a dev build with `eas init` done (Task 14 runbook); on web the screen explains itself.

- [ ] **Step 5: Commit**

```bash
git add apps/app
git commit -m "feat(app): push registration (silent re-register on launch, opt-in from Settings → Notifications)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Playwright signup smoke, in CI

**Files:**
- Create: `apps/app/playwright.config.ts`, `apps/app/e2e/signup.spec.ts`
- Modify: `.github/workflows/ci.yml`, `package.json` (root `e2e` script)

**Interfaces:**
- Consumes: the served web export (`expo serve`), the api with `EMAIL_TRANSPORT=devsink` and `GET /__dev/mail/latest` (Task 5), every `testID` from Tasks 9–11.

- [ ] **Step 1: Write the failing test**

`apps/app/e2e/signup.spec.ts`:
```ts
import { expect, test, type APIRequestContext } from '@playwright/test'

const API = process.env.E2E_API_URL ?? 'http://localhost:3001'

async function latestOtp(request: APIRequestContext, email: string): Promise<string> {
  const url = `${API}/__dev/mail/latest?to=${encodeURIComponent(email)}`
  await expect.poll(async () => (await request.get(url)).status(), { timeout: 15_000 }).toBe(200)
  const mail = (await (await request.get(url)).json()) as { text: string }
  const otp = mail.text.match(/\b(\d{6})\b/)?.[1]
  if (!otp) throw new Error('no code in the devsink mail')
  return otp
}

test('sign up with an email code, create a workspace, finish the profile step, resume at the mailbox step, reach the inbox', async ({ page, request }) => {
  const email = `pw-${Date.now()}@example.com`
  await page.goto('/')
  await expect(page.getByTestId('sign-in')).toBeVisible()
  await page.getByTestId('email').fill(email)
  await page.getByTestId('send-code').click()
  await expect(page.getByTestId('verify')).toBeVisible()
  await page.getByTestId('otp').fill(await latestOtp(request, email))
  await page.getByTestId('verify-code').click()

  await expect(page.getByTestId('create-workspace')).toBeVisible()
  await page.getByTestId('your-name').fill('Playwright Owner')
  await page.getByTestId('business-name').fill('Playwright Socks')
  await page.getByTestId('create').click()

  await expect(page.getByTestId('onboarding-profile')).toBeVisible()
  await page.getByTestId('website').fill('https://www.playwright-socks.example')
  await expect(page.getByTestId('guardrail-summary')).toContainText('playwright-socks.example')
  await page.getByTestId('save-profile').click()
  await expect(page.getByTestId('onboarding-mailbox')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('onboarding-mailbox')).toBeVisible()          // the server owns the step
  await page.goto('/onboarding/profile')
  await expect(page.getByTestId('onboarding-mailbox')).toBeVisible()          // a stale URL is corrected

  await page.getByTestId('continue').click()
  await expect(page.getByTestId('onboarding-knowledge')).toBeVisible()
  await page.getByTestId('skip').click()
  await expect(page.getByTestId('onboarding-go-live')).toBeVisible()
  await page.getByTestId('finish').click()
  await expect(page.getByTestId('inbox')).toBeVisible()

  // Returning user: sign out, sign in again, straight to the inbox.
  await page.getByTestId('tab-settings').or(page.getByTestId('nav-settings')).first().click()
  await expect(page.getByTestId('settings')).toBeVisible()
  await page.getByTestId('sign-out').click()
  await expect(page.getByTestId('sign-in')).toBeVisible()
  await page.getByTestId('email').fill(email)
  await page.getByTestId('send-code').click()
  await page.getByTestId('otp').fill(await latestOtp(request, email))
  await page.getByTestId('verify-code').click()
  await expect(page.getByTestId('inbox')).toBeVisible()
})
```

`apps/app/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:8081'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: WEB, trace: 'retain-on-failure', viewport: { width: 1280, height: 900 } },
  webServer: [
    {
      // The api with the devsink transport. Needs a migrated database at DATABASE_URL.
      command: 'pnpm --filter @aesa/api start',
      url: `${API}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test', EMAIL_TRANSPORT: 'devsink', LOG_LEVEL: 'warn',
        APP_BASE_URL: API, APP_WEB_ORIGIN: WEB, PORT: new URL(API).port,
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev',
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'playwright-secret-playwright-secret-playwright',
      },
    },
    {
      // The web export (run `EXPO_PUBLIC_API_URL=<API> pnpm export:web` first) hosted by Expo's production server.
      command: 'pnpm exec expo serve --port 8081',
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (database up and migrated): `cd apps/app && pnpm exec playwright install chromium && EXPO_PUBLIC_API_URL=http://localhost:3001 pnpm export:web && pnpm e2e`
Expected: the spec runs against the real api and web export and PASSES if Tasks 9–12 are complete; it FAILS before that with the first missing `testID`. (There is no separate red step for an end-to-end smoke; the green run is the deliverable.)

- [ ] **Step 3: Wire CI and the root script**

Root `package.json` scripts: add `"e2e": "pnpm --filter @aesa/app e2e"`.

`.github/workflows/ci.yml` — append after `pnpm db:check`:
```yaml
      - name: Install Playwright Chromium
        run: pnpm --filter @aesa/app exec playwright install --with-deps chromium
      - name: Playwright signup smoke (api with devsink mail + the served web export)
        run: pnpm e2e
        env:
          CI: 'true'
          BETTER_AUTH_SECRET: playwright-secret-playwright-secret-playwright
      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: apps/app/playwright-report
```
(`DATABASE_URL` is already in the job env and points at the migrated service database; the web export step from Task 8 already ran with `EXPO_PUBLIC_API_URL=http://localhost:3001`.)

- [ ] **Step 4: Run the gate and the smoke locally**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check && EXPO_PUBLIC_API_URL=http://localhost:3001 pnpm --filter @aesa/app export:web && pnpm e2e`
Expected: all green; the smoke passes in under two minutes.

- [ ] **Step 5: Commit**

```bash
git add apps/app/playwright.config.ts apps/app/e2e package.json .github/workflows/ci.yml
git commit -m "test(app): Playwright signup smoke against the api and the served web export, in CI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Privacy and terms pages, `eas.json`, the external-setup runbook, docs

**Files:**
- Create: `apps/app/src/app/privacy.tsx`, `apps/app/src/app/terms.tsx`, `apps/app/eas.json`, `docs/runbooks/2026-09-phase-1-external-setup.md`
- Modify: `README.md`, `CLAUDE.md`, `docs/STATUS.md`

- [ ] **Step 1: Legal pages (drafts; Robert's counsel signs off before the consent screens are submitted)**

`apps/app/src/app/privacy.tsx`:
```tsx
import { Screen } from '@/components/screen'
import { Body, Heading, Muted, Title } from '@/components/typography'

export default function Privacy() {
  return (
    <Screen testID="privacy">
      <Title>Privacy Policy</Title>
      <Muted>Draft of 8 September 2026 — pending legal review. Closing Brackets (“we”) operates aesa.</Muted>
      <Heading>What we collect</Heading>
      <Body>Your account (name, email, sign-in method), your workspace profile, and — once you connect a mailbox — the customer email addressed to the addresses you choose, so the agent can draft replies. We never read mail sent to addresses you did not select.</Body>
      <Heading>Where it goes</Heading>
      <Body>Data is stored in our Postgres database (hosted in the region shown in your workspace settings). To draft a reply, the relevant customer message and your knowledge are sent to the AI provider your workspace uses: our managed provider (Anthropic, and Voyage AI for search embeddings) by default, or a provider you connect yourself under that provider’s terms. Platform email (sign-in codes, invitations, digests) is sent through Resend. Push notifications go through Expo’s push service. We do not sell personal data.</Body>
      <Heading>Retention and deletion</Heading>
      <Body>Message bodies are kept for the retention period set on your workspace (180 days by default) and audit records for two years. You can delete a workspace; the data is removed after a 30-day grace period. You can ask us to delete everything the agent learned from a single customer.</Body>
      <Heading>Your rights and contact</Heading>
      <Body>Access, correction, export and deletion requests: privacy@closingbrackets.com.</Body>
    </Screen>
  )
}
```

`apps/app/src/app/terms.tsx`:
```tsx
import { Screen } from '@/components/screen'
import { Body, Heading, Muted, Title } from '@/components/typography'

export default function Terms() {
  return (
    <Screen testID="terms">
      <Title>Terms of Service</Title>
      <Muted>Draft of 8 September 2026 — pending legal review.</Muted>
      <Heading>The service</Heading>
      <Body>aesa drafts and, when you enable it, sends replies to your customers’ email from your own mailbox. You remain responsible for what is sent from your addresses; every automatic reply can be reviewed, held and turned off at any time.</Body>
      <Heading>Your account and workspace</Heading>
      <Body>One workspace per business. Teammates you invite act on your behalf within the roles you give them. Keep your sign-in email secure; we never ask for a password.</Body>
      <Heading>Acceptable use</Heading>
      <Body>No unlawful, deceptive or abusive use of the mail we help you send. We may suspend a workspace that sends spam or violates a mail provider’s terms.</Body>
      <Heading>Fees</Heading>
      <Body>Pricing is per connected domain per month with an included allowance of AI-handled conversations; overage is billed as shown in Billing. Trials need no card.</Body>
      <Heading>Liability</Heading>
      <Body>The service is provided as is. To the extent permitted by law our liability is limited to the fees you paid in the twelve months before a claim.</Body>
      <Heading>Contact</Heading>
      <Body>legal@closingbrackets.com</Body>
    </Screen>
  )
}
```

- [ ] **Step 2: `apps/app/eas.json`**

```json
{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "env": { "EXPO_PUBLIC_API_URL": "http://192.168.1.20:3001" }
    },
    "preview": {
      "distribution": "internal",
      "env": { "EXPO_PUBLIC_API_URL": "https://api-staging.example.com" }
    },
    "production": {
      "autoIncrement": true,
      "env": { "EXPO_PUBLIC_API_URL": "https://api.example.com" }
    }
  },
  "submit": { "production": {} }
}
```
(The three `EXPO_PUBLIC_API_URL` values are placeholders Robert replaces with the LAN address of the dev machine and the real api hosts.)

- [ ] **Step 3: The runbook**

`docs/runbooks/2026-09-phase-1-external-setup.md`:
```markdown
# Phase 1 external setup (Robert)

Everything Phase 1 needs that CI cannot do. Values in angle brackets are yours to fill in. `APP_BASE_URL` is the
api's public origin (e.g. `https://api.<product>.com`), `APP_WEB_ORIGIN` the web app's (e.g. `https://app.<product>.com`).

## 1. Better Auth secret and production env (api)

- `BETTER_AUTH_SECRET`: `openssl rand -base64 48`.
- `APP_BASE_URL`, `APP_WEB_ORIGIN`, `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `MAIL_FROM` (see §4), `NODE_ENV=production`.
- Add extra web origins (staging) to `AUTH_TRUSTED_ORIGINS` (comma-separated). If the web app and the api are
  on different registrable domains, set `AUTH_CROSS_SITE_COOKIES=true` (cookies become `SameSite=None; Secure`).

## 2. Google sign-in (consent screen + brand verification)

1. Google Cloud console → APIs & Services → OAuth consent screen: External; app name `<product>`; support email;
   app domain `<APP_WEB_ORIGIN>`; privacy `<APP_WEB_ORIGIN>/privacy`; terms `<APP_WEB_ORIGIN>/terms`.
2. Scopes: only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (non-sensitive; no verification
   audit for sign-in alone — Gmail scopes arrive in Phase 2 and start CASA).
3. Credentials → OAuth client (Web application): authorised JavaScript origin `<APP_WEB_ORIGIN>`, authorised
   redirect URI `<APP_BASE_URL>/api/auth/callback/google`. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the api.
4. Submit brand verification (logo + homepage + privacy/terms) now; it takes days and Phase 2 needs it.

## 3. Microsoft sign-in (Entra app registration + publisher verification)

1. Entra admin center → App registrations → New: name `<product>`; supported account types: *Accounts in any
   organizational directory and personal Microsoft accounts*; redirect URI (Web) `<APP_BASE_URL>/api/auth/callback/microsoft`.
2. Certificates & secrets → new client secret (24 months). Set `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`.
3. API permissions: only `openid`, `profile`, `email` (delegated). No `User.Read`: the app reads the id token.
4. Branding & properties → Publisher domain `<APP_WEB_ORIGIN host>` and start **publisher verification** with the
   Partner Center (MPN) account; unverified publishers show a warning on the consent prompt and Phase 2's mail
   scopes need it done.

## 4. Resend (platform mail only)

1. Resend → Domains → add `mail.<product>.com`; add the DKIM CNAMEs, the SPF TXT and a DMARC record
   (`v=DMARC1; p=quarantine; rua=mailto:dmarc@<product>.com`) at the DNS host; wait for *Verified*.
2. API key with sending permission → `RESEND_API_KEY`; `MAIL_FROM="<product> <no-reply@mail.<product>.com>"`.
3. Send yourself a code from the production api and check headers show SPF, DKIM and DMARC `pass`.

## 5. EAS: project, dev builds, web hosting

    cd apps/app
    eas login
    eas init                                   # writes extra.eas.projectId into app.json — commit it (push tokens need it)
    eas build --profile development --platform ios      # dev client for a real iPhone (push needs a device)
    eas build --profile development --platform android
    # web: export with the production api URL, then deploy the server output
    EXPO_PUBLIC_API_URL=https://api.<product>.com pnpm export:web
    eas deploy --prod

Set the three `EXPO_PUBLIC_API_URL` values in `eas.json` (dev = this machine's LAN IP, preview = staging, production).
Point `app.<product>.com` at the EAS Hosting deployment and set `APP_WEB_ORIGIN` accordingly on the api.

## 6. Phase 1 verification walk (spec)

- Sign up on iOS (dev build), Android (dev build) and web with the same email; the onboarding step you left on one
  device is the one you land on with the other.
- `SELECT actor, action FROM audit_log WHERE org_id = '<org>' ORDER BY id` shows `user:<uuid>` rows for
  `workspace.create`, `workspace.profile.update`, `workspace.onboarding.advance`, `team.invite`, `team.join`,
  `device.register`.
- Settings → Notifications on a device: enable → the row appears; send a test push with Expo's push tool to the
  token in `notification_devices` (the worker's dispatcher arrives in Phase 2).
- CI green on the branch: typecheck, lint, tests, drift check, web export, Playwright smoke.
```

- [ ] **Step 4: Docs**

`README.md` — in *Development*, after the db lines, add:
```
    cp apps/api/.env.example apps/api/.env      # set BETTER_AUTH_SECRET (openssl rand -base64 48)
    pnpm --filter @aesa/api dev                  # http://localhost:3001 — codes: /__dev/mail/latest?to=<email>
    cp apps/app/.env.example apps/app/.env
    pnpm --filter @aesa/app dev                  # Expo: press w for web (http://localhost:8081), i / a for simulators
    pnpm e2e                                     # Playwright smoke (export the web app first: pnpm --filter @aesa/app export:web)
```
and change the Layout line to `Layout: apps/api (Fastify + Better Auth + tRPC), apps/worker (pg-boss), apps/app (Expo), packages/{contracts,db,crypto,core,queue}.` Replace the `APP_BASE_URL` sentence with: `APP_BASE_URL is the api's public origin (Better Auth baseURL, OAuth redirect URIs); APP_WEB_ORIGIN is the Expo web origin (CORS, trusted origin, invitation links).` Add a line under *Database roles*: `Better Auth's seven tables are not tenant tables (no RLS; aesa_app has DML); the api reaches them only through Better Auth's adapter.`

`CLAUDE.md` — *Commands*: add `pnpm --filter @aesa/app dev` (copy `apps/app/.env.example` to `.env`; `EXPO_PUBLIC_API_URL` must be the LAN address for a physical phone), `pnpm --filter @aesa/app export:web`, `pnpm e2e`, and `pnpm --filter @aesa/app test` (jest, no database). *Layout*: add `packages/contracts — zod inputs and enums shared by api, db and app; zod only, no Node imports` and rewrite the `apps/app` line: `apps/app — the Expo universal app (@aesa/app, SDK 57, Expo Router, web.output server): src/app routes only, src/screens bodies, src/lib clients and the session gate, src/components primitives; jest-expo + RNTL for units, Playwright for the signup smoke`. *Rules*: append `**App bundle.** apps/app never imports @aesa/db, @aesa/core, @aesa/crypto, @aesa/queue, drizzle-orm or node:* as values, and @aesa/api only as import type (ESLint block for apps/app/**). Share types through @aesa/contracts.`; `**Auth tables.** Better Auth's user/session/account/verification/organization/member/invitation are RLS_EXEMPT with uuid ids minted by Postgres (generateId: false); the api reaches them only through Better Auth; tRPC's orgProcedure derives orgId from the session's active organization plus getActiveMember, never from input.`; `**Audit.** Tenant-side audit rows go through audit(tx, entry) with actor user:<id> | agent:<run_id> | system:<job>; every tRPC mutation writes one.`; and extend the Toolchain bullet: `apps/app extends expo/tsconfig.base with allowImportingTsExtensions, noEmit and types ["node","jest"]; the root ESLint TypeScript block covers **/*.tsx.`

`docs/STATUS.md` — move Phase 1 under *Done* (plan path, commit range, gate numbers, deviations 1–7 from this plan, what exists now: `@aesa/contracts`, the auth tables + `notification_devices`, `audit()`, Better Auth + tRPC in the api, the Expo app with sign-in, onboarding, shell, settings, team, push, the Playwright smoke and CI web export), write *Next: Phase 2 — mailboxes, agents, ingest, triage* from the spec with the rulings a planner needs (the `SECURITY DEFINER` resolvers, `mailbox_credentials` worker-only grants via explicit REVOKE, org key provisioning in the worker before the first credential — deviation 2 here — and the CASA submission), and list the Phase 2 pre-flight carry-overs: `pinned-fetch.ts` HEAD content-length; `platform.access` retention; worker logger and `defineJob` zod fail-fast; `keys.test.ts` order dependence; the non-superuser CI login role; Better Auth's in-memory rate limiter is per replica (move to `rateLimit.storage: 'database'` or secondary storage before the api scales past one instance); the `team.remove` flow does not clear the removed user's `activeOrganizationId` in an open session on another device (the gate handles it as FORBIDDEN → create-workspace; a friendlier "you were removed" state is UX polish); `apps/app` still ships placeholder art. Update *Open items for Robert* with the runbook path.

- [ ] **Step 5: Final gate and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check && EXPO_PUBLIC_API_URL=http://localhost:3001 pnpm --filter @aesa/app export:web && pnpm e2e`
Expected: green.

```bash
git add apps/app/src/app/privacy.tsx apps/app/src/app/terms.tsx apps/app/eas.json docs/runbooks README.md CLAUDE.md docs/STATUS.md
git commit -m "docs: privacy/terms drafts, eas.json, the external-setup runbook, and Phase 1 status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then `superpowers:finishing-a-development-branch` — Robert decides how `phase-1` lands; never push or merge without him.

---

## Self-review against the spec

**Coverage of *Build phases → Phase 1*:** Expo app with Expo Router → Tasks 8–11; `ResponsiveShell` → Task 11; auth with email OTP + Google/Microsoft with minimal scopes → Tasks 5, 9 (deviation 3 records the Microsoft scope choice); workspace creation → Tasks 6, 10; four-step onboarding scaffold → Task 10 (server-owned step, Task 6); team invites + roles → Tasks 7, 11; Settings skeleton → Task 11; push registration → Tasks 7, 12; `web.output 'server'` → Task 8; EAS Hosting + dev builds → Task 14 runbook (deviation 6); external verifications (Google consent + brand, Microsoft publisher, privacy/terms pages, Resend domain) → Task 14. Verification: sign up on iOS/Android/web → runbook §6 (manual); onboarding step resumes across devices → Task 10 route + Task 13 assertions; audit rows carry `user:<id>` → Task 6/7 tests; Playwright signup smoke → Task 13; Expo web export in CI → Task 8. Data model: Better Auth core tables with `generateId: false` and uuid ids, `workspaces.org_id` FK → Task 2; `notification_devices` → Task 2; `audit_log` actor grammar → Task 3. Tenancy net 3 (orgId from session + membership, never input) → Task 6. Carry-overs handled or re-deferred with reasons in the header.

**Placeholder scan:** no TBD/TODO; every step carries its code; the only "later" items are named phases with a reason (Inbox/Activity placeholders and inert settings rows are product copy, not plan gaps).

**Type consistency:** `createTestApi` returns `{ app, config, mail, api, handle, lines, close }` and is used that way in Tasks 5–7; `signInWithOtp` returns `{ cookie, user }`; `ServerDeps` is `{ config, auth, api, mail, logLevel?, logStream? }` everywhere; `orgProcedure` ctx provides `orgId`, `member.{id,role}`, `user`, `actor`, `headers`, `ip`, `userAgent` and the routers use exactly those; `WorkspaceView` fields match what `ProfileForm`'s `ProfileInitial` and `useGate` read; `GateTarget` kinds are the same in `session-gate.ts`, `use-gate.ts` and every layout; `RegisterDeviceInput` shape matches `registerForPush`'s `ok` result; test IDs used by Playwright (`sign-in`, `email`, `send-code`, `verify`, `otp`, `verify-code`, `create-workspace`, `your-name`, `business-name`, `create`, `onboarding-profile`, `website`, `guardrail-summary`, `save-profile`, `onboarding-mailbox`, `continue`, `onboarding-knowledge`, `skip`, `onboarding-go-live`, `finish`, `inbox`, `tab-settings`/`nav-settings`, `settings`, `sign-out`) all exist in Tasks 9–12.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-08-phase-1-accounts-and-app-shell.md`. Two execution options:

1. **Subagent-Driven (recommended)** — `superpowers:subagent-driven-development`: a fresh implementer per task, a task review after each, the fix loop, then the whole-branch review recorded under `docs/superpowers/reviews/`.
2. **Inline Execution** — `superpowers:executing-plans` in this session with checkpoints.
