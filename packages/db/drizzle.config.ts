import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  // Roles (aesa_app / aesa_platform, Task 3) are managed by drizzle-kit so CREATE ROLE and
  // ENABLE ROW LEVEL SECURITY land in generated migrations instead of by hand. The cluster's own
  // roles are excluded so a future `drizzle-kit push` cannot try to manage (or drop) them.
  entities: { roles: { exclude: ['aesa_owner', 'aesa'] } },
})
