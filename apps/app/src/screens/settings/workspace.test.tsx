import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { WorkspaceSettingsScreen } from './workspace'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

interface MockWorkspace {
  orgId: string; businessName: string; timezone: string; role: string; agentEnabled: boolean
  websiteUrl: string | null; description: string; tone: 'friendly' | 'formal' | 'concise'
  contactPhone: string | null; contactUrls: string[]
}

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
let mockWorkspace: MockWorkspace = {} as MockWorkspace
let mockWorkspaceQueries = 0
const mockEnableCalls: unknown[] = []
let mockEnableImpl: (input: unknown) => Promise<unknown> = (input) => Promise.resolve(input)

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
      // The ProfileForm below this screen's switch has its own mutation.
      updateProfile: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({}), ...o }) },
    },
  }),
}))

function workspace(overrides: Partial<MockWorkspace> = {}): MockWorkspace {
  return {
    orgId: 'o1', businessName: 'Acme', timezone: 'UTC', role: 'owner', agentEnabled: true,
    websiteUrl: null, description: '', tone: 'friendly', contactPhone: null, contactUrls: [], ...overrides,
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
  const rendered = await render(<WorkspaceSettingsScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockWorkspace = workspace()
  mockWorkspaceQueries = 0
  mockEnableCalls.length = 0
  mockEnableImpl = (input) => Promise.resolve(input)
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a manager sees the master switch, set to whatever the workspace says', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch').props.accessibilityState.checked).toBe(true))
  expect(screen.getByText('Agent is ON')).toBeTruthy()
  expect(screen.getByText('Every category starts in Review — the agent drafts, you approve.')).toBeTruthy()
})

test('turning the agent off sends enabled:false and re-reads the workspace', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy())
  expect(mockWorkspaceQueries).toBe(1)

  mockWorkspace = workspace({ agentEnabled: false })
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', false)
  expect(mockEnableCalls).toEqual([{ enabled: false }])
  // onSuccess invalidates workspace.get, which refetches it.
  await waitFor(() => expect(mockWorkspaceQueries).toBe(2))
  await waitFor(() => expect(screen.getByTestId('agent-switch').props.accessibilityState.checked).toBe(false))
})

test('turning it back on sends enabled:true', async () => {
  mockWorkspace = workspace({ agentEnabled: false })
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch').props.accessibilityState.checked).toBe(false))

  mockWorkspace = workspace({ agentEnabled: true })
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', true)
  expect(mockEnableCalls).toEqual([{ enabled: true }])
  await waitFor(() => expect(screen.getByTestId('agent-switch').props.accessibilityState.checked).toBe(true))
})

test('a change the server refuses says so', async () => {
  mockEnableImpl = () => Promise.reject(new Error('nope'))
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy())
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', false)
  await waitFor(() => expect(screen.getByTestId('agent-switch-error')).toBeTruthy())
  expect(screen.getByText('Could not change the agent. Try again.')).toBeTruthy()
})

test('a second flip while the first is still in flight is ignored', async () => {
  // Held open across both flips, then settled before teardown: a mutation still in flight when the
  // suite ends leaves jest with a handle it cannot close.
  let release = () => { /* replaced below */ }
  mockEnableImpl = () => new Promise((resolve) => { release = () => resolve({ agentEnabled: false }) })
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy())

  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', false)
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', false)
  expect(mockEnableCalls).toHaveLength(1)
  expect(screen.getByTestId('agent-switch').props.accessibilityState.disabled).toBe(true)

  mockWorkspace = workspace({ agentEnabled: false })
  await act(async () => { release() })
  await waitFor(() => expect(screen.getByTestId('agent-switch').props.accessibilityState.disabled).toBe(false))
})

test('a member gets neither the switch nor the profile form', async () => {
  mockWorkspace = workspace({ role: 'member' })
  await setup()
  await waitFor(() => expect(screen.getByText('Only owners and admins can edit the workspace profile.')).toBeTruthy())
  expect(screen.queryByTestId('agent-switch')).toBeNull()
})
