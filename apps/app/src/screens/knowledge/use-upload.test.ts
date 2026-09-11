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

test('refuses an oversized file and an unlisted MIME without calling startUpload', async () => {
  const { result } = await setup()
  const oversized = file({ name: 'huge.pdf', size: KNOWLEDGE_MAX_UPLOAD_BYTES + 1 })
  const wrongType = file({ name: 'evil.exe', mime: 'application/x-msdownload' })

  await act(async () => { await result.current.start([oversized, wrongType]) })

  expect(mockStartUploadCalls).toHaveLength(0)
  expect(mockUploadCalls).toHaveLength(0)
  expect(mockCompleteUploadCalls).toHaveLength(0)
  expect(result.current.pending).toEqual([
    { name: 'huge.pdf', progress: 'failed' },
    { name: 'evil.exe', progress: 'failed' },
  ])
})

test('signs, uploads, then completes in order, and invalidates knowledge.list', async () => {
  const { result, invalidateSpy } = await setup()
  const picked = file()

  await act(async () => { await result.current.start([picked]) })

  expect(mockCallOrder).toEqual(['sign', 'upload', 'complete'])
  expect(mockStartUploadCalls).toEqual([{ fileName: 'doc.pdf', mime: 'application/pdf', byteSize: 1000 }])
  expect(mockUploadCalls).toEqual([{ url: 'https://storage.test/put', headers: { 'x-test': '1' }, file: picked }])
  expect(mockCompleteUploadCalls).toEqual([{ sourceId: 's1' }])
  expect(result.current.pending).toEqual([{ name: 'doc.pdf', progress: 'queued' }])
  expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['knowledge', 'list'] })
})

test('a failed PUT marks that file failed and still completes the others', async () => {
  mockUploadImpl = (input) => {
    mockUploadCalls.push(input)
    const picked = (input as { file: PickedFile }).file
    if (picked.name === 'bad.pdf') return Promise.reject(new Error('network blip'))
    return Promise.resolve()
  }
  const { result } = await setup()
  const bad = file({ name: 'bad.pdf' })
  const good = file({ name: 'good.pdf' })

  await act(async () => { await result.current.start([bad, good]) })

  expect(result.current.pending).toEqual([
    { name: 'bad.pdf', progress: 'failed' },
    { name: 'good.pdf', progress: 'queued' },
  ])
  // The failed file's own completeUpload never fires; the good one's still does.
  expect(mockCompleteUploadCalls).toEqual([{ sourceId: 's1' }])
})
