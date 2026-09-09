import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import type { GateTarget } from './session-gate'
import { classifyWorkspaceError, useGate } from './use-gate'

const mockSetActive = jest.fn()
const mockUseSession = jest.fn()
const mockUseListOrganizations = jest.fn()

jest.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => mockUseSession(),
    useListOrganizations: () => mockUseListOrganizations(),
    organization: { setActive: (...args: unknown[]) => mockSetActive(...args) },
  },
}))

let mockWorkspaceQueryFn: () => Promise<unknown> = () => Promise.resolve({ onboardingStep: 'done' })

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: {
        queryOptions: () => ({ queryKey: ['workspace.get'], queryFn: () => mockWorkspaceQueryFn() }),
      },
    },
  }),
}))

/** Torn down in afterEach: react-query's own timers (gc, retry backoff) otherwise outlive the test and jest hangs. */
const teardowns: Array<() => Promise<void> | void> = []

async function setupGate() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await renderHook(() => useGate(), { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

/** Narrows a GateTarget to its error variant, or fails the test with a useful message. */
function asError(target: GateTarget) {
  if (target.kind !== 'error') throw new Error(`expected an error target, got ${target.kind}`)
  return target
}

/** A promise this test resolves by hand, to pin down exactly when each step of an async chain proceeds. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  mockSetActive.mockReset()
  mockUseSession.mockReset()
  mockUseListOrganizations.mockReset()
  mockWorkspaceQueryFn = () => Promise.resolve({ onboardingStep: 'done' })
})

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown()
})

describe('useGate — activating the first membership', () => {
  it('a rejected setActive surfaces as an error target, does not retry on its own, and retry() tries again', async () => {
    mockUseSession.mockReturnValue({ data: { session: { activeOrganizationId: null } }, isPending: false, error: null, refetch: jest.fn() })
    mockUseListOrganizations.mockReturnValue({ data: [{ id: 'o1' }], isPending: false })
    mockSetActive.mockRejectedValue(new Error('nope'))

    const { result, rerender } = await setupGate()

    await waitFor(() => asError(result.current))
    expect(mockSetActive).toHaveBeenCalledTimes(1)

    // Re-rendering (e.g. a sibling state change) must not fire another activation attempt.
    await rerender(undefined)
    await rerender(undefined)
    expect(mockSetActive).toHaveBeenCalledTimes(1)

    await act(() => { asError(result.current).retry() })
    await waitFor(() => expect(mockSetActive).toHaveBeenCalledTimes(2))
  })

  it('a successful activation keeps the guard set through the session refetch race, so setActive fires only once', async () => {
    const staleSession = { session: { activeOrganizationId: null } }
    const settledSession = { session: { activeOrganizationId: 'o1' } }

    const setActiveGate = deferred<void>()
    mockSetActive.mockReturnValue(setActiveGate.promise)

    const refetchGate = deferred<void>()
    const refetch = jest.fn(() => refetchGate.promise)

    mockUseSession.mockReturnValue({ data: staleSession, isPending: false, error: null, refetch })
    mockUseListOrganizations.mockReturnValue({ data: [{ id: 'o1' }], isPending: false })

    const { result, rerender } = await setupGate()

    await waitFor(() => expect(result.current.kind).toBe('activate'))
    expect(mockSetActive).toHaveBeenCalledTimes(1)

    // setActive is still pending: re-rendering must not fire a second attempt.
    await rerender(undefined)
    await rerender(undefined)
    expect(mockSetActive).toHaveBeenCalledTimes(1)

    // setActive resolves. better-auth's session atom now reports `isRefetching: true` with the OLD, stale
    // activeOrganizationId while the network refetch is still in flight — reproduce that exact window: the
    // mocked session hasn't changed yet, but a re-render happens anyway.
    await act(async () => {
      setActiveGate.resolve()
      await Promise.resolve()
    })
    await rerender(undefined)
    expect(result.current.kind).toBe('activate')
    expect(mockSetActive).toHaveBeenCalledTimes(1)

    // The refetch settles: the session now carries the new org, whose workspace is already onboarded.
    mockUseSession.mockReturnValue({ data: settledSession, isPending: false, error: null, refetch })
    mockWorkspaceQueryFn = () => Promise.resolve({ onboardingStep: 'done' })
    await act(async () => {
      refetchGate.resolve()
      await Promise.resolve()
    })
    await rerender(undefined)

    await waitFor(() => expect(result.current.kind).not.toBe('activate'))
    expect(mockSetActive).toHaveBeenCalledTimes(1)
  })
})

describe('useGate — the workspace lookup', () => {
  it('classifies NOT_FOUND as "no workspace yet" and sends the user to create one', async () => {
    mockUseSession.mockReturnValue({ data: { session: { activeOrganizationId: 'o1' } }, isPending: false, error: null, refetch: jest.fn() })
    mockUseListOrganizations.mockReturnValue({ data: [], isPending: false })
    mockWorkspaceQueryFn = () => Promise.reject({ data: { code: 'NOT_FOUND' } })

    const { result } = await setupGate()

    await waitFor(() => expect(result.current.kind).toBe('create-workspace'))
  })

  it('an unrecognized error surfaces as an error target with a working retry', async () => {
    mockUseSession.mockReturnValue({ data: { session: { activeOrganizationId: 'o1' } }, isPending: false, error: null, refetch: jest.fn() })
    mockUseListOrganizations.mockReturnValue({ data: [], isPending: false })
    let attempts = 0
    mockWorkspaceQueryFn = () => {
      attempts += 1
      return Promise.reject({ data: { code: 'INTERNAL_SERVER_ERROR' } })
    }

    const { result } = await setupGate()

    await waitFor(() => asError(result.current))
    expect(attempts).toBe(1)

    await act(() => { asError(result.current).retry() })
    await waitFor(() => expect(attempts).toBe(2))
  })

  it('ignores a workspace error left over from before sign-out — the gate still sends a signed-out user to sign-in', async () => {
    // A workspace.get in flight when the user signs out can resolve (401) after the session is already
    // gone: react-query freezes that error on the now-disabled query rather than clearing it. Reproduce
    // that by letting the error land while signed in, then flipping the session to signed-out underneath it.
    mockUseSession.mockReturnValue({ data: { session: { activeOrganizationId: 'o1' } }, isPending: false, error: null, refetch: jest.fn() })
    mockUseListOrganizations.mockReturnValue({ data: [], isPending: false })
    mockWorkspaceQueryFn = () => Promise.reject({ data: { code: 'UNAUTHORIZED' } })

    const { result, rerender } = await setupGate()

    await waitFor(() => asError(result.current))

    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null, refetch: jest.fn() })
    mockUseListOrganizations.mockReturnValue({ data: undefined, isPending: false })
    await rerender(undefined)

    await waitFor(() => expect(result.current.kind).toBe('sign-in'))
  })
})

describe('useGate — a broken session lookup', () => {
  it('surfaces as an error target whose retry re-fetches the session', async () => {
    const refetch = jest.fn()
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: new Error('offline'), refetch })
    mockUseListOrganizations.mockReturnValue({ data: undefined, isPending: false })

    const { result } = await setupGate()

    const target = asError(result.current)
    target.retry()
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})

describe('classifyWorkspaceError', () => {
  it('treats NOT_FOUND, PRECONDITION_FAILED and FORBIDDEN as a missing workspace', () => {
    expect(classifyWorkspaceError({ data: { code: 'NOT_FOUND' } })).toBe('missing')
    expect(classifyWorkspaceError({ data: { code: 'PRECONDITION_FAILED' } })).toBe('missing')
    expect(classifyWorkspaceError({ data: { code: 'FORBIDDEN' } })).toBe('missing')
  })

  it('treats anything else, including no data at all, as a real error', () => {
    expect(classifyWorkspaceError({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe('error')
    expect(classifyWorkspaceError({ data: null })).toBe('error')
    expect(classifyWorkspaceError(null)).toBe('error')
    expect(classifyWorkspaceError(undefined)).toBe('error')
  })
})
