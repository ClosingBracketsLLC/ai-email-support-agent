import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { TicketScreen, shortcutFor } from './ticket'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
const mockTicketId = '11111111-1111-4111-8111-111111111111'
const mockDraftId = '22222222-2222-4222-8222-222222222222'

interface MockDraft {
  id: string; version: number; status: string; body: string; finalBody: string | null
  decisionReason: string; confidence: number | null; guardrailResult: unknown
  send: unknown; viewedAt: Date | null
}
interface MockTicket {
  id: string; subject: string | null; status: string; needsOwnerReason: string | null
  agentAddress: string | null; categoryLabel: string | null; redraftCount: number
}

let mockDraft: MockDraft | null = null
let mockTicket: MockTicket = {} as MockTicket
let mockTicketQueries = 0
let mockTicketOpts: { refetchInterval?: unknown } = {}
let mockUndoUntil = new Date()

const mockBack = jest.fn()
const mockMarkViewedCalls: unknown[] = []
const mockApproveCalls: unknown[] = []
const mockHoldCalls: unknown[] = []
const mockRejectCalls: unknown[] = []
const mockResumeCalls: unknown[] = []
const mockResolveCalls: unknown[] = []

let mockApproveImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({})
let mockHoldImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ held: true })
let mockRejectImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ resolution: 'redraft' })

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockTicketId }),
  useRouter: () => ({ back: mockBack }),
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    inbox: {
      ticket: {
        queryOptions: (input: { ticketId: string }, opts: object) => {
          mockTicketOpts = opts
          return {
            queryKey: ['inbox', 'ticket', input.ticketId],
            queryFn: () => {
              mockTicketQueries += 1
              return Promise.resolve({ ticket: mockTicket, messages: [], draft: mockDraft })
            },
            ...opts,
          }
        },
        queryKey: (input: { ticketId: string }) => ['inbox', 'ticket', input.ticketId],
      },
      list: { queryKey: () => ['inbox', 'list'] },
      resolve: {
        mutationOptions: (o: object) => ({
          mutationFn: (v: unknown) => { mockResolveCalls.push(v); return Promise.resolve({ resolved: true }) },
          ...o,
        }),
      },
    },
    drafts: {
      markViewed: {
        mutationOptions: (o: object) => ({
          mutationFn: (v: unknown) => { mockMarkViewedCalls.push(v); return Promise.resolve({ viewed: true }) },
          ...o,
        }),
      },
      approve: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockApproveCalls.push(v); return mockApproveImpl(v) }, ...o }) },
      hold: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockHoldCalls.push(v); return mockHoldImpl(v) }, ...o }) },
      reject: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockRejectCalls.push(v); return mockRejectImpl(v) }, ...o }) },
      resume: {
        mutationOptions: (o: object) => ({
          mutationFn: (v: unknown) => { mockResumeCalls.push(v); return Promise.resolve({ resumed: true }) },
          ...o,
        }),
      },
    },
  }),
}))

function pendingDraft(overrides: Partial<MockDraft> = {}): MockDraft {
  return {
    id: mockDraftId, version: 1, status: 'pending', body: 'Your order ships tomorrow.', finalBody: null,
    decisionReason: 'cold_start', confidence: 0.82, guardrailResult: { ok: true, findings: [] },
    send: null, viewedAt: null, ...overrides,
  }
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  // `undoTickMs` far beyond the test's lifetime: the undo bar renders its first frame and never ticks,
  // so no state update can land outside an act() scope (no fake timers — React 19 deadlocks with them).
  const rendered = await render(<TicketScreen undoTickMs={60_000} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

/** Approve, then wait for the undo bar the server's `undoUntil` opens. */
async function approveAndWait() {
  await waitFor(() => expect(screen.getByTestId('approve')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('approve'))
  await waitFor(() => expect(screen.getByTestId('undo-bar')).toBeTruthy())
}

beforeEach(() => {
  mockTicket = {
    id: mockTicketId, subject: 'Where is my order?', status: 'awaiting_review', needsOwnerReason: null,
    agentAddress: 'support@acme.com', categoryLabel: 'Shipping', redraftCount: 0,
  }
  mockDraft = pendingDraft({ viewedAt: new Date('2026-01-01T00:00:00Z') })
  mockTicketQueries = 0
  mockTicketOpts = {}
  mockUndoUntil = new Date(Date.now() + 15_000)
  mockBack.mockReset()
  for (const calls of [mockMarkViewedCalls, mockApproveCalls, mockHoldCalls, mockRejectCalls, mockResumeCalls, mockResolveCalls]) calls.length = 0
  mockApproveImpl = () => Promise.resolve({ sendId: 'send-1', sendAfter: mockUndoUntil, undoUntil: mockUndoUntil })
  mockHoldImpl = () => Promise.resolve({ held: true })
  mockRejectImpl = () => Promise.resolve({ resolution: 'redraft' })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('marks an unviewed pending draft as viewed exactly once, even across the refetch it triggers', async () => {
  mockDraft = pendingDraft({ viewedAt: null })
  await setup()

  await waitFor(() => expect(mockMarkViewedCalls).toEqual([{ draftId: mockDraftId }]))
  // markViewed's success invalidates the ticket query; the refetch must not re-fire it.
  await waitFor(() => expect(mockTicketQueries).toBeGreaterThan(1))
  expect(mockMarkViewedCalls).toHaveLength(1)
})

test('an already-viewed draft is not marked again', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('draft-panel')).toBeTruthy())

  expect(mockMarkViewedCalls).toHaveLength(0)
  expect(screen.getByTestId('approve').props.accessibilityState.disabled).toBe(false)
})

test('Approve calls drafts.approve with the draft id and opens the undo window the server returned', async () => {
  await setup()
  await approveAndWait()

  expect(mockApproveCalls).toEqual([{ draftId: mockDraftId }])
  expect(screen.getByText('Sending in 15s')).toBeTruthy()
})

test('Undo holds the send and closes the undo window', async () => {
  await setup()
  await approveAndWait()

  await fireEvent.press(screen.getByTestId('undo-button'))

  await waitFor(() => expect(screen.queryByTestId('undo-bar')).toBeNull())
  expect(mockHoldCalls).toEqual([{ draftId: mockDraftId }])
})

test('a hold that lost the race says so', async () => {
  mockHoldImpl = () => Promise.resolve({ held: false, code: 'too_late' })
  await setup()
  await approveAndWait()

  await fireEvent.press(screen.getByTestId('undo-button'))

  await waitFor(() => expect(screen.getByText('Too late — it already sent.')).toBeTruthy())
})

test('an approve refused by the guardrails surfaces the findings', async () => {
  mockApproveImpl = () => Promise.reject(Object.assign(new Error('guardrail'), {
    data: { code: 'BAD_REQUEST', findings: [{ code: 'url_not_allowed', severity: 'fail', detail: 'bit.ly is not allowed' }, { code: 'secret_leak', severity: 'fail', detail: '' }] },
  }))
  await setup()

  await waitFor(() => expect(screen.getByTestId('approve')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('approve'))

  await waitFor(() => expect(screen.getByText('url_not_allowed: bit.ly is not allowed')).toBeTruthy())
  expect(screen.getByText('secret_leak')).toBeTruthy()
  expect(screen.getByTestId('draft-editor')).toBeTruthy()
})

test('rejecting with a reason asks for a re-draft and says one is coming', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('reject')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reject'))
  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Too formal')
  await fireEvent.press(screen.getByTestId('reject-redraft'))

  await waitFor(() => expect(screen.getByText('The agent is re-drafting — a new draft will appear here.')).toBeTruthy())
  expect(mockRejectCalls).toEqual([{ draftId: mockDraftId, action: 'redraft', reason: 'Too formal' }])
})

test('"I\'ll handle it" hands the ticket to the owner', async () => {
  mockRejectImpl = () => Promise.resolve({ resolution: 'escalate_terminal' })
  await setup()
  await waitFor(() => expect(screen.getByTestId('reject')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reject'))
  await fireEvent.press(screen.getByTestId('reject-handle'))

  await waitFor(() => expect(screen.getByText('Marked for you to handle.')).toBeTruthy())
  expect(mockRejectCalls).toEqual([{ draftId: mockDraftId, action: 'handle', reason: '' }])
})

test('a held draft offers Back to review, which resumes it', async () => {
  mockDraft = pendingDraft({ status: 'held', send: { id: 'send-1', status: 'held', sendAfter: new Date(), sentAt: null, lastError: 'held:agent_disabled' } })
  await setup()

  await waitFor(() => expect(screen.getByTestId('draft-held')).toBeTruthy())
  expect(screen.getByText('On hold — the agent is off.')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('resume'))
  await waitFor(() => expect(mockResumeCalls).toEqual([{ draftId: mockDraftId }]))
})

test('a needs_owner ticket offers Mark resolved behind a two-tap confirm', async () => {
  mockDraft = null
  mockTicket = { ...mockTicket, status: 'needs_owner', needsOwnerReason: 'tripwire' }
  await setup()

  await waitFor(() => expect(screen.getByTestId('resolve')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('resolve'))
  expect(mockResolveCalls).toHaveLength(0)
  expect(screen.getByText('Confirm resolve')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('resolve'))
  await waitFor(() => expect(mockResolveCalls).toEqual([{ ticketId: mockTicketId }]))
})

test('the ticket query polls only while the reply is on its way out', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('draft-panel')).toBeTruthy())

  const refetchInterval = mockTicketOpts.refetchInterval as (q: { state: { data: unknown } }) => number | false
  expect(typeof refetchInterval).toBe('function')
  expect(refetchInterval({ state: { data: { draft: { status: 'approved' } } } })).toBe(10_000)
  expect(refetchInterval({ state: { data: { draft: { status: 'sending' } } } })).toBe(10_000)
  expect(refetchInterval({ state: { data: { draft: { status: 'pending' } } } })).toBe(false)
  expect(refetchInterval({ state: { data: { draft: null } } })).toBe(false)
  expect(refetchInterval({ state: { data: undefined } })).toBe(false)
})

describe('shortcutFor', () => {
  it.each([
    ['a', 'approve'],
    ['A', 'approve'],
    ['e', 'edit'],
    ['E', 'edit'],
    ['r', 'reject'],
    ['R', 'reject'],
  ] as const)('maps "%s" to %s', (key, action) => {
    expect(shortcutFor({ key })).toBe(action)
  })

  it.each([
    ['an unbound key', { key: 'x' }],
    ['a text input', { key: 'a', target: { tagName: 'INPUT' } }],
    ['a textarea', { key: 'e', target: { tagName: 'TEXTAREA' } }],
    ['a select', { key: 'r', target: { tagName: 'SELECT' } }],
    ['a contenteditable', { key: 'a', target: { isContentEditable: true } }],
    ['a browser shortcut (meta)', { key: 'a', metaKey: true }],
    ['a browser shortcut (ctrl)', { key: 'a', ctrlKey: true }],
    ['a browser shortcut (alt)', { key: 'e', altKey: true }],
  ])('ignores %s', (_label, event) => {
    expect(shortcutFor(event)).toBeNull()
  })
})
