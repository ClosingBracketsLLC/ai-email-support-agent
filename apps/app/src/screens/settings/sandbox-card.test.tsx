import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { SandboxCard } from './sandbox-card'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

const AGENT_ID = '11111111-1111-4111-8111-111111111111'

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations.
const mockSandboxStart = jest.fn()
const mockSandboxGet = jest.fn()

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agents: {
      sandboxStart: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => mockSandboxStart(v), ...o }) },
    },
  }),
  useTRPCClient: () => ({
    agents: { sandboxGet: { query: (v: unknown) => mockSandboxGet(v) } },
  }),
}))

function baseOutput(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'reply', body: 'x', normalizedBody: 'x', guardrail: { ok: true, findings: [] }, confidence: 0.5,
    decision: 'send', decisionReason: 'ok', reason: null, rationale: '', unresolvedQuestions: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1, costMicros: 100 },
    ...overrides,
  }
}
function runningResult() {
  return { status: 'running', output: null, errorCode: null, startedAt: new Date(), finishedAt: null }
}
function succeededResult(output: ReturnType<typeof baseOutput>) {
  return { status: 'succeeded', output, errorCode: null, startedAt: new Date(), finishedAt: new Date() }
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup(props: { pollMs?: number; maxPolls?: number } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(
    <SandboxCard agentId={AGENT_ID} pollMs={props.pollMs ?? 5} maxPolls={props.maxPolls ?? 80} />,
    { wrapper: Wrapper },
  )
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

function runDisabled() {
  const run = screen.getByTestId('sandbox-run')
  return run.props.accessibilityState?.disabled ?? run.props.disabled
}
async function ask(text = 'How do refunds work?') {
  await fireEvent.changeText(screen.getByTestId('sandbox-question'), text)
  await act(async () => { await fireEvent.press(screen.getByTestId('sandbox-run')) })
}

beforeEach(() => {
  mockSandboxStart.mockReset()
  mockSandboxGet.mockReset()
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('Run is disabled while the question is blank, enabled once something is typed', async () => {
  await setup()
  expect(runDisabled()).toBe(true)
  await fireEvent.changeText(screen.getByTestId('sandbox-question'), 'How do refunds work?')
  expect(runDisabled()).toBe(false)
})

test('Run starts the sandbox, polls until success, and renders the body and confidence', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-1' })
  mockSandboxGet
    .mockResolvedValueOnce(runningResult())
    .mockResolvedValueOnce(succeededResult(baseOutput({ normalizedBody: 'Refunds take 3-5 days.', confidence: 0.87 })))

  await setup()
  await ask()

  await waitFor(() => expect(mockSandboxStart).toHaveBeenCalledWith({ agentId: AGENT_ID, question: 'How do refunds work?' }))
  await waitFor(() => expect(screen.getByTestId('sandbox-result')).toBeTruthy())
  expect(screen.getByText('Refunds take 3-5 days.')).toBeTruthy()
  expect(screen.getByText('87% confidence')).toBeTruthy()
  expect(screen.getByText('Would go to: Send (Ready to send)')).toBeTruthy()
})

test('Run is disabled again once pressed, while the run is in flight (pending guard)', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-2' })
  mockSandboxGet.mockResolvedValue(runningResult())

  await setup()
  await ask()
  await waitFor(() => expect(runDisabled()).toBe(true))
})

test('a guardrail-failing output shows "Blocked:" and the review reason label', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-3' })
  mockSandboxGet.mockResolvedValue(succeededResult(baseOutput({
    guardrail: { ok: false, findings: [{ code: 'secret_leak', severity: 'fail', detail: 'looked like an API key' }] },
    decision: 'review', decisionReason: 'guardrail_failed',
  })))

  await setup()
  await ask()

  await waitFor(() => expect(screen.getByText('Blocked: secret_leak: looked like an API key')).toBeTruthy())
  expect(screen.getByText('Would go to: Review (The guardrails blocked this draft)')).toBeTruthy()
})

test('a guardrail warning-only output shows "Heads up:"', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-3b' })
  mockSandboxGet.mockResolvedValue(succeededResult(baseOutput({
    guardrail: { ok: true, findings: [{ code: 'unbacked_number', severity: 'warn', detail: 'no source for this figure' }] },
  })))

  await setup()
  await ask()

  await waitFor(() => expect(screen.getByText('Heads up: unbacked_number: no source for this figure')).toBeTruthy())
})

test('an escalate outcome shows the model\'s reason and rationale', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-4' })
  mockSandboxGet.mockResolvedValue({
    status: 'succeeded',
    output: {
      outcome: 'escalate', body: null, normalizedBody: null, guardrail: null, confidence: null,
      decision: 'escalate', decisionReason: 'agent_escalate', reason: 'Needs a refund exception',
      rationale: 'The customer is asking for something outside policy.', unresolvedQuestions: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1, costMicros: 100 },
    },
    errorCode: null, startedAt: new Date(), finishedAt: new Date(),
  })

  await setup()
  await ask('Can I get a refund outside policy?')

  await waitFor(() => expect(screen.getByText('Needs a refund exception')).toBeTruthy())
  expect(screen.getByText('The customer is asking for something outside policy.')).toBeTruthy()
})

test('a failed run shows "The agent could not answer (<errorCode>)."', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-5' })
  mockSandboxGet.mockResolvedValue({ status: 'failed', output: null, errorCode: 'model_error', startedAt: new Date(), finishedAt: new Date() })

  await setup()
  await ask('Anything')

  await waitFor(() => expect(screen.getByText('The agent could not answer (model_error).')).toBeTruthy())
})

test('the daily cap error shows the exact copy', async () => {
  mockSandboxStart.mockRejectedValue({ data: { code: 'TOO_MANY_REQUESTS' }, message: 'sandbox.daily_cap reached for today' })

  await setup()
  await ask('Anything')

  await waitFor(() => expect(screen.getByText('Daily sandbox limit reached — try again tomorrow.')).toBeTruthy())
  await act(async () => { await Promise.resolve() })
})

test('polling gives up after maxPolls and shows a timeout message', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-6' })
  mockSandboxGet.mockResolvedValue(runningResult())

  await setup({ pollMs: 5, maxPolls: 2 })
  await ask('Anything')

  await waitFor(() => expect(screen.getByText('Taking too long. Try again.')).toBeTruthy())
  expect(mockSandboxGet.mock.calls.length).toBeLessThanOrEqual(2)
})

test('unmounting stops the poll — no further sandboxGet calls after that', async () => {
  mockSandboxStart.mockResolvedValue({ runId: 'run-7' })
  mockSandboxGet.mockResolvedValue(runningResult())

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } })
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> }
  const rendered = await render(<SandboxCard agentId={AGENT_ID} pollMs={5} />, { wrapper: Wrapper })

  await ask('Anything')
  await waitFor(() => expect(mockSandboxGet.mock.calls.length).toBeGreaterThan(0))

  // A sync act() here does not flush the passive-effect cleanup (verified empirically — RNTL/React 19
  // schedules a `useEffect` cleanup as a passive effect even on unmount); the awaited async form does.
  await act(async () => { rendered.unmount() })
  const callsAtUnmount = mockSandboxGet.mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(mockSandboxGet.mock.calls.length).toBe(callsAtUnmount)
  queryClient.unmount()
})
