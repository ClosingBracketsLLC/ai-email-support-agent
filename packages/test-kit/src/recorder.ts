/**
 * Scrubbed fixture recorder primitives, ported from doge-buddy
 * `packages/gmail/scripts/record-fixtures.ts` (452 LOC). See that file's header comment for the
 * full recording-sequence rationale this ports the SHARED, provider-agnostic pieces from:
 *
 *   - `assertScrubbed` — serializes each fixture and rejects any whose serialized JSON contains an
 *     Authorization: Bearer header or PEM private-key material, throwing ONE error that names
 *     EVERY offending file (not just the first).
 *   - `createRecordingFetch` — wraps the real `fetch` as a `MailboxClient`'s `fetchFn` seam,
 *     capturing each request/response pair into `captured`, keyed by whatever fixture name
 *     `target.current` names at call time. The captured shape (`FixtureFile.fixture.request`)
 *     carries only `{ method, path, query }` — deliberately NO headers field — so the
 *     Authorization bearer token is excluded from every fixture STRUCTURALLY, by construction,
 *     not by best-effort redaction. `assertScrubbed` is still meant to run on every batch right
 *     before writing, as defense-in-depth on top of that structural exclusion.
 *
 * What this module does NOT do: drive an actual live recording session. Unlike doge-buddy's
 * single-provider `packages/gmail`, this port serves both Gmail and Graph, and a mailbox has no
 * generic "record everything" mode — the concrete sequence (which endpoints, in what order,
 * against which provider and tenant) is wired later by hand per the runbook (Task 23), reusing the
 * two primitives above. This module only owns those primitives plus the run-gate pattern below
 * (ported near-verbatim): the live sequence never runs on import, and gating on an explicit env
 * var makes an accidental `tsx` invocation of this file safe in every environment, credentialed or
 * not.
 */
import { pathToFileURL } from 'node:url'

export interface FixtureFile {
  name: string
  fixture: {
    request: { method: string; path: string; query?: Record<string, string | string[]> }
    response: { status: number; body: unknown }
  }
}

/** No fixture file may ever contain either substring — an Authorization: Bearer header value, or
 * PEM private-key material — wherever it appears once the fixture is serialized. */
export const FORBIDDEN_SUBSTRINGS = ['Bearer ', 'PRIVATE KEY'] as const

/**
 * Throws (listing every offending file name, not just the first) if any fixture's serialized JSON
 * contains an Authorization: Bearer header anywhere in its structure, or either forbidden bare
 * substring wherever it appears. Serializing first (rather than walking keys) catches both a
 * nested `{ "Authorization": "Bearer x" }` and a leaked string value with one check. Clean
 * fixtures pass through untouched.
 */
export function assertScrubbed(files: FixtureFile[]): void {
  const offenders = files
    .filter(({ fixture }) => {
      const serialized = JSON.stringify(fixture)
      return FORBIDDEN_SUBSTRINGS.some((needle) => serialized.includes(needle))
    })
    .map(({ name }) => name)

  if (offenders.length > 0) {
    throw new Error(`assertScrubbed: fixture(s) contain auth material and must NOT be written: ${offenders.join(', ')}`)
  }
}

/** Mirrors `packages/mail`'s adapter-test fixture `query` shape: repeated params become an array,
 * singletons a plain string; no params at all is `undefined` (matches a fixture with no `query`
 * key at all, rather than an empty object). */
function buildQuery(searchParams: URLSearchParams): Record<string, string | string[]> | undefined {
  const keys = [...new Set(searchParams.keys())]
  if (keys.length === 0) return undefined
  const query: Record<string, string | string[]> = {}
  for (const key of keys) {
    const values = searchParams.getAll(key)
    query[key] = values.length > 1 ? values : (values[0] as string)
  }
  return query
}

async function captureBody(res: Response): Promise<unknown> {
  // Clone before reading — the original Response body stream still has to reach the real caller's
  // own res.text()/JSON.parse() unconsumed.
  const text = await res.clone().text()
  return text.length > 0 ? JSON.parse(text) : null
}

/**
 * Wraps the real global `fetch` as a `MailboxClient`'s `fetchFn` seam, capturing each request/
 * response pair keyed by whatever fixture name `target.current` names at call time. `target` is a
 * mutable box the recording sequence flips between client calls, so unrelated calls never collide
 * and a retried call (e.g. a transient 401) simply overwrites with its own final response. A call
 * made while `target.current` is `null` (the token-exchange path, or any call the recording
 * sequence deliberately doesn't want captured) passes through uncaptured.
 */
export function createRecordingFetch(target: { current: string | null }, captured: Map<string, FixtureFile>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const res = await fetch(url, init)
    if (target.current) {
      const u = new URL(String(url))
      const name = target.current
      const query = buildQuery(u.searchParams)
      captured.set(name, {
        name,
        fixture: {
          // `query` is omitted entirely (not just `undefined`) when the request carried none, so
          // a no-query fixture's `request` object has exactly the same two keys a hand-authored
          // one would — no `headers` key ever exists here either, which is the whole point: the
          // Authorization bearer token is excluded from every captured fixture STRUCTURALLY.
          request: { method: (init?.method ?? 'GET').toUpperCase(), path: u.pathname, ...(query ? { query } : {}) },
          response: { status: res.status, body: await captureBody(res) },
        },
      })
    }
    return res
  }) as unknown as typeof fetch
}

/**
 * Only true when this file is the actual process entry point (e.g. `tsx src/recorder.ts`), never
 * on import — ported from doge-buddy verbatim so a test file can import `assertScrubbed`/
 * `createRecordingFetch` without ever triggering a live run.
 */
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  if (process.env.MAIL_RECORD !== '1') {
    console.log(
      [
        'recorder: MAIL_RECORD is unset (or not "1") — nothing was recorded.',
        '',
        'This module only provides the shared scrub/capture primitives (assertScrubbed,',
        'createRecordingFetch). The live recording sequence against a real Gmail or Graph tenant',
        'is wired per-provider by hand, per the runbook (Task 23).',
      ].join('\n'),
    )
    process.exit(0)
  }

  console.error('recorder: MAIL_RECORD=1 but no live recording sequence is wired in this module yet — see Task 23 (runbook).')
  process.exit(1)
}
