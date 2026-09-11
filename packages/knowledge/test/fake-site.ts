// The worker's suites and the phase E2E import this fixture as `@aesa/knowledge/testing` (it must
// live on the production path, not under `test/`, since it isn't allowed to import from `test/`
// or from `vitest`) — this file just re-exports it for `packages/knowledge`'s own tests.
export { fakeSite, type FakePage } from '../src/testing.ts'
