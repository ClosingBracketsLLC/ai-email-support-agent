import { fireEvent, render, screen } from '@testing-library/react-native'
import { TicketRow, type TicketSummary } from './ticket-row'

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
