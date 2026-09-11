import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { palettes } from '@/theme'
import type { SourceRow } from './source-list'
import { SourceList } from './source-list'

const L = palettes.light

const mockRefreshCrawlCalls: unknown[] = []
const mockDeleteSourceCalls: unknown[] = []
let mockRefreshCrawlImpl: (input: unknown) => Promise<unknown> = (input) => { mockRefreshCrawlCalls.push(input); return Promise.resolve({ ok: true }) }
let mockDeleteSourceImpl: (input: unknown) => Promise<unknown> = (input) => { mockDeleteSourceCalls.push(input); return Promise.resolve({ ok: true }) }

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    knowledge: {
      refreshCrawl: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockRefreshCrawlImpl(v), ...o }) },
      deleteSource: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockDeleteSourceImpl(v), ...o }) },
    },
  }),
}))

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 's1', kind: 'upload', status: 'ready', title: 'policies.pdf', url: null,
    documentCount: 1, chunkCount: 12, failureReason: null, failureDetail: null, crawlProgress: null,
    ...overrides,
  }
}

/** A promise this test resolves by hand — same idiom `use-gate.test.tsx` uses to pin down exactly
 * when an in-flight mutation settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup(sources: SourceRow[], onChanged: () => void = () => {}, canManage = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<SourceList sources={sources} onChanged={onChanged} canManage={canManage} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockRefreshCrawlCalls.length = 0
  mockDeleteSourceCalls.length = 0
  mockRefreshCrawlImpl = (input) => { mockRefreshCrawlCalls.push(input); return Promise.resolve({ ok: true }) }
  mockDeleteSourceImpl = (input) => { mockDeleteSourceCalls.push(input); return Promise.resolve({ ok: true }) }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('renders a status chip per source: queued/processing primary, ready success, failed danger with the failure reason', async () => {
  const sources = [
    source({ id: 'q1', status: 'queued' }),
    source({ id: 'p1', status: 'processing' }),
    source({ id: 'r1', status: 'ready' }),
    source({ id: 'f1', status: 'failed', failureReason: 'parse_failed' }),
  ]
  await setup(sources)

  await waitFor(() => expect(screen.getByTestId('source-status-q1')).toBeTruthy())
  const chipProps = (id: string) => screen.getByTestId(`source-status-${id}`).props

  expect(chipProps('q1').accessibilityLabel).toBe('Queued')
  expect(chipProps('p1').accessibilityLabel).toBe('Processing')
  expect(chipProps('r1').accessibilityLabel).toBe('Ready')
  // The failed chip's own text IS the failure reason, in the owner's words — not the bare word "Failed".
  expect(chipProps('f1').accessibilityLabel).toBe('Could not read this file')
})

test('the status chips resolve to the theme tint tokens: queued/processing primary, ready success, failed danger', async () => {
  const sources = [
    source({ id: 'q1', status: 'queued' }),
    source({ id: 'p1', status: 'processing' }),
    source({ id: 'r1', status: 'ready' }),
    source({ id: 'f1', status: 'failed', failureReason: 'parse_failed' }),
  ]
  await setup(sources)
  await waitFor(() => expect(screen.getByTestId('source-status-q1')).toBeTruthy())

  expect(screen.getByTestId('source-status-q1')).toHaveStyle({ backgroundColor: L.primaryTint })
  expect(screen.getByTestId('source-status-p1')).toHaveStyle({ backgroundColor: L.primaryTint })
  expect(screen.getByTestId('source-status-r1')).toHaveStyle({ backgroundColor: L.successTint })
  expect(screen.getByTestId('source-status-f1')).toHaveStyle({ backgroundColor: L.dangerTint })
})

test('a crawl source shows its progress line; an upload does not', async () => {
  const sources = [
    source({ id: 'c1', kind: 'crawl', status: 'processing', url: 'https://acme.example.com', crawlProgress: { fetched: 4, ingested: 3, skipped: 1 } }),
    source({ id: 'u1', kind: 'upload' }),
  ]
  await setup(sources)
  await waitFor(() => expect(screen.getByTestId('crawl-progress-c1')).toBeTruthy())
  expect(screen.queryByTestId('crawl-progress-u1')).toBeNull()
})

test('Refresh appears only on a ready or failed crawl, never on an upload or paste source', async () => {
  const sources = [
    source({ id: 'c1', kind: 'crawl', status: 'ready', url: 'https://acme.example.com' }),
    source({ id: 'c2', kind: 'crawl', status: 'processing', url: 'https://acme.example.com' }),
    source({ id: 'u1', kind: 'upload', status: 'ready' }),
  ]
  await setup(sources)
  await waitFor(() => expect(screen.getByTestId('refresh-c1')).toBeTruthy())
  expect(screen.queryByTestId('refresh-c2')).toBeNull()
  expect(screen.queryByTestId('refresh-u1')).toBeNull()

  await fireEvent.press(screen.getByTestId('refresh-c1'))
  await waitFor(() => expect(mockRefreshCrawlCalls).toEqual([{ sourceId: 'c1' }]))
})

test('Delete needs two taps before it actually deletes, and calls onChanged after', async () => {
  const onChanged = jest.fn()
  await setup([source({ id: 's1' })], onChanged)

  await fireEvent.press(screen.getByTestId('delete-s1'))
  expect(mockDeleteSourceCalls).toHaveLength(0)
  expect(screen.getByText('Confirm delete')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('delete-s1'))
  await waitFor(() => expect(mockDeleteSourceCalls).toEqual([{ sourceId: 's1' }]))
  await waitFor(() => expect(onChanged).toHaveBeenCalled())
})

test('while one row\'s delete is in flight, a DIFFERENT row\'s Delete button does not spin too (per-row pending, not the shared mutation\'s)', async () => {
  const gate = deferred<{ ok: true }>()
  mockDeleteSourceImpl = (input) => { mockDeleteSourceCalls.push(input); return gate.promise }
  await setup([source({ id: 'a' }), source({ id: 'b' })])

  await fireEvent.press(screen.getByTestId('delete-a')) // arm
  await fireEvent.press(screen.getByTestId('delete-a')) // confirm — mutate({ sourceId: 'a' }), still in flight
  await waitFor(() => expect(mockDeleteSourceCalls).toEqual([{ sourceId: 'a' }]))

  expect(screen.getByTestId('delete-a').props.accessibilityState.busy).toBe(true)
  // Row b was never touched: same shared `deleteSource` mutation, but its OWN button reads its own
  // (untouched) `confirmingDeleteId`/pending state, not row a's.
  expect(screen.getByText('Delete')).toBeTruthy()
  expect(screen.getByTestId('delete-b').props.accessibilityState.busy).toBe(false)

  gate.resolve({ ok: true })
  await waitFor(() => expect(screen.getByTestId('delete-a').props.accessibilityState.busy).toBe(false))
})

test('canManage: false hides Refresh and Delete for every row (read-only for a plain member)', async () => {
  const sources = [source({ id: 'c1', kind: 'crawl', status: 'ready', url: 'https://acme.example.com' })]
  await setup(sources, () => {}, false)
  await waitFor(() => expect(screen.getByTestId('source-c1')).toBeTruthy())
  expect(screen.queryByTestId('refresh-c1')).toBeNull()
  expect(screen.queryByTestId('delete-c1')).toBeNull()
})
