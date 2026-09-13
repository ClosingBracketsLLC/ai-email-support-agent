import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { WORKSPACE_ERROR_MESSAGES } from '@aesa/contracts'
import { DangerZone } from './danger-zone'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
let mockRole = 'owner'
let mockBusinessName = 'Acme Co'
let mockKillSwitch = false
let mockRetentionDays = 90
let mockDeletionRequestedAt: Date | null = null
let mockPurgeAfter: Date | null = null
let mockExportState = 'none'
let mockExportUrl: string | null = null

const mockKillSwitchCalls: unknown[] = []
const mockRetentionCalls: unknown[] = []
const mockRequestExportCalls: unknown[] = []
const mockRequestDeletionCalls: unknown[] = []
const mockCancelDeletionCalls: unknown[] = []
const mockOpenExternalCalls: Array<{ start: () => Promise<{ url: string }> }> = []

let mockKillSwitchImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ ok: true })
let mockRetentionImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ ok: true })
let mockRequestExportImpl: () => Promise<unknown> = () => Promise.resolve({ exportId: 'exp1' })
let mockRequestDeletionImpl: (input: unknown) => Promise<unknown> =
  () => Promise.resolve({ purgeAfter: new Date('2026-10-13T00:00:00Z'), subscriptionCancelled: false })
let mockCancelDeletionImpl: () => Promise<unknown> = () => Promise.resolve({ ok: true, needsResubscribe: false })

jest.mock('@/lib/open-external', () => ({
  openExternal: (start: () => Promise<{ url: string }>, opts: { onBlocked: (msg: string) => void }) => {
    mockOpenExternalCalls.push({ start })
    return start().then(() => undefined).catch(() => opts.onBlocked('failed'))
  },
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: {
        queryOptions: () => ({
          queryKey: ['workspace', 'get'],
          queryFn: () => Promise.resolve({
            role: mockRole, businessName: mockBusinessName, killSwitch: mockKillSwitch, retentionDays: mockRetentionDays,
            deletionRequestedAt: mockDeletionRequestedAt, purgeAfter: mockPurgeAfter,
          }),
        }),
        queryKey: () => ['workspace', 'get'],
      },
      setKillSwitch: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockKillSwitchCalls.push(v); return mockKillSwitchImpl(v) }, ...o }) },
      setRetentionDays: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockRetentionCalls.push(v); return mockRetentionImpl(v) }, ...o }) },
      requestExport: { mutationOptions: (o: object) => ({ mutationFn: () => { mockRequestExportCalls.push(true); return mockRequestExportImpl() }, ...o }) },
      requestDeletion: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockRequestDeletionCalls.push(v); return mockRequestDeletionImpl(v) }, ...o }) },
      cancelDeletion: { mutationOptions: (o: object) => ({ mutationFn: () => { mockCancelDeletionCalls.push(true); return mockCancelDeletionImpl() }, ...o }) },
      exportStatus: {
        queryOptions: () => ({
          queryKey: ['workspace', 'exportStatus'],
          queryFn: () => Promise.resolve({ state: mockExportState, readyAt: null, url: mockExportUrl }),
        }),
        queryKey: () => ['workspace', 'exportStatus'],
      },
    },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<DangerZone />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

/** A promise this test resolves by hand, mirroring `create-workspace.test.tsx`'s own `deferred`. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  mockRole = 'owner'
  mockBusinessName = 'Acme Co'
  mockKillSwitch = false
  mockRetentionDays = 90
  mockDeletionRequestedAt = null
  mockPurgeAfter = null
  mockExportState = 'none'
  mockExportUrl = null
  for (const calls of [mockKillSwitchCalls, mockRetentionCalls, mockRequestExportCalls, mockRequestDeletionCalls, mockCancelDeletionCalls, mockOpenExternalCalls]) calls.length = 0
  mockKillSwitchImpl = () => Promise.resolve({ ok: true })
  mockRetentionImpl = () => Promise.resolve({ ok: true })
  mockRequestExportImpl = () => Promise.resolve({ exportId: 'exp1' })
  mockRequestDeletionImpl = () => Promise.resolve({ purgeAfter: new Date('2026-10-13T00:00:00Z'), subscriptionCancelled: false })
  mockCancelDeletionImpl = () => Promise.resolve({ ok: true, needsResubscribe: false })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a plain member sees only the readonly note — no switch, no fields, no buttons', async () => {
  mockRole = 'member'
  await setup()
  await waitFor(() => expect(screen.getByTestId('danger-zone-readonly')).toBeTruthy())

  expect(screen.getByText('Only the workspace owner can change these.')).toBeTruthy()
  expect(screen.queryByTestId('kill-switch')).toBeNull()
  expect(screen.queryByTestId('delete-open')).toBeNull()
})

test('an admin gets the SAME readonly treatment as a member — every mutation here is ownerProcedure, not just managerProcedure', async () => {
  mockRole = 'admin'
  await setup()
  await waitFor(() => expect(screen.getByTestId('danger-zone-readonly')).toBeTruthy())

  expect(screen.queryByTestId('kill-switch')).toBeNull()
  expect(screen.queryByTestId('retention-days')).toBeNull()
  expect(screen.queryByTestId('export-request')).toBeNull()
  expect(screen.queryByTestId('delete-open')).toBeNull()
})

test('the kill switch names exactly what it does and calls setKillSwitch, disabled while pending', async () => {
  const gate = deferred<{ ok: true }>()
  mockKillSwitchImpl = () => gate.promise
  await setup()
  await waitFor(() => expect(screen.getByTestId('kill-switch')).toBeTruthy())

  expect(screen.getByText('Stops every send instantly, including replies you already approved. Drafts keep coming.')).toBeTruthy()

  await fireEvent(screen.getByTestId('kill-switch'), 'valueChange', true)
  expect(mockKillSwitchCalls).toEqual([{ on: true }])
  await waitFor(() => expect(screen.getByTestId('kill-switch').props.accessibilityState.disabled).toBe(true))

  gate.resolve({ ok: true })
  await waitFor(() => expect(screen.getByTestId('kill-switch').props.accessibilityState.disabled).toBe(false))
})

test('retention only saves a number in the 30-730 range', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('retention-days')).toBeTruthy())

  await fireEvent.changeText(screen.getByTestId('retention-days'), '10')
  expect(screen.getByTestId('retention-save').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('retention-days'), '400')
  expect(screen.getByTestId('retention-save').props.accessibilityState.disabled).toBe(false)

  await fireEvent.press(screen.getByTestId('retention-save'))
  await waitFor(() => expect(mockRetentionCalls).toEqual([{ retentionDays: 400 }]))
})

test('Export data queues an export, then a ready bundle downloads through openExternal', async () => {
  mockExportState = 'ready'
  mockExportUrl = 'https://s3.example.com/export.ndjson'
  await setup()
  await waitFor(() => expect(screen.getByTestId('export-download')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('export-download'))
  await waitFor(() => expect(mockOpenExternalCalls).toHaveLength(1))
  await expect(mockOpenExternalCalls[0]!.start()).resolves.toEqual({ url: 'https://s3.example.com/export.ndjson' })
})

test('a queued export says it is preparing, with no button to press twice', async () => {
  mockExportState = 'queued'
  await setup()
  await waitFor(() => expect(screen.getByTestId('export-status')).toBeTruthy())
  expect(screen.getByText('Preparing…')).toBeTruthy()
  expect(screen.queryByTestId('export-request')).toBeNull()
})

test('a failed export offers to try again, which re-requests it', async () => {
  mockExportState = 'failed'
  await setup()
  await waitFor(() => expect(screen.getByTestId('export-request')).toBeTruthy())
  expect(screen.getByText('Failed — try again')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('export-request'))
  await waitFor(() => expect(mockRequestExportCalls).toHaveLength(1))
})

test('an export request that is already running says so, in the owner\'s own words', async () => {
  mockRequestExportImpl = () => Promise.reject(Object.assign(new Error(WORKSPACE_ERROR_MESSAGES.export_in_progress), { data: { code: 'PRECONDITION_FAILED' } }))
  await setup()
  await waitFor(() => expect(screen.getByTestId('export-request')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('export-request'))
  await waitFor(() => expect(screen.getByTestId('danger-zone-error')).toBeTruthy())
  expect(screen.getByText('An export is already running.')).toBeTruthy()
})

test('deleting requires typing the exact workspace name, then schedules the purge and offers to cancel it', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('delete-open')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('delete-open'))
  await waitFor(() => expect(screen.getByTestId('delete-confirm-name')).toBeTruthy())
  expect(screen.getByTestId('delete-confirm').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('delete-confirm-name'), 'Wrong Name')
  expect(screen.getByTestId('delete-confirm').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('delete-confirm-name'), 'Acme Co')
  expect(screen.getByTestId('delete-confirm').props.accessibilityState.disabled).toBe(false)

  mockRequestDeletionImpl = () => {
    mockDeletionRequestedAt = new Date('2026-09-13T00:00:00Z')
    mockPurgeAfter = new Date('2026-10-13T00:00:00Z')
    return Promise.resolve({ purgeAfter: mockPurgeAfter, subscriptionCancelled: true })
  }
  await fireEvent.press(screen.getByTestId('delete-confirm'))

  expect(mockRequestDeletionCalls).toEqual([{ confirm: 'Acme Co' }])
  await waitFor(() => expect(screen.getByTestId('delete-scheduled')).toBeTruthy())
  expect(screen.getByText('Deletion scheduled for 2026-10-13.')).toBeTruthy()
  // R22: requestDeletion cancelling a live subscription is said in words, once, right here.
  expect(screen.getByTestId('delete-subscription-cancelled')).toBeTruthy()
  expect(screen.queryByTestId('delete-open')).toBeNull()

  mockCancelDeletionImpl = () => {
    mockDeletionRequestedAt = null
    mockPurgeAfter = null
    return Promise.resolve({ ok: true, needsResubscribe: true })
  }
  await fireEvent.press(screen.getByTestId('cancel-deletion'))
  await waitFor(() => expect(mockCancelDeletionCalls).toHaveLength(1))
  // R23: cancelDeletion's OWN signal — needsResubscribe — is a different fact and gets its own words.
  await waitFor(() => expect(screen.getByTestId('cancel-needs-resubscribe')).toBeTruthy())
  expect(screen.getByText('Re-subscribe in Billing to turn Autopilot back on.')).toBeTruthy()
  await waitFor(() => expect(screen.getByTestId('delete-open')).toBeTruthy())
})

test('a deletion Stripe could not cancel refuses in the owner\'s own words, from WORKSPACE_ERROR_MESSAGES', async () => {
  mockRequestDeletionImpl = () => Promise.reject(Object.assign(new Error(WORKSPACE_ERROR_MESSAGES.billing_cancel_failed), { data: { code: 'BAD_GATEWAY' } }))
  await setup()
  await waitFor(() => expect(screen.getByTestId('delete-open')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('delete-open'))
  await fireEvent.changeText(screen.getByTestId('delete-confirm-name'), 'Acme Co')
  await fireEvent.press(screen.getByTestId('delete-confirm'))

  await waitFor(() => expect(screen.getByTestId('danger-zone-error')).toBeTruthy())
  expect(screen.getByText('Could not cancel the subscription — deletion was not scheduled.')).toBeTruthy()
  // The refusal never claims the deletion happened.
  expect(screen.queryByTestId('delete-scheduled')).toBeNull()
})
