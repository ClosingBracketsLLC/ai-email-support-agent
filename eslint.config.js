import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const RAW_DB_MESSAGE =
  "Import from '@aesa/db' and use withOrg()/withPlatform(). A raw pool has no org scope: it runs as the LOGIN role with no `-c role`, which in production bypasses the app-role timeouts and locally bypasses RLS entirely. Allowed only in packages/db, composition roots (apps/*/src/index.ts) and tests; `import type` is always fine."

const rawDbImports = {
  paths: [
    { name: '@aesa/db/raw', message: RAW_DB_MESSAGE, allowTypeImports: true },
    { name: 'pg', message: RAW_DB_MESSAGE, allowTypeImports: true },
    { name: 'drizzle-orm/node-postgres', message: RAW_DB_MESSAGE, allowTypeImports: true },
  ],
  patterns: [{ group: ['drizzle-orm/node-postgres/*'], message: RAW_DB_MESSAGE, allowTypeImports: true }],
}

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/migrations/**', '**/.expo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',                                  // superseded by the type-aware version
      '@typescript-eslint/no-restricted-imports': ['error', rawDbImports],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/db/**/*.ts', 'apps/*/src/index.ts', '**/test/**/*.ts', '**/scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
)
