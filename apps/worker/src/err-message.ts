/** Every "log and never throw" path in the mailbox jobs (sync failures, renew-watch failures, revoke's
 * best-effort provider calls) needs a safe string out of an unknown catch value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
