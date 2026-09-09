import { defineConfig } from '@playwright/test'

const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:8081'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
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
