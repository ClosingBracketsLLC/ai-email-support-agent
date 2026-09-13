import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { AgentsScreen } from './agents'

const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_1_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_2_ID = '33333333-3333-4333-8333-333333333333'

type Agent = {
  id: string; connectionId: string; address: string; personaPreset: string
  priority: number; status: 'pending_verification' | 'active' | 'disabled'
  model: { mode: string; provider: string; model: string; credentialLabel: string | null }
}

// Every variable the jest.mock() factory below closes over must be prefixed `mock` (case-insensitive)
// — babel-plugin-jest-hoist only exempts those from its "no out-of-scope reference" check, since
// jest.mock() itself is hoisted above these declarations.
let mockAgents: Agent[] = []
let mockListQueryCalls = 0
const mockPush = jest.fn()
const mockUpdateCalls: unknown[] = []
let mockUpdateImpl: (input: unknown) => Promise<unknown> = (input) => { mockUpdateCalls.push(input); return Promise.resolve({ ok: true }) }

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agents: {
      list: {
        queryOptions: () => ({ queryKey: ['agents', 'list'], queryFn: () => { mockListQueryCalls += 1; return Promise.resolve({ agents: mockAgents }) } }),
        queryKey: () => ['agents', 'list'],
      },
      update: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockUpdateImpl(v), ...o }) },
    },
  }),
}))

function twoAgentsSameConnection(): Agent[] {
  return [
    { id: AGENT_1_ID, connectionId: CONNECTION_ID, address: 'support@acme.com', personaPreset: 'support', priority: 0, status: 'active',
      model: { mode: 'managed', provider: 'anthropic', model: 'claude-opus-5', credentialLabel: null } },
    { id: AGENT_2_ID, connectionId: CONNECTION_ID, address: 'sales@acme.com', personaPreset: 'sales', priority: 1, status: 'active',
      model: { mode: 'byok', provider: 'openai', model: 'gpt-5', credentialLabel: 'Production key' } },
  ]
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<AgentsScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockAgents = twoAgentsSameConnection()
  mockListQueryCalls = 0
  mockPush.mockReset()
  mockUpdateCalls.length = 0
  mockUpdateImpl = (v) => { mockUpdateCalls.push(v); return Promise.resolve({ ok: true }) }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('renders one row per agent with reorder buttons, and pressing a row navigates to the editor', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId(`agent-${AGENT_1_ID}`)).toBeTruthy())

  expect(screen.getByText('support@acme.com')).toBeTruthy()
  expect(screen.getByText('sales@acme.com')).toBeTruthy()
  // Phase 6: each row says which model writes its replies — Managed AI, or the connection's own name.
  expect(screen.getByText('Support · Managed AI')).toBeTruthy()
  expect(screen.getByText('Sales · Production key')).toBeTruthy()
  // First row: no "up" (top of its group), has "down". Second row: has "up", no "down" (bottom).
  expect(screen.getByTestId(`agent-up-${AGENT_1_ID}`).props.accessibilityState.disabled).toBe(true)
  expect(screen.getByTestId(`agent-down-${AGENT_1_ID}`).props.accessibilityState.disabled).toBe(false)
  expect(screen.getByTestId(`agent-up-${AGENT_2_ID}`).props.accessibilityState.disabled).toBe(false)
  expect(screen.getByTestId(`agent-down-${AGENT_2_ID}`).props.accessibilityState.disabled).toBe(true)

  await fireEvent.press(screen.getByTestId(`agent-${AGENT_1_ID}`))
  expect(mockPush).toHaveBeenCalledWith(`/settings/agents/${AGENT_1_ID}`)
})

test('a partial swap failure still refreshes the list and warns it may have only partially applied (review fix, Important 2)', async () => {
  let calls = 0
  mockUpdateImpl = (v) => {
    calls += 1
    mockUpdateCalls.push(v)
    // First call (the pressed agent's own priority update) succeeds; the second (its neighbor) fails —
    // exactly the partial-failure shape the fix addresses.
    return calls === 1 ? Promise.resolve({ ok: true }) : Promise.reject(new Error('network blip'))
  }

  await setup()
  await waitFor(() => expect(screen.getByTestId(`agent-down-${AGENT_1_ID}`)).toBeTruthy())
  const queryCallsBeforeSwap = mockListQueryCalls

  await fireEvent.press(screen.getByTestId(`agent-down-${AGENT_1_ID}`))

  await waitFor(() => expect(mockUpdateCalls).toHaveLength(2))
  // `invalidateQueries` ran from `finally`, regardless of the second call's rejection — the list was
  // refetched at least once more after the failed swap, not left showing the stale pre-swap order.
  await waitFor(() => expect(mockListQueryCalls).toBeGreaterThan(queryCallsBeforeSwap))
  await waitFor(() => expect(screen.getByText('Could not finish reordering — it may have partially applied. Refreshed the list below.')).toBeTruthy())
  await act(async () => { await Promise.resolve() })
})
