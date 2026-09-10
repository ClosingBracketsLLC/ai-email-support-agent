import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { InboxScreen } from './inbox'

// TanStack Query's default scheduler defers every notification through a real `setTimeout(0)`
// (batching multiple synchronous updates into one tick) — outside RNTL's `act()` polling window,
// which stops as soon as a `waitFor` assertion passes. Running the scheduler synchronously (the
// library's own documented test recipe) keeps every state update inside the triggering `act()`.
notifyManager.setScheduler((callback) => callback())

type Ticket = {
  id: string; subject: string | null; customerEmail: string | null; customerName: string | null; status: string
  needsOwnerReason: string | null; categoryKey: string | null; categoryLabel: string | null; sentiment: string | null
  lastInboundAt: Date | null; inboundCount: number; agentAddress: string | null; spamFlagged: boolean; hasAttachments: boolean
  draft: null
}
type ListInput = { section: string }

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) — see
// agents.test.tsx's note; jest.mock() itself is hoisted above these declarations.
let mockTicketsBySection: Record<string, Ticket[]> = {}
let mockDegraded = false
let mockListInputs: ListInput[] = []
const mockPush = jest.fn()

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    inbox: {
      list: {
        infiniteQueryOptions: (
          input: ListInput,
          opts: { getNextPageParam: (p: { nextCursor: string | null }) => string | undefined; refetchInterval?: number },
        ) => {
          mockListInputs.push(input)
          return {
            queryKey: ['inbox', 'list', input.section],
            queryFn: () => Promise.resolve({ tickets: mockTicketsBySection[input.section] ?? [], nextCursor: null, degraded: mockDegraded }),
            initialPageParam: undefined,
            getNextPageParam: opts.getNextPageParam,
            refetchInterval: opts.refetchInterval,
          }
        },
      },
    },
  }),
}))

function oneTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1', subject: 'Help', customerEmail: 'a@b.com', customerName: 'A B', status: 'needs_owner',
    needsOwnerReason: null, categoryKey: null, categoryLabel: null, sentiment: null, lastInboundAt: null,
    inboundCount: 1, agentAddress: 'support@acme.com', spamFlagged: false, hasAttachments: false, draft: null, ...overrides,
  }
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<InboxScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockTicketsBySection = { to_review: [], auto_sending: [], recent: [] }
  mockDegraded = false
  mockListInputs = []
  mockPush.mockClear()
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

// Every wait below settles on RENDERED OUTPUT that only appears once the mocked fetch has actually
// resolved (the empty-state text, or a ticket row) — never on `mockListInputs` alone, which is
// populated synchronously at render time, before the fetch's promise settles. Waiting on that alone
// would let the test return while the promise was still pending, leaving a state update to land
// after teardown (outside any `act()` scope) and printing a spurious "not wrapped in act" warning.

test('defaults to "To review", fires inbox.list with that section, and shows its empty copy', async () => {
  await setup()
  await waitFor(() => expect(screen.getByText('Nothing needs you right now')).toBeTruthy())
  expect(mockListInputs.some((i) => i.section === 'to_review')).toBe(true)
  expect(screen.getByTestId('inbox-tab-to_review').props.accessibilityState.selected).toBe(true)
  expect(screen.getByTestId('inbox-tab-auto_sending').props.accessibilityState.selected).toBe(false)
})

test('pressing "Auto-sending" fires inbox.list with section=auto_sending, selects that tab, and shows its empty copy', async () => {
  await setup()
  await waitFor(() => expect(screen.getByText('Nothing needs you right now')).toBeTruthy())

  fireEvent.press(screen.getByTestId('inbox-tab-auto_sending'))

  await waitFor(() => expect(screen.getByText('Nothing is auto-sending — autopilot arrives later')).toBeTruthy())
  expect(mockListInputs.some((i) => i.section === 'auto_sending')).toBe(true)
  expect(screen.getByTestId('inbox-tab-auto_sending').props.accessibilityState.selected).toBe(true)
})

test('pressing "Recent" fires inbox.list with section=recent and shows its empty copy', async () => {
  await setup()
  await waitFor(() => expect(screen.getByText('Nothing needs you right now')).toBeTruthy())

  fireEvent.press(screen.getByTestId('inbox-tab-recent'))

  await waitFor(() => expect(screen.getByText('Connected mail shows up here')).toBeTruthy())
  expect(mockListInputs.some((i) => i.section === 'recent')).toBe(true)
})

test('renders one row per returned ticket, and pressing it pushes to the ticket screen', async () => {
  mockTicketsBySection.to_review = [oneTicket({ id: 't1', subject: 'Where is my order?' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('ticket-row-t1')).toBeTruthy())
  expect(screen.getByText('Where is my order?')).toBeTruthy()

  fireEvent.press(screen.getByTestId('ticket-row-t1'))
  expect(mockPush).toHaveBeenCalledWith('/ticket/t1')
})

test('a degraded page warns that tickets may be missing', async () => {
  mockDegraded = true
  mockTicketsBySection.to_review = [oneTicket({ id: 't1' })]
  await setup()

  await waitFor(() => expect(screen.getByTestId('inbox-degraded')).toBeTruthy())
  expect(screen.getByText('Some tickets may be missing — pull down to refresh.')).toBeTruthy()
})

test('no degraded banner on an ordinary page', async () => {
  mockTicketsBySection.to_review = [oneTicket({ id: 't1' })]
  await setup()

  await waitFor(() => expect(screen.getByTestId('ticket-row-t1')).toBeTruthy())
  expect(screen.queryByTestId('inbox-degraded')).toBeNull()
})
