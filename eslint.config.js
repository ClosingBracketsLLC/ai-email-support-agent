import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const RAW_DB_MESSAGE =
  "Import from '@aesa/db' and use withOrg()/withPlatform(). A raw pool has no org scope: it runs as the LOGIN role with no `-c role`, which in production bypasses the app-role timeouts and locally bypasses RLS entirely. Allowed only in packages/db, composition roots (apps/*/src/index.ts) and tests; `import type` is always fine."

const BOSS_SEND_MESSAGE =
  "Enqueue through @aesa/queue's enqueue(): it sets the `${orgId}:${entityId}` singletonKey the `short` queues dedupe on; a bare boss.send on one of them collapses with every other keyless send."

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
    ...[
      '@aesa/db', '@aesa/core', '@aesa/crypto', '@aesa/queue', '@aesa/api',
      '@aesa/mail', '@aesa/platform-mail', '@aesa/llm', '@aesa/agent', '@aesa/knowledge', '@aesa/test-kit',
      'drizzle-orm', 'fastify', 'better-auth/node',
    ].map((name) => ({ name, message: APP_MESSAGE, allowTypeImports: true })),
  ],
  patterns: [
    ...rawDbImports.patterns,
    { group: ['@aesa/db/*', '@aesa/api/*', '@aesa/agent/*', '@aesa/knowledge/*', 'drizzle-orm/*', 'node:*'], message: APP_MESSAGE, allowTypeImports: true },
  ],
}

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/migrations/**', '**/.expo/**', '**/playwright-report/**', '**/test-results/**', '**/.venv/**'] },
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
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: ['packages/queue/src/**'],
    rules: {
      'no-restricted-syntax': ['error',
        // Two selectors, one message: a bare `boss.send(...)`, and `<anything>.boss.send(...)` —
        // `deps.boss.send(...)` is how a job or a service actually reaches the instance, and the
        // identifier-only selector never saw it.
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='send'][callee.object.name='boss']",
          message: BOSS_SEND_MESSAGE,
        },
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='send'][callee.object.type='MemberExpression'][callee.object.property.name='boss']",
          message: BOSS_SEND_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['packages/db/**/*.ts', 'apps/*/src/index.ts', '**/test/**/*.ts', '**/scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
)
