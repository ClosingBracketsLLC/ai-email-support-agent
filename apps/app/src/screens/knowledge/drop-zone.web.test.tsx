import { fireEvent, render, screen } from '@testing-library/react-native'
import { DropZone } from './drop-zone.web'

/**
 * A direct smoke test only — jest-expo's default project resolves the platform-suffixed sibling
 * `drop-zone.tsx` for every other test in this suite (`knowledge.test.tsx` included), so this file is
 * the only place `drop-zone.web.tsx` is ever mounted (task brief, "Platform files").
 */
test('a drop with files calls onFiles', async () => {
  const onFiles = jest.fn()
  await render(<DropZone onFiles={onFiles} />)
  const zone = screen.getByTestId('drop-zone')

  const file = { name: 'notes.pdf', type: 'application/pdf', size: 42 } as unknown as File
  await fireEvent(zone, 'drop', { preventDefault: () => {}, dataTransfer: { files: [file] } })

  expect(onFiles).toHaveBeenCalledTimes(1)
  expect(onFiles).toHaveBeenCalledWith([{ name: 'notes.pdf', mime: 'application/pdf', size: 42, uri: 'notes.pdf', file }])
})

test('disabled ignores a drop', async () => {
  const onFiles = jest.fn()
  await render(<DropZone onFiles={onFiles} disabled />)
  const zone = screen.getByTestId('drop-zone')

  const file = { name: 'notes.pdf', type: 'application/pdf', size: 42 } as unknown as File
  await fireEvent(zone, 'drop', { preventDefault: () => {}, dataTransfer: { files: [file] } })

  expect(onFiles).not.toHaveBeenCalled()
})
