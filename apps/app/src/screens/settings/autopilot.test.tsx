import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { AutopilotScreen } from './autopilot'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const SALES_AGENT_ID = '44444444-4444-4444-8444-444444444444'
const ORDERS = '22222222-2222-4222-8222-222222222222'
const RETURNS = '33333333-3333-4333-8333-333333333333'

interface Category {
  categoryId: string; key: string; label: string; mode: string
  autoSendMinConfidence: number | null; humanDecisionCount: number
  graduatedAt: Date | null; demotedAt: Date | null; demotedReason: string | null
  suggestion: { wouldSend: number; of: number; at: Date } | null
  stats30d: {
    drafted: number; approvedUnchanged: number; approvedEdited: number; rejected: number
    autoSent: number; autoSentFlagged: number; held: number
  }
}
interface Agent { id: string; connectionId: string; address: string; status: string }

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations (see agents.test.tsx).
let mockAgents: Agent[] = []
let mockAgentSettings = { autoGraduate: false, autoSendDelayMin: 2 }
let mockCategories: Category[] = []
let mockCategoryInputs: { agentId: string }[] = []
let mockRole = 'owner'
const mockPolicyCalls: unknown[] = []
const mockUpdateCalls: unknown[] = []
let mockPolicyImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ ok: true })

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: { queryOptions: () => ({ queryKey: ['workspace', 'get'], queryFn: () => Promise.resolve({ businessName: 'Acme', role: mockRole }) }) },
    },
    agents: {
      list: {
        queryOptions: () => ({ queryKey: ['agents', 'list'], queryFn: () => Promise.resolve({ agents: mockAgents }) }),
        queryKey: () => ['agents', 'list'],
      },
      categories: {
        queryOptions: (input: { agentId: string }, opts: object) => ({
          queryKey: ['agents', 'categories', input.agentId],
          queryFn: () => { mockCategoryInputs.push(input); return Promise.resolve({ agent: mockAgentSettings, coldStartAt: 10, categories: mockCategories }) },
          ...opts,
        }),
        queryKey: (input: { agentId: string }) => ['agents', 'categories', input.agentId],
      },
      setCategoryPolicy: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockPolicyCalls.push(v); return mockPolicyImpl(v) }, ...o }) },
      update: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockUpdateCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
    },
  }),
}))

function category(overrides: Partial<Category> = {}): Category {
  return {
    categoryId: ORDERS, key: 'order_status', label: 'Order status', mode: 'review',
    autoSendMinConfidence: null, humanDecisionCount: 12,
    graduatedAt: null, demotedAt: null, demotedReason: null, suggestion: null,
    stats30d: { drafted: 20, approvedUnchanged: 14, approvedEdited: 3, rejected: 1, autoSent: 0, autoSentFlagged: 0, held: 0 },
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
  const rendered = await render(<AutopilotScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockAgents = [{ id: AGENT_ID, connectionId: 'conn-1', address: 'support@acme.com', status: 'active' }]
  mockAgentSettings = { autoGraduate: false, autoSendDelayMin: 2 }
  mockCategories = [category()]
  mockCategoryInputs = []
  mockRole = 'owner'
  mockPolicyCalls.length = 0
  mockUpdateCalls.length = 0
  mockPolicyImpl = () => Promise.resolve({ ok: true })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

const state = (testID: string) => screen.getByTestId(testID).props.accessibilityState

test('renders one row per category with the mode control; Auto is disabled with the lock copy under 10 decisions and enabled at 10', async () => {
  mockCategories = [
    category({ humanDecisionCount: 4 }),
    category({
      categoryId: RETURNS, key: 'returns_refunds', label: 'Returns & refunds', humanDecisionCount: 10,
      stats30d: { drafted: 9, approvedUnchanged: 8, approvedEdited: 0, rejected: 0, autoSent: 5, autoSentFlagged: 0, held: 1 },
    }),
  ]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`category-${ORDERS}`)).toBeTruthy())

  expect(screen.getByText('Order status')).toBeTruthy()
  expect(screen.getByText('Returns & refunds')).toBeTruthy()
  expect(screen.getByText('Last 30 days: 14 unchanged · 3 edited · 1 rejected · 0 auto-sent')).toBeTruthy()
  expect(screen.getByText('Last 30 days: 8 unchanged · 0 edited · 0 rejected · 5 auto-sent')).toBeTruthy()
  expect(state(`mode-review-${ORDERS}`).checked).toBe(true)

  // Under the cold-start floor: Auto is locked and says why, in the owner's own numbers.
  expect(state(`mode-auto-${ORDERS}`).disabled).toBe(true)
  expect(screen.getByTestId(`cold-start-${ORDERS}`).props.children).toBe('Auto unlocks after 10 decisions (4 so far)')
  // At the floor it is live, and the lock copy is gone.
  expect(state(`mode-auto-${RETURNS}`).disabled).toBe(false)
  expect(screen.queryByTestId(`cold-start-${RETURNS}`)).toBeNull()

  await fireEvent.press(screen.getByTestId(`mode-auto-${ORDERS}`))
  expect(mockPolicyCalls).toHaveLength(0)
})

test('choosing Auto calls setCategoryPolicy with mode auto and the Balanced preset by default', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId(`mode-auto-${ORDERS}`)).toBeTruthy())

  // The presets only exist once the category IS on auto.
  expect(screen.queryByTestId(`preset-balanced-${ORDERS}`)).toBeNull()
  await fireEvent.press(screen.getByTestId(`mode-auto-${ORDERS}`))
  expect(mockPolicyCalls).toEqual([{ agentId: AGENT_ID, categoryId: ORDERS, mode: 'auto', autoSendMinConfidence: 80 }])
})

test('choosing a preset re-calls setCategoryPolicy with that threshold', async () => {
  mockCategories = [category({ mode: 'auto', autoSendMinConfidence: 80 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`preset-balanced-${ORDERS}`)).toBeTruthy())
  expect(state(`preset-balanced-${ORDERS}`).checked).toBe(true)

  await fireEvent.press(screen.getByTestId(`preset-cautious-${ORDERS}`))
  expect(mockPolicyCalls).toEqual([{ agentId: AGENT_ID, categoryId: ORDERS, mode: 'auto', autoSendMinConfidence: 90 }])
})

test('Off and Review carry no threshold at all', async () => {
  mockCategories = [category({ mode: 'auto', autoSendMinConfidence: 90 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`mode-off-${ORDERS}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`mode-off-${ORDERS}`))
  expect(mockPolicyCalls).toEqual([{ agentId: AGENT_ID, categoryId: ORDERS, mode: 'off' }])
})

test('a threshold that matches no preset is shown as a custom value rather than silently rounded', async () => {
  mockCategories = [category({ mode: 'auto', autoSendMinConfidence: 77 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`preset-custom-${ORDERS}`)).toBeTruthy())
  expect(screen.getByText('Custom · 77%')).toBeTruthy()
  expect(state(`preset-balanced-${ORDERS}`).checked).toBe(false)
})

test('a suggestion renders the "would have auto-sent X of your last Y" banner with a Turn on button that calls setCategoryPolicy auto', async () => {
  mockCategories = [category({ suggestion: { wouldSend: 9, of: 10, at: new Date('2026-09-10T00:00:00Z') } })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`suggestion-${ORDERS}`)).toBeTruthy())

  expect(screen.getByText('Ready for Autopilot — it would have auto-sent 9 of your last 10 unchanged approvals at Balanced.')).toBeTruthy()
  await fireEvent.press(screen.getByTestId(`suggestion-turn-on-${ORDERS}`))
  expect(mockPolicyCalls).toEqual([{ agentId: AGENT_ID, categoryId: ORDERS, mode: 'auto', autoSendMinConfidence: 80 }])
})

test('a demoted category shows the demotion notice with its reason sentence', async () => {
  mockCategories = [category({ mode: 'review', demotedAt: new Date(Date.now() - 2 * 3_600_000), demotedReason: 'flags' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`demoted-${ORDERS}`)).toBeTruthy())
  expect(screen.getByText('Autopilot was paused 2h ago: two auto-sent replies were flagged')).toBeTruthy()
})

test('a re-graduated category keeps its old demotion stamp but shows no notice', async () => {
  mockCategories = [category({
    mode: 'auto', autoSendMinConfidence: 80,
    demotedAt: new Date('2026-09-01T00:00:00Z'), demotedReason: 'rejections', graduatedAt: new Date('2026-09-05T00:00:00Z'),
  })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`category-${ORDERS}`)).toBeTruthy())
  expect(screen.queryByTestId(`demoted-${ORDERS}`)).toBeNull()
})

test('auto-graduate switch and the delay radio call agents.update', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('auto-graduate')).toBeTruthy())

  await fireEvent(screen.getByTestId('auto-graduate'), 'valueChange', true)
  expect(mockUpdateCalls).toEqual([{ agentId: AGENT_ID, autoGraduate: true }])

  expect(state('delay-2').checked).toBe(true)
  await fireEvent.press(screen.getByTestId('delay-15'))
  expect(mockUpdateCalls[1]).toEqual({ agentId: AGENT_ID, autoSendDelayMin: 15 })
})

test('a refused switch to Auto is spoken in the owner\'s words', async () => {
  mockPolicyImpl = () => Promise.reject(new Error('cold_start'))
  await setup()
  await waitFor(() => expect(screen.getByTestId(`mode-auto-${ORDERS}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`mode-auto-${ORDERS}`))
  await waitFor(() => expect(screen.getByText('Auto unlocks after 10 decisions')).toBeTruthy())
})

test('a member (canManage false) sees everything read-only', async () => {
  mockRole = 'member'
  mockCategories = [category({ suggestion: { wouldSend: 9, of: 10, at: new Date() } })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`category-${ORDERS}`)).toBeTruthy())

  expect(screen.getByTestId('autopilot-readonly')).toBeTruthy()
  expect(state(`mode-auto-${ORDERS}`).disabled).toBe(true)
  expect(state(`mode-off-${ORDERS}`).disabled).toBe(true)
  expect(state('auto-graduate').disabled).toBe(true)
  expect(state('delay-15').disabled).toBe(true)
  // The suggestion still reads, but a member cannot act on it.
  expect(screen.getByTestId(`suggestion-${ORDERS}`)).toBeTruthy()
  expect(screen.queryByTestId(`suggestion-turn-on-${ORDERS}`)).toBeNull()

  await fireEvent.press(screen.getByTestId(`mode-auto-${ORDERS}`))
  await fireEvent(screen.getByTestId('auto-graduate'), 'valueChange', true)
  expect(mockPolicyCalls).toHaveLength(0)
  expect(mockUpdateCalls).toHaveLength(0)
})

test('a single agent needs no picker', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId(`category-${ORDERS}`)).toBeTruthy())
  expect(screen.queryByTestId('autopilot-agents')).toBeNull()
})

test('with more than one active agent the picker appears, and switching it re-reads that agent', async () => {
  mockAgents = [
    { id: AGENT_ID, connectionId: 'conn-1', address: 'support@acme.com', status: 'active' },
    { id: SALES_AGENT_ID, connectionId: 'conn-1', address: 'sales@acme.com', status: 'active' },
    // A disabled agent has no autonomy to manage — it never reaches the picker.
    { id: '55555555-5555-4555-8555-555555555555', connectionId: 'conn-1', address: 'old@acme.com', status: 'disabled' },
  ]
  await setup()
  await waitFor(() => expect(screen.getByTestId('autopilot-agents')).toBeTruthy())
  expect(screen.queryByTestId('agent-55555555-5555-4555-8555-555555555555')).toBeNull()
  expect(state(`agent-${AGENT_ID}`).checked).toBe(true)

  await fireEvent.press(screen.getByTestId(`agent-${SALES_AGENT_ID}`))
  await waitFor(() => expect(mockCategoryInputs.some((i) => i.agentId === SALES_AGENT_ID)).toBe(true))
})
