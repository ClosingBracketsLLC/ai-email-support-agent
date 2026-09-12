import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { UndoBar } from './undo-bar'

// No fake timers anywhere in this suite: React 19's awaited `act()` deadlocks with them, so every
// wait below is a real (millisecond-scale) one and the tick is injected through `tickMs`.
const mockUndo = jest.fn()
const mockExpired = jest.fn()

beforeEach(() => {
  mockUndo.mockReset()
  mockExpired.mockReset()
})

// One window, one test: the countdown, its last frame and the callback are one behaviour, and asserting
// them together means no interval outlives the test's last act() scope. The window is generous on
// purpose — a 40 ms one raced `render()` itself on a loaded worker and flaked.
test('counts down, disappears when the window closes, and calls onExpired once', async () => {
  await render(<UndoBar untilAt={new Date(Date.now() + 1_200)} onUndo={mockUndo} busy={false} tickMs={5} onExpired={mockExpired} />)

  expect(screen.getByTestId('undo-bar')).toBeTruthy()
  expect(screen.getByText(/^Sending in [12]s$/)).toBeTruthy()
  expect(mockExpired).not.toHaveBeenCalled()

  // Longer than waitFor's 1 s default: the window itself is 1.2 s, so the default would expire first.
  await waitFor(() => expect(screen.getByText('Sending in 1s')).toBeTruthy(), { timeout: 3_000 })
  await waitFor(() => expect(screen.queryByTestId('undo-bar')).toBeNull(), { timeout: 3_000 })
  expect(mockExpired).toHaveBeenCalledTimes(1)
})

test('Undo fires onUndo exactly once, even on a double press (pending guard)', async () => {
  await render(<UndoBar untilAt={new Date(Date.now() + 10_000)} onUndo={mockUndo} busy={false} tickMs={10_000} />)

  await fireEvent.press(screen.getByTestId('undo-button'))
  await fireEvent.press(screen.getByTestId('undo-button'))

  expect(mockUndo).toHaveBeenCalledTimes(1)
})

test('a press while the hold is already in flight is ignored', async () => {
  await render(<UndoBar untilAt={new Date(Date.now() + 10_000)} onUndo={mockUndo} busy tickMs={10_000} />)

  await fireEvent.press(screen.getByTestId('undo-button'))

  expect(mockUndo).not.toHaveBeenCalled()
})

// An AUTO-sent reply gets the same bar with different words: the owner never approved it, so there
// is nothing to "undo" — there is a send to hold (task 10 brief).
test('an auto-send labels the bar Hold and counts down as "Auto-sending"', async () => {
  await render(
    <UndoBar untilAt={new Date(Date.now() + 10_000)} onUndo={mockUndo} busy={false} tickMs={10_000} label="Hold" verb="Auto-sending" />,
  )

  expect(screen.getByText(/^Auto-sending in \d+s$/)).toBeTruthy()
  await fireEvent.press(screen.getByTestId('undo-button'))
  expect(mockUndo).toHaveBeenCalledTimes(1)
})

test('without the two props it stays the approve-path Undo bar', async () => {
  await render(<UndoBar untilAt={new Date(Date.now() + 10_000)} onUndo={mockUndo} busy={false} tickMs={10_000} />)
  expect(screen.getByText(/^Sending in \d+s$/)).toBeTruthy()
  expect(screen.getByTestId('undo-button').props.accessibilityLabel).toBe('Undo')
})

// The bar is the Hold surface for a 2/5/15-minute auto-send window now, not just the 15-second undo
// — "Auto-sending in 899s" is not a time anyone reads. Same `m:ss` clock as the inbox row's chip
// (`formatCountdown`), so one window never reads two different ways on two screens.
test('a multi-minute hold window counts down in m:ss', async () => {
  const now = new Date('2026-01-01T12:00:00Z')
  await render(
    <UndoBar
      untilAt={new Date(now.getTime() + 899_000)} onUndo={mockUndo} busy={false}
      tickMs={60_000} now={() => now} label="Hold" verb="Auto-sending"
    />,
  )
  expect(screen.getByText('Auto-sending in 14:59')).toBeTruthy()
})

test('the 15-second undo window still counts down in bare seconds', async () => {
  const now = new Date('2026-01-01T12:00:00Z')
  await render(<UndoBar untilAt={new Date(now.getTime() + 12_000)} onUndo={mockUndo} busy={false} tickMs={60_000} now={() => now} />)
  expect(screen.getByText('Sending in 12s')).toBeTruthy()
})
