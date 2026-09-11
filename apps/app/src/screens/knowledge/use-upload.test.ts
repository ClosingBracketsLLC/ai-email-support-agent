import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react-native'
import { createElement, type ReactNode } from 'react'
import { KNOWLEDGE_MAX_UPLOAD_BYTES } from '@aesa/contracts'
import type { PickedFile } from '@/lib/upload'
import { useUpload } from './use-upload'

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
const mockStartUploadCalls: unknown[] = []
const mockCompleteUploadCalls: unknown[] = []
const mockUploadCalls: unknown[] = []
const mockCallOrder: string[] = []

let mockStartUploadImpl: (input: unknown) => Promise<unknown> = (input) => {
  mockStartUploadCalls.push(input)
  mockCallOrder.push('sign')
  return Promise.resolve({ sourceId: 's1', url: 'https://storage.test/put', headers: { 'x-test': '1' }, expiresAt: new Date() })
}
let mockCompleteUploadImpl: (input: unknown) => Promise<unknown> = (input) => {
  mockCompleteUploadCalls.push(input)
  mockCallOrder.push('complete')
  return Promise.resolve({ ok: true })
}
let mockUploadImpl: (input: unknown) => Promise<void> = (input) => {
  mockUploadCalls.push(input)
  mockCallOrder.push('upload')
  return Promise.resolve()
}

jest.mock('@/lib/upload', () => ({
  uploadToPresignedUrl: (input: unknown) => mockUploadImpl(input),
  inferMime: (name: string, declared: string) => declared, // exercised on its own in lib/upload.test.ts
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    knowledge: {
      startUpload: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockStartUploadImpl(v), ...o }) },
      completeUpload: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockCompleteUploadImpl(v), ...o }) },
      list: { queryKey: () => ['knowledge', 'list'] },
    },
  }),
}))

function file(overrides: Partial<PickedFile> = {}): PickedFile {
  return { name: 'doc.pdf', mime: 'application/pdf', size: 1000, uri: 'file:///doc.pdf', ...overrides }
}
/** Strips the random per-pick `id` so assertions can compare the rest structurally. */
function withoutId(pending: { id: string; name: string; progress: string; reason: string | null }[]) {
  return pending.map((p) => ({ name: p.name, progress: p.progress, reason: p.reason }))
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries')
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
  const rendered = await renderHook(() => useUpload(), { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return { ...rendered, invalidateSpy }
}

beforeEach(() => {
  mockStartUploadCalls.length = 0
  mockCompleteUploadCalls.length = 0
  mockUploadCalls.length = 0
  mockCallOrder.length = 0
  mockStartUploadImpl = (input) => {
    mockStartUploadCalls.push(input)
    mockCallOrder.push('sign')
    return Promise.resolve({ sourceId: 's1', url: 'https://storage.test/put', headers: { 'x-test': '1' }, expiresAt: new Date() })
  }
  mockCompleteUploadImpl = (input) => {
    mockCompleteUploadCalls.push(input)
    mockCallOrder.push('complete')
    return Promise.resolve({ ok: true })
  }
  mockUploadImpl = (input) => {
    mockUploadCalls.push(input)
    mockCallOrder.push('upload')
    return Promise.resolve()
  }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('refuses an oversized file, an unlisted MIME, and an unreadable size, without calling startUpload', async () => {
  const { result } = await setup()
  const oversized = file({ name: 'huge.pdf', size: KNOWLEDGE_MAX_UPLOAD_BYTES + 1 })
  const wrongType = file({ name: 'evil.exe', mime: 'application/x-msdownload' })
  const unknownSize = file({ name: 'mystery.pdf', size: null })

  let outcome
  await act(async () => { outcome = await result.current.start([oversized, wrongType, unknownSize]) })

  expect(mockStartUploadCalls).toHaveLength(0)
  expect(mockUploadCalls).toHaveLength(0)
  expect(mockCompleteUploadCalls).toHaveLength(0)
  expect(withoutId(result.current.pending)).toEqual([
    { name: 'huge.pdf', progress: 'failed', reason: 'too_large' },
    { name: 'evil.exe', progress: 'failed', reason: 'wrong_type' },
    { name: 'mystery.pdf', progress: 'failed', reason: 'unknown_size' },
  ])
  expect(outcome).toEqual({ stoppedBy: null })
})

test('signs, uploads, then completes in order, and invalidates knowledge.list', async () => {
  const { result, invalidateSpy } = await setup()
  const picked = file()

  let outcome
  await act(async () => { outcome = await result.current.start([picked]) })

  expect(mockCallOrder).toEqual(['sign', 'upload', 'complete'])
  expect(mockStartUploadCalls).toEqual([{ fileName: 'doc.pdf', mime: 'application/pdf', byteSize: 1000 }])
  expect(mockUploadCalls).toEqual([{ url: 'https://storage.test/put', headers: { 'x-test': '1' }, file: picked }])
  expect(mockCompleteUploadCalls).toEqual([{ sourceId: 's1' }])
  expect(withoutId(result.current.pending)).toEqual([{ name: 'doc.pdf', progress: 'queued', reason: null }])
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['knowledge', 'list'] })
  expect(outcome).toEqual({ stoppedBy: null })
})

test('a failed PUT marks that file failed/upload_failed and still completes the others', async () => {
  mockUploadImpl = (input) => {
    mockUploadCalls.push(input)
    const picked = (input as { file: PickedFile }).file
    if (picked.name === 'bad.pdf') return Promise.reject(new Error('network blip'))
    return Promise.resolve()
  }
  const { result } = await setup()
  const bad = file({ name: 'bad.pdf' })
  const good = file({ name: 'good.pdf' })

  let outcome
  await act(async () => { outcome = await result.current.start([bad, good]) })

  expect(withoutId(result.current.pending)).toEqual([
    { name: 'bad.pdf', progress: 'failed', reason: 'upload_failed' },
    { name: 'good.pdf', progress: 'queued', reason: null },
  ])
  // The failed file's own completeUpload never fires; the good one's still does.
  expect(mockCompleteUploadCalls).toEqual([{ sourceId: 's1' }])
  expect(outcome).toEqual({ stoppedBy: null })
})

test('a FORBIDDEN (the source cap) stops the batch: later files are never signed and land failed/cap', async () => {
  let call = 0
  mockStartUploadImpl = (input) => {
    call += 1
    mockStartUploadCalls.push(input)
    if (call === 2) return Promise.reject({ data: { code: 'FORBIDDEN' }, message: 'knowledge.max_sources reached (2)' })
    return Promise.resolve({ sourceId: `s${call}`, url: 'https://storage.test/put', headers: {}, expiresAt: new Date() })
  }
  const { result } = await setup()
  const first = file({ name: 'first.pdf' })
  const second = file({ name: 'second.pdf' })
  const third = file({ name: 'third.pdf' })

  let outcome
  await act(async () => { outcome = await result.current.start([first, second, third]) })

  // Exactly two sign attempts: the third file's startUpload is never called at all.
  expect(mockStartUploadCalls).toHaveLength(2)
  expect(withoutId(result.current.pending)).toEqual([
    { name: 'first.pdf', progress: 'queued', reason: null },
    { name: 'second.pdf', progress: 'failed', reason: 'cap' },
    { name: 'third.pdf', progress: 'failed', reason: 'cap' },
  ])
  expect(outcome).toEqual({ stoppedBy: 'cap' })
})
