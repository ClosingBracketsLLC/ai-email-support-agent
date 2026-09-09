import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { AgentEditScreen } from './agent-edit'

// UpdateAgentInput.agentId is z.uuid(), which checks the RFC 4122 version/variant nibbles too — a
// merely uuid-shaped id (e.g. all-1s) fails that check, so every save would silently no-op.
const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'

type Agent = {
  id: string; connectionId: string; address: string; replyFromAddress: string | null; connectionEmailAddress: string; domain: string
  displayName: string; signature: string; personaPreset: string; personaText: string; guidanceExtra: string
  priority: number; status: 'pending_verification' | 'active' | 'disabled'; autoSendDelayMin: number
}

// Every variable the jest.mock() factory below closes over must be prefixed `mock` (case-insensitive)
// — babel-plugin-jest-hoist only exempts those from its "no out-of-scope reference" check, since
// jest.mock() itself is hoisted above these declarations.
let mockAgents: Agent[] = []
let mockCategories: { categoryId: string; key: string; label: string; mode: string }[] = []
const mockUpdateCalls: unknown[] = []
let mockUpdateImpl: (input: unknown) => Promise<unknown> = (input) => { mockUpdateCalls.push(input); return Promise.resolve({ ok: true }) }

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agents: {
      list: {
        queryOptions: () => ({ queryKey: ['agents', 'list'], queryFn: () => Promise.resolve({ agents: mockAgents }) }),
        queryKey: () => ['agents', 'list'],
      },
      categories: {
        queryOptions: (input: { agentId: string }) => ({ queryKey: ['agents', 'categories', input], queryFn: () => Promise.resolve({ categories: mockCategories }) }),
      },
      update: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockUpdateImpl(v), ...o }) },
    },
  }),
}))

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID, connectionId: CONNECTION_ID, address: 'support@acme.com', replyFromAddress: null, connectionEmailAddress: 'support@acme.com', domain: 'acme.com',
    displayName: 'Support', signature: '', personaPreset: 'support', personaText: '', guidanceExtra: '',
    priority: 0, status: 'active', autoSendDelayMin: 2,
    ...overrides,
  }
}

/** A promise this test resolves by hand, to keep a save pending across assertions — same trick as
 * `profile-form.test.tsx`. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function saveDisabled() {
  const save = screen.getByTestId('agent-save')
  return save.props.accessibilityState?.disabled ?? save.props.disabled
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<AgentEditScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockAgents = [baseAgent()]
  mockCategories = []
  mockUpdateCalls.length = 0
  mockUpdateImpl = (v) => { mockUpdateCalls.push(v); return Promise.resolve({ ok: true }) }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('all four persona presets render with their one-line spec descriptions', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('persona-preset-support')).toBeTruthy())

  expect(screen.getByText('Support')).toBeTruthy()
  expect(screen.getByText('helpful, concise, resolves')).toBeTruthy()
  expect(screen.getByText('Sales')).toBeTruthy()
  expect(screen.getByText('warm, consultative, never invents pricing')).toBeTruthy()
  expect(screen.getByText('Concierge')).toBeTruthy()
  expect(screen.getByText('neutral, thorough, cites sources')).toBeTruthy()
  expect(screen.getByText('Billing')).toBeTruthy()
  expect(screen.getByText('precise, cautious, escalates disputes')).toBeTruthy()
})

test('the persona-text counter tracks typed length against the 4000 cap', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('persona-text-counter')).toBeTruthy())
  // Both the persona and guidance counters start at "0/4000" — read the element's own text directly
  // rather than `getByText` (ambiguous across the two counters).
  expect(screen.getByTestId('persona-text-counter').props.children).toBe('0/4000')

  await fireEvent.changeText(screen.getByTestId('persona-text'), 'Be extra warm.')
  expect(screen.getByTestId('persona-text-counter').props.children).toBe('14/4000')
  // Editing the other field's counter must stay untouched.
  expect(screen.getByTestId('guidance-extra-counter').props.children).toBe('0/4000')
})

test('save sends only the dirty keys, never the whole agent', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('display-name')).toBeTruthy())

  await fireEvent.changeText(screen.getByTestId('display-name'), 'Support Team')
  await fireEvent.press(screen.getByTestId('agent-save'))

  await waitFor(() => expect(mockUpdateCalls).toEqual([{ agentId: AGENT_ID, displayName: 'Support Team' }]))
  // `onSuccess` invalidates `agents.list`, which triggers a second, unobserved refetch/re-render —
  // flush it inside act so it doesn't leak into the next test's console output (same pattern as
  // mailboxes.test.tsx).
  await act(async () => { await Promise.resolve() })
})

test('the save button is disabled while the mutation is pending, guarding a second tap', async () => {
  const gate = deferred<unknown>()
  let calls = 0
  mockUpdateImpl = (v) => { calls += 1; mockUpdateCalls.push(v); return gate.promise }

  await setup()
  await waitFor(() => expect(screen.getByTestId('display-name')).toBeTruthy())
  await fireEvent.changeText(screen.getByTestId('display-name'), 'Support Team')
  expect(saveDisabled()).toBe(false)

  await fireEvent.press(screen.getByTestId('agent-save'))
  // TanStack Query notifies `isPending` through a setTimeout(0), not synchronously — wait for it to
  // actually land before the second press, mirroring a real double-tap rather than a synthetic one.
  await waitFor(() => expect(saveDisabled()).toBe(true))

  await fireEvent.press(screen.getByTestId('agent-save'))
  expect(calls).toBe(1)

  gate.resolve({ ok: true })
  await waitFor(() => expect(mockUpdateCalls).toEqual([{ agentId: AGENT_ID, displayName: 'Support Team' }]))
  await act(async () => { await Promise.resolve() })
})

test('disabling an active agent needs a second tap to confirm', async () => {
  mockAgents = [baseAgent({ status: 'active' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-toggle-status')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('agent-toggle-status'))
  expect(mockUpdateCalls).toHaveLength(0)
  expect(screen.getByText('Confirm disable')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('agent-toggle-status'))
  await waitFor(() => expect(mockUpdateCalls).toEqual([{ agentId: AGENT_ID, status: 'disabled' }]))
  await act(async () => { await Promise.resolve() })
})

test('a disabled agent shows an "Enable agent" action with no confirm step', async () => {
  mockAgents = [baseAgent({ status: 'disabled' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-toggle-status')).toBeTruthy())
  expect(screen.getByText('Enable agent')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('agent-toggle-status'))
  await waitFor(() => expect(mockUpdateCalls).toEqual([{ agentId: AGENT_ID, status: 'active' }]))
  await act(async () => { await Promise.resolve() })
})

test('a pending-verification agent has no status toggle at all — it is untouchable until verified', async () => {
  mockAgents = [baseAgent({ status: 'pending_verification' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-status-pending')).toBeTruthy())
  expect(screen.queryByTestId('agent-toggle-status')).toBeNull()
})

test('the reply-from radios appear only when replyFromAddress is set, "reply from connection" selected by default', async () => {
  mockAgents = [baseAgent({ replyFromAddress: 'support@acme.com', address: 'sales@acme.com', connectionEmailAddress: 'support@acme.com' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('reply-from')).toBeTruthy())

  expect(screen.getByText('Reply as sales@acme.com')).toBeTruthy()
  expect(screen.getByText('Set up Send-as with your provider first')).toBeTruthy()
  expect(screen.getByText('Reply from support@acme.com')).toBeTruthy()
  expect(screen.getByTestId('reply-from-connection').props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('reply-as-own').props.accessibilityState.checked).toBe(false)
})

test('selecting "reply as own address" marks replyFromAddress dirty and saves null (review fix, Important 1)', async () => {
  mockAgents = [baseAgent({ replyFromAddress: 'support@acme.com', address: 'sales@acme.com', connectionEmailAddress: 'support@acme.com' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('reply-from')).toBeTruthy())
  expect(saveDisabled()).toBe(true) // nothing dirty yet

  await fireEvent.press(screen.getByTestId('reply-as-own'))
  expect(screen.getByTestId('reply-as-own').props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('reply-from-connection').props.accessibilityState.checked).toBe(false)
  expect(saveDisabled()).toBe(false)

  await fireEvent.press(screen.getByTestId('agent-save'))
  await waitFor(() => expect(mockUpdateCalls).toEqual([{ agentId: AGENT_ID, replyFromAddress: null }]))
  await act(async () => { await Promise.resolve() })
})

test('switching back to "reply from connection" saves the connection address', async () => {
  mockAgents = [baseAgent({ replyFromAddress: 'support@acme.com', address: 'sales@acme.com', connectionEmailAddress: 'support@acme.com' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('reply-from')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('reply-as-own'))
  await fireEvent.press(screen.getByTestId('reply-from-connection'))
  await fireEvent.press(screen.getByTestId('agent-save'))

  await waitFor(() => expect(mockUpdateCalls).toEqual([{ agentId: AGENT_ID, replyFromAddress: 'support@acme.com' }]))
  await act(async () => { await Promise.resolve() })
})

test('no reply-from card when replyFromAddress is null', async () => {
  mockAgents = [baseAgent({ replyFromAddress: null })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('display-name')).toBeTruthy())
  expect(screen.queryByTestId('reply-from')).toBeNull()
})
