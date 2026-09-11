import { fireEvent, render, screen } from '@testing-library/react-native'
import { REDRAFT_CAP_COPY, RejectSheet } from './reject-sheet'

const mockSubmit = jest.fn()
const mockCancel = jest.fn()

beforeEach(() => {
  mockSubmit.mockReset()
  mockCancel.mockReset()
})

function renderSheet(overrides: { redraftCount?: number; busy?: boolean } = {}) {
  return render(
    <RejectSheet
      redraftCount={overrides.redraftCount ?? 0}
      busy={overrides.busy ?? false}
      onSubmit={mockSubmit}
      onCancel={mockCancel}
    />,
  )
}

test('the re-draft button is disabled with a blank reason and enabled once one is typed', async () => {
  await renderSheet()
  expect(screen.getByTestId('reject-redraft').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('reject-reason'), '   ')
  expect(screen.getByTestId('reject-redraft').props.accessibilityState.disabled).toBe(true)

  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'Too formal — warm it up')
  expect(screen.getByTestId('reject-redraft').props.accessibilityState.disabled).toBe(false)

  await fireEvent.press(screen.getByTestId('reject-redraft'))
  expect(mockSubmit).toHaveBeenCalledTimes(1)
  expect(mockSubmit).toHaveBeenCalledWith('redraft', 'Too formal — warm it up')
})

test('at the re-draft cap the button is replaced by the cap copy', async () => {
  await renderSheet({ redraftCount: 2 })

  expect(screen.queryByTestId('reject-redraft')).toBeNull()
  expect(screen.getByTestId('reject-cap')).toBeTruthy()
  expect(screen.getByText(REDRAFT_CAP_COPY)).toBeTruthy()
  expect(REDRAFT_CAP_COPY).toBe('Re-drafted twice already — rejecting again hands the ticket to you.')
})

test("\"I'll handle it\" stays available at the cap and submits the typed reason", async () => {
  await renderSheet({ redraftCount: 2 })

  expect(screen.getByTestId('reject-handle').props.accessibilityState.disabled).toBe(false)
  await fireEvent.changeText(screen.getByTestId('reject-reason'), 'I know this customer')
  await fireEvent.press(screen.getByTestId('reject-handle'))

  expect(mockSubmit).toHaveBeenCalledWith('handle', 'I know this customer')
})

test('a second press while the rejection is in flight is ignored', async () => {
  await renderSheet({ busy: true })

  await fireEvent.press(screen.getByTestId('reject-handle'))

  expect(mockSubmit).not.toHaveBeenCalled()
})

test('Cancel closes the sheet without submitting', async () => {
  await renderSheet()

  await fireEvent.press(screen.getByTestId('reject-cancel'))

  expect(mockCancel).toHaveBeenCalledTimes(1)
  expect(mockSubmit).not.toHaveBeenCalled()
})
