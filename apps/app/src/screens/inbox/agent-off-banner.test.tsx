import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { AgentOffBanner } from './agent-off-banner'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive).
let mockWorkspace = { agentEnabled: false, role: 'owner' }
let mockWorkspaceQueries = 0
const mockEnableCalls: unknown[] = []
let mockEnableImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ agentEnabled: true, role: 'owner' })

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: {
        queryOptions: () => ({
          queryKey: ['workspace', 'get'],
          queryFn: () => { mockWorkspaceQueries += 1; return Promise.resolve(mockWorkspace) },
        }),
        queryKey: () => ['workspace', 'get'],
      },
      setAgentEnabled: {
        mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockEnableCalls.push(v); return mockEnableImpl(v) }, ...o }),
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
  const rendered = await render(<AgentOffBanner />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockWorkspace = { agentEnabled: false, role: 'owner' }
  mockWorkspaceQueries = 0
  mockEnableCalls.length = 0
  mockEnableImpl = () => Promise.resolve({ agentEnabled: true, role: 'owner' })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('an agent that is on shows nothing at all', async () => {
  mockWorkspace = { agentEnabled: true, role: 'owner' }
  await setup()
  await waitFor(() => expect(mockWorkspaceQueries).toBe(1))
  // The query's promise resolves in a microtask: flush it inside act() before asserting an absence,
  // so this cannot pass merely because the workspace had not loaded yet.
  await act(async () => { /* flush */ })
  expect(screen.queryByTestId('agent-off')).toBeNull()
  expect(screen.queryByTestId('agent-on')).toBeNull()
})

test('an agent that is off says replies are waiting, and a manager can turn it on', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-off')).toBeTruthy())
  expect(screen.getByText('The agent is off — replies wait until you turn it on.')).toBeTruthy()
  expect(screen.getByTestId('agent-on')).toBeTruthy()
})

test('a member sees the banner but no switch to flip', async () => {
  mockWorkspace = { agentEnabled: false, role: 'member' }
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-off')).toBeTruthy())
  expect(screen.queryByTestId('agent-on')).toBeNull()
})

test('the button turns the agent on exactly once, however often it is pressed', async () => {
  // Held open across both presses, then settled before teardown: a mutation still in flight when the
  // suite ends leaves the button's spinner mounted and jest with a handle it cannot close.
  let release = () => { /* replaced below */ }
  mockEnableImpl = () => new Promise((resolve) => { release = () => resolve({ agentEnabled: true, role: 'owner' }) })
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-on')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('agent-on'))
  await fireEvent.press(screen.getByTestId('agent-on'))
  expect(mockEnableCalls).toEqual([{ enabled: true }])

  mockWorkspace = { agentEnabled: true, role: 'owner' }
  await act(async () => { release() })
  await waitFor(() => expect(screen.queryByTestId('agent-off')).toBeNull())
})
