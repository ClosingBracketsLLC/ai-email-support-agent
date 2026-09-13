import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { LLM_ERROR_MESSAGES, MANAGED_MODELS } from '@aesa/contracts'
import { ModelCard } from './model-card'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CRED_ID = '22222222-2222-4222-8222-222222222222'
const DEAD_CRED_ID = '33333333-3333-4333-8333-333333333333'

interface Credential {
  id: string; provider: string; label: string; baseUrl: string | null; keyFingerprint: string
  healthStatus: string; lastProbe: null; lastProbedAt: Date | null; lastError: string | null
  createdAt: Date
  usage30d: { calls: number; errors: number; costMicros: number; costUnknownCalls: number; lastErrorCode: string | null }
  agentsUsing: number
}
interface Resolved {
  mode: string; credentialId: string | null; provider: string; model: string
  effort: string | null; fallbackToManaged: boolean; tier: string
  modelGeneration: number; modelGenerationAt: Date | null
  credential: { label: string; baseUrl: string | null; healthStatus: string; lastProbe: null } | null
}

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations (see agents.test.tsx).
let mockCredentials: Credential[] = []
let mockAgentModel: { draft: Resolved; triage: Resolved } | null = null
let mockAgentModelImpl: () => Promise<unknown> = () => Promise.resolve(mockAgentModel)
const mockSetCalls: unknown[] = []
let mockSetImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ ok: true, generationBumped: true, demoted: 0 })

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agents: { list: { queryKey: () => ['agents', 'list'] } },
    llm: {
      list: {
        queryOptions: () => ({ queryKey: ['llm', 'list'], queryFn: () => Promise.resolve({ credentials: mockCredentials }) }),
        queryKey: () => ['llm', 'list'],
      },
      agentModel: {
        queryOptions: (input: { agentId: string }) => ({ queryKey: ['llm', 'agentModel', input.agentId], queryFn: () => mockAgentModelImpl() }),
        queryKey: (input: { agentId: string }) => ['llm', 'agentModel', input.agentId],
      },
      setAgentModel: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockSetCalls.push(v); return mockSetImpl(v) }, ...o }) },
    },
  }),
}))

function managed(role: 'draft' | 'triage'): Resolved {
  return {
    mode: 'managed', credentialId: null, provider: 'anthropic', model: MANAGED_MODELS[role],
    effort: null, fallbackToManaged: false, tier: 'calibrated', modelGeneration: 1, modelGenerationAt: null, credential: null,
  }
}
function byok(model: string, overrides: Partial<Resolved> = {}): Resolved {
  return {
    mode: 'byok', credentialId: CRED_ID, provider: 'openai', model,
    effort: null, fallbackToManaged: false, tier: 'standard', modelGeneration: 2,
    modelGenerationAt: new Date('2026-09-10T00:00:00.000Z'),
    credential: { label: 'Production key', baseUrl: null, healthStatus: 'healthy', lastProbe: null },
    ...overrides,
  }
}
function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: CRED_ID, provider: 'openai', label: 'Production key', baseUrl: null, keyFingerprint: '4f3a2b1c…dEfG',
    healthStatus: 'healthy', lastProbe: null, lastProbedAt: null, lastError: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    usage30d: { calls: 0, errors: 0, costMicros: 0, costUnknownCalls: 0, lastErrorCode: null },
    agentsUsing: 0,
    ...overrides,
  }
}

/** A promise this test resolves by hand, so a refetch can be held open across assertions — the same
 * trick `agent-edit.test.tsx` uses. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** The initial load resolves at once; every refetch after it is handed to the caller to settle. */
function heldRefetch() {
  const held = deferred<{ draft: Resolved; triage: Resolved }>()
  let calls = 0
  mockAgentModelImpl = () => {
    calls += 1
    return calls === 1 ? Promise.resolve(mockAgentModel) : held.promise
  }
  return held
}

const SAVED_BYOK = () => ({
  draft: byok('gpt-5-pro', { effort: 'high', fallbackToManaged: true }),
  triage: byok('gpt-5-mini', { effort: 'high', fallbackToManaged: true }),
})

const teardowns: Array<() => Promise<void> | void> = []
async function setup(canManage = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<ModelCard agentId={AGENT_ID} canManage={canManage} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockCredentials = []
  mockAgentModel = { draft: managed('draft'), triage: managed('triage') }
  mockAgentModelImpl = () => Promise.resolve(mockAgentModel)
  mockSetCalls.length = 0
  mockSetImpl = () => Promise.resolve({ ok: true, generationBumped: true, demoted: 0 })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('the default is Managed AI, with no model fields to fill in', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('model-managed')).toBeTruthy())

  expect(screen.getByTestId('model-managed').props.accessibilityState.checked).toBe(true)
  expect(screen.queryByTestId('draft-model')).toBeNull()
  expect(screen.queryByTestId('triage-model')).toBeNull()
  expect(screen.queryByTestId('model-fallback')).toBeNull()
  // Nothing has changed yet, so neither the note nor an enabled Save.
  expect(screen.queryByTestId('model-change-note')).toBeNull()
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(true)
})

test('with no connection at all, the card points at Settings › AI instead of an empty picker', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('model-managed')).toBeTruthy())

  expect(screen.getByTestId('model-no-credentials')).toBeTruthy()
})

test('picking a healthy connection reveals both model fields prefilled from the preset, the effort chips and the fallback switch', async () => {
  mockCredentials = [credential()]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`model-credential-${CRED_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`model-credential-${CRED_ID}`))

  expect(screen.getByTestId('draft-model').props.value).toBe('gpt-5')
  expect(screen.getByTestId('triage-model').props.value).toBe('gpt-5-mini')
  for (const id of ['effort-default', 'effort-low', 'effort-medium', 'effort-high']) expect(screen.getByTestId(id)).toBeTruthy()
  expect(screen.getByTestId('effort-default').props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('model-fallback')).toBeTruthy()
  // The draft model is about to change, so the owner is told what it costs before they save.
  expect(screen.getByText('Autopilot categories go back to Review when the model changes.')).toBeTruthy()
})

test('a rejected key is listed but cannot be chosen', async () => {
  mockCredentials = [credential({ id: DEAD_CRED_ID, label: 'Old key', healthStatus: 'dead', lastError: 'invalid_api_key' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`model-credential-${DEAD_CRED_ID}`)).toBeTruthy())

  expect(screen.getByTestId(`model-credential-${DEAD_CRED_ID}`).props.accessibilityState.disabled).toBe(true)
  expect(screen.getByText('Key rejected')).toBeTruthy()

  await fireEvent.press(screen.getByTestId(`model-credential-${DEAD_CRED_ID}`))
  expect(screen.getByTestId('model-managed').props.accessibilityState.checked).toBe(true)
  expect(screen.queryByTestId('draft-model')).toBeNull()
})

test('Save sends exactly what the form holds, and reports the categories that went back to Review', async () => {
  mockCredentials = [credential()]
  mockSetImpl = () => Promise.resolve({ ok: true, generationBumped: true, demoted: 2 })
  // The invalidation's refetch is held open, which is where the regression lived: the fields must keep
  // showing what was saved for as long as the server has not answered.
  const refetch = heldRefetch()
  await setup()
  await waitFor(() => expect(screen.getByTestId(`model-credential-${CRED_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`model-credential-${CRED_ID}`))
  await fireEvent.changeText(screen.getByTestId('draft-model'), 'gpt-5-pro')
  await fireEvent.press(screen.getByTestId('effort-high'))
  await fireEvent(screen.getByTestId('model-fallback'), 'valueChange', true)
  await fireEvent.press(screen.getByTestId('model-save'))

  await waitFor(() => expect(mockSetCalls).toHaveLength(1))
  expect(mockSetCalls[0]).toEqual({
    agentId: AGENT_ID, mode: 'byok', credentialId: CRED_ID,
    draftModel: 'gpt-5-pro', triageModel: 'gpt-5-mini', effort: 'high', fallbackToManaged: true,
  })
  await waitFor(() => expect(screen.getByText('Saved — 2 Autopilot categories went back to Review.')).toBeTruthy())

  // STILL showing what was saved while the refetch is in flight. Clearing `dirty` first re-ran the
  // seeding effect against the PRE-save config, which snapped the card back to Managed AI — the byok
  // fields would not even be mounted here — under the green banner.
  expect(screen.getByTestId('draft-model').props.value).toBe('gpt-5-pro')
  expect(screen.getByTestId('triage-model').props.value).toBe('gpt-5-mini')
  expect(screen.getByTestId(`model-credential-${CRED_ID}`).props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('model-managed').props.accessibilityState.checked).toBe(false)
  expect(screen.getByTestId('effort-high').props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('model-fallback').props.value).toBe(true)

  await act(async () => { refetch.resolve(SAVED_BYOK()) })

  // And once the server has answered, the same values — now nothing is dirty, so Save is disabled.
  expect(screen.getByTestId('draft-model').props.value).toBe('gpt-5-pro')
  expect(screen.getByTestId(`model-credential-${CRED_ID}`).props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(true)
})

test('a save whose refetch then FAILS still shows what was saved, not the config it replaced', async () => {
  mockCredentials = [credential()]
  const refetch = heldRefetch()
  await setup()
  await waitFor(() => expect(screen.getByTestId(`model-credential-${CRED_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`model-credential-${CRED_ID}`))
  await fireEvent.changeText(screen.getByTestId('draft-model'), 'gpt-5-pro')
  await fireEvent.press(screen.getByTestId('model-save'))
  await waitFor(() => expect(mockSetCalls).toHaveLength(1))

  await act(async () => { refetch.reject(new Error('network down')) })

  // The save landed; only the read-back failed. Reverting the form would claim the save did not happen.
  expect(screen.getByTestId('draft-model').props.value).toBe('gpt-5-pro')
  expect(screen.getByTestId(`model-credential-${CRED_ID}`).props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(true)
})

test('an edit made while a save was in flight survives the refetch that follows it', async () => {
  mockCredentials = [credential()]
  mockAgentModel = { draft: byok('gpt-5'), triage: byok('gpt-5-mini') }
  const refetch = heldRefetch()
  await setup()
  await waitFor(() => expect(screen.getByTestId('draft-model')).toBeTruthy())

  await fireEvent.changeText(screen.getByTestId('draft-model'), 'gpt-5-pro')
  await fireEvent.press(screen.getByTestId('model-save'))
  await waitFor(() => expect(mockSetCalls).toHaveLength(1))

  // The owner kept typing while the save was in flight; the config the server then returns is the one
  // that was SENT, and must not overwrite what is on screen now.
  await fireEvent.changeText(screen.getByTestId('triage-model'), 'gpt-5-nano')
  await act(async () => { refetch.resolve({ draft: byok('gpt-5-pro'), triage: byok('gpt-5-mini') }) })

  expect(screen.getByTestId('triage-model').props.value).toBe('gpt-5-nano')
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(false)
})

test('going back to Managed AI sends the managed shape', async () => {
  mockCredentials = [credential()]
  mockAgentModel = { draft: byok('gpt-5'), triage: byok('gpt-5-mini') }
  await setup()
  await waitFor(() => expect(screen.getByTestId('model-managed')).toBeTruthy())

  expect(screen.getByTestId(`model-credential-${CRED_ID}`).props.accessibilityState.checked).toBe(true)
  await fireEvent.press(screen.getByTestId('model-managed'))
  expect(screen.getByText('Autopilot categories go back to Review when the model changes.')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('model-save'))
  await waitFor(() => expect(mockSetCalls).toHaveLength(1))
  expect(mockSetCalls[0]).toEqual({
    agentId: AGENT_ID, mode: 'managed', credentialId: null,
    draftModel: null, triageModel: null, effort: null, fallbackToManaged: false,
  })
})

test('a change that leaves the draft model alone carries no demotion warning', async () => {
  mockCredentials = [credential()]
  mockAgentModel = { draft: byok('gpt-5'), triage: byok('gpt-5-mini') }
  await setup()
  await waitFor(() => expect(screen.getByTestId('triage-model')).toBeTruthy())

  await fireEvent.changeText(screen.getByTestId('triage-model'), 'gpt-5-nano')
  expect(screen.queryByTestId('model-change-note')).toBeNull()
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(false)
})

test('a plain member sees the choice, disabled, and no Save', async () => {
  mockCredentials = [credential()]
  mockAgentModel = { draft: byok('gpt-5'), triage: byok('gpt-5-mini') }
  await setup(false)
  await waitFor(() => expect(screen.getByTestId('model-managed')).toBeTruthy())

  expect(screen.getByTestId('model-readonly')).toBeTruthy()
  expect(screen.getByTestId('model-managed').props.accessibilityState.disabled).toBe(true)
  expect(screen.getByTestId(`model-credential-${CRED_ID}`).props.accessibilityState.disabled).toBe(true)
  expect(screen.getByTestId('draft-model').props.editable).toBe(false)
  expect(screen.getByTestId('effort-low').props.accessibilityState.disabled).toBe(true)
  expect(screen.getByTestId('model-fallback').props.accessibilityState.disabled).toBe(true)
  expect(screen.queryByTestId('model-save')).toBeNull()
})

test('a model choice that cannot be read says so instead of vanishing', async () => {
  mockAgentModelImpl = () => Promise.reject(new Error('network down'))
  await setup()
  await waitFor(() => expect(screen.getByTestId('model-load-error')).toBeTruthy())

  expect(screen.getByText("Couldn't load this agent's model settings. Pull to refresh or try again.")).toBeTruthy()
  expect(screen.queryByTestId('model-managed')).toBeNull()
})

test('a custom endpoint has nothing to prefill, so both fields say what to put in them', async () => {
  mockCredentials = [credential({ provider: 'custom', label: 'On-prem', baseUrl: 'https://llm.example.com/v1' })]
  await setup()
  await waitFor(() => expect(screen.getByTestId(`model-credential-${CRED_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`model-credential-${CRED_ID}`))
  expect(screen.getByTestId('draft-model').props.value).toBe('')
  expect(screen.getByTestId('triage-model').props.value).toBe('')
  expect(screen.getAllByText('Enter the model id this endpoint serves (for example qwen3:32b).')).toHaveLength(2)
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(true)

  // Naming the draft model retires that field's hint; the triage field still asks for its own.
  await fireEvent.changeText(screen.getByTestId('draft-model'), 'qwen3:32b')
  expect(screen.getAllByText('Enter the model id this endpoint serves (for example qwen3:32b).')).toHaveLength(1)
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('triage-model'), 'qwen3:8b')
  expect(screen.getByTestId('model-save').props.accessibilityState.disabled).toBe(false)
})

test('a refused save says what to do about it', async () => {
  mockCredentials = [credential()]
  mockSetImpl = () => Promise.reject({ message: LLM_ERROR_MESSAGES.credential_dead, data: { code: 'PRECONDITION_FAILED' } })
  await setup()
  await waitFor(() => expect(screen.getByTestId(`model-credential-${CRED_ID}`)).toBeTruthy())

  await fireEvent.press(screen.getByTestId(`model-credential-${CRED_ID}`))
  await fireEvent.press(screen.getByTestId('model-save'))

  await waitFor(() => expect(screen.getByTestId('model-error')).toBeTruthy())
  expect(screen.getByText('That connection was rejected by the provider — test it on the AI screen first.')).toBeTruthy()
})
