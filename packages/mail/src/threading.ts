/**
 * `References` per spec §4.3: the thread's rfc ids oldest -> newest with the In-Reply-To target
 * guaranteed last. The explicit re-anchoring matters because the newest message on the thread is
 * not necessarily the latest INBOUND one (the owner may have hand-replied after it), and RFC 5322
 * threading expects the parent to be the final id.
 *
 * Trimming follows RFC 5322 §3.6.4 rather than a plain tail slice: when the list is longer than
 * `REFERENCES_CAP`, keep the FIRST id — the thread root, which is what mail clients group the
 * conversation by — plus the newest `REFERENCES_CAP - 1`. A tail-only trim drops the root and can
 * split a long thread into a second conversation in the customer's client.
 */
export const REFERENCES_CAP = 20

export function buildReferences(priorRfcIds: (string | null)[], inReplyTo: string): string[] {
  const ordered: string[] = []
  const seen = new Set<string>([inReplyTo])
  for (const id of priorRfcIds) {
    if (id === null || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  ordered.push(inReplyTo)

  if (ordered.length <= REFERENCES_CAP) return ordered
  return [ordered[0]!, ...ordered.slice(-(REFERENCES_CAP - 1))]
}

/**
 * Tokenizes a `References` (or `In-Reply-To`) header into its `<id>` tokens, keeping only the
 * newest `REFERENCES_CAP` — a hostile 10KB header must never turn into an unbounded token list
 * (e.g. an `IN (...)` lookup) downstream.
 */
export function tokenizeReferences(header: string | null): string[] {
  return [...(header ?? '').matchAll(/<[^<>\s]+>/g)].map((m) => m[0]).slice(-REFERENCES_CAP)
}
