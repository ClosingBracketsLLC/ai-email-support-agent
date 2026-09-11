import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { GuidanceEditor } from './guidance-editor'

const mockUpdateGuidanceCalls: unknown[] = []
let mockUpdateGuidanceImpl: (input: unknown) => Promise<unknown> = (input) => {
  mockUpdateGuidanceCalls.push(input)
  return Promise.resolve({ operatingGuidance: (input as { operatingGuidance: string }).operatingGuidance })
}

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: { queryKey: () => ['workspace', 'get'] },
      updateGuidance: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockUpdateGuidanceImpl(v), ...o }) },
    },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []
async function setup(initial = '') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<GuidanceEditor initial={initial} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockUpdateGuidanceCalls.length = 0
  mockUpdateGuidanceImpl = (input) => {
    mockUpdateGuidanceCalls.push(input)
    return Promise.resolve({ operatingGuidance: (input as { operatingGuidance: string }).operatingGuidance })
  }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('renders the initial guidance text and the three example bullets as placeholder copy', async () => {
  await setup('Always confirm the order number before refunding.')
  await waitFor(() => expect(screen.getByTestId('guidance-text')).toBeTruthy())
  expect(screen.getByTestId('guidance-text').props.value).toBe('Always confirm the order number before refunding.')
  const placeholder = screen.getByTestId('guidance-text').props.placeholder as string
  expect(placeholder).toContain("we don't refund sale items")
  expect(placeholder).toContain('sign as Team Acme')
  expect(placeholder).toContain('never promise delivery dates')
})

test('Save is disabled until the text changes, then saves and shows a success banner', async () => {
  await setup('Existing guidance.')
  expect(screen.getByTestId('save-guidance').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('guidance-text'), 'Existing guidance. Also: sign as Team Acme.')
  expect(screen.getByTestId('save-guidance').props.accessibilityState.disabled).toBe(false)

  await fireEvent.press(screen.getByTestId('save-guidance'))
  await waitFor(() => expect(mockUpdateGuidanceCalls).toEqual([{ operatingGuidance: 'Existing guidance. Also: sign as Team Acme.' }]))
  await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy())
})

test('a failed save shows an error banner', async () => {
  mockUpdateGuidanceImpl = () => Promise.reject(new Error('network down'))
  await setup('Existing.')
  await fireEvent.changeText(screen.getByTestId('guidance-text'), 'Existing. Edited.')
  await fireEvent.press(screen.getByTestId('save-guidance'))
  await waitFor(() => expect(screen.getByText('Could not save guidance. Try again.')).toBeTruthy())
})
