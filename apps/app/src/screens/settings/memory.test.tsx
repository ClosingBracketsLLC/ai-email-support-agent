import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { MemoryScreen } from './memory'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const ACTIVE_ID = '33333333-3333-4333-8333-333333333333'
const RETIRED_ID = '44444444-4444-4444-8444-444444444444'
const TICKET_ID = '55555555-5555-4555-8555-555555555555'

interface Answer {
  id: string; status: string; question: string; answer: string; approvals: number; strikes: number
  reuseCount: number; wasEdited: boolean; reviewReason: string | null; retiredReason: string | null
  categoryLabel: string | null; agentAddress: string | null; sourceTicketId: string | null
  createdAt: Date; lastApprovedAt: Date | null; expiresAt: Date
}

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations (see agents.test.tsx).
let mockAnswersByTab: Record<string, Answer[]> = {}
let mockSummary = { candidate: 0, active: 0, needsReview: 0, retired: 0, toCheck: 0 }
let mockRole = 'owner'
let mockDeleted = 0
const mockListInputs: { tab: string }[] = []
const mockKeepCalls: unknown[] = []
const mockRetireCalls: unknown[] = []
const mockConfirmCalls: unknown[] = []
const mockRejectCalls: unknown[] = []
const mockDeleteCalls: unknown[] = []
const mockPush = jest.fn()

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: { queryOptions: () => ({ queryKey: ['workspace', 'get'], queryFn: () => Promise.resolve({ businessName: 'Acme', role: mockRole }) }) },
    },
    memory: {
      summary: {
        queryOptions: () => ({ queryKey: ['memory', 'summary'], queryFn: () => Promise.resolve(mockSummary) }),
        queryKey: () => ['memory', 'summary'],
      },
      list: {
        queryOptions: (input: { tab: string }) => ({
          queryKey: ['memory', 'list', input.tab],
          queryFn: () => { mockListInputs.push(input); return Promise.resolve({ answers: mockAnswersByTab[input.tab] ?? [] }) },
        }),
        queryKey: () => ['memory', 'list'],
      },
      keep: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockKeepCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
      retire: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockRetireCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
      confirmCandidate: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockConfirmCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
      rejectCandidate: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockRejectCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
      deleteByCustomer: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockDeleteCalls.push(v); return Promise.resolve({ deleted: mockDeleted }) }, ...o }) },
    },
  }),
}))

function answer(overrides: Partial<Answer> = {}): Answer {
  return {
    id: CANDIDATE_ID, status: 'candidate', question: 'Where is my order?', answer: 'It ships tomorrow.',
    approvals: 0, strikes: 0, reuseCount: 0, wasEdited: false, reviewReason: null, retiredReason: null,
    categoryLabel: 'Shipping', agentAddress: 'support@acme.com', sourceTicketId: null,
    createdAt: new Date('2026-09-01T00:00:00Z'), lastApprovedAt: null, expiresAt: new Date('2027-09-01T00:00:00Z'),
    ...overrides,
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
  const rendered = await render(<MemoryScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockAnswersByTab = { to_check: [], active: [], retired: [] }
  mockSummary = { candidate: 2, active: 5, needsReview: 1, retired: 4, toCheck: 3 }
  mockRole = 'owner'
  mockDeleted = 0
  mockListInputs.length = 0
  for (const calls of [mockKeepCalls, mockRetireCalls, mockConfirmCalls, mockRejectCalls, mockDeleteCalls]) calls.length = 0
  mockPush.mockReset()
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('three tabs; To check lists candidates with Looks good / Should not have sent and needs_review rows with Keep / Retire', async () => {
  mockAnswersByTab.to_check = [
    answer({ sourceTicketId: TICKET_ID }),
    answer({ id: REVIEW_ID, status: 'needs_review', reviewReason: 'model_conflict', question: 'Do you ship to Spain?', answer: 'Yes, in 5 days.', categoryLabel: null, agentAddress: 'sales@acme.com' }),
  ]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`answer-${CANDIDATE_ID}`)).toBeTruthy())

  expect(screen.getByTestId('memory-tab-to_check')).toBeTruthy()
  expect(screen.getByTestId('memory-tab-active')).toBeTruthy()
  expect(screen.getByTestId('memory-tab-retired')).toBeTruthy()
  expect(screen.getByTestId('memory-tab-to_check').props.accessibilityState.selected).toBe(true)

  expect(screen.getByText('Q: Where is my order?')).toBeTruthy()
  expect(screen.getByText('A: It ships tomorrow.')).toBeTruthy()
  expect(screen.getByText('Shipping · support@acme.com')).toBeTruthy()
  // An answer with no category of its own still says which agent learned it.
  expect(screen.getByText('Uncategorized · sales@acme.com')).toBeTruthy()
  expect(screen.getByText('Auto-sent · unchecked')).toBeTruthy()
  expect(screen.getByText('The agent has answered this differently since')).toBeTruthy()

  await fireEvent.press(screen.getByTestId(`confirm-${CANDIDATE_ID}`))
  expect(mockConfirmCalls).toEqual([{ answerId: CANDIDATE_ID }])
  await fireEvent.press(screen.getByTestId(`reject-${CANDIDATE_ID}`))
  expect(mockRejectCalls).toEqual([{ answerId: CANDIDATE_ID }])

  // A parked answer is the OTHER pair: it already passed sampling, so the question is keep or forget.
  expect(screen.queryByTestId(`confirm-${REVIEW_ID}`)).toBeNull()
  await fireEvent.press(screen.getByTestId(`keep-${REVIEW_ID}`))
  expect(mockKeepCalls).toEqual([{ answerId: REVIEW_ID }])
  await fireEvent.press(screen.getByTestId(`retire-${REVIEW_ID}`))
  expect(mockRetireCalls).toEqual([{ answerId: REVIEW_ID }])

  // Only a row that names its source ticket offers the way back to it.
  await fireEvent.press(screen.getByTestId(`open-ticket-${CANDIDATE_ID}`))
  expect(mockPush).toHaveBeenCalledWith(`/ticket/${TICKET_ID}`)
  expect(screen.queryByTestId(`open-ticket-${REVIEW_ID}`)).toBeNull()
})

test('Active rows have Retire and their approval count; Retired rows have no actions at all', async () => {
  mockAnswersByTab.active = [answer({ id: ACTIVE_ID, status: 'active', approvals: 3 })]
  mockAnswersByTab.retired = [answer({ id: RETIRED_ID, status: 'retired', retiredReason: 'strikes' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('memory-tab-active')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('memory-tab-active'))
  await waitFor(() => expect(screen.getByTestId(`answer-${ACTIVE_ID}`)).toBeTruthy())
  expect(screen.getByText('3 approvals')).toBeTruthy()
  await fireEvent.press(screen.getByTestId(`retire-${ACTIVE_ID}`))
  expect(mockRetireCalls).toEqual([{ answerId: ACTIVE_ID }])
  expect(screen.queryByTestId(`keep-${ACTIVE_ID}`)).toBeNull()

  await fireEvent.press(screen.getByTestId('memory-tab-retired'))
  await waitFor(() => expect(screen.getByTestId(`answer-${RETIRED_ID}`)).toBeTruthy())
  expect(screen.getByText('Wrong too often')).toBeTruthy()
  expect(screen.queryByTestId(`retire-${RETIRED_ID}`)).toBeNull()
  expect(screen.queryByTestId(`keep-${RETIRED_ID}`)).toBeNull()
})

test('an empty tab says so rather than showing a blank screen', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('memory-empty')).toBeTruthy())
  expect(screen.getByText('Nothing to check — the agent samples its own auto-sends')).toBeTruthy()
})

test('the summary line reads "N to check · N active · N retired"', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('memory-summary')).toBeTruthy())
  expect(screen.getByTestId('memory-summary').props.children).toBe('3 to check · 5 active · 4 retired')
})

test('delete-by-customer asks for an email, confirms, calls deleteByCustomer and shows "Deleted N answers"', async () => {
  mockDeleted = 2
  await setup()
  await waitFor(() => expect(screen.getByTestId('delete-by-customer')).toBeTruthy())

  // Nothing to delete until an address is typed.
  expect(screen.getByTestId('delete-customer-submit').props.accessibilityState.disabled).toBe(true)
  await fireEvent.changeText(screen.getByTestId('delete-customer-email'), 'jane@example.com')
  expect(screen.getByTestId('delete-customer-submit').props.accessibilityState.disabled).toBe(false)

  // First press only arms the confirm — the delete is irreversible.
  await fireEvent.press(screen.getByTestId('delete-customer-submit'))
  expect(mockDeleteCalls).toHaveLength(0)

  await fireEvent.press(screen.getByTestId('delete-customer-submit'))
  expect(mockDeleteCalls).toEqual([{ email: 'jane@example.com' }])
  await waitFor(() => expect(screen.getByText('Deleted 2 answers')).toBeTruthy())
})

test('members see no actions', async () => {
  mockRole = 'member'
  mockAnswersByTab.to_check = [answer(), answer({ id: REVIEW_ID, status: 'needs_review', reviewReason: 'edited_reuse' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`answer-${CANDIDATE_ID}`)).toBeTruthy())

  expect(screen.getByTestId('memory-readonly')).toBeTruthy()
  expect(screen.queryByTestId(`confirm-${CANDIDATE_ID}`)).toBeNull()
  expect(screen.queryByTestId(`reject-${CANDIDATE_ID}`)).toBeNull()
  expect(screen.queryByTestId(`keep-${REVIEW_ID}`)).toBeNull()
  expect(screen.queryByTestId(`retire-${REVIEW_ID}`)).toBeNull()
  expect(screen.queryByTestId('delete-by-customer')).toBeNull()
})
