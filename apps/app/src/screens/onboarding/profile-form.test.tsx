import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { ProfileForm, type ProfileInitial } from './profile-form'

const mockMutate = jest.fn()

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      updateProfile: { mutationOptions: (o: object) => ({ mutationFn: mockMutate, ...o }) },
      get: { queryKey: () => ['workspace.get'] },
    },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []

function makeInitial(websiteUrl: string): ProfileInitial {
  return { websiteUrl, description: '', tone: 'friendly', contactPhone: null, contactUrls: [] }
}

async function setup(initial: ProfileInitial) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<ProfileForm initial={initial} submitLabel="Continue" onSaved={jest.fn()} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => { mockMutate.mockReset() })
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('an untouched form re-seeds when a later initial arrives (a background refetch)', async () => {
  const { rerender } = await setup(makeInitial('https://a.test'))
  expect(screen.getByTestId('website').props.value).toBe('https://a.test')

  await rerender(<ProfileForm initial={makeInitial('https://b.test')} submitLabel="Continue" onSaved={jest.fn()} />)
  expect(screen.getByTestId('website').props.value).toBe('https://b.test')
})

test('a dirty form keeps the in-progress edit through a later initial (last write wins)', async () => {
  const { rerender } = await setup(makeInitial('https://a.test'))
  await fireEvent.changeText(screen.getByTestId('website'), 'https://typed.test')
  expect(screen.getByTestId('website').props.value).toBe('https://typed.test')

  await rerender(<ProfileForm initial={makeInitial('https://c.test')} submitLabel="Continue" onSaved={jest.fn()} />)
  expect(screen.getByTestId('website').props.value).toBe('https://typed.test')
})

test('save is disabled for a non-http(s) website and enabled once it is a valid URL', async () => {
  await setup(makeInitial('https://a.test'))
  const disabled = () => { const save = screen.getByTestId('save-profile'); return save.props.accessibilityState?.disabled ?? save.props.disabled }
  expect(disabled()).toBe(false)

  await fireEvent.changeText(screen.getByTestId('website'), 'not-a-url')
  expect(disabled()).toBe(true)

  await fireEvent.changeText(screen.getByTestId('website'), 'https://valid.test')
  expect(disabled()).toBe(false)
})
