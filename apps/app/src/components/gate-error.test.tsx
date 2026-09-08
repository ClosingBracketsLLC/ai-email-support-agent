import { fireEvent, render, screen } from '@testing-library/react-native'
import { GateError } from './gate-error'

test('renders the message and calls retry when "Try again" is pressed', async () => {
  const retry = jest.fn()
  await render(<GateError target={{ kind: 'error', message: 'Could not load your workspace.', retry }} />)
  expect(screen.getByText('Could not load your workspace.')).toBeTruthy()
  fireEvent.press(screen.getByText('Try again'))
  expect(retry).toHaveBeenCalledTimes(1)
})
