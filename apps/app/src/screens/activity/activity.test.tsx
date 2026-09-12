import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { ActivityScreen, formatUsd } from './activity'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

interface RecentItem {
  ticketId: string
  draftId: string
  subject: string | null
  customerEmail: string | null
  agentAddress: string | null
  sentAt: Date | null
  decisionSource: string | null
  editDistanceRatio: number | null
}
interface Summary {
  days: 7 | 30
  drafted: number
  approvedUnchanged: number
  approvedEdited: number
  rejected: number
  sent: number
  escalated: number
  autoSent: number
  costMicros: number
  byokCostMicros: number
  aiHandledConversations: number
  recent: RecentItem[]
}

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}))

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
let mockSummaryByDays: Record<number, Summary> = {}
let mockSummaryInputs: { days: number }[] = []

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activity: {
      summary: {
        queryOptions: (input: { days: number }) => {
          mockSummaryInputs.push(input)
          return { queryKey: ['activity', 'summary', input], queryFn: () => Promise.resolve(mockSummaryByDays[input.days]) }
        },
      },
    },
  }),
}))

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    days: 7, drafted: 10, approvedUnchanged: 3, approvedEdited: 2, rejected: 1, sent: 5, escalated: 1,
    autoSent: 0, costMicros: 420_000, byokCostMicros: 0, aiHandledConversations: 4, recent: [], ...overrides,
  }
}
function recentItem(overrides: Partial<RecentItem> = {}): RecentItem {
  return {
    ticketId: 't1', draftId: 'd1', subject: 'Help with billing', customerEmail: 'a@b.com',
    agentAddress: 'support@acme.com', sentAt: new Date(), decisionSource: 'app', editDistanceRatio: 0,
    ...overrides,
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
  const rendered = await render(<ActivityScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockPush.mockReset()
  mockSummaryInputs = []
  mockSummaryByDays = { 7: summary(), 30: summary({ days: 30, drafted: 40 }) }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test("formatUsd follows the brief's exact table", () => {
  expect(formatUsd(0)).toBe('$0.00')
  expect(formatUsd(5000)).toBe('<$0.01')
  expect(formatUsd(420_000)).toBe('$0.42')
  expect(formatUsd(1_234_567)).toBe('$1.23')
})

test('formatUsd clamps a negative to zero rather than rendering "$-0.00"', () => {
  expect(formatUsd(-1)).toBe('$0.00')
  expect(formatUsd(-420_000)).toBe('$0.00')
})

test('renders the tiles from a mocked summary, including the AI cost and the approved unchanged/edited subtitle', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('stat-drafted')).toBeTruthy())

  expect(within(screen.getByTestId('stat-drafted')).getByText('10')).toBeTruthy()
  expect(within(screen.getByTestId('stat-approved')).getByText('5')).toBeTruthy()
  expect(within(screen.getByTestId('stat-approved')).getByText('3 unchanged · 2 edited')).toBeTruthy()
  expect(within(screen.getByTestId('stat-rejected')).getByText('1')).toBeTruthy()
  expect(within(screen.getByTestId('stat-sent')).getByText('5')).toBeTruthy()
  expect(within(screen.getByTestId('stat-auto-sent')).getByText('0')).toBeTruthy()
  expect(within(screen.getByTestId('stat-escalated')).getByText('1')).toBeTruthy()
  expect(within(screen.getByTestId('stat-ai-cost')).getByText('$0.42')).toBeTruthy()
  expect(within(screen.getByTestId('stat-ai-handled')).getByText('4')).toBeTruthy()
})

test('the AI cost tile shows managed + BYOK spend, and says how much of it is on the workspace\'s own keys', async () => {
  // Phase 6 routes BYOK cost to its own meter (it must never trip the platform's daily cap); a
  // workspace fully on its own key used to read "$0.00" here while it was spending real money.
  mockSummaryByDays[7] = summary({ costMicros: 420_000, byokCostMicros: 1_580_000 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('stat-ai-cost')).toBeTruthy())
  expect(within(screen.getByTestId('stat-ai-cost')).getByText('$2.00')).toBeTruthy()
  expect(within(screen.getByTestId('stat-ai-cost')).getByText('$1.58 of this on your own provider keys')).toBeTruthy()
})

test('the AI cost tile has no BYOK subtitle when nothing was spent on a workspace key', async () => {
  mockSummaryByDays[7] = summary({ costMicros: 420_000, byokCostMicros: 0 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('stat-ai-cost')).toBeTruthy())
  expect(within(screen.getByTestId('stat-ai-cost')).getByText('$0.42')).toBeTruthy()
  expect(within(screen.getByTestId('stat-ai-cost')).queryByText(/your own provider keys/)).toBeNull()
})

test('the Auto-sent tile renders activity.summary.autoSent', async () => {
  mockSummaryByDays[7] = summary({ autoSent: 4 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('stat-auto-sent')).toBeTruthy())
  expect(within(screen.getByTestId('stat-auto-sent')).getByText('Auto-sent')).toBeTruthy()
  expect(within(screen.getByTestId('stat-auto-sent')).getByText('4')).toBeTruthy()
})

test('the days toggle re-queries with { days: 30 } and the tiles update', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('stat-drafted')).toBeTruthy())
  // `queryOptions({ days })` is called on every render (React Query does not memoize it), so the
  // exact call count isn't meaningful here — only that nothing has asked for 30 days yet.
  expect(mockSummaryInputs.every((i) => i.days === 7)).toBe(true)

  await fireEvent.press(screen.getByTestId('activity-days-30'))
  await waitFor(() => expect(mockSummaryInputs.at(-1)).toEqual({ days: 30 }))
  await waitFor(() => expect(within(screen.getByTestId('stat-drafted')).getByText('40')).toBeTruthy())
})

test('the empty state shows when nothing has been sent yet', async () => {
  mockSummaryByDays[7] = summary({ recent: [] })
  await setup()
  await waitFor(() => expect(screen.getByTestId('activity-empty')).toBeTruthy())
  expect(screen.getByText('Nothing sent yet — approve your first draft from the inbox.')).toBeTruthy()
})

test('a recent row shows the "edited" badge and pressing it pushes the ticket route', async () => {
  mockSummaryByDays[7] = summary({ recent: [recentItem({ draftId: 'd1', ticketId: 't1', editDistanceRatio: 0.3 })] })
  await setup()
  await waitFor(() => expect(screen.getByTestId('activity-recent-d1')).toBeTruthy())
  expect(screen.getByText('edited')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('activity-recent-d1'))
  expect(mockPush).toHaveBeenCalledWith('/ticket/t1')
})

test('a recent row approved unchanged (editDistanceRatio 0) shows no badge', async () => {
  mockSummaryByDays[7] = summary({ recent: [recentItem({ draftId: 'd2', editDistanceRatio: 0 })] })
  await setup()
  await waitFor(() => expect(screen.getByTestId('activity-recent-d2')).toBeTruthy())
  expect(screen.queryByText('edited')).toBeNull()
})
