import { fireEvent, render, screen } from '@testing-library/react-native'
import { SwitchRow } from './switch-row'

const HINT = 'Every category starts in Review — the agent drafts, you approve.'

test('renders the label and hint, and reports itself as a checked switch', async () => {
  await render(<SwitchRow label="Agent is ON" value hint={HINT} onValueChange={jest.fn()} testID="agent-switch" />)
  expect(screen.getByText('Agent is ON')).toBeTruthy()
  expect(screen.getByText(HINT)).toBeTruthy()
  const control = screen.getByTestId('agent-switch')
  expect(control.props.accessibilityRole).toBe('switch')
  expect(control.props.accessibilityState.checked).toBe(true)
})

test('toggling reports the new value in both directions', async () => {
  const onValueChange = jest.fn()
  const { rerender } = await render(<SwitchRow label="Agent is ON" value={false} onValueChange={onValueChange} testID="agent-switch" />)
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', true)
  expect(onValueChange).toHaveBeenLastCalledWith(true)

  await rerender(<SwitchRow label="Agent is ON" value onValueChange={onValueChange} testID="agent-switch" />)
  expect(screen.getByTestId('agent-switch').props.accessibilityState.checked).toBe(true)
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', false)
  expect(onValueChange).toHaveBeenLastCalledWith(false)
  expect(onValueChange).toHaveBeenCalledTimes(2)
})

test('a disabled row says so and emits nothing', async () => {
  const onValueChange = jest.fn()
  await render(<SwitchRow label="Agent is ON" value={false} disabled onValueChange={onValueChange} testID="agent-switch" />)
  const control = screen.getByTestId('agent-switch')
  expect(control.props.accessibilityState.disabled).toBe(true)
  await fireEvent(control, 'valueChange', true)
  expect(onValueChange).not.toHaveBeenCalled()
})

test('without a hint it renders the label alone', async () => {
  await render(<SwitchRow label="Agent is ON" value={false} onValueChange={jest.fn()} testID="agent-switch" />)
  expect(screen.getByText('Agent is ON')).toBeTruthy()
  expect(screen.queryByText(HINT)).toBeNull()
})
