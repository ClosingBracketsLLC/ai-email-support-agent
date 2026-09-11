import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { SourceCards } from './source-cards'

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
const mockStartCrawlCalls: unknown[] = []
const mockPasteCalls: unknown[] = []
let mockStartCrawlImpl: (input: unknown) => Promise<unknown> = (input) => { mockStartCrawlCalls.push(input); return Promise.resolve({ sourceId: 'crawl-1' }) }
let mockPasteImpl: (input: unknown) => Promise<unknown> = (input) => { mockPasteCalls.push(input); return Promise.resolve({ sourceId: 'paste-1' }) }

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })) }))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    knowledge: {
      list: { queryKey: () => ['knowledge', 'list'] },
      startCrawl: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockStartCrawlImpl(v), ...o }) },
      paste: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockPasteImpl(v), ...o }) },
      startUpload: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.reject(new Error('not exercised')), ...o }) },
      completeUpload: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.reject(new Error('not exercised')), ...o }) },
    },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []
async function setup(websiteUrl: string | null = 'https://acme.example.com') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<SourceCards websiteUrl={websiteUrl} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockStartCrawlCalls.length = 0
  mockPasteCalls.length = 0
  mockStartCrawlImpl = (input) => { mockStartCrawlCalls.push(input); return Promise.resolve({ sourceId: 'crawl-1' }) }
  mockPasteImpl = (input) => { mockPasteCalls.push(input); return Promise.resolve({ sourceId: 'paste-1' }) }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('the crawl field prefills the workspace website URL and defaults the page cap to 50, clamped to one of the fixed options', async () => {
  await setup('https://acme.example.com')
  await waitFor(() => expect(screen.getByTestId('crawl-url')).toBeTruthy())
  expect(screen.getByTestId('crawl-url').props.value).toBe('https://acme.example.com')
  expect(screen.getByTestId('page-cap-50').props.accessibilityState.checked).toBe(true)

  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(mockStartCrawlCalls).toEqual([{ url: 'https://acme.example.com', maxPages: 50 }]))

  // Selecting a different segment sends exactly that option — never something outside the fixed set.
  await fireEvent.press(screen.getByTestId('page-cap-100'))
  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(mockStartCrawlCalls).toEqual([
    { url: 'https://acme.example.com', maxPages: 50 },
    { url: 'https://acme.example.com', maxPages: 100 },
  ]))
})

test('with no website on file, the crawl field starts empty', async () => {
  await setup(null)
  await waitFor(() => expect(screen.getByTestId('crawl-url')).toBeTruthy())
  expect(screen.getByTestId('crawl-url').props.value).toBe('')
})

test('a BAD_REQUEST from startCrawl shows its message under the crawl field, not as a banner', async () => {
  mockStartCrawlImpl = () => Promise.reject({ data: { code: 'BAD_REQUEST' }, message: 'Crawls need an https:// address' })
  await setup('http://acme.example.com')
  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(screen.getByText('Crawls need an https:// address')).toBeTruthy())
  expect(screen.queryByTestId('knowledge-cap-error')).toBeNull()
})

test('a FORBIDDEN from startCrawl (the source cap) surfaces as an error banner', async () => {
  mockStartCrawlImpl = () => Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (100)' })
  await setup()
  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(screen.getByTestId('knowledge-cap-error')).toBeTruthy())
  expect(screen.getByText('knowledge.max_sources reached (100)')).toBeTruthy()
})

test('paste sends the trimmed title and text, then clears the fields on success', async () => {
  await setup()
  await fireEvent.changeText(screen.getByTestId('paste-title'), '  Return policy  ')
  await fireEvent.changeText(screen.getByTestId('paste-text'), 'We accept returns within 30 days.')
  await fireEvent.press(screen.getByTestId('add-paste'))

  await waitFor(() => expect(mockPasteCalls).toEqual([{ title: 'Return policy', text: 'We accept returns within 30 days.' }]))
  await waitFor(() => expect(screen.getByTestId('paste-title').props.value).toBe(''))
  expect(screen.getByTestId('paste-text').props.value).toBe('')
})

test('a FORBIDDEN from paste (the source cap) surfaces as an error banner', async () => {
  mockPasteImpl = () => Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (100)' })
  await setup()
  await fireEvent.changeText(screen.getByTestId('paste-title'), 'FAQ')
  await fireEvent.changeText(screen.getByTestId('paste-text'), 'Some text')
  await fireEvent.press(screen.getByTestId('add-paste'))
  await waitFor(() => expect(screen.getByTestId('knowledge-cap-error')).toBeTruthy())
})

test('renders the upload card with the accepted types and size cap', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('drop-zone-picker')).toBeTruthy())
  expect(screen.getByText(/20 MB/)).toBeTruthy()
})
