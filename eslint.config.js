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
    ...[
      '@aesa/db', '@aesa/core', '@aesa/crypto', '@aesa/queue', '@aesa/api',
      '@aesa/mail', '@aesa/platform-mail', '@aesa/llm', '@aesa/agent', '@aesa/test-kit',
      'drizzle-orm', 'fastify', 'better-auth/node',
    ].map((name) => ({ name, message: APP_MESSAGE, allowTypeImports: true })),
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
