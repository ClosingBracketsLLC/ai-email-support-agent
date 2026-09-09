import { fireEvent, render, screen } from '@testing-library/react-native'
import { Button } from './button'

test('renders its label and calls onPress', async () => {
  const onPress = jest.fn()
  await render(<Button label="Continue" onPress={onPress} />)
  fireEvent.press(screen.getByText('Continue'))
  expect(onPress).toHaveBeenCalledTimes(1)
})

test('while loading it is disabled and ignores presses', async () => {
  const onPress = jest.fn()
  await render(<Button label="Saving" onPress={onPress} loading />)
  const saving = screen.getByRole('button', { name: 'Saving' })
  expect(saving.props.accessibilityState?.disabled ?? saving.props.disabled).toBe(true)
  fireEvent.press(saving)
  expect(onPress).not.toHaveBeenCalled()
})
