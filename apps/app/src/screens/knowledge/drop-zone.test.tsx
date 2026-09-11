import { fireEvent, render, screen } from '@testing-library/react-native'
import { DropZone } from './drop-zone'

const mockGetDocumentAsync = jest.fn()
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args) }))

beforeEach(() => { mockGetDocumentAsync.mockReset() })

test('maps every picked asset to a PickedFile, opening the picker with the accepted types', async () => {
  const onFiles = jest.fn()
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [
      { name: 'manual.pdf', uri: 'file:///manual.pdf', mimeType: 'application/pdf', size: 2048, lastModified: 0 },
    ],
  })
  await render(<DropZone onFiles={onFiles} />)
  await fireEvent.press(screen.getByTestId('drop-zone-picker'))

  expect(mockGetDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, copyToCacheDirectory: true }))
  expect(onFiles).toHaveBeenCalledWith([{ name: 'manual.pdf', mime: 'application/pdf', size: 2048, uri: 'file:///manual.pdf', file: undefined }])
})

test('an asset with no reported size maps to size: null, never 0', async () => {
  const onFiles = jest.fn()
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ name: 'notes.md', uri: 'file:///notes.md', mimeType: undefined, size: undefined, lastModified: 0 }],
  })
  await render(<DropZone onFiles={onFiles} />)
  await fireEvent.press(screen.getByTestId('drop-zone-picker'))

  expect(onFiles).toHaveBeenCalledWith([{ name: 'notes.md', mime: '', size: null, uri: 'file:///notes.md', file: undefined }])
})

test('a cancelled pick never calls onFiles', async () => {
  const onFiles = jest.fn()
  mockGetDocumentAsync.mockResolvedValue({ canceled: true, assets: null })
  await render(<DropZone onFiles={onFiles} />)
  await fireEvent.press(screen.getByTestId('drop-zone-picker'))
  expect(onFiles).not.toHaveBeenCalled()
})
