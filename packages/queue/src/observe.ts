/**
 * Task 11's job-failure seam. Deliberately Sentry-free: `@aesa/queue` must never gain a Sentry
 * dependency (that lives in each app's own `observability.ts`), so this is nothing but a settable
 * callback `registerJob`'s catch block calls before it rethrows the scrubbed error. The worker is
 * the only process that ever calls `setJobObserver` — it wires the real one
 * (`apps/worker/src/observability.ts`'s `captureWithOrg`) at boot; the api never works a job at all,
 * so it never calls this either.
 */
export interface JobObserver {
  onFailure(err: unknown, ctx: { name: string; jobId: string; orgId: string | null }): void
}

let observer: JobObserver | null = null

/** `null` unregisters (the default — nothing observes a job failure until the worker wires one). */
export function setJobObserver(o: JobObserver | null): void {
  observer = o
}

/**
 * Called from `registerJob`'s catch AFTER `scrubJobError` and before the rethrow — the observer
 * receives the scrubbed error (a `DrizzleQueryError` with its `query`/`params` gone), never the raw
 * one, so a bound customer body cannot ride into Sentry this way. Never throws itself — an
 * observer's own failure (a bad Sentry call, a network hiccup) must never replace or mask the job's
 * real error, which is what pg-boss still needs to see.
 */
export function notifyJobFailure(err: unknown, ctx: { name: string; jobId: string; orgId: string | null }): void {
  if (!observer) return
  try {
    observer.onFailure(err, ctx)
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}
