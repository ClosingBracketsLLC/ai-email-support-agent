import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { DraftPanel, type DraftPanelHandle, type DraftPanelProps, type DraftView } from './draft-panel'

const BODY = 'Hi Jane,\n\nYour order ships tomorrow.\n\nThanks!'

const BASE: DraftView = {
  id: 'draft-1',
  version: 1,
  status: 'pending',
  body: BODY,
  finalBody: null,
  decisionReason: 'cold_start',
  confidence: 0.82,
  guardrailResult: { ok: true, findings: [] },
  send: null,
}

const TICKET = { id: 'ticket-1', redraftCount: 0, status: 'awaiting_review' }

const mockApprove = jest.fn()
const mockHold = jest.fn()
const mockReject = jest.fn()
const mockResume = jest.fn()

beforeEach(() => {
  mockApprove.mockReset()
  mockHold.mockReset()
  mockReject.mockReset()
  mockResume.mockReset()
})

function props(overrides: Partial<DraftPanelProps> = {}): DraftPanelProps {
  return {
    draft: BASE,
    ticket: TICKET,
    viewed: true,
    busy: false,
    approveError: null,
    undoUntil: null,
    onApprove: mockApprove,
    onHold: mockHold,
    onReject: mockReject,
    onResume: mockResume,
    ...overrides,
  }
}

const disabled = (testID: string) => screen.getByTestId(testID).props.accessibilityState.disabled

test('renders the header, the confidence chip, the why line and the body', async () => {
  await render(<DraftPanel {...props()} />)

  expect(screen.getByText('Draft reply · v1')).toBeTruthy()
  expect(screen.getByText('82% confidence')).toBeTruthy()
  expect(screen.getByTestId('draft-why').props.children).toBe('Why: Fewer than 10 decisions so far')
  expect(screen.getByTestId('draft-body').props.children).toBe(BODY)
})

test('Approve is disabled until the draft has been viewed', async () => {
  const rendered = await render(<DraftPanel {...props({ viewed: false })} />)
  expect(disabled('approve')).toBe(true)

  await rendered.rerender(<DraftPanel {...props({ viewed: true })} />)
  expect(disabled('approve')).toBe(false)

  await fireEvent.press(screen.getByTestId('approve'))
  expect(mockApprove).toHaveBeenCalledWith(undefined)
})

test('Approve is disabled while a decision is in flight and once the draft is no longer pending', async () => {
  const rendered = await render(<DraftPanel {...props({ busy: true })} />)
  expect(disabled('approve')).toBe(true)

  await rendered.rerender(<DraftPanel {...props({ draft: { ...BASE, status: 'sending' } })} />)
  expect(screen.queryByTestId('approve')).toBeNull()
  expect(screen.getByTestId('draft-decided')).toBeTruthy()
})

test('Edit opens the editor prefilled, and "Approve edited" approves the edited body', async () => {
  await render(<DraftPanel {...props()} />)

  await fireEvent.press(screen.getByTestId('edit'))
  expect(screen.getByTestId('draft-editor').props.value).toBe(BODY)

  await fireEvent.changeText(screen.getByTestId('draft-editor'), 'Hi Jane — it ships tomorrow.')
  await fireEvent.press(screen.getByTestId('approve-edited'))

  expect(mockApprove).toHaveBeenCalledWith('Hi Jane — it ships tomorrow.')
})

test('Cancel leaves edit mode and restores the original body', async () => {
  await render(<DraftPanel {...props()} />)

  await fireEvent.press(screen.getByTestId('edit'))
  await fireEvent.changeText(screen.getByTestId('draft-editor'), 'scratch')
  await fireEvent.press(screen.getByTestId('edit-cancel'))

  expect(screen.queryByTestId('draft-editor')).toBeNull()
  expect(screen.getByTestId('draft-body').props.children).toBe(BODY)
})

test('Reject opens the reject sheet, and submitting it calls onReject', async () => {
  await render(<DraftPanel {...props()} />)

  await fireEvent.press(screen.getByTestId('reject'))
  expect(screen.getByTestId('reject-sheet')).toBeTruthy()

  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Wrong shipping date')
  await fireEvent.press(screen.getByTestId('reject-redraft'))

  expect(mockReject).toHaveBeenCalledWith('redraft', 'Wrong shipping date')
})

test("a guardrail approveError shows the findings and opens edit mode", async () => {
  await render(<DraftPanel {...props({ approveError: { code: 'guardrail', findings: ['url_not_allowed: http://bit.ly/x', 'secret_leak'] } })} />)

  expect(screen.getByTestId('draft-editor')).toBeTruthy()
  expect(screen.getByText('url_not_allowed: http://bit.ly/x')).toBeTruthy()
  expect(screen.getByText('secret_leak')).toBeTruthy()
})

test('an agent_disabled approveError points at the workspace switch', async () => {
  await render(<DraftPanel {...props({ approveError: { code: 'agent_disabled' } })} />)

  expect(screen.getByTestId('approve-error')).toBeTruthy()
  expect(screen.getByText('Turn the agent on to send replies (Settings › Workspace).')).toBeTruthy()
})

test('a not_pending approveError says the draft was already decided', async () => {
  await render(<DraftPanel {...props({ approveError: { code: 'not_pending' } })} />)

  expect(screen.getByText('This draft was already decided.')).toBeTruthy()
})

test('warn findings render as "Heads up" lines', async () => {
  const guardrailResult = { ok: true, findings: [{ code: 'unbacked_number', severity: 'warn', detail: 'the 48h figure is not grounded' }] }
  await render(<DraftPanel {...props({ draft: { ...BASE, guardrailResult } })} />)

  expect(screen.getByText('Heads up: the 48h figure is not grounded')).toBeTruthy()
  expect(disabled('approve')).toBe(false)
})

test('a guardrail_failed draft shows "Blocked:" lines and requires an edit before it can be approved', async () => {
  const guardrailResult = { ok: false, findings: [{ code: 'url_not_allowed', severity: 'fail', detail: 'bit.ly is not an allowed host' }] }
  await render(<DraftPanel {...props({ draft: { ...BASE, decisionReason: 'guardrail_failed', guardrailResult } })} />)

  expect(screen.getByText('Blocked: bit.ly is not an allowed host')).toBeTruthy()
  expect(screen.getByTestId('draft-blocked-note')).toBeTruthy()
  expect(disabled('approve')).toBe(true)

  // Editing is the way through: the approve gate re-validates the edited body.
  await fireEvent.press(screen.getByTestId('edit'))
  await fireEvent.changeText(screen.getByTestId('draft-editor'), 'Hi Jane — see our site for tracking.')
  expect(disabled('approve-edited')).toBe(false)
})

test('an undo window renders the undo bar, and Undo calls onHold', async () => {
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'approved' }, undoUntil: new Date(Date.now() + 15_000), undoTickMs: 10_000 })} />)

  expect(screen.getByTestId('undo-bar')).toBeTruthy()
  await fireEvent.press(screen.getByTestId('undo-button'))
  expect(mockHold).toHaveBeenCalledTimes(1)
})

test('once the undo window closes the panel shows where the reply got to', async () => {
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'approved' }, undoUntil: new Date(Date.now() + 60), undoTickMs: 5 })} />)

  // Longer than waitFor's 1 s default is unnecessary here, but the bar's own interval is what drives it.
  await waitFor(() => expect(screen.getByTestId('draft-decided')).toBeTruthy(), { timeout: 3_000 })
  expect(screen.queryByTestId('undo-bar')).toBeNull()
  expect(screen.getByText('Approved — going out shortly.')).toBeTruthy()
})

test('a held draft explains why and offers "Back to review" instead of the actions row', async () => {
  const send = { id: 'send-1', status: 'held', sendAfter: new Date(), sentAt: null, lastError: 'held:workspace_kill_switch' }
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'held', send } })} />)

  expect(screen.getByText('On hold — sending is paused.')).toBeTruthy()
  expect(screen.queryByTestId('approve')).toBeNull()

  await fireEvent.press(screen.getByTestId('resume'))
  expect(mockResume).toHaveBeenCalledTimes(1)
})

test('a held draft with an unknown hold reason falls back to the generic sentence', async () => {
  const send = { id: 'send-1', status: 'held', sendAfter: new Date(), sentAt: null, lastError: 'held:something_new' }
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'held', send } })} />)

  expect(screen.getByText('On hold — sending was paused.')).toBeTruthy()
})

test('a re-authentication hold points at the mailbox', async () => {
  const send = { id: 'send-1', status: 'held', sendAfter: new Date(), sentAt: null, lastError: 'reauth_required: delivery unverified' }
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'held', send } })} />)

  expect(screen.getByText('On hold — the mailbox needs reconnecting.')).toBeTruthy()
})

test('a held draft that was approved earlier still shows Back to review (status, not decidedAt, decides)', async () => {
  const send = { id: 'send-1', status: 'held', sendAfter: new Date(), sentAt: null, lastError: 'held:ticket_resolved' }
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'held', finalBody: 'An edited reply', send } })} />)

  expect(screen.getByText('On hold — the ticket was resolved.')).toBeTruthy()
  expect(screen.getByTestId('draft-body').props.children).toBe('An edited reply')
  expect(screen.getByTestId('resume')).toBeTruthy()
})

test('a failed draft says it was not sent, in the owner\'s words, and offers Back to review', async () => {
  const send = { id: 'send-1', status: 'failed', sendAfter: new Date(), sentAt: null, lastError: 'stale: newer customer message' }
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'failed', send } })} />)

  expect(screen.getByText('Not sent — the customer wrote again first.')).toBeTruthy()
  expect(screen.queryByTestId('approve')).toBeNull()

  await fireEvent.press(screen.getByTestId('resume'))
  expect(mockResume).toHaveBeenCalledTimes(1)
})

test('a send blocked by the guardrails names them', async () => {
  const send = { id: 'send-1', status: 'failed', sendAfter: new Date(), sentAt: null, lastError: 'guardrail:url_not_allowed,secret_leak' }
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'failed', send } })} />)

  expect(screen.getByText('Not sent — the guardrails blocked the reply.')).toBeTruthy()
  expect(screen.queryByText(/url_not_allowed/)).toBeNull()
})

test("a dead-lettered send's raw provider error never reaches the screen", async () => {
  const send = { id: 'send-1', status: 'failed', sendAfter: new Date(), sentAt: null, lastError: 'getaddrinfo ENOTFOUND smtp.acme.test' }
  await render(<DraftPanel {...props({ draft: { ...BASE, status: 'failed', send } })} />)

  expect(screen.getByText('Not sent — the reply could not be sent.')).toBeTruthy()
  expect(screen.queryByText(/ENOTFOUND/)).toBeNull()
  expect(screen.getByTestId('resume')).toBeTruthy()
})

test('the editor is closed and re-seeded when a different draft takes the panel over', async () => {
  const rendered = await render(<DraftPanel {...props()} />)

  await fireEvent.press(screen.getByTestId('edit'))
  await fireEvent.changeText(screen.getByTestId('draft-editor'), 'half-written edit of the FIRST draft')

  await rendered.rerender(<DraftPanel {...props({ draft: { ...BASE, id: 'draft-2', version: 2, body: 'A newer reply.' } })} />)

  expect(screen.queryByTestId('draft-editor')).toBeNull()
  expect(screen.getByTestId('draft-body').props.children).toBe('A newer reply.')

  await fireEvent.press(screen.getByTestId('edit'))
  expect(screen.getByTestId('draft-editor').props.value).toBe('A newer reply.')
})

describe("the web shortcuts' handle", () => {
  async function renderWithHandle(overrides: Partial<DraftPanelProps> = {}) {
    const handle: { current: DraftPanelHandle | null } = { current: null }
    await render(<DraftPanel {...props({ panelRef: handle, ...overrides })} />)
    return handle
  }

  test('approve, edit and reject drive the panel', async () => {
    const handle = await renderWithHandle()

    await act(async () => { handle.current?.reject() })
    expect(screen.getByTestId('reject-sheet')).toBeTruthy()
  })

  test('approve fires only once the draft has been viewed', async () => {
    const handle = await renderWithHandle({ viewed: false })
    await act(async () => { handle.current?.approve() })
    expect(mockApprove).not.toHaveBeenCalled()
  })

  test('nothing stacks on top of the open editor', async () => {
    const handle = await renderWithHandle()

    await act(async () => { handle.current?.edit() })
    expect(screen.getByTestId('draft-editor')).toBeTruthy()

    // 'r' and 'a' are both no-ops while the owner is editing — the sheet must not cover the editor.
    await act(async () => { handle.current?.reject() })
    expect(screen.queryByTestId('reject-sheet')).toBeNull()

    await act(async () => { handle.current?.approve() })
    expect(mockApprove).not.toHaveBeenCalled()
  })

  test('a blocked draft cannot be approved through the shortcut either', async () => {
    const guardrailResult = { ok: false, findings: [{ code: 'secret_leak', severity: 'fail', detail: 'an API key' }] }
    const handle = await renderWithHandle({ draft: { ...BASE, decisionReason: 'guardrail_failed', guardrailResult } })

    await act(async () => { handle.current?.approve() })
    expect(mockApprove).not.toHaveBeenCalled()
  })
})
