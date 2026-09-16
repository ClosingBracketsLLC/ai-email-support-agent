/**
 * The managed-draft admission pool (spec §Budgets; plan deviation 13): a process-external ceiling on
 * how many MANAGED model calls this deployment may have in flight at once, so a burst of drafting
 * across every replica cannot walk into the Anthropic tier's concurrency limit and turn one busy
 * hour into a wall of `llm_transient` failures.
 *
 * It is **prevention with a reactive floor, never a gate**. Three rules follow from that, and all
 * three are load-bearing:
 *
 *  1. **A draft is never lost to admission control.** When no slot frees inside `waitMs` the caller
 *     is handed `null` and PROCEEDS anyway (with an `admission_slot_timeout` alert). The pool exists
 *     to smooth a burst, not to refuse work — a refusal here would cost the owner a reply.
 *  2. **`acquire` never throws.** A connection this pool could not check out, or a lock query that
 *     errored, resolves `null` for the same reason: the model call is what matters, and the run's own
 *     `withOrg` transactions will surface a genuinely unreachable database soon enough.
 *  3. **BYOK calls never enter the pool at all.** A tenant's own endpoint has its own per-credential
 *     limiter (`byok:${orgId}:${credentialId}`), and the platform's concurrency is not their problem.
 *
 * The slot itself is a SESSION-level `pg_try_advisory_lock(hashtext('managed-slot'), i)` held on a
 * dedicated pool client — session-level, not `_xact`, because the holder is a model call and not a
 * transaction (CLAUDE.md: a `withOrg` transaction never spans network I/O). `release()` unlocks on
 * the SAME client and only then returns it to the pool: a client handed back still holding a lock
 * would poison every later borrower of that connection.
 */
import type pg from 'pg'

/** One held slot. `release()` is idempotent and never throws — a `finally` must never mask the
 *  model call's own error. */
export interface AdmissionSlot {
  release(): Promise<void>
}

export interface AdmissionPool {
  /** A slot, or `null` when none freed inside the wait (or the signal was already aborted). The
   *  caller PROCEEDS on `null` — see rule 1 in this file's header. */
  acquire(signal: AbortSignal): Promise<AdmissionSlot | null>
}

/** How long a managed call waits for a slot before it proceeds uncontrolled. */
export const ADMISSION_WAIT_MS = 60_000
/** How often the wait re-tries every slot. */
export const ADMISSION_POLL_MS = 500

/** The advisory lock's first key — one namespace shared by every replica of this deployment. */
const SLOT_NAMESPACE = 'managed-slot'

/** `MANAGED_DRAFT_SLOTS=0`: no admission control at all. Every `acquire` succeeds immediately with a
 *  release that does nothing, so no call site needs a null check for "the pool is switched off". */
export const noAdmission: AdmissionPool = {
  acquire: async () => ({ release: async () => {} }),
}

/** Resolves after `ms`, or as soon as `signal` aborts — whichever comes first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function createAdmissionPool(
  pool: pg.Pool,
  slots: number,
  opts: { waitMs?: number; pollMs?: number } = {},
): AdmissionPool {
  if (slots <= 0) return noAdmission
  const waitMs = opts.waitMs ?? ADMISSION_WAIT_MS
  const pollMs = opts.pollMs ?? ADMISSION_POLL_MS

  return {
    async acquire(signal: AbortSignal): Promise<AdmissionSlot | null> {
      if (signal.aborted) return null
      let client: pg.PoolClient | undefined
      try {
        client = await pool.connect()
        const held = client
        const deadline = Date.now() + waitMs
        for (;;) {
          for (let i = 0; i < slots; i++) {
            const { rows } = await held.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_lock(hashtext($1), $2) AS locked', [SLOT_NAMESPACE, i],
            )
            if (rows[0]?.locked === true) {
              let released = false
              return {
                release: async () => {
                  if (released) return
                  released = true
                  try {
                    await held.query('SELECT pg_advisory_unlock(hashtext($1), $2)', [SLOT_NAMESPACE, i])
                  } catch {
                    // The unlock failed, so this connection still holds the slot: destroy it rather
                    // than hand a poisoned session back. A new one is cheaper than a stuck slot.
                    held.release(true)
                    return
                  }
                  held.release()
                },
              }
            }
          }
          if (signal.aborted || Date.now() >= deadline) break
          await sleep(pollMs, signal)
        }
        held.release()
        return null
      } catch {
        // Rule 2: never throw — including out of this handler. A client we did check out is
        // DESTROYED rather than reused (we do not know which locks it may still hold), and even
        // that is guarded: a double release throws in `pg`, and a throw here would be a throw out
        // of `acquire`.
        try { client?.release(true) } catch { /* already returned to the pool */ }
        return null
      }
    },
  }
}
