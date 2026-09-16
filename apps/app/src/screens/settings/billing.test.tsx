import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { BILLING_ERROR_MESSAGES } from '@aesa/contracts'
import { BillingSettingsScreen } from './billing'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

interface MockBilling {
  plan: string; state: string; trialEndsAt: Date | null; domainQuantity: number; allowance: number; used: number
  overageUnits: number; overageMode: string; overageUnitCents: number; perDomainCents: number; configured: boolean
  activeDomains: number
}

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
let mockRole = 'owner'
let mockBilling: MockBilling = {} as MockBilling
let mockCheckoutParam: string | undefined
let mockBillingQueries = 0
const mockStartCheckoutCalls: unknown[] = []
const mockOpenPortalCalls: unknown[] = []
const mockSetOverageCalls: unknown[] = []
const mockOpenExternalCalls: Array<{ start: () => Promise<{ url: string }> }> = []

let mockStartCheckoutImpl: () => Promise<unknown> = () => Promise.resolve({ url: 'https://checkout.stripe.com/session' })
let mockOpenPortalImpl: () => Promise<unknown> = () => Promise.resolve({ url: 'https://billing.stripe.com/portal' })
let mockSetOverageImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ ok: true })

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ checkout: mockCheckoutParam }),
}))

jest.mock('@/lib/open-external', () => ({
  openExternal: (start: () => Promise<{ url: string }>, opts: { onBlocked: (msg: string) => void }) => {
    mockOpenExternalCalls.push({ start })
    return start().then(() => undefined).catch(() => opts.onBlocked('failed'))
  },
}))

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: { queryOptions: () => ({ queryKey: ['workspace', 'get'], queryFn: () => Promise.resolve({ role: mockRole }) }) },
    },
    billing: {
      get: {
        queryOptions: () => ({
          queryKey: ['billing', 'get'],
          queryFn: () => { mockBillingQueries += 1; return Promise.resolve(mockBilling) },
        }),
        queryKey: () => ['billing', 'get'],
      },
      startCheckout: { mutationOptions: (o: object) => ({ mutationFn: () => { mockStartCheckoutCalls.push(true); return mockStartCheckoutImpl() }, ...o }) },
      openPortal: { mutationOptions: (o: object) => ({ mutationFn: () => { mockOpenPortalCalls.push(true); return mockOpenPortalImpl() }, ...o }) },
      setOverageMode: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockSetOverageCalls.push(v); return mockSetOverageImpl(v) }, ...o }) },
    },
  }),
}))

/** `n` days out, guarding the ceil against a boundary — `billing-banner.test.tsx`'s own helper. */
function daysFromNow(n: number): Date {
  return new Date(Date.now() + (n - 1) * 86_400_000 + 3_600_000)
}

function billing(overrides: Partial<MockBilling> = {}): MockBilling {
  return {
    plan: 'trial', state: 'trialing', trialEndsAt: daysFromNow(9), domainQuantity: 0, allowance: 50, used: 12,
    overageUnits: 0, overageMode: 'automatic', overageUnitCents: 12, perDomainCents: 4999, configured: true, activeDomains: 0,
    ...overrides,
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
  const rendered = await render(<BillingSettingsScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockRole = 'owner'
  mockBilling = billing()
  mockCheckoutParam = undefined
  mockBillingQueries = 0
  for (const calls of [mockStartCheckoutCalls, mockOpenPortalCalls, mockSetOverageCalls, mockOpenExternalCalls]) calls.length = 0
  mockStartCheckoutImpl = () => Promise.resolve({ url: 'https://checkout.stripe.com/session' })
  mockOpenPortalImpl = () => Promise.resolve({ url: 'https://billing.stripe.com/portal' })
  mockSetOverageImpl = () => Promise.resolve({ ok: true })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a trial shows its chip, countdown and usage, and Subscribe opens Checkout through openExternal', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-summary')).toBeTruthy())

  expect(screen.getByText('Trial')).toBeTruthy()
  expect(screen.getByText('ends in 9 days')).toBeTruthy()
  expect(screen.getByText('12 of 50 conversations this month')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('billing-subscribe'))
  await waitFor(() => expect(mockStartCheckoutCalls).toHaveLength(1))
  // openExternal (mocked) is handed a `start` that calls the SAME mutation, hands it the url —
  // asserted separately by billing-banner.test.tsx's identical wiring, so this just confirms the
  // hand-off happened exactly once, without re-invoking the real mutation a second time.
  expect(mockOpenExternalCalls).toHaveLength(1)
  expect(screen.queryByTestId('billing-error')).toBeNull()
})

test('a member reads the same summary but gets no button, just the readonly note', async () => {
  mockRole = 'member'
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-readonly')).toBeTruthy())

  expect(screen.getByText('Only the workspace owner can manage billing.')).toBeTruthy()
  expect(screen.getByText('Trial')).toBeTruthy()
  expect(screen.queryByTestId('billing-subscribe')).toBeNull()
  expect(screen.queryByTestId('overage-mode')).toBeNull()
})

test('an admin gets the SAME readonly treatment as a member — every billing mutation here is ownerProcedure', async () => {
  mockRole = 'admin'
  mockBilling = billing({ plan: 'standard', state: 'active', trialEndsAt: null, domainQuantity: 1, allowance: 300, used: 10 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-readonly')).toBeTruthy())

  expect(screen.queryByTestId('billing-manage')).toBeNull()
  expect(screen.queryByTestId('overage-mode')).toBeNull()
})

test('an unconfigured server says so instead of offering a Subscribe button that cannot work', async () => {
  mockBilling = billing({ configured: false })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-not-configured')).toBeTruthy())

  expect(screen.getByText('Billing is not set up on this server yet.')).toBeTruthy()
  expect(screen.queryByTestId('billing-subscribe')).toBeNull()
})

test('an active subscription shows the plan, the price and the overage, with Manage billing', async () => {
  mockBilling = billing({
    plan: 'standard', state: 'active', trialEndsAt: null, domainQuantity: 2, allowance: 600, used: 301, overageUnits: 1, activeDomains: 2,
  })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-summary')).toBeTruthy())

  expect(screen.getByText('Standard · 2 domains')).toBeTruthy()
  expect(screen.getByText('$99.98 / month')).toBeTruthy()
  expect(screen.getByText('301 of 600 · 1 extra at $0.12')).toBeTruthy()
  expect(screen.queryByTestId('billing-active-domains')).toBeNull()

  await fireEvent.press(screen.getByTestId('billing-manage'))
  await waitFor(() => expect(mockOpenPortalCalls).toHaveLength(1))
})

test('a live domain count that differs from the billed quantity is shown beside it', async () => {
  mockBilling = billing({ plan: 'standard', state: 'active', trialEndsAt: null, domainQuantity: 2, allowance: 600, used: 10, activeDomains: 3 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-active-domains')).toBeTruthy())
  expect(screen.getByText('3 domains connected')).toBeTruthy()
})

/** A promise this test resolves by hand, mirroring `create-workspace.test.tsx`'s own `deferred`. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

test('the overage-mode radio calls setOverageMode for the owner, is disabled while pending, and hidden for a member', async () => {
  mockBilling = billing({ plan: 'standard', state: 'active', trialEndsAt: null, domainQuantity: 1, allowance: 300, used: 10 })
  const gate = deferred<{ ok: true }>()
  mockSetOverageImpl = () => gate.promise
  await setup()
  await waitFor(() => expect(screen.getByTestId('overage-mode')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('overage-blocked'))
  expect(mockSetOverageCalls).toEqual([{ mode: 'blocked' }])
  await waitFor(() => expect(screen.getByTestId('overage-automatic').props.accessibilityState.disabled).toBe(true))

  gate.resolve({ ok: true })
  await waitFor(() => expect(screen.getByTestId('overage-automatic').props.accessibilityState.disabled).toBe(false))
})

test('a member sees no overage radio at all', async () => {
  mockRole = 'member'
  mockBilling = billing({ plan: 'standard', state: 'active', trialEndsAt: null, domainQuantity: 1, allowance: 300, used: 10 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-summary')).toBeTruthy())
  expect(screen.queryByTestId('overage-mode')).toBeNull()
})

test('a failed card shows the error banner and Manage billing, not Subscribe', async () => {
  mockBilling = billing({ plan: 'standard', state: 'past_due', trialEndsAt: null, domainQuantity: 1, allowance: 300, used: 10 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-past-due')).toBeTruthy())

  expect(screen.getByText('Payment failed — Autopilot is paused until the card is updated.')).toBeTruthy()
  expect(screen.getByTestId('billing-manage')).toBeTruthy()
  expect(screen.queryByTestId('billing-subscribe')).toBeNull()
})

test("the api's refusal renders via BILLING_ERROR_MESSAGES, never a raw code", async () => {
  mockStartCheckoutImpl = () => Promise.reject(Object.assign(new Error(BILLING_ERROR_MESSAGES.already_subscribed), { data: { code: 'PRECONDITION_FAILED' } }))
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-subscribe')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('billing-subscribe'))
  await waitFor(() => expect(screen.getByTestId('billing-error')).toBeTruthy())
  expect(screen.getByText('This workspace already has a subscription — use Manage billing.')).toBeTruthy()
})

test('an error the api never promised is never shown verbatim', async () => {
  mockStartCheckoutImpl = () => Promise.reject(new Error('relation "billing_subscriptions" does not exist'))
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-subscribe')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('billing-subscribe'))
  await waitFor(() => expect(screen.getByTestId('billing-error')).toBeTruthy())
  expect(screen.queryByText('relation "billing_subscriptions" does not exist')).toBeNull()
  expect(screen.getByText('Could not complete that. Try again.')).toBeTruthy()
})

test('checkout=success refetches billing.get and thanks the owner once the subscription is active', async () => {
  mockCheckoutParam = 'success'
  mockBilling = billing({ plan: 'standard', state: 'active', trialEndsAt: null, domainQuantity: 1, allowance: 300, used: 10 })
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-checkout-banner')).toBeTruthy())
  expect(screen.getByText('Thanks — your subscription is active.')).toBeTruthy()
  await waitFor(() => expect(mockBillingQueries).toBeGreaterThan(1))
})

test('checkout=success while Stripe has not confirmed yet (still trialing) says so instead', async () => {
  mockCheckoutParam = 'success'
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-checkout-banner')).toBeTruthy())
  expect(screen.getByText('Stripe is confirming your payment…')).toBeTruthy()
})

// ---- fix wave B11: the thanks is for an ACTIVE subscription, nothing else ----

test('checkout=success from an EXPIRED trial (or a cancelled workspace) says Stripe is confirming — never "your subscription is active" above a Subscribe button', async () => {
  mockCheckoutParam = 'success'
  mockBilling = billing({ state: 'trial_expired', trialEndsAt: new Date(Date.now() - 86_400_000) })
  await setup()

  await waitFor(() => expect(screen.getByTestId('billing-checkout-banner')).toBeTruthy())
  expect(screen.getByText('Stripe is confirming your payment…')).toBeTruthy()
  expect(screen.queryByText('Thanks — your subscription is active.')).toBeNull()
  expect(screen.getByTestId('billing-subscribe')).toBeTruthy()

  for (const teardown of teardowns.splice(0)) await teardown()
  mockBilling = billing({ state: 'canceled', trialEndsAt: null, domainQuantity: 2 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-checkout-banner')).toBeTruthy())
  expect(screen.getByText('Stripe is confirming your payment…')).toBeTruthy()
})

// ---- fix wave B10: a lapsed workspace reads as lapsed, never as a paid plan ----

test('a CANCELLED workspace reads "cancelled" with the usage tile and Subscribe — not "Trial · 2 domains · $99.98 / month" and no overage radio', async () => {
  mockBilling = billing({ plan: 'trial', state: 'canceled', trialEndsAt: null, domainQuantity: 2, allowance: 50, used: 301, overageUnits: 251, activeDomains: 2 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-summary')).toBeTruthy())

  expect(screen.getByText('Cancelled')).toBeTruthy()
  expect(screen.getByText('Your subscription was cancelled — replies wait for your review until you subscribe again.')).toBeTruthy()
  expect(screen.queryByText(/\/ month/)).toBeNull()
  expect(screen.queryByText(/2 domains/)).toBeNull()
  expect(screen.getByTestId('billing-usage')).toBeTruthy()
  expect(screen.getByTestId('billing-subscribe')).toBeTruthy()
  expect(screen.queryByTestId('billing-manage')).toBeNull()
  expect(screen.queryByTestId('overage-mode')).toBeNull()
})

test('an EXPIRED trial reads "trial ended" with the usage tile and Subscribe, and no overage radio', async () => {
  mockBilling = billing({ state: 'trial_expired', trialEndsAt: new Date(Date.now() - 86_400_000), used: 50 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-summary')).toBeTruthy())

  expect(screen.getByText('Trial ended')).toBeTruthy()
  expect(screen.getByText('Your trial has ended — replies wait for your review until you subscribe.')).toBeTruthy()
  expect(screen.queryByText(/ends in/)).toBeNull()
  expect(screen.getByText('50 of 50 conversations this month')).toBeTruthy()
  expect(screen.getByTestId('billing-subscribe')).toBeTruthy()
  expect(screen.queryByTestId('overage-mode')).toBeNull()
})

test('a paid plan keeps its price line and the overage radio (B10 keys them on the plan, not the state)', async () => {
  mockBilling = billing({ plan: 'standard', state: 'past_due', trialEndsAt: null, domainQuantity: 2, allowance: 600, used: 10, activeDomains: 2 })
  await setup()
  await waitFor(() => expect(screen.getByTestId('billing-summary')).toBeTruthy())
  expect(screen.getByText('Standard · 2 domains')).toBeTruthy()
  expect(screen.getByText('$99.98 / month')).toBeTruthy()
  expect(screen.getByTestId('overage-mode')).toBeTruthy()
})
