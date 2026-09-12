import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { TicketScreen, shortcutFor } from './ticket'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
const mockTicketId = '11111111-1111-4111-8111-111111111111'
const mockDraftId = '22222222-2222-4222-8222-222222222222'
/** The draft a reject→redraft puts on this same mounted screen. */
const mockRedraftId = '33333333-3333-4333-8333-333333333333'

interface MockDraft {
  id: string; version: number; status: string; body: string; finalBody: string | null
  decisionReason: string; confidence: number | null; guardrailResult: unknown
  confidenceBreakdown: unknown; decisionSource: string | null; flaggedAt: Date | null
  send: unknown; viewedAt: Date | null; undoUntil: Date | null
}
interface MockTicket {
  id: string; subject: string | null; status: string; needsOwnerReason: string | null
  agentAddress: string | null; categoryLabel: string | null; redraftCount: number
}

let mockDraft: MockDraft | null = null
/** When set, every query after the first returns THIS view — the reject→redraft handover (and the
 * window in between, where the live draft is gone and the ticket is back on `triaged`). */
let mockLater: { draft: MockDraft | null; ticket?: MockTicket } | null = null
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
const mockFlagCalls: unknown[] = []

let mockApproveImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({})
let mockHoldImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ held: true })
let mockRejectImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ resolution: 'redraft' })
let mockMarkViewedImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ viewed: true })
let mockResumeImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ resumed: true })
let mockResolveImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ resolved: true })

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
              const later = mockTicketQueries > 1 ? mockLater : null
              return Promise.resolve({
                ticket: later?.ticket ?? mockTicket,
                messages: [],
                draft: later ? later.draft : mockDraft,
              })
            },
            ...opts,
          }
        },
        queryKey: (input: { ticketId: string }) => ['inbox', 'ticket', input.ticketId],
      },
      list: { queryKey: () => ['inbox', 'list'] },
      resolve: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockResolveCalls.push(v); return mockResolveImpl(v) }, ...o }) },
    },
    drafts: {
      markViewed: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockMarkViewedCalls.push(v); return mockMarkViewedImpl(v) }, ...o }) },
      approve: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockApproveCalls.push(v); return mockApproveImpl(v) }, ...o }) },
      hold: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockHoldCalls.push(v); return mockHoldImpl(v) }, ...o }) },
      reject: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockRejectCalls.push(v); return mockRejectImpl(v) }, ...o }) },
      resume: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockResumeCalls.push(v); return mockResumeImpl(v) }, ...o }) },
      flagAutoSent: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockFlagCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
    },
  }),
}))

function pendingDraft(overrides: Partial<MockDraft> = {}): MockDraft {
  return {
    id: mockDraftId, version: 1, status: 'pending', body: 'Your order ships tomorrow.', finalBody: null,
    decisionReason: 'cold_start', confidence: 0.82, guardrailResult: { ok: true, findings: [] },
    confidenceBreakdown: {}, decisionSource: null, flaggedAt: null,
    send: null, viewedAt: null, undoUntil: null, ...overrides,
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
  mockLater = null
  mockTicketQueries = 0
  mockTicketOpts = {}
  mockUndoUntil = new Date(Date.now() + 15_000)
  mockBack.mockReset()
  for (const calls of [mockMarkViewedCalls, mockApproveCalls, mockHoldCalls, mockRejectCalls, mockResumeCalls, mockResolveCalls, mockFlagCalls]) calls.length = 0
  mockApproveImpl = () => Promise.resolve({ sendId: 'send-1', sendAfter: mockUndoUntil, undoUntil: mockUndoUntil })
  mockHoldImpl = () => Promise.resolve({ held: true })
  mockRejectImpl = () => Promise.resolve({ resolution: 'redraft', guidanceAdded: false })
  mockMarkViewedImpl = () => Promise.resolve({ viewed: true })
  mockResumeImpl = () => Promise.resolve({ resumed: true })
  mockResolveImpl = () => Promise.resolve({ resolved: true })
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
  expect(mockRejectCalls).toEqual([{ draftId: mockDraftId, action: 'redraft', reason: 'Too formal', addToGuidance: false }])
})

test('"I\'ll handle it" hands the ticket to the owner', async () => {
  mockRejectImpl = () => Promise.resolve({ resolution: 'escalate_terminal', guidanceAdded: false })
  await setup()
  await waitFor(() => expect(screen.getByTestId('reject')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reject'))
  await fireEvent.press(screen.getByTestId('reject-handle'))

  await waitFor(() => expect(screen.getByText('Marked for you to handle.')).toBeTruthy())
  expect(mockRejectCalls).toEqual([{ draftId: mockDraftId, action: 'handle', reason: '', addToGuidance: false }])
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
  // No live draft while the ticket is back on `triaged`: a draft (or a re-draft) is being written.
  expect(refetchInterval({ state: { data: { draft: null, ticket: { status: 'triaged' } } } })).toBe(10_000)
  expect(refetchInterval({ state: { data: { draft: null, ticket: { status: 'resolved' } } } })).toBe(false)
  expect(refetchInterval({ state: { data: { draft: null, ticket: { status: 'needs_owner' } } } })).toBe(false)
  // A stale send fails the draft and sends the ticket back to `triaged` for a re-draft; the api
  // serves that failed draft in the live one's place, so it must not stop the poll.
  expect(refetchInterval({ state: { data: { draft: { status: 'failed' }, ticket: { status: 'triaged' } } } })).toBe(10_000)
  expect(refetchInterval({ state: { data: { draft: { status: 'failed' }, ticket: { status: 'needs_owner' } } } })).toBe(false)
  // Once the re-draft lands the ordinary rule takes over again.
  expect(refetchInterval({ state: { data: { draft: { status: 'pending' }, ticket: { status: 'triaged' } } } })).toBe(false)
})

test('the poll covers the re-draft window a reject opens, and the promise stays on screen until it lands', async () => {
  mockLater = { draft: null, ticket: { ...mockTicket, status: 'triaged' } }
  await setup()
  await waitFor(() => expect(screen.getByTestId('reject')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reject'))
  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Too formal')
  await fireEvent.press(screen.getByTestId('reject-redraft'))

  // The live draft is gone (the api returns only live drafts), so the panel goes with it.
  await waitFor(() => expect(screen.queryByTestId('draft-panel')).toBeNull())
  expect(screen.getByText('The agent is re-drafting — a new draft will appear here.')).toBeTruthy()

  const refetchInterval = mockTicketOpts.refetchInterval as (q: { state: { data: unknown } }) => number | false
  expect(refetchInterval({ state: { data: { draft: null, ticket: { status: 'triaged' } } } })).toBe(10_000)
})

test('a stale banner clears when a different draft takes the panel over', async () => {
  mockLater = { draft: pendingDraft({ id: mockRedraftId, version: 2, viewedAt: new Date('2026-01-01T00:00:00Z') }) }
  await setup()
  await waitFor(() => expect(screen.getByTestId('reject')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reject'))
  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Too formal')
  await fireEvent.press(screen.getByTestId('reject-redraft'))

  await waitFor(() => expect(screen.getByText('Draft reply · v2')).toBeTruthy())
  expect(screen.queryByTestId('ticket-note')).toBeNull()
})

test('a viewed-mark that fails retries itself once, and Approve comes back when the retry lands', async () => {
  let attempts = 0
  mockMarkViewedImpl = () => {
    attempts += 1
    return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ viewed: true })
  }
  mockDraft = pendingDraft({ viewedAt: null })
  await setup()

  await waitFor(() => expect(screen.getByTestId('approve').props.accessibilityState.disabled).toBe(false))
  expect(mockMarkViewedCalls).toHaveLength(2)
  expect(screen.queryByTestId('ticket-note')).toBeNull()
  expect(screen.queryByTestId('retry-view')).toBeNull()
})

test('a viewed-mark that fails twice says so and offers a retry that re-fires it', async () => {
  let attempts = 0
  mockMarkViewedImpl = () => {
    attempts += 1
    return attempts <= 2 ? Promise.reject(new Error('offline')) : Promise.resolve({ viewed: true })
  }
  mockDraft = pendingDraft({ viewedAt: null })
  await setup()

  await waitFor(() => expect(screen.getByTestId('retry-view')).toBeTruthy())
  expect(screen.getByText('Could not open the draft — tap to retry')).toBeTruthy()
  // The one button the whole review flow exists for stays shut until the server has recorded the read.
  expect(screen.getByTestId('approve').props.accessibilityState.disabled).toBe(true)
  expect(mockMarkViewedCalls).toHaveLength(2)

  await fireEvent.press(screen.getByTestId('retry-view'))

  await waitFor(() => expect(screen.getByTestId('approve').props.accessibilityState.disabled).toBe(false))
  expect(mockMarkViewedCalls).toHaveLength(3)
  expect(screen.queryByTestId('ticket-note')).toBeNull()
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

test('a second draft on the same screen has to be opened on its own before Approve comes back', async () => {
  // The reject→redraft handover: the screen never unmounts, so a viewed flag that is not keyed to the
  // draft would hand the new draft an enabled Approve nobody had read.
  let resolveRedraftView: (() => void) | undefined
  mockMarkViewedImpl = (input) => {
    if ((input as { draftId: string }).draftId !== mockRedraftId) return Promise.resolve({ viewed: true })
    return new Promise((res) => { resolveRedraftView = () => res({ viewed: true }) })
  }
  mockDraft = pendingDraft({ viewedAt: null })
  mockLater = { draft: pendingDraft({ id: mockRedraftId, version: 2, viewedAt: null }) }
  await setup()

  await waitFor(() => expect(mockMarkViewedCalls).toEqual([{ draftId: mockDraftId }, { draftId: mockRedraftId }]))
  expect(screen.getByText('Draft reply · v2')).toBeTruthy()
  expect(screen.getByTestId('approve').props.accessibilityState.disabled).toBe(true)

  await act(async () => { resolveRedraftView?.() })
  await waitFor(() => expect(screen.getByTestId('approve').props.accessibilityState.disabled).toBe(false))
  expect(mockMarkViewedCalls).toHaveLength(2)
})

test('a resume that found nothing on hold says so instead of pretending it worked', async () => {
  mockResumeImpl = () => Promise.resolve({ resumed: false })
  mockDraft = pendingDraft({ status: 'held', send: { id: 'send-1', status: 'held', sendAfter: new Date(), sentAt: null, lastError: 'held:category_off' } })
  await setup()

  await waitFor(() => expect(screen.getByTestId('resume')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('resume'))

  await waitFor(() => expect(screen.getByText('This draft is no longer on hold.')).toBeTruthy())
})

test('a resolve that resolved nothing says so instead of pretending it worked', async () => {
  mockResolveImpl = () => Promise.resolve({ resolved: false })
  mockDraft = null
  mockTicket = { ...mockTicket, status: 'needs_owner', needsOwnerReason: 'tripwire' }
  await setup()

  await waitFor(() => expect(screen.getByTestId('resolve')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('resolve'))
  await fireEvent.press(screen.getByTestId('resolve'))

  await waitFor(() => expect(screen.getByText('This ticket was already resolved.')).toBeTruthy())
})

test('an approved draft still inside its undo window shows the undo bar without an approve press', async () => {
  mockDraft = pendingDraft({
    status: 'approved', viewedAt: new Date('2026-01-01T00:00:00Z'), undoUntil: new Date(Date.now() + 10_000),
    send: { id: 'send-1', status: 'queued', sendAfter: new Date(Date.now() + 10_000), sentAt: null, lastError: null },
  })
  await setup()

  await waitFor(() => expect(screen.getByTestId('undo-bar')).toBeTruthy())
  expect(mockApproveCalls).toHaveLength(0)
})

test('an undo window that has already closed shows no undo bar', async () => {
  mockDraft = pendingDraft({
    status: 'approved', viewedAt: new Date('2026-01-01T00:00:00Z'), undoUntil: new Date(Date.now() - 1_000),
    send: { id: 'send-1', status: 'queued', sendAfter: new Date(Date.now() - 1_000), sentAt: null, lastError: null },
  })
  await setup()

  await waitFor(() => expect(screen.getByTestId('draft-panel')).toBeTruthy())
  expect(screen.queryByTestId('undo-bar')).toBeNull()
  expect(screen.getByText('Approved — going out shortly.')).toBeTruthy()
})

// --- Phase 5: reject-to-guidance, and the owner's last word on a reply that already went out.

test("the reject sheet's guidance switch rides along, and the note says the rule was added", async () => {
  mockRejectImpl = () => Promise.resolve({ resolution: 'redraft', guidanceAdded: true })
  await setup()
  await waitFor(() => expect(screen.getByTestId('reject')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reject'))
  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Never promise a delivery date')
  await fireEvent(screen.getByTestId('reject-add-guidance'), 'valueChange', true)
  await fireEvent.press(screen.getByTestId('reject-redraft'))

  expect(mockRejectCalls).toEqual([{ draftId: mockDraftId, action: 'redraft', reason: 'Never promise a delivery date', addToGuidance: true }])
  await waitFor(() => expect(screen.getByText('The agent is re-drafting — a new draft will appear here. Added to your guidance.')).toBeTruthy())
})

test('a guidance that was already full says the reply was still rejected, without claiming a rule was added', async () => {
  mockRejectImpl = () => Promise.resolve({ resolution: 'redraft', guidanceAdded: false })
  await setup()
  await waitFor(() => expect(screen.getByTestId('reject')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reject'))
  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Never promise a delivery date')
  await fireEvent(screen.getByTestId('reject-add-guidance'), 'valueChange', true)
  await fireEvent.press(screen.getByTestId('reject-redraft'))

  await waitFor(() => expect(screen.getByText('The agent is re-drafting — a new draft will appear here.')).toBeTruthy())
})

test('"Should not have sent" flags the auto-sent reply', async () => {
  mockDraft = pendingDraft({ status: 'sent', decisionSource: 'auto', viewedAt: new Date('2026-01-01T00:00:00Z') })
  await setup()
  await waitFor(() => expect(screen.getByTestId('flag-auto-sent')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('flag-auto-sent'))

  expect(mockFlagCalls).toEqual([{ draftId: mockDraftId }])
  await waitFor(() => expect(screen.getByText('Flagged — the agent will not reuse what it learned here.')).toBeTruthy())
})
