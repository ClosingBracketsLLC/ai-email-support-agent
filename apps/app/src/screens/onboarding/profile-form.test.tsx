import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { ProfileForm, type ProfileInitial } from './profile-form'

let mockMutationFn: () => Promise<unknown> = () => Promise.resolve({})

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      updateProfile: { mutationOptions: (o: object) => ({ mutationFn: () => mockMutationFn(), ...o }) },
      get: { queryKey: () => ['workspace.get'] },
    },
  }),
}))

/** A promise this test resolves by hand, to keep a save pending across assertions/further edits. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const teardowns: Array<() => Promise<void> | void> = []

function makeInitial(websiteUrl: string): ProfileInitial {
  return { websiteUrl, description: '', tone: 'friendly', contactPhone: null, contactUrls: [] }
}

async function setup(initial: ProfileInitial) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false },
      mutations: { retry: false, gcTime: 0 },
    },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<ProfileForm initial={initial} submitLabel="Continue" onSaved={jest.fn()} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

function saveDisabled() {
  const save = screen.getByTestId('save-profile')
  return save.props.accessibilityState?.disabled ?? save.props.disabled
}

beforeEach(() => { mockMutationFn = () => Promise.resolve({}) })
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
  expect(saveDisabled()).toBe(false)

  await fireEvent.changeText(screen.getByTestId('website'), 'not-a-url')
  expect(saveDisabled()).toBe(true)

  await fireEvent.changeText(screen.getByTestId('website'), 'https://valid.test')
  expect(saveDisabled()).toBe(false)
})

test('after a successful save the form goes pristine, so a later initial re-seeds it again', async () => {
  const gate = deferred<object>()
  mockMutationFn = () => gate.promise

  const { rerender } = await setup(makeInitial('https://a.test'))
  await fireEvent.changeText(screen.getByTestId('website'), 'https://typed.test')
  await fireEvent.press(screen.getByTestId('save-profile'))

  gate.resolve({})
  // Once the save's onSuccess has cleared `dirty`, re-seeding a later initial (equal to what was just saved,
  // as a real refetch would report) is a no-op — the field still shows it.
  await waitFor(() => expect(saveDisabled()).toBe(false))
  await rerender(<ProfileForm initial={makeInitial('https://typed.test')} submitLabel="Continue" onSaved={jest.fn()} />)
  expect(screen.getByTestId('website').props.value).toBe('https://typed.test')

  // The form is pristine again: a later, different initial (a genuinely new background refetch) re-seeds it.
  await rerender(<ProfileForm initial={makeInitial('https://d.test')} submitLabel="Continue" onSaved={jest.fn()} />)
  expect(screen.getByTestId('website').props.value).toBe('https://d.test')
})

test('an edit made while a save is still in flight is never discarded', async () => {
  const gate = deferred<object>()
  mockMutationFn = () => gate.promise

  const { rerender } = await setup(makeInitial('https://a.test'))
  await fireEvent.changeText(screen.getByTestId('website'), 'https://saved-by-server.test')
  await fireEvent.press(screen.getByTestId('save-profile'))

  // The save is still pending — type something else before it resolves.
  await fireEvent.changeText(screen.getByTestId('website'), 'https://typed-during-save.test')

  gate.resolve({})
  await waitFor(() => expect(saveDisabled()).toBe(false))

  // Rerender with what the server actually saved (the value sent before the mid-flight edit) — since the form
  // was edited again while that save was in flight, it must stay dirty and keep the newer, not-yet-saved value
  // rather than being clobbered by the server's response to the older save.
  await rerender(<ProfileForm initial={makeInitial('https://saved-by-server.test')} submitLabel="Continue" onSaved={jest.fn()} />)
  expect(screen.getByTestId('website').props.value).toBe('https://typed-during-save.test')
})

test('pressing save twice while the first save is pending calls the mutationFn once', async () => {
  const gate = deferred<object>()
  let calls = 0
  mockMutationFn = () => { calls += 1; return gate.promise }

  await setup(makeInitial('https://a.test'))
  await fireEvent.changeText(screen.getByTestId('website'), 'https://typed.test')
  await fireEvent.press(screen.getByTestId('save-profile'))

  // Wait for isPending to actually land (TanStack Query notifies through a setTimeout(0), not synchronously —
  // see create-workspace.test.tsx) before pressing again, mirroring a real second tap while the first request
  // is still in flight rather than a zero-delay synthetic double-press.
  await waitFor(() => expect(saveDisabled()).toBe(true))
  await fireEvent.press(screen.getByTestId('save-profile'))

  expect(calls).toBe(1)

  gate.resolve({})
  await waitFor(() => expect(saveDisabled()).toBe(false))
})
