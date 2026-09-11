import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { GuidanceSuggestions } from './guidance-suggestions'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

const SUGGESTION_ID = '11111111-1111-4111-8111-111111111111'

interface Suggestion {
  id: string; text: string; rationale: string | null
  categoryLabel: string | null; agentAddress: string | null; createdAt: Date
}

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive).
let mockSuggestions: Suggestion[] = []
const mockAcceptCalls: unknown[] = []
const mockDismissCalls: unknown[] = []
let mockAcceptImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ ok: true })

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: { queryKey: () => ['workspace', 'get'] },
      guidanceSuggestions: {
        queryOptions: () => ({ queryKey: ['workspace', 'guidanceSuggestions'], queryFn: () => Promise.resolve({ suggestions: mockSuggestions }) }),
        queryKey: () => ['workspace', 'guidanceSuggestions'],
      },
      acceptSuggestion: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockAcceptCalls.push(v); return mockAcceptImpl(v) }, ...o }) },
      dismissSuggestion: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockDismissCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
    },
  }),
}))

function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: SUGGESTION_ID, text: 'Never promise a delivery date', rationale: 'You edited 3 replies that promised one',
    categoryLabel: 'Shipping', agentAddress: 'support@acme.com', createdAt: new Date('2026-09-01T00:00:00Z'), ...overrides,
  }
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup(canManage = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<GuidanceSuggestions canManage={canManage} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockSuggestions = [suggestion()]
  mockAcceptCalls.length = 0
  mockDismissCalls.length = 0
  mockAcceptImpl = () => Promise.resolve({ ok: true })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a pending suggestion renders with its rationale, and Add to guidance accepts it', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('guidance-suggestions')).toBeTruthy())

  expect(screen.getByText('Suggested rules')).toBeTruthy()
  expect(screen.getByText('From replies you edited')).toBeTruthy()
  expect(screen.getByText('Never promise a delivery date')).toBeTruthy()
  expect(screen.getByText('You edited 3 replies that promised one')).toBeTruthy()

  await fireEvent.press(screen.getByTestId(`accept-${SUGGESTION_ID}`))
  expect(mockAcceptCalls).toEqual([{ suggestionId: SUGGESTION_ID }])
})

test('Dismiss spends the suggestion without touching the guidance', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId(`dismiss-${SUGGESTION_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`dismiss-${SUGGESTION_ID}`))
  expect(mockDismissCalls).toEqual([{ suggestionId: SUGGESTION_ID }])
  expect(mockAcceptCalls).toHaveLength(0)
})

test('nothing renders at all when there is nothing to suggest', async () => {
  mockSuggestions = []
  await setup()
  await waitFor(() => expect(screen.queryByTestId('guidance-suggestions')).toBeNull())
})

test('a full guidance is said out loud rather than failing silently', async () => {
  mockAcceptImpl = () => Promise.reject(new Error('guidance_full'))
  await setup()
  await waitFor(() => expect(screen.getByTestId(`accept-${SUGGESTION_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`accept-${SUGGESTION_ID}`))
  await waitFor(() => expect(screen.getByText('Your guidance is full — remove something first')).toBeTruthy())
})

test('any other failure says so without blaming the guidance', async () => {
  mockAcceptImpl = () => Promise.reject(new Error('network down'))
  await setup()
  await waitFor(() => expect(screen.getByTestId(`accept-${SUGGESTION_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`accept-${SUGGESTION_ID}`))
  await waitFor(() => expect(screen.getByText('Could not add that rule. Try again.')).toBeTruthy())
})

test('a member reads the suggestions but cannot act on them', async () => {
  await setup(false)
  await waitFor(() => expect(screen.getByTestId('guidance-suggestions')).toBeTruthy())

  expect(screen.getByText('Never promise a delivery date')).toBeTruthy()
  expect(screen.queryByTestId(`accept-${SUGGESTION_ID}`)).toBeNull()
  expect(screen.queryByTestId(`dismiss-${SUGGESTION_ID}`)).toBeNull()
})
