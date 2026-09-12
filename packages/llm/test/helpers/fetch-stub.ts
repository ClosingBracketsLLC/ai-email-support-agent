import { vi } from 'vitest'

/** A JSON `Response` for an SDK's `fetch` option — status and headers are what the adapters'
 * error mapping keys off, so both are settable. */
export function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
}

/**
 * A `fetch` stub that records every request body it is handed and answers with `handler`'s
 * response. Every adapter test drives the adapter through THIS — never a mock of the adapter
 * itself — so what is asserted is the wire request the SDK actually built. A GET (the models list)
 * carries no body, and only a request that had one is recorded in `bodies`.
 */
export function capturingFetch(handler: (body: Record<string, unknown>) => Response): {
  fetchFn: typeof fetch
  bodies: Record<string, unknown>[]
} {
  const bodies: Record<string, unknown>[] = []
  const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const raw = init?.body
    const body = raw === undefined || raw === null ? {} : (JSON.parse(String(raw)) as Record<string, unknown>)
    if (raw !== undefined && raw !== null) bodies.push(body)
    return handler(body)
  }) as unknown as typeof fetch
  return { fetchFn, bodies }
}
