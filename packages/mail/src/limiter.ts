/**
 * Provider request limiter — pure, no DB, no network. Bounds concurrency at two levels: at most
 * `perConnectionConcurrent` in-flight calls for a single mailbox connection (so a burst of jobs for
 * one mailbox doesn't hammer the provider account), and at most `processConcurrent` in-flight calls
 * across every connection in this worker process (spec: one shared GCP OAuth project/quota for all
 * tenants). Each acquire() waits on both gates before resolving; release() (returned to the caller)
 * frees both. FIFO within each gate — a connection's own waiters resolve in arrival order, and so do
 * the process-wide gate's — which is enough fairness for a job queue that itself has no priority.
 */
export interface MailLimiter {
  acquire(connectionId: string): Promise<() => void>
}

export interface MailLimiterOptions {
  /** Concurrent in-flight calls allowed for one connection. Default 1 — the spec's real per-connection mutex. */
  perConnectionConcurrent?: number
  /** Concurrent in-flight calls allowed across the whole process. Default 8. */
  processConcurrent?: number
}

const DEFAULT_PER_CONNECTION_CONCURRENT = 1
const DEFAULT_PROCESS_CONCURRENT = 8

/** A minimal counting semaphore: `max` concurrent holders, FIFO queue for the rest. */
class Semaphore {
  private available: number
  private readonly waiters: (() => void)[] = []

  constructor(private readonly max: number) {
    this.available = max
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /** Hands the freed slot straight to the oldest waiter (FIFO) if one exists; otherwise returns it to the pool. */
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.available += 1
  }

  /** True only when nobody holds a slot and nobody is waiting — safe to drop this semaphore entirely. */
  get isFullyFree(): boolean {
    return this.waiters.length === 0 && this.available === this.max
  }
}

export function createMailLimiter(opts: MailLimiterOptions = {}): MailLimiter {
  const perConnectionConcurrent = opts.perConnectionConcurrent ?? DEFAULT_PER_CONNECTION_CONCURRENT
  const processConcurrent = opts.processConcurrent ?? DEFAULT_PROCESS_CONCURRENT

  const processGate = new Semaphore(processConcurrent)
  // Lazily created per connection id, and dropped again once fully idle — a long-running worker
  // process must not accumulate one entry per connection it has EVER touched.
  const connectionGates = new Map<string, Semaphore>()

  function gateFor(connectionId: string): Semaphore {
    const existing = connectionGates.get(connectionId)
    if (existing) return existing
    const created = new Semaphore(perConnectionConcurrent)
    connectionGates.set(connectionId, created)
    return created
  }

  return {
    async acquire(connectionId: string): Promise<() => void> {
      const connectionGate = gateFor(connectionId)
      await connectionGate.acquire()
      await processGate.acquire()

      let released = false
      return () => {
        if (released) return
        released = true
        processGate.release()
        connectionGate.release()
        if (connectionGate.isFullyFree) connectionGates.delete(connectionId)
      }
    },
  }
}
