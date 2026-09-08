import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { CreateWorkspaceScreen } from './create-workspace'

const mockReplace = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }))

const mockUpdateUser = jest.fn()
const mockUseSession = jest.fn()
jest.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => mockUseSession(),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  },
}))

/** A promise this test resolves by hand, to keep the mutation pending across repeated submit-editing events. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

let mockMutationFn: () => Promise<unknown> = () => Promise.resolve({ orgId: 'org1' })

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: { create: { mutationOptions: (o: object) => ({ mutationFn: () => mockMutationFn(), ...o }) } },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []

async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false },
      mutations: { retry: false, gcTime: 0 },
    },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<CreateWorkspaceScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockReplace.mockReset()
  mockUpdateUser.mockReset()
  mockUseSession.mockReturnValue({ data: { user: { name: 'Robert' } }, refetch: jest.fn() })
  mockMutationFn = () => Promise.resolve({ orgId: 'org1' })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('repeated Enter/submit-editing events while the mutation is pending call the mutationFn only once', async () => {
  const gate = deferred<{ orgId: string }>()
  let calls = 0
  mockMutationFn = () => { calls += 1; return gate.promise }

  await setup()
  await fireEvent.changeText(screen.getByTestId('business-name'), 'Acme Socks')
  await fireEvent(screen.getByTestId('business-name'), 'submitEditing')

  // TanStack Query's mutation observer notifies React through a setTimeout(0), not synchronously — wait for
  // the pending state to actually land (mirrors a real second Enter press while the first request is still in
  // flight) before firing the next two, which the isPending guard must then swallow.
  await waitFor(() => {
    const button = screen.getByTestId('create')
    expect(button.props.accessibilityState?.disabled ?? button.props.disabled).toBe(true)
  })
  await fireEvent(screen.getByTestId('business-name'), 'submitEditing')
  await fireEvent(screen.getByTestId('business-name'), 'submitEditing')

  expect(calls).toBe(1)

  // Let the pending mutation settle before the test ends, so nothing is still in flight at teardown.
  gate.resolve({ orgId: 'org1' })
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/profile'))
})
