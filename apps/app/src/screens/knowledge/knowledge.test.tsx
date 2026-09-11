import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { KnowledgeScreen } from './knowledge'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

interface Source {
  id: string; kind: 'upload' | 'paste' | 'crawl'; status: 'queued' | 'processing' | 'ready' | 'failed'
  title: string; url: string | null; documentCount: number; chunkCount: number
  failureReason: string | null; failureDetail: string | null; crawlProgress: unknown
}
interface ListData {
  knowledgeVersion: number
  counts: { sources: number; readyChunks: number; flaggedChunks: number }
  sources: Source[]
  caps: { maxSources: number; maxCrawlPages: number }
  canManage: boolean
}

const DEFAULT_CAPS = { maxSources: 100, maxCrawlPages: 200 }

function defaultListData(): ListData {
  return { knowledgeVersion: 0, counts: { sources: 0, readyChunks: 0, flaggedChunks: 0 }, sources: [], caps: DEFAULT_CAPS, canManage: true }
}

let mockWorkspace = { websiteUrl: 'https://acme.example.com', operatingGuidance: '' }
let mockWorkspaceImpl: () => Promise<typeof mockWorkspace> = () => Promise.resolve(mockWorkspace)
let mockListData: ListData = defaultListData()
let mockListImpl: () => Promise<ListData> = () => Promise.resolve(mockListData)
let mockListQueryCalls = 0
const mockAdvanceCalls: unknown[] = []
let mockAdvanceImpl: () => Promise<unknown> = () => Promise.resolve({ from: 'knowledge', to: 'go_live' })

const mockReplace = jest.fn()
const mockPush = jest.fn()

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: mockPush }) }))
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })) }))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: {
        queryOptions: () => ({ queryKey: ['workspace', 'get'], queryFn: () => mockWorkspaceImpl() }),
        queryKey: () => ['workspace', 'get'],
      },
      updateGuidance: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve(mockWorkspace), ...o }) },
      advanceOnboarding: { mutationOptions: (o: object) => ({ mutationFn: () => { mockAdvanceCalls.push(true); return mockAdvanceImpl() }, ...o }) },
    },
    knowledge: {
      list: {
        queryOptions: (_input: undefined, opts: object) => ({
          queryKey: ['knowledge', 'list'],
          queryFn: () => { mockListQueryCalls += 1; return mockListImpl() },
          ...opts,
        }),
        queryKey: () => ['knowledge', 'list'],
      },
      startCrawl: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ sourceId: 'c1' }), ...o }) },
      paste: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ sourceId: 'p1' }), ...o }) },
      startUpload: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.reject(new Error('not exercised')), ...o }) },
      completeUpload: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.reject(new Error('not exercised')), ...o }) },
      deleteSource: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ ok: true }), ...o }) },
      refreshCrawl: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ ok: true }), ...o }) },
      flaggedChunks: { queryOptions: () => ({ queryKey: ['knowledge', 'flaggedChunks'], queryFn: () => Promise.resolve({ chunks: [] }) }) },
      unflagChunk: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ ok: true }), ...o }) },
      deleteChunk: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ ok: true }), ...o }) },
      gaps: { queryOptions: () => ({ queryKey: ['knowledge', 'gaps'], queryFn: () => Promise.resolve({ windowDays: 30, drafts: 0, uncited: 0, questions: [] }) }) },
    },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []
async function setup(mode: 'settings' | 'onboarding' = 'settings', pollMs?: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<KnowledgeScreen mode={mode} pollMs={pollMs} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

function sourceRow(overrides: Partial<Source> = {}): Source {
  return { id: 's1', kind: 'crawl', status: 'processing', title: 'https://acme.example.com', url: 'https://acme.example.com', documentCount: 0, chunkCount: 0, failureReason: null, failureDetail: null, crawlProgress: null, ...overrides }
}

/** A promise this test resolves by hand — same idiom `use-gate.test.tsx` uses. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  mockWorkspace = { websiteUrl: 'https://acme.example.com', operatingGuidance: '' }
  mockWorkspaceImpl = () => Promise.resolve(mockWorkspace)
  mockListData = defaultListData()
  mockListImpl = () => Promise.resolve(mockListData)
  mockListQueryCalls = 0
  mockAdvanceCalls.length = 0
  mockAdvanceImpl = () => Promise.resolve({ from: 'knowledge', to: 'go_live' })
  mockReplace.mockClear()
  mockPush.mockClear()
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('shows the live "Ready: N of M sources · P chunks" counter', async () => {
  mockListData = { knowledgeVersion: 1, counts: { sources: 3, readyChunks: 212, flaggedChunks: 0 }, sources: [], caps: DEFAULT_CAPS, canManage: true }
  await setup()
  await waitFor(() => expect(screen.getByTestId('knowledge-counter')).toBeTruthy())
  expect(screen.getByText('Ready: 3 of 100 sources · 212 chunks')).toBeTruthy()
})

test('polls knowledge.list while a source is queued or processing, and stops once it turns ready', async () => {
  let call = 0
  mockListImpl = () => {
    call += 1
    const status = call < 3 ? 'processing' : 'ready'
    mockListData = { knowledgeVersion: 1, counts: { sources: 1, readyChunks: 0, flaggedChunks: 0 }, sources: [sourceRow({ status })], caps: DEFAULT_CAPS, canManage: true }
    return Promise.resolve(mockListData)
  }
  await setup('settings', 5)

  await waitFor(() => expect(mockListQueryCalls).toBeGreaterThanOrEqual(3), { timeout: 2000 })
  const callsOnceReady = mockListQueryCalls
  // The interval stopped: waiting well past several poll periods doesn't add more calls.
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(mockListQueryCalls).toBeLessThanOrEqual(callsOnceReady + 1)
})

test('onboarding: Continue is disabled with zero sources', async () => {
  await setup('onboarding')
  await waitFor(() => expect(screen.getByTestId('continue')).toBeTruthy())
  expect(screen.getByTestId('continue').props.accessibilityState.disabled).toBe(true)
})

test('onboarding: Continue is enabled once at least one source exists and none is processing', async () => {
  mockListData = { knowledgeVersion: 1, counts: { sources: 1, readyChunks: 5, flaggedChunks: 0 }, sources: [sourceRow({ status: 'ready' })], caps: DEFAULT_CAPS, canManage: true }
  await setup('onboarding')
  await waitFor(() => expect(screen.getByTestId('continue').props.accessibilityState.disabled).toBe(false))
})

test('onboarding: Skip shows a warning banner, and a second tap advances', async () => {
  await setup('onboarding')
  await waitFor(() => expect(screen.getByTestId('skip')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('skip'))
  expect(screen.getByText('Without knowledge the agent answers from your profile and guidance only')).toBeTruthy()
  expect(mockAdvanceCalls).toHaveLength(0)

  await fireEvent.press(screen.getByTestId('skip'))
  await waitFor(() => expect(mockAdvanceCalls).toHaveLength(1))
})

test('settings mode renders without the onboarding stepper or Continue/Skip', async () => {
  await setup('settings')
  await waitFor(() => expect(screen.getByTestId('knowledge')).toBeTruthy())
  expect(screen.queryByTestId('continue')).toBeNull()
  expect(screen.queryByTestId('skip')).toBeNull()
})

test('onboarding: the loading gate keeps the Stepper shell, the way MailboxStep does', async () => {
  const gate = deferred<ListData>()
  mockListImpl = () => gate.promise
  await setup('onboarding')

  await waitFor(() => expect(screen.getByTestId('onboarding-knowledge')).toBeTruthy())
  expect(screen.getByTestId('step-knowledge')).toBeTruthy()
  expect(screen.getByTestId('loading')).toBeTruthy()

  gate.resolve(defaultListData())
  await waitFor(() => expect(screen.queryByTestId('loading')).toBeNull())
})

test('a load failure shows an error banner with a working "Try again", and Skip stays available in onboarding', async () => {
  mockListImpl = () => Promise.reject(new Error('network down'))
  await setup('onboarding')

  await waitFor(() => expect(screen.getByTestId('knowledge-retry')).toBeTruthy())
  expect(screen.getByTestId('step-knowledge')).toBeTruthy()
  expect(screen.getByTestId('skip')).toBeTruthy()

  const callsBeforeRetry = mockListQueryCalls
  mockListImpl = () => Promise.resolve(defaultListData())
  await fireEvent.press(screen.getByTestId('knowledge-retry'))
  await waitFor(() => expect(mockListQueryCalls).toBeGreaterThan(callsBeforeRetry))
  await waitFor(() => expect(screen.getByTestId('knowledge-counter')).toBeTruthy())
})

test('canManage: false hides the add cards behind a read-only notice, but still shows the list/guidance/gaps', async () => {
  mockListData = { ...defaultListData(), canManage: false }
  await setup('settings')
  await waitFor(() => expect(screen.getByTestId('knowledge-readonly')).toBeTruthy())
  expect(screen.getByText('Only owners and admins can change knowledge.')).toBeTruthy()
  expect(screen.queryByTestId('crawl-card')).toBeNull()
  expect(screen.getByTestId('guidance-editor')).toBeTruthy()
  expect(screen.queryByTestId('save-guidance')).toBeNull()
})
