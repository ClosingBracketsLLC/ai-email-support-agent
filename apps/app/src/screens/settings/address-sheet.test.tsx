import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { AddressSheet } from './address-sheet'

const calls: unknown[] = []
let mockMutationFn: (vars: unknown) => Promise<unknown> = () => Promise.resolve({ agentId: 'a1', status: 'active' as const })

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    mailboxes: {
      addAddress: {
        mutationOptions: (o: object) => ({
          mutationFn: (vars: unknown) => { calls.push(vars); return mockMutationFn(vars) },
          ...o,
        }),
      },
    },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []

async function setup(onDone: () => void = jest.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(
    <AddressSheet connectionId="conn1" connectionAddress="support@acme.com" onDone={onDone} />,
    { wrapper: Wrapper },
  )
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  calls.length = 0
  mockMutationFn = () => Promise.resolve({ agentId: 'a1', status: 'active' as const })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('the primary address is listed unchecked, with the exact required copy (spec: never pre-checked)', async () => {
  await setup()
  const primary = screen.getByTestId('address-primary')
  expect(primary.props.accessibilityState?.checked).toBe(false)
  expect(screen.getByText('support@acme.com')).toBeTruthy()
  expect(screen.getByText('All mail to this address will be read by the agent and visible to your team.')).toBeTruthy()
})

test('adding an alias shows the reply-from radios, "replies come from the alias" selected by default', async () => {
  await setup()
  await fireEvent.press(screen.getByTestId('add-alias'))
  await fireEvent.changeText(screen.getByTestId('alias-email'), 'sales@acme.com')
  await fireEvent.press(screen.getByTestId('alias-add'))

  const fromAlias = screen.getByTestId('reply-from-alias-sales@acme.com')
  const fromConnection = screen.getByTestId('reply-from-connection-sales@acme.com')
  expect(fromAlias.props.accessibilityState?.checked).toBe(true)
  expect(fromConnection.props.accessibilityState?.checked).toBe(false)

  await fireEvent.press(fromConnection)
  expect(screen.getByTestId('reply-from-connection-sales@acme.com').props.accessibilityState?.checked).toBe(true)
  expect(screen.getByTestId('reply-from-alias-sales@acme.com').props.accessibilityState?.checked).toBe(false)
})

test('an alias entry cannot be added a second time, and is not offered for the connection address itself', async () => {
  await setup()
  await fireEvent.press(screen.getByTestId('add-alias'))
  await fireEvent.changeText(screen.getByTestId('alias-email'), 'support@acme.com')
  expect(screen.getByTestId('alias-add').props.accessibilityState?.disabled).toBe(true)
})

test('Done fires exactly one addAddress mutation per ticked row, and none for an unticked alias', async () => {
  const onDone = jest.fn()
  await setup(onDone)

  // Tick the primary (unchecked by default).
  await fireEvent.press(screen.getByTestId('address-primary'))

  // Add two aliases: one left ticked (the default), one explicitly unticked.
  await fireEvent.press(screen.getByTestId('add-alias'))
  await fireEvent.changeText(screen.getByTestId('alias-email'), 'sales@acme.com')
  await fireEvent.press(screen.getByTestId('alias-add'))
  await fireEvent.press(screen.getByTestId('add-alias'))
  await fireEvent.changeText(screen.getByTestId('alias-email'), 'billing@acme.com')
  await fireEvent.press(screen.getByTestId('alias-add'))
  await fireEvent.press(screen.getByTestId('alias-checkbox-billing@acme.com'))

  await fireEvent.press(screen.getByTestId('address-done'))

  await waitFor(() => expect(calls).toHaveLength(2))
  expect(calls).toEqual(expect.arrayContaining([
    { connectionId: 'conn1', address: 'support@acme.com', replyFromConnection: false },
    { connectionId: 'conn1', address: 'sales@acme.com', replyFromConnection: false },
  ]))
  expect(onDone).not.toHaveBeenCalled()
})

test('a pending alias shows the verification-sent copy after Done, then Continue closes the sheet', async () => {
  mockMutationFn = (vars) => {
    const address = (vars as { address: string }).address
    return Promise.resolve({ agentId: `agent-${address}`, status: address === 'support@acme.com' ? 'active' as const : 'pending_verification' as const })
  }
  const onDone = jest.fn()
  await setup(onDone)

  await fireEvent.press(screen.getByTestId('address-primary'))
  await fireEvent.press(screen.getByTestId('add-alias'))
  await fireEvent.changeText(screen.getByTestId('alias-email'), 'sales@acme.com')
  await fireEvent.press(screen.getByTestId('alias-add'))
  await fireEvent.press(screen.getByTestId('address-done'))

  await waitFor(() => expect(screen.getByText('Verification code sent — the agent will confirm it automatically when the code arrives.')).toBeTruthy())
  expect(screen.queryByTestId('add-alias')).toBeNull()

  await fireEvent.press(screen.getByTestId('address-done'))
  expect(onDone).toHaveBeenCalledTimes(1)
})

test('pressing Done with nothing ticked closes the sheet without any mutation', async () => {
  const onDone = jest.fn()
  await setup(onDone)
  await fireEvent.press(screen.getByTestId('address-done'))
  expect(calls).toHaveLength(0)
  expect(onDone).toHaveBeenCalledTimes(1)
})
