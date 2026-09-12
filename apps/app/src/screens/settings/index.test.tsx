import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { SettingsIndexScreen } from './index'

const mockReplace = jest.fn()
const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  Link: ({ children }: { children: ReactNode }) => children,
}))

const mockSetActive = jest.fn()
const mockRefetch = jest.fn()
const mockSignOut = jest.fn()
const mockUseSession = jest.fn()
const mockUseListOrganizations = jest.fn()

jest.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => mockUseSession(),
    useListOrganizations: () => mockUseListOrganizations(),
    organization: { setActive: (...args: unknown[]) => mockSetActive(...args) },
    signOut: (...args: unknown[]) => mockSignOut(...args),
  },
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: { get: { queryOptions: () => ({ queryKey: ['workspace', 'get'], queryFn: () => Promise.resolve({ businessName: 'Acme', role: 'owner' as const }) }) } },
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
  const rendered = await render(<SettingsIndexScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockReplace.mockReset()
  mockPush.mockReset()
  mockSetActive.mockReset()
  mockSetActive.mockRejectedValue(new Error('network down'))
  mockRefetch.mockReset()
  mockRefetch.mockResolvedValue(undefined)
  mockSignOut.mockReset()
  mockUseSession.mockReturnValue({ data: { session: { activeOrganizationId: 'o1' }, user: { email: 'me@example.com', id: 'u1' } }, refetch: mockRefetch })
  mockUseListOrganizations.mockReturnValue({ data: [{ id: 'o1', name: 'Acme' }, { id: 'o2', name: 'Beta' }] })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a failed workspace switch shows an error and leaves the row pressable again', async () => {
  await setup()
  await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy())

  await fireEvent.press(screen.getByText('Beta'))
  expect(mockSetActive).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.getByTestId('switch-error')).toBeTruthy())
  expect(mockReplace).not.toHaveBeenCalledWith('/')

  // switching was reset in the `finally`, so the row accepts another press (and does not just replay a disabled no-op).
  await fireEvent.press(screen.getByText('Beta'))
  expect(mockSetActive).toHaveBeenCalledTimes(2)
})

test('Autopilot, Learned answers and AI are live rows now, each opening its own screen', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('settings-autopilot')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('settings-autopilot'))
  expect(mockPush).toHaveBeenCalledWith('/settings/autopilot')

  await fireEvent.press(screen.getByTestId('settings-memory'))
  expect(mockPush).toHaveBeenCalledWith('/settings/memory')

  // Phase 6: the AI row lost its "Phase 6" badge and opens Settings › AI.
  await fireEvent.press(screen.getByTestId('settings-ai'))
  expect(mockPush).toHaveBeenCalledWith('/settings/ai')
  expect(screen.queryByText('Phase 6')).toBeNull()
})
