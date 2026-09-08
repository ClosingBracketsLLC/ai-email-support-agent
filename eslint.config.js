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
