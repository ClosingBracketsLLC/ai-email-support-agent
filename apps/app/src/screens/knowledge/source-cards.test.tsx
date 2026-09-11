import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { SourceCards, type KnowledgeCaps } from './source-cards'

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
const mockStartCrawlCalls: unknown[] = []
const mockPasteCalls: unknown[] = []
const mockStartUploadCalls: unknown[] = []
let mockStartCrawlImpl: (input: unknown) => Promise<unknown> = (input) => { mockStartCrawlCalls.push(input); return Promise.resolve({ sourceId: 'crawl-1' }) }
let mockPasteImpl: (input: unknown) => Promise<unknown> = (input) => { mockPasteCalls.push(input); return Promise.resolve({ sourceId: 'paste-1' }) }
let mockStartUploadImpl: (input: unknown) => Promise<unknown> = (input) => {
  mockStartUploadCalls.push(input)
  return Promise.resolve({ sourceId: 'up-1', url: 'https://storage.test/put', headers: {}, expiresAt: new Date() })
}

let mockGetDocumentAsyncImpl: () => Promise<unknown> = () => Promise.resolve({ canceled: true, assets: null })
jest.mock('expo-document-picker', () => ({ getDocumentAsync: () => mockGetDocumentAsyncImpl() }))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    knowledge: {
      list: { queryKey: () => ['knowledge', 'list'] },
      startCrawl: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockStartCrawlImpl(v), ...o }) },
      paste: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockPasteImpl(v), ...o }) },
      startUpload: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockStartUploadImpl(v), ...o }) },
      completeUpload: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ ok: true }), ...o }) },
      deleteSource: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ ok: true }), ...o }) },
    },
  }),
}))
jest.mock('@/lib/upload', () => ({
  uploadToPresignedUrl: () => Promise.resolve(),
  inferMime: (_name: string, declared: string) => declared,
}))

const DEFAULT_CAPS: KnowledgeCaps = { maxSources: 100, maxCrawlPages: 200 }

const teardowns: Array<() => Promise<void> | void> = []
async function setup(websiteUrl: string | null = 'https://acme.example.com', caps: KnowledgeCaps = DEFAULT_CAPS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<SourceCards websiteUrl={websiteUrl} caps={caps} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockStartCrawlCalls.length = 0
  mockPasteCalls.length = 0
  mockStartUploadCalls.length = 0
  mockStartCrawlImpl = (input) => { mockStartCrawlCalls.push(input); return Promise.resolve({ sourceId: 'crawl-1' }) }
  mockPasteImpl = (input) => { mockPasteCalls.push(input); return Promise.resolve({ sourceId: 'paste-1' }) }
  mockStartUploadImpl = (input) => {
    mockStartUploadCalls.push(input)
    return Promise.resolve({ sourceId: 'up-1', url: 'https://storage.test/put', headers: {}, expiresAt: new Date() })
  }
  mockGetDocumentAsyncImpl = () => Promise.resolve({ canceled: true, assets: null })
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

test('the page-cap control only offers options at or under the plan cap', async () => {
  await setup('https://acme.example.com', { maxSources: 100, maxCrawlPages: 50 })
  await waitFor(() => expect(screen.getByTestId('page-cap-20')).toBeTruthy())
  expect(screen.getByTestId('page-cap-50')).toBeTruthy()
  expect(screen.queryByTestId('page-cap-100')).toBeNull()
})

test('a plan cap under every fixed option collapses to a single fixed cap line, and that value is what gets sent', async () => {
  await setup('https://acme.example.com', { maxSources: 100, maxCrawlPages: 10 })
  await waitFor(() => expect(screen.getByTestId('page-cap-fixed')).toBeTruthy())
  expect(screen.getByText('Plan cap: 10 pages')).toBeTruthy()
  expect(screen.queryByTestId('page-cap-20')).toBeNull()

  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(mockStartCrawlCalls).toEqual([{ url: 'https://acme.example.com', maxPages: 10 }]))
})

test('a non-https URL is refused client-side, under the field, and never reaches startCrawl', async () => {
  await setup('http://acme.example.com')
  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(screen.getByText('Enter a full https:// address')).toBeTruthy())
  expect(mockStartCrawlCalls).toHaveLength(0)
  expect(screen.queryByTestId('knowledge-cap-error')).toBeNull()
})

test('a BAD_REQUEST from the server shows the same fixed copy under the field — never the server message', async () => {
  // zod 4 stringifies its issue array into `message`, and tRPC keeps a BAD_REQUEST's message
  // verbatim: rendering `err.message` would put raw JSON under the owner's URL field.
  mockStartCrawlImpl = () => Promise.reject({
    data: { code: 'BAD_REQUEST' },
    message: '[\n  {\n    "code": "invalid_format",\n    "path": ["url"]\n  }\n]',
  })
  await setup('https://acme.example.com')
  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(screen.getByText('Enter a full https:// address')).toBeTruthy())
  expect(screen.queryByText(/invalid_format/)).toBeNull()
  expect(screen.queryByTestId('knowledge-cap-error')).toBeNull()
})

test('a non-FORBIDDEN failure on startCrawl shows a plain retry line, never the cap banner', async () => {
  mockStartCrawlImpl = () => Promise.reject({ data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'boom' })
  await setup('https://acme.example.com', { maxSources: 7, maxCrawlPages: 200 })
  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(screen.getByTestId('crawl-error')).toBeTruthy())
  expect(screen.getByText('Could not start the crawl. Try again.')).toBeTruthy()
  expect(screen.queryByTestId('knowledge-cap-error')).toBeNull()
  expect(screen.queryByText('boom')).toBeNull()
})

test('a non-FORBIDDEN failure on paste shows a plain retry line, never the cap banner', async () => {
  mockPasteImpl = () => Promise.reject({ data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'boom' })
  await setup('https://acme.example.com', { maxSources: 7, maxCrawlPages: 200 })
  await fireEvent.changeText(screen.getByTestId('paste-title'), 'FAQ')
  await fireEvent.changeText(screen.getByTestId('paste-text'), 'Some text')
  await fireEvent.press(screen.getByTestId('add-paste'))
  await waitFor(() => expect(screen.getByTestId('paste-error')).toBeTruthy())
  expect(screen.getByText('Could not add the text. Try again.')).toBeTruthy()
  expect(screen.queryByTestId('knowledge-cap-error')).toBeNull()
})

test('a FORBIDDEN from startCrawl (the source cap) shows the client-composed cap banner, never the server message', async () => {
  mockStartCrawlImpl = () => Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (100)' })
  await setup('https://acme.example.com', { maxSources: 7, maxCrawlPages: 200 })
  await fireEvent.press(screen.getByTestId('start-crawl'))
  await waitFor(() => expect(screen.getByTestId('knowledge-cap-error')).toBeTruthy())
  expect(screen.getByText('Your plan allows 7 sources. Delete one to add another.')).toBeTruthy()
  expect(screen.queryByText('knowledge.max_sources reached (100)')).toBeNull()
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

test('a FORBIDDEN from paste (the source cap) shows the client-composed cap banner', async () => {
  mockPasteImpl = () => Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (100)' })
  await setup('https://acme.example.com', { maxSources: 3, maxCrawlPages: 200 })
  await fireEvent.changeText(screen.getByTestId('paste-title'), 'FAQ')
  await fireEvent.changeText(screen.getByTestId('paste-text'), 'Some text')
  await fireEvent.press(screen.getByTestId('add-paste'))
  await waitFor(() => expect(screen.getByText('Your plan allows 3 sources. Delete one to add another.')).toBeTruthy())
})

test('renders the upload card with types and size cap derived from the contracts constants', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('drop-zone-picker')).toBeTruthy())
  expect(screen.getByText('PDF, DOCX, MD, TXT · up to 20 MB each')).toBeTruthy()
})

test('an upload batch stopped by the cap shows the same client-composed cap banner', async () => {
  mockGetDocumentAsyncImpl = () => Promise.resolve({
    canceled: false,
    assets: [{ name: 'a.pdf', uri: 'file:///a.pdf', mimeType: 'application/pdf', size: 10, lastModified: 0 }],
  })
  mockStartUploadImpl = () => Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (2)' })
  await setup('https://acme.example.com', { maxSources: 2, maxCrawlPages: 200 })
  await fireEvent.press(screen.getByTestId('drop-zone-picker'))
  await waitFor(() => expect(screen.getByText('Your plan allows 2 sources. Delete one to add another.')).toBeTruthy())
})
