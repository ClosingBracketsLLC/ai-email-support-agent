import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { MANAGED_MODELS } from '@aesa/contracts'
import { AiSettingsScreen } from './ai'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

const CRED_ID = '11111111-1111-4111-8111-111111111111'
const CRED_2_ID = '22222222-2222-4222-8222-222222222222'

interface Probe {
  ok: boolean; probedAt: string; models: string[] | null; chat: 'ok' | 'failed'
  structured: 'native' | 'json_mode' | 'none' | null; latencyMs: number
  error: { code: string; message: string } | null
}
interface Credential {
  id: string; provider: string; label: string; baseUrl: string | null; keyFingerprint: string
  healthStatus: string; lastProbe: Probe | null; lastProbedAt: Date | null; lastError: string | null
  createdAt: Date
  usage30d: { calls: number; errors: number; costMicros: number; costUnknownCalls: number; lastErrorCode: string | null }
  agentsUsing: number
}

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations (see agents.test.tsx).
let mockCredentials: Credential[] = []
let mockRole = 'owner'
const mockAddCalls: unknown[] = []
const mockProbeCalls: unknown[] = []
const mockRemoveCalls: unknown[] = []
let mockAddImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ credentialId: CRED_ID })
let mockRemoveImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ ok: true, agentsReset: 0 })

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    workspace: {
      get: { queryOptions: () => ({ queryKey: ['workspace', 'get'], queryFn: () => Promise.resolve({ businessName: 'Acme', role: mockRole }) }) },
    },
    agents: { list: { queryKey: () => ['agents', 'list'] } },
    llm: {
      list: {
        queryOptions: () => ({ queryKey: ['llm', 'list'], queryFn: () => Promise.resolve({ credentials: mockCredentials }) }),
        queryKey: () => ['llm', 'list'],
      },
      agentModel: { queryKey: () => ['llm', 'agentModel'] },
      add: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockAddCalls.push(v); return mockAddImpl(v) }, ...o }) },
      probe: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockProbeCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
      remove: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockRemoveCalls.push(v); return mockRemoveImpl(v) }, ...o }) },
    },
  }),
}))

function probe(overrides: Partial<Probe> = {}): Probe {
  return {
    ok: true, probedAt: '2026-09-12T10:00:00.000Z', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    chat: 'ok', structured: 'native', latencyMs: 412, error: null, ...overrides,
  }
}
function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: CRED_ID, provider: 'openai', label: 'Production key', baseUrl: null, keyFingerprint: '4f3a2b1c…dEfG',
    healthStatus: 'healthy', lastProbe: probe(), lastProbedAt: new Date('2026-09-12T10:00:00.000Z'),
    lastError: null, createdAt: new Date('2026-09-01T00:00:00.000Z'),
    usage30d: { calls: 12, errors: 0, costMicros: 30_000, costUnknownCalls: 0, lastErrorCode: null },
    agentsUsing: 0,
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
  const rendered = await render(<AiSettingsScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

/** Opens the add form and fills the two fields every provider needs. */
async function openAddForm() {
  await fireEvent.press(screen.getByTestId('ai-add-open'))
  await waitFor(() => expect(screen.getByTestId('add-provider-form')).toBeTruthy())
}

beforeEach(() => {
  mockCredentials = []
  mockRole = 'owner'
  mockAddCalls.length = 0
  mockProbeCalls.length = 0
  mockRemoveCalls.length = 0
  mockAddImpl = () => Promise.resolve({ credentialId: CRED_ID })
  mockRemoveImpl = () => Promise.resolve({ ok: true, agentsReset: 0 })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('the Managed AI card names both platform models', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('managed-card')).toBeTruthy())

  expect(screen.getByText(`Drafting ${MANAGED_MODELS.draft}`)).toBeTruthy()
  expect(screen.getByText(`Triage ${MANAGED_MODELS.triage}`)).toBeTruthy()
})

test('no connections: the empty state, and the Add button only for a manager', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('ai-empty')).toBeTruthy())
  expect(screen.getByTestId('ai-add-open')).toBeTruthy()
  expect(screen.queryByTestId('ai-readonly')).toBeNull()
})

test('a plain member sees the connections read-only: no Add, no Test, no Remove', async () => {
  mockRole = 'member'
  mockCredentials = [credential({ agentsUsing: 2 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`credential-${CRED_ID}`)).toBeTruthy())

  expect(screen.getByTestId('ai-readonly')).toBeTruthy()
  expect(screen.queryByTestId('ai-add-open')).toBeNull()
  expect(screen.queryByTestId(`credential-test-${CRED_ID}`)).toBeNull()
  expect(screen.queryByTestId(`credential-remove-${CRED_ID}`)).toBeNull()
  // The facts are still readable — a member can see what the workspace is on and what it costs.
  expect(screen.getByText('Production key')).toBeTruthy()
  expect(screen.getByText('12 calls · $0.03')).toBeTruthy()
})

test('the add form: a preset hides the base URL, custom shows base URL and probe model, and the consent sentence names the provider', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('ai-add-open')).toBeTruthy())
  await openAddForm()

  // The default pick is a preset, so the endpoint fields are not in the way.
  expect(screen.queryByTestId('credential-base-url')).toBeNull()
  expect(screen.queryByTestId('credential-probe-model')).toBeNull()
  expect(screen.getByText('Email content will be sent to Anthropic under its terms.')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('provider-openai'))
  expect(screen.queryByTestId('credential-base-url')).toBeNull()
  expect(screen.getByText('Email content will be sent to OpenAI under its terms.')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('provider-custom'))
  expect(screen.getByTestId('credential-base-url')).toBeTruthy()
  expect(screen.getByTestId('credential-probe-model')).toBeTruthy()
  expect(screen.getByText('Email content will be sent to the endpoint you configured under its terms.')).toBeTruthy()
  expect(screen.getByText('A custom endpoint must be an https address on the public internet — a local Ollama or vLLM needs a public hostname.')).toBeTruthy()
})

test('Add stays disabled until the form is complete, and a preset is submitted with no baseUrl at all', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('ai-add-open')).toBeTruthy())
  await openAddForm()
  await fireEvent.press(screen.getByTestId('provider-openai'))

  expect(screen.getByTestId('add-submit').props.accessibilityState.disabled).toBe(true)
  await fireEvent.changeText(screen.getByTestId('credential-label'), 'Production key')
  expect(screen.getByTestId('add-submit').props.accessibilityState.disabled).toBe(true)
  await fireEvent.changeText(screen.getByTestId('credential-key'), 'sk-test-0123456789')
  expect(screen.getByTestId('add-submit').props.accessibilityState.disabled).toBe(false)

  await fireEvent.press(screen.getByTestId('add-submit'))
  await waitFor(() => expect(mockAddCalls).toHaveLength(1))
  expect(mockAddCalls[0]).toEqual({ provider: 'openai', label: 'Production key', apiKey: 'sk-test-0123456789' })
  expect(Object.keys(mockAddCalls[0] as object)).not.toContain('baseUrl')
  // The pasted key never survives the add — it lived in component state and nowhere else.
  await waitFor(() => expect(screen.queryByTestId('add-provider-form')).toBeNull())
})

test('a custom endpoint needs its base URL and probe model, and submits both', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('ai-add-open')).toBeTruthy())
  await openAddForm()
  await fireEvent.press(screen.getByTestId('provider-custom'))
  await fireEvent.changeText(screen.getByTestId('credential-label'), 'On-prem')
  await fireEvent.changeText(screen.getByTestId('credential-key'), 'sk-test-0123456789')
  expect(screen.getByTestId('add-submit').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('credential-base-url'), 'https://llm.example.com/v1')
  await fireEvent.changeText(screen.getByTestId('credential-probe-model'), 'qwen3:32b')
  expect(screen.getByTestId('add-submit').props.accessibilityState.disabled).toBe(false)

  await fireEvent.press(screen.getByTestId('add-submit'))
  await waitFor(() => expect(mockAddCalls).toHaveLength(1))
  expect(mockAddCalls[0]).toEqual({
    provider: 'custom', label: 'On-prem', apiKey: 'sk-test-0123456789',
    baseUrl: 'https://llm.example.com/v1', probeModel: 'qwen3:32b',
  })
})

test('a base URL that is not https says so under the field instead of a silently dead button', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('ai-add-open')).toBeTruthy())
  await openAddForm()
  await fireEvent.press(screen.getByTestId('provider-custom'))
  await fireEvent.changeText(screen.getByTestId('credential-label'), 'On-prem')
  await fireEvent.changeText(screen.getByTestId('credential-key'), 'sk-test-0123456789')
  await fireEvent.changeText(screen.getByTestId('credential-base-url'), 'http://localhost:11434/v1')
  await fireEvent.changeText(screen.getByTestId('credential-probe-model'), 'qwen3:32b')

  expect(screen.getByText('Enter a full https:// address')).toBeTruthy()
  expect(screen.getByTestId('add-submit').props.accessibilityState.disabled).toBe(true)
})

test('an unsafe custom endpoint is refused in the owner\'s words', async () => {
  mockAddImpl = () => Promise.reject({ message: 'that endpoint must be a public https address', data: { code: 'BAD_REQUEST' } })
  await setup()
  await waitFor(() => expect(screen.getByTestId('ai-add-open')).toBeTruthy())
  await openAddForm()
  await fireEvent.press(screen.getByTestId('provider-custom'))
  await fireEvent.changeText(screen.getByTestId('credential-label'), 'On-prem')
  await fireEvent.changeText(screen.getByTestId('credential-key'), 'sk-test-0123456789')
  await fireEvent.changeText(screen.getByTestId('credential-base-url'), 'https://llm.example.com/v1')
  await fireEvent.changeText(screen.getByTestId('credential-probe-model'), 'qwen3:32b')
  await fireEvent.press(screen.getByTestId('add-submit'))

  await waitFor(() => expect(screen.getByTestId('add-error')).toBeTruthy())
  expect(screen.getByText("That endpoint can't be reached safely: it must be an https address on the public internet.")).toBeTruthy()
  // The form stays open with the owner's typing intact, so the endpoint can simply be corrected.
  expect(screen.getByTestId('credential-base-url').props.value).toBe('https://llm.example.com/v1')
})

test('each health status has its own chip', async () => {
  mockCredentials = [
    credential({ id: CRED_ID, healthStatus: 'unknown', lastProbe: null, lastProbedAt: null }),
    credential({ id: CRED_2_ID, label: 'Backup key', healthStatus: 'dead', lastError: 'invalid_api_key' }),
  ]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`credential-${CRED_ID}`)).toBeTruthy())

  expect(screen.getByTestId(`credential-health-${CRED_ID}`).props.accessibilityLabel).toBe('Checking…')
  expect(screen.getByTestId(`credential-health-${CRED_2_ID}`).props.accessibilityLabel).toBe('Key rejected')
  expect(screen.getByText('Not tested yet')).toBeTruthy()
})

test('degraded and healthy chips read as such', async () => {
  mockCredentials = [
    credential({ id: CRED_ID, healthStatus: 'healthy' }),
    credential({ id: CRED_2_ID, label: 'Backup key', healthStatus: 'degraded' }),
  ]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`credential-${CRED_ID}`)).toBeTruthy())

  expect(screen.getByTestId(`credential-health-${CRED_ID}`).props.accessibilityLabel).toBe('Healthy')
  expect(screen.getByTestId(`credential-health-${CRED_2_ID}`).props.accessibilityLabel).toBe('Degraded')
})

test('a connection card carries its provider, fingerprint, probe summary, cost and both actions', async () => {
  mockCredentials = [credential({ agentsUsing: 1 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`credential-${CRED_ID}`)).toBeTruthy())

  expect(screen.getByText('Production key')).toBeTruthy()
  expect(screen.getByText('OpenAI · 4f3a2b1c…dEfG')).toBeTruthy()
  expect(screen.getByText('3 models · structured output: native')).toBeTruthy()
  expect(screen.getByText('12 calls · $0.03')).toBeTruthy()
  expect(screen.getByText('Used by 1 agent')).toBeTruthy()

  await fireEvent.press(screen.getByTestId(`credential-test-${CRED_ID}`))
  await waitFor(() => expect(mockProbeCalls).toEqual([{ credentialId: CRED_ID }]))
})

test('calls whose price we do not know say so instead of showing a wrong total', async () => {
  mockCredentials = [credential({ usage30d: { calls: 12, errors: 1, costMicros: 0, costUnknownCalls: 4, lastErrorCode: 'llm_rate_limit' } })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`credential-${CRED_ID}`)).toBeTruthy())

  expect(screen.getByText('12 calls · cost unknown')).toBeTruthy()
})

test('a probe the workspace is still waiting on says the page will update itself', async () => {
  mockCredentials = [credential({ healthStatus: 'unknown', lastProbe: null, lastProbedAt: null })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('ai-testing')).toBeTruthy())
})

test('a settled connection is quiet until its key is tested again', async () => {
  mockCredentials = [credential()]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`credential-${CRED_ID}`)).toBeTruthy())
  expect(screen.queryByTestId('ai-testing')).toBeNull()

  await fireEvent.press(screen.getByTestId(`credential-test-${CRED_ID}`))
  await waitFor(() => expect(screen.getByTestId('ai-testing')).toBeTruthy())
})

test('Remove asks first, and says how many agents fall back to Managed AI', async () => {
  mockCredentials = [credential({ agentsUsing: 2 })]
  mockRemoveImpl = () => Promise.resolve({ ok: true, agentsReset: 2 })
  await setup()
  await waitFor(() => expect(screen.getByTestId(`credential-remove-${CRED_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`credential-remove-${CRED_ID}`))
  expect(mockRemoveCalls).toHaveLength(0)
  expect(screen.getByText('Remove this connection? 2 agents fall back to Managed AI.')).toBeTruthy()

  await fireEvent.press(screen.getByTestId(`credential-remove-${CRED_ID}`))
  await waitFor(() => expect(mockRemoveCalls).toEqual([{ credentialId: CRED_ID }]))
})
