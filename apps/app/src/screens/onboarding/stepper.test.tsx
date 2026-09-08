import { render, screen } from '@testing-library/react-native'
import { Stepper } from './stepper'

test('lists the four steps and marks the current one', async () => {
  await render(<Stepper current="knowledge" />)
  for (const label of ['Profile', 'Mailbox', 'Knowledge', 'Go live']) expect(screen.getByText(label)).toBeTruthy()
  expect(screen.getByTestId('step-knowledge').props.accessibilityState?.selected).toBe(true)
  expect(screen.getByTestId('step-profile').props.accessibilityState?.selected).toBe(false)
})
