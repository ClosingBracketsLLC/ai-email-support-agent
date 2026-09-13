import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { BillingBanner } from './billing-banner'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
let mockRole = 'owner'
let mockDeletionRequestedAt: Date | null = null
let mockPurgeAfter: Date | null = null
let mockBillingState = 'trialing'
let mockTrialEndsAt: Date | null = null
const mockStartCheckoutCalls: unknown[] = []
const mockOpenPortalCalls: unknown[] = []
const mockOpenExternalCalls: Array<{ start: () => Promise<{ url: string }>; opts: { onBlocked: (msg: string) => void } }> = []
let mockStartCheckoutImpl: () => Promise<{ url: string }> = () => Promise.resolve({ url: 'https://checkout.stripe.com/session' })
let mockOpenPortalImpl: () => Promise<{ url: string }> = () => Promise.resolve({ url: 'https://billing.stripe.com/portal' })

jest.mock('@/lib/open-external', () => ({
  openExternal: (start: () => Promise<{ url: string }>, opts: { onBlocked: (msg: string) => void }) => {
    mockOpenExternalCalls.push({ start, opts })
    return start().then(() => undefined)
  },
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: {
        queryOptions: () => ({
          queryKey: ['workspace', 'get'],
          queryFn: () => Promise.resolve({ role: mockRole, deletionRequestedAt: mockDeletionRequestedAt, purgeAfter: mockPurgeAfter }),
        }),
      },
    },
    billing: {
      get: {
        queryOptions: () => ({
          queryKey: ['billing', 'get'],
          queryFn: () => Promise.resolve({ state: mockBillingState, trialEndsAt: mockTrialEndsAt }),
        }),
      },
      startCheckout: { mutationOptions: (o: object) => ({ mutationFn: () => { mockStartCheckoutCalls.push(true); return mockStartCheckoutImpl() }, ...o }) },
      openPortal: { mutationOptions: (o: object) => ({ mutationFn: () => { mockOpenPortalCalls.push(true); return mockOpenPortalImpl() }, ...o }) },
    },
  }),
}))

/** `n` days out, guarding the ceil against a boundary: `n-1` whole days plus one hour always ceils
 * back to exactly `n`. */
function daysFromNow(n: number): Date {
  return new Date(Date.now() + (n - 1) * 86_400_000 + 3_600_000)
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<BillingBanner />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockRole = 'owner'
  mockDeletionRequestedAt = null
  mockPurgeAfter = null
  mockBillingState = 'trialing'
  mockTrialEndsAt = daysFromNow(10)
  mockStartCheckoutCalls.length = 0
  mockOpenPortalCalls.length = 0
  mockOpenExternalCalls.length = 0
  mockStartCheckoutImpl = () => Promise.resolve({ url: 'https://checkout.stripe.com/session' })
  mockOpenPortalImpl = () => Promise.resolve({ url: 'https://billing.stripe.com/portal' })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a trial with 10 days left renders nothing', async () => {
  await setup()
  await waitFor(() => expect(screen.toJSON()).toBeNull())
})

test('a trial inside its last 3 days warns, and Subscribe opens Checkout through openExternal', async () => {
  mockTrialEndsAt = daysFromNow(3)
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-banner')).toBeTruthy())
  expect(screen.getByText('Your trial ends in 3 days — subscribe to keep Autopilot.')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('billing-banner-subscribe'))
  await waitFor(() => expect(mockStartCheckoutCalls).toHaveLength(1))
  expect(mockOpenExternalCalls).toHaveLength(1)
})

test('a member sees the warning but no Subscribe button', async () => {
  mockRole = 'member'
  mockTrialEndsAt = daysFromNow(1)
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-banner')).toBeTruthy())
  expect(screen.queryByTestId('billing-banner-subscribe')).toBeNull()
})

test('an admin sees the SAME banner with no button — startCheckout and openPortal are both ownerProcedure', async () => {
  mockRole = 'admin'
  mockBillingState = 'past_due'
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-banner')).toBeTruthy())
  expect(screen.queryByTestId('billing-banner-manage')).toBeNull()
})

test('a lapsed trial says replies wait for review, with a Subscribe button', async () => {
  mockBillingState = 'trial_expired'
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-banner')).toBeTruthy())
  expect(screen.getByText('Your trial has ended — replies wait for your review until you subscribe.')).toBeTruthy()
  expect(screen.getByTestId('billing-banner-subscribe')).toBeTruthy()
})

test('a cancelled subscription reuses the trial-ended copy, with a Subscribe button', async () => {
  mockBillingState = 'canceled'
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-banner')).toBeTruthy())
  expect(screen.getByText('Your trial has ended — replies wait for your review until you subscribe.')).toBeTruthy()
  expect(screen.getByTestId('billing-banner-subscribe')).toBeTruthy()
})

test('a failed card says so and offers Manage billing, which opens the Portal through openExternal', async () => {
  mockBillingState = 'past_due'
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-banner')).toBeTruthy())
  expect(screen.getByText('Payment failed — Autopilot is paused until the card is updated.')).toBeTruthy()
  expect(screen.queryByTestId('billing-banner-subscribe')).toBeNull()

  await fireEvent.press(screen.getByTestId('billing-banner-manage'))
  await waitFor(() => expect(mockOpenPortalCalls).toHaveLength(1))
})

test('a pending deletion outranks every billing state, even a failed card', async () => {
  mockBillingState = 'past_due'
  mockDeletionRequestedAt = new Date('2026-09-13T00:00:00Z')
  mockPurgeAfter = new Date('2026-10-13T00:00:00Z')
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-banner')).toBeTruthy())
  expect(screen.getByText('This workspace will be deleted on 2026-10-13. Turn this off in Settings → Workspace.')).toBeTruthy()
  expect(screen.queryByTestId('billing-banner-manage')).toBeNull()
  expect(screen.queryByTestId('billing-banner-subscribe')).toBeNull()
})

test('an active, fully-paid workspace renders nothing', async () => {
  mockBillingState = 'active'
  await setup()
  await waitFor(() => expect(screen.toJSON()).toBeNull())
})
