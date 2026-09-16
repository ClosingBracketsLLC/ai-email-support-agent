import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { useState, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { ShareScreen, shareFileOf } from './share'

// See knowledge.test.tsx: TanStack's default scheduler defers notifications through a real
// setTimeout(0), outside RNTL's act() window. Running it synchronously keeps every update inside
// the triggering act().
notifyManager.setScheduler((callback) => callback())

// Every variable a jest.mock() factory closes over must be prefixed `mock` — babel-plugin-jest-hoist
// hoists jest.mock() above these declarations (see knowledge/source-cards.test.tsx).
const mockReplace = jest.fn()
const mockRedirectHref = jest.fn()
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  Redirect: ({ href }: { href: unknown }) => { mockRedirectHref(href); return null },
}))

type GateState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; retry: () => void }
  | { kind: 'sign-in' }
  | { kind: 'app' }
let mockGateState: GateState = { kind: 'app' }
const mockUseGate = jest.fn(() => mockGateState)
jest.mock('@/lib/use-gate', () => ({ useGate: () => mockUseGate() }))

interface MockShareIntent { webUrl?: string | null; text?: string | null; files?: { fileName: string; mimeType: string; path: string; size: number | null }[] | null }
let mockShareIntent: MockShareIntent | null = null
const mockResetShareIntent = jest.fn()
const mockUseShareIntentSafe = jest.fn(() => ({ hasShareIntent: mockShareIntent !== null, shareIntent: mockShareIntent, resetShareIntent: mockResetShareIntent }))
jest.mock('@/lib/share-intent', () => ({ useShareIntentSafe: () => mockUseShareIntentSafe() }))

// A REAL (if tiny) `useState`-backed hook, not a fixed `{ start, pending: [] }` object — `FileCard`
// (finding 2's fix) reads the entry `start()` produces off `pending` itself, on a LATER render, not
// off `start()`'s own return value, so the mock has to actually re-render its caller when `pending`
// changes for that fix to be exercised at all rather than trivially vacuous.
interface MockPendingItem { id: string; name: string; progress: 'signing' | 'uploading' | 'queued' | 'failed'; reason: string | null }
type MockUploadResult = { progress: 'queued' } | { progress: 'failed'; reason: string }
let mockUploadResult: MockUploadResult = { progress: 'queued' }
const mockUploadStartCalls: unknown[] = []
function useMockUpload() {
  const [pending, setPending] = useState<MockPendingItem[]>([])
  return {
    pending,
    start: (files: { name: string }[]) => {
      mockUploadStartCalls.push(files)
      const name = files[0]!.name
      if (mockUploadResult.progress === 'queued') {
        setPending([{ id: 'mock-1', name, progress: 'queued', reason: null }])
        return Promise.resolve({ stoppedBy: null })
      }
      setPending([{ id: 'mock-1', name, progress: 'failed', reason: mockUploadResult.reason }])
      return Promise.resolve({ stoppedBy: mockUploadResult.reason === 'cap' ? ('cap' as const) : null })
    },
  }
}
const mockUseUpload = jest.fn(() => useMockUpload())
jest.mock('@/screens/knowledge/use-upload', () => ({ useUpload: () => mockUseUpload() }))

const DEFAULT_CAPS = { maxSources: 100, maxCrawlPages: 200 }
let mockListData: { caps: typeof DEFAULT_CAPS; canManage: boolean } = { caps: DEFAULT_CAPS, canManage: true }
let mockListImpl: () => Promise<typeof mockListData> = () => Promise.resolve(mockListData)
const mockStartCrawlCalls: unknown[] = []
let mockStartCrawlImpl: (input: unknown) => Promise<unknown> = (input) => { mockStartCrawlCalls.push(input); return Promise.resolve({ sourceId: 'c1' }) }
const mockPasteCalls: unknown[] = []
let mockPasteImpl: (input: unknown) => Promise<unknown> = (input) => { mockPasteCalls.push(input); return Promise.resolve({ sourceId: 'p1' }) }

const mockUseTRPC = jest.fn(() => ({
  knowledge: {
    list: {
      queryOptions: () => ({ queryKey: ['knowledge', 'list'], queryFn: () => mockListImpl() }),
      queryKey: () => ['knowledge', 'list'],
    },
    startCrawl: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockStartCrawlImpl(v), ...o }) },
    paste: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockPasteImpl(v), ...o }) },
  },
}))
jest.mock('@/lib/trpc', () => ({ useTRPC: () => mockUseTRPC() }))

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<ShareScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockGateState = { kind: 'app' }
  mockShareIntent = null
  mockReplace.mockClear()
  mockRedirectHref.mockClear()
  mockUseGate.mockClear()
  mockUseShareIntentSafe.mockClear()
  mockUseUpload.mockClear()
  mockUseTRPC.mockClear()
  mockResetShareIntent.mockClear()
  mockUploadStartCalls.length = 0
  mockUploadResult = { progress: 'queued' }
  mockListData = { caps: DEFAULT_CAPS, canManage: true }
  mockListImpl = () => Promise.resolve(mockListData)
  mockStartCrawlCalls.length = 0
  mockStartCrawlImpl = (input) => { mockStartCrawlCalls.push(input); return Promise.resolve({ sourceId: 'c1' }) }
  mockPasteCalls.length = 0
  mockPasteImpl = (input) => { mockPasteCalls.push(input); return Promise.resolve({ sourceId: 'p1' }) }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

describe('the gate — the route sits outside (app) and must run useGate itself', () => {
  test('loading shows the loading state, before any card', async () => {
    mockGateState = { kind: 'loading' }
    await setup()
    expect(screen.getByTestId('loading')).toBeTruthy()
  })
  test('a hard gate failure shows GateError', async () => {
    mockGateState = { kind: 'error', message: 'Could not load your session.', retry: jest.fn() }
    await setup()
    expect(screen.getByTestId('gate-error')).toBeTruthy()
  })
  test('signed out redirects to sign-in rather than rendering any card', async () => {
    mockGateState = { kind: 'sign-in' }
    await setup()
    expect(mockRedirectHref).toHaveBeenCalledWith('/sign-in')
    expect(screen.queryByTestId('link-card')).toBeNull()
  })
})

test('Platform.OS === "web" renders the one-line banner and touches no hook', async () => {
  const os = jest.replaceProperty(Platform, 'OS', 'web')
  try {
    await setup()
    expect(screen.getByTestId('share-web-banner')).toBeTruthy()
    expect(screen.getByText('Sharing into aesa works from the iOS and Android apps.')).toBeTruthy()
    expect(mockUseGate).not.toHaveBeenCalled()
    expect(mockUseShareIntentSafe).not.toHaveBeenCalled()
    expect(mockUseTRPC).not.toHaveBeenCalled()
    expect(mockUseUpload).not.toHaveBeenCalled()
  } finally {
    os.restore()
  }
})

test('a plain member (canManage: false) sees a read-only message, never a card', async () => {
  mockListData = { caps: DEFAULT_CAPS, canManage: false }
  mockShareIntent = { webUrl: 'https://example.com' }
  await setup()
  await waitFor(() => expect(screen.getByTestId('share-readonly')).toBeTruthy())
  expect(screen.queryByTestId('link-card')).toBeNull()
})

test('"Not now" resets the intent and goes to /inbox, without touching any mutation', async () => {
  mockShareIntent = { webUrl: 'https://example.com' }
  await setup()
  await waitFor(() => expect(screen.getByTestId('link-card')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('share-not-now'))
  expect(mockResetShareIntent).toHaveBeenCalledTimes(1)
  expect(mockReplace).toHaveBeenCalledWith('/inbox')
  expect(mockStartCrawlCalls).toHaveLength(0)
})

describe('a URL intent', () => {
  test('renders the Link card, prefilled, and starts the crawl with the default page cap', async () => {
    mockShareIntent = { webUrl: 'https://example.com' }
    await setup()
    await waitFor(() => expect(screen.getByTestId('link-card')).toBeTruthy())
    expect(screen.getByTestId('share-crawl-url').props.value).toBe('https://example.com')
    expect(screen.getByTestId('share-page-cap-50').props.accessibilityState.checked).toBe(true)

    await fireEvent.press(screen.getByTestId('share-start-crawl'))
    await waitFor(() => expect(mockStartCrawlCalls).toEqual([{ url: 'https://example.com', maxPages: 50 }]))
    await waitFor(() => expect(mockResetShareIntent).toHaveBeenCalledTimes(1))
    expect(mockReplace).toHaveBeenCalledWith('/settings/knowledge')
  })

  test('a FORBIDDEN from startCrawl (the source cap) shows the shared cap banner, and never navigates away', async () => {
    mockStartCrawlImpl = () => Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (100)' })
    mockShareIntent = { webUrl: 'https://example.com' }
    mockListData = { caps: { maxSources: 3, maxCrawlPages: 200 }, canManage: true }
    await setup()
    await waitFor(() => expect(screen.getByTestId('link-card')).toBeTruthy())
    await fireEvent.press(screen.getByTestId('share-start-crawl'))
    await waitFor(() => expect(screen.getByTestId('knowledge-cap-error')).toBeTruthy())
    expect(screen.getByText('Your plan allows 3 sources. Delete one to add another.')).toBeTruthy()
    expect(mockResetShareIntent).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

describe('a text intent', () => {
  test('needs a title — Add as a note stays disabled until one is typed — then pastes the shared text verbatim', async () => {
    mockShareIntent = { text: 'Refunds take 5-7 business days.' }
    await setup()
    await waitFor(() => expect(screen.getByTestId('text-card')).toBeTruthy())
    expect(screen.getByText('Refunds take 5-7 business days.')).toBeTruthy()

    const button = screen.getByTestId('share-add-paste')
    expect(button.props.accessibilityState?.disabled ?? button.props.disabled).toBe(true)

    await fireEvent.changeText(screen.getByTestId('share-paste-title'), '  Refund policy  ')
    await fireEvent.press(screen.getByTestId('share-add-paste'))
    await waitFor(() => expect(mockPasteCalls).toEqual([{ title: 'Refund policy', text: 'Refunds take 5-7 business days.' }]))
    await waitFor(() => expect(mockResetShareIntent).toHaveBeenCalledTimes(1))
    expect(mockReplace).toHaveBeenCalledWith('/settings/knowledge')
  })

  test('a FORBIDDEN from paste (the source cap) shows the same shared cap banner', async () => {
    mockPasteImpl = () => Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (100)' })
    mockShareIntent = { text: 'Some shared text' }
    mockListData = { caps: { maxSources: 5, maxCrawlPages: 200 }, canManage: true }
    await setup()
    await waitFor(() => expect(screen.getByTestId('text-card')).toBeTruthy())
    await fireEvent.changeText(screen.getByTestId('share-paste-title'), 'Note')
    await fireEvent.press(screen.getByTestId('share-add-paste'))
    await waitFor(() => expect(screen.getByTestId('knowledge-cap-error')).toBeTruthy())
    expect(screen.getByText('Your plan allows 5 sources. Delete one to add another.')).toBeTruthy()
    expect(mockResetShareIntent).not.toHaveBeenCalled()
  })
})

describe('a file intent', () => {
  test('renders the File card and calls the mocked useUpload().start with the PickedFile shape', async () => {
    mockShareIntent = { files: [{ fileName: 'return-policy.pdf', mimeType: 'application/pdf', path: 'file:///tmp/return-policy.pdf', size: 2048 }] }
    await setup()
    await waitFor(() => expect(screen.getByTestId('file-card')).toBeTruthy())
    expect(screen.getByText('return-policy.pdf')).toBeTruthy()

    await fireEvent.press(screen.getByTestId('share-upload'))
    await waitFor(() => expect(mockUploadStartCalls).toEqual([
      [{ name: 'return-policy.pdf', mime: 'application/pdf', size: 2048, uri: 'file:///tmp/return-policy.pdf' }],
    ]))
    await waitFor(() => expect(mockResetShareIntent).toHaveBeenCalledTimes(1))
    expect(mockReplace).toHaveBeenCalledWith('/settings/knowledge')
  })

  // Fix wave: the library's types say string, the library can hand over null — and a null name used
  // to throw inside `useUpload`'s synchronous `setPending`, so Upload silently did nothing.
  test('a file with a NULL fileName and mimeType is coerced at the seam (shared-file, empty mime) and still uploads', async () => {
    mockShareIntent = { files: [{ fileName: null, mimeType: null, path: 'file:///tmp/unnamed', size: null } as unknown as { fileName: string; mimeType: string; path: string; size: number | null }] }
    await setup()
    await waitFor(() => expect(screen.getByTestId('file-card')).toBeTruthy())
    expect(screen.getByText('shared-file')).toBeTruthy()

    await fireEvent.press(screen.getByTestId('share-upload'))
    await waitFor(() => expect(mockUploadStartCalls).toEqual([
      [{ name: 'shared-file', mime: '', size: null, uri: 'file:///tmp/unnamed' }],
    ]))
    expect(shareFileOf({ fileName: undefined, mimeType: undefined, path: 'p' })).toEqual({ fileName: 'shared-file', mimeType: '', path: 'p', size: null })
    expect(shareFileOf({ fileName: 'a.pdf', mimeType: 'application/pdf', path: 'p', size: 3 })).toEqual({ fileName: 'a.pdf', mimeType: 'application/pdf', path: 'p', size: 3 })
  })

  test('a cap refusal (the pending entry lands failed/cap) shows the shared cap banner and never navigates away', async () => {
    mockUploadResult = { progress: 'failed', reason: 'cap' }
    mockShareIntent = { files: [{ fileName: 'faq.pdf', mimeType: 'application/pdf', path: 'file:///tmp/faq.pdf', size: 1024 }] }
    mockListData = { caps: { maxSources: 2, maxCrawlPages: 200 }, canManage: true }
    await setup()
    await waitFor(() => expect(screen.getByTestId('file-card')).toBeTruthy())
    await fireEvent.press(screen.getByTestId('share-upload'))
    await waitFor(() => expect(screen.getByTestId('knowledge-cap-error')).toBeTruthy())
    expect(screen.getByText('Your plan allows 2 sources. Delete one to add another.')).toBeTruthy()
    expect(mockResetShareIntent).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  // Finding 2 (fix round 1): `start()` resolves `{ stoppedBy: 'cap' | null }` only — a per-file
  // refusal for any OTHER reason (wrong type, too large, an unreadable size, the PUT itself failing)
  // used to read as `stoppedBy: null`, which the old FileCard treated as success: it reset the
  // intent and navigated away, silently discarding the file. This pins the fix: a `wrong_type`
  // entry shows its OWN reason (never the cap banner) and the intent is left untouched.
  test('a non-cap failure (wrong_type) shows its own reason — never the cap banner — and does not reset or navigate', async () => {
    mockUploadResult = { progress: 'failed', reason: 'wrong_type' }
    mockShareIntent = { files: [{ fileName: 'archive.zip', mimeType: 'application/zip', path: 'file:///tmp/archive.zip', size: 4096 }] }
    await setup()
    await waitFor(() => expect(screen.getByTestId('file-card')).toBeTruthy())
    await fireEvent.press(screen.getByTestId('share-upload'))
    await waitFor(() => expect(screen.getByTestId('share-upload-error')).toBeTruthy())
    expect(screen.getByText('Not a supported file type')).toBeTruthy()
    expect(screen.queryByTestId('knowledge-cap-error')).toBeNull()
    expect(mockResetShareIntent).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
