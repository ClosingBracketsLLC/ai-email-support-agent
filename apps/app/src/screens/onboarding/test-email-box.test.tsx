import { fireEvent, render, screen } from '@testing-library/react-native'
import { TestEmailBox } from './test-email-box'

test('with no draft yet it names the address to write to and says it is waiting', async () => {
  await render(<TestEmailBox address="support@acme.com" firstDraft={null} onReview={jest.fn()} />)
  expect(screen.getByText('Send yourself a test email')).toBeTruthy()
  expect(screen.getByText("From any mailbox, email support@acme.com with a question a customer might ask. The agent's first draft appears here.")).toBeTruthy()
  expect(screen.getByTestId('waiting')).toBeTruthy()
  expect(screen.getByText('Waiting for your first email…')).toBeTruthy()
  expect(screen.queryByTestId('review-first-draft')).toBeNull()
})

test('once the first draft exists it shows the subject and hands the ticket id to Review it', async () => {
  const onReview = jest.fn()
  await render(<TestEmailBox address="support@acme.com" firstDraft={{ ticketId: 't1', draftId: 'd1', subject: 'Where is my order?' }} onReview={onReview} />)
  expect(screen.getByText('Your first draft is ready')).toBeTruthy()
  expect(screen.getByText('Where is my order?')).toBeTruthy()
  expect(screen.queryByTestId('waiting')).toBeNull()

  await fireEvent.press(screen.getByTestId('review-first-draft'))
  expect(onReview).toHaveBeenCalledWith('t1')
})

test('a draft on a subject-less ticket still reads sensibly', async () => {
  await render(<TestEmailBox address="support@acme.com" firstDraft={{ ticketId: 't1', draftId: 'd1', subject: null }} onReview={jest.fn()} />)
  expect(screen.getByText('(no subject)')).toBeTruthy()
})
