import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { InviteScreen, isNotRecipient } from './invite'

const mockReplace = jest.fn()
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'inv1' }),
  useRouter: () => ({ replace: mockReplace }),
  Redirect: () => null,
}))

const mockGetInvitation = jest.fn()
const mockSignOut = jest.fn()
const mockSession = { user: { id: 'u1', email: 'me@example.com', name: 'Me' }, session: { activeOrganizationId: null } }

jest.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: mockSession, isPending: false, refetch: jest.fn() }),
    organization: {
      getInvitation: (...args: unknown[]) => mockGetInvitation(...args),
      acceptInvitation: jest.fn(),
      setActive: jest.fn(),
    },
    updateUser: jest.fn(),
    signOut: (...args: unknown[]) => mockSignOut(...args),
  },
}))

const teardowns: Array<() => Promise<void> | void> = []

async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<InviteScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockReplace.mockReset()
  mockSignOut.mockReset()
  mockSignOut.mockResolvedValue(undefined)
  mockGetInvitation.mockReset()
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a wrong-account refusal offers sign-out without disclosing the invited address', async () => {
  mockGetInvitation.mockResolvedValue({ data: null, error: { status: 403, message: 'You are not the recipient of the invitation' } })
  await setup()

  await waitFor(() => expect(screen.getByTestId('invite-wrong-account')).toBeTruthy())
  expect(screen.getByText('This invitation is for a different email address')).toBeTruthy()
  expect(screen.queryByText(/invited you as/)).toBeNull()

  await fireEvent.press(screen.getByTestId('invite-sign-out'))
  expect(mockSignOut).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith({ pathname: '/sign-in', params: { next: '/invite/inv1' } }))
})

test('any other getInvitation failure shows the generic not-found state, never the wrong-account one', async () => {
  mockGetInvitation.mockResolvedValue({ data: null, error: { status: 404, message: 'not found' } })
  await setup()

  await waitFor(() => expect(screen.getByText('Invitation not found')).toBeTruthy())
  expect(screen.queryByTestId('invite-wrong-account')).toBeNull()
})

describe('isNotRecipient', () => {
  test('true for a 403 status', () => {
    expect(isNotRecipient({ status: 403 })).toBe(true)
  })
  test('true when the message mentions "recipient" (case-insensitive), regardless of status', () => {
    expect(isNotRecipient({ status: 400, message: 'You are not the RECIPIENT of the invitation' })).toBe(true)
  })
  test('false for an unrelated error', () => {
    expect(isNotRecipient({ status: 404, message: 'not found' })).toBe(false)
  })
  test('false for no error', () => {
    expect(isNotRecipient(null)).toBe(false)
    expect(isNotRecipient(undefined)).toBe(false)
  })
})
