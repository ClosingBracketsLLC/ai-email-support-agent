import { fireEvent, render, screen } from '@testing-library/react-native'
import { TicketRow, type TicketDraftSummary, type TicketSummary } from './ticket-row'

const BASE: TicketSummary = {
  id: 'ticket-1',
  subject: 'Where is my order?',
  customerEmail: 'jane@example.com',
  customerName: 'Jane Doe',
  status: 'needs_owner',
  needsOwnerReason: null,
  categoryKey: 'shipping',
  categoryLabel: 'Shipping',
  sentiment: 'neutral',
  lastInboundAt: new Date('2026-01-01T00:00:00Z'),
  inboundCount: 1,
  agentAddress: 'support@acme.com',
  spamFlagged: false,
  hasAttachments: false,
  draft: null,
}

function ticket(overrides: Partial<TicketSummary>): TicketSummary {
  return { ...BASE, ...overrides }
}

const mockOnPress = jest.fn()
beforeEach(() => mockOnPress.mockReset())

test('renders subject, customer and category, and pressing the row fires onPress', async () => {
  await render(<TicketRow ticket={ticket({})} onPress={mockOnPress} />)
  expect(screen.getByText('Where is my order?')).toBeTruthy()
  expect(screen.getByText('Jane Doe')).toBeTruthy()
  expect(screen.getByText(/Shipping/)).toBeTruthy()

  fireEvent.press(screen.getByTestId('ticket-row-ticket-1'))
  expect(mockOnPress).toHaveBeenCalledTimes(1)
})

test('falls back to "(no subject)" and the customer email when the name is missing', async () => {
  await render(<TicketRow ticket={ticket({ subject: null, customerName: null })} onPress={mockOnPress} />)
  expect(screen.getByText('(no subject)')).toBeTruthy()
  expect(screen.getByText('jane@example.com')).toBeTruthy()
})

describe.each([
  ['tripwire', 'Tripwire'],
  ['triage_flags', 'Flagged'],
  ['sentiment_angry', 'Angry'],
  ['triage_failed', 'Failed'],
  ['triage_cap', 'Capped'],
] as const)('needs_owner reason %s', (reason, chip) => {
  test(`renders the one-word chip "${chip}"`, async () => {
    await render(<TicketRow ticket={ticket({ needsOwnerReason: reason })} onPress={mockOnPress} />)
    expect(screen.getByTestId('ticket-reason-ticket-1')).toBeTruthy()
    expect(screen.getByText(chip)).toBeTruthy()
  })
})

it.each([
  ['agent_escalated', 'Escalated'],
  ['agent_failed', 'Failed'],
  ['agent_run_cap', 'Capped'],
  ['guardrail_failed', 'Blocked'],
  ['redraft_limit_reached', 'Re-drafted 2×'],
  ['redraft_unfulfilled', 'Needs you'],
  ['owner_handling', 'Yours'],
  ['orphaned', 'Lost draft'],
  ['draft_expired', 'Expired'],
  ['send_failed', 'Not sent'],
  ['category_off', 'Off'],
  ['no_agent', 'No agent'],
] as const)('needs_owner reason %s renders the one-word chip "%s"', async (reason, chip) => {
  await render(<TicketRow ticket={ticket({ needsOwnerReason: reason })} onPress={mockOnPress} />)
  expect(screen.getByTestId('ticket-reason-ticket-1')).toBeTruthy()
  expect(screen.getByText(chip)).toBeTruthy()
})

test('no reason chip when needsOwnerReason is null', async () => {
  await render(<TicketRow ticket={ticket({ needsOwnerReason: null })} onPress={mockOnPress} />)
  expect(screen.queryByTestId('ticket-reason-ticket-1')).toBeNull()
})

test('an unrecognized reason string renders no chip rather than throwing (defensive lookup)', async () => {
  await render(<TicketRow ticket={ticket({ needsOwnerReason: 'something_new' })} onPress={mockOnPress} />)
  expect(screen.queryByTestId('ticket-reason-ticket-1')).toBeNull()
})

test('spam and attachment glyphs render only when their flags are set', async () => {
  await render(<TicketRow ticket={ticket({ spamFlagged: true, hasAttachments: true })} onPress={mockOnPress} />)
  expect(screen.getByTestId('ticket-spam-ticket-1')).toBeTruthy()
  expect(screen.getByTestId('ticket-attachment-ticket-1')).toBeTruthy()
})

test('no glyphs when neither flag is set', async () => {
  await render(<TicketRow ticket={ticket({ spamFlagged: false, hasAttachments: false })} onPress={mockOnPress} />)
  expect(screen.queryByTestId('ticket-spam-ticket-1')).toBeNull()
  expect(screen.queryByTestId('ticket-attachment-ticket-1')).toBeNull()
})

test('a ticket with no inbound message yet shows "no messages yet" instead of a bogus relative time', async () => {
  await render(<TicketRow ticket={ticket({ lastInboundAt: null })} onPress={mockOnPress} />)
  expect(screen.getByText('no messages yet')).toBeTruthy()
})

function draft(overrides: Partial<TicketDraftSummary> = {}): TicketDraftSummary {
  return {
    id: 'draft-1', status: 'pending', confidence: 0.82, decisionReason: 'cold_start',
    expiresAt: new Date('2026-01-08T00:00:00Z'), version: 1, ...overrides,
  }
}

test('a pending draft renders the "Reply ready" chip with the category and the confidence', async () => {
  await render(<TicketRow ticket={ticket({ status: 'awaiting_review', draft: draft() })} onPress={mockOnPress} />)
  expect(screen.getByTestId('ticket-draft-ticket-1')).toBeTruthy()
  expect(screen.getByText('Reply ready · Shipping · 82%')).toBeTruthy()
})

test('an uncategorised pending draft says "Uncategorized"', async () => {
  await render(<TicketRow ticket={ticket({ categoryLabel: null, draft: draft({ confidence: 0.5 }) })} onPress={mockOnPress} />)
  expect(screen.getByText('Reply ready · Uncategorized · 50%')).toBeTruthy()
})

test('a pending draft with no confidence score still says "Reply ready"', async () => {
  await render(<TicketRow ticket={ticket({ draft: draft({ confidence: null }) })} onPress={mockOnPress} />)
  expect(screen.getByText('Reply ready · Shipping')).toBeTruthy()
})

it.each([
  ['approved', 'Sending…'],
  ['sending', 'Sending…'],
  ['held', 'On hold'],
] as const)('a %s draft renders the chip "%s"', async (status, chip) => {
  await render(<TicketRow ticket={ticket({ draft: draft({ status }) })} onPress={mockOnPress} />)
  expect(screen.getByTestId('ticket-draft-ticket-1')).toBeTruthy()
  expect(screen.getByText(chip)).toBeTruthy()
})

test('no draft chip when the ticket has no live draft', async () => {
  await render(<TicketRow ticket={ticket({ draft: null })} onPress={mockOnPress} />)
  expect(screen.queryByTestId('ticket-draft-ticket-1')).toBeNull()
})

test('a draft in a status with no chip of its own renders none rather than throwing', async () => {
  await render(<TicketRow ticket={ticket({ draft: draft({ status: 'sent' }) })} onPress={mockOnPress} />)
  expect(screen.queryByTestId('ticket-draft-ticket-1')).toBeNull()
})
