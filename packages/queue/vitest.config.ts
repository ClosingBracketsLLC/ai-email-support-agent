import { defineConfig } from 'vitest/config'
// pg-boss test files (register-cron, pg-boss-behaviour, fair-select) all share one Postgres
// database/schema; running the files in parallel worker processes lets their queues/jobs race
// against each other (job-stealing across files), so file-level parallelism is disabled here.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], fileParallelism: false } })
