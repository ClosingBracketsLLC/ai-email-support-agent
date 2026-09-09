export * from './conformance.ts'
export * from './recorder.ts'

// Re-exported for convenience: a consumer wiring a conformance harness (or any other mailbox
// test) needs the mock without a separate `@aesa/mail` import for just this.
export { createMockMailbox, type MockMailbox, type MockMailboxOptions, type ReceiveInboundInput } from '@aesa/mail'
