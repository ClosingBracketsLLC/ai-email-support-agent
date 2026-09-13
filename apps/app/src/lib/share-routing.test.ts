import { renderHook } from '@testing-library/react-native'
import { setNextPath as mockSetNextPath } from './next-path'
import { pathForShareIntent, useShareIntentRouting, type ShareIntentLike } from './share-routing'

describe('pathForShareIntent', () => {
  test('null intent routes nowhere', () => {
    expect(pathForShareIntent(null)).toBeNull()
  })
  test('an intent with none of webUrl, text or files routes nowhere', () => {
    expect(pathForShareIntent({})).toBeNull()
  })
  test('text present but blank (whitespace only) routes nowhere', () => {
    expect(pathForShareIntent({ text: '   ' })).toBeNull()
  })
  test('an empty files array routes nowhere', () => {
    expect(pathForShareIntent({ files: [] })).toBeNull()
  })
  test('a webUrl routes to /share', () => {
    expect(pathForShareIntent({ webUrl: 'https://example.com' })).toBe('/share')
  })
  test('non-empty text routes to /share', () => {
    expect(pathForShareIntent({ text: 'hello' })).toBe('/share')
  })
  test('at least one file routes to /share', () => {
    expect(pathForShareIntent({ files: [{ fileName: 'a.pdf' }] })).toBe('/share')
  })
  test('a webUrl wins even when text and files are also present', () => {
    const intent: ShareIntentLike = { webUrl: 'https://example.com', text: 'https://example.com', files: [] }
    expect(pathForShareIntent(intent)).toBe('/share')
  })
})

let mockHasShareIntent = false
let mockShareIntent: ShareIntentLike | null = null
const mockResetShareIntent = jest.fn()
jest.mock('./share-intent', () => ({
  useShareIntentSafe: () => ({ hasShareIntent: mockHasShareIntent, shareIntent: mockShareIntent, resetShareIntent: mockResetShareIntent }),
}))

const mockPush = jest.fn()
const mockRouter = { push: mockPush }
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }))
jest.mock('./next-path', () => ({ setNextPath: jest.fn() }))
const setNextPathMock = jest.mocked(mockSetNextPath)

beforeEach(() => {
  mockHasShareIntent = false
  mockShareIntent = null
  mockResetShareIntent.mockClear()
  mockPush.mockClear()
  setNextPathMock.mockClear()
})

describe('useShareIntentRouting', () => {
  test('no share intent at mount does nothing', async () => {
    await renderHook(() => useShareIntentRouting())
    expect(setNextPathMock).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('a share intent already present at mount (cold start) is queued through next-path, never pushed directly', async () => {
    mockHasShareIntent = true
    mockShareIntent = { webUrl: 'https://example.com' }
    await renderHook(() => useShareIntentRouting())
    expect(setNextPathMock).toHaveBeenCalledWith('/share')
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('a share intent that arrives after the app is already running (warm) pushes directly', async () => {
    const { rerender } = await renderHook(() => useShareIntentRouting())
    expect(setNextPathMock).not.toHaveBeenCalled()

    mockHasShareIntent = true
    mockShareIntent = { text: 'some shared text' }
    await rerender(undefined)
    expect(mockPush).toHaveBeenCalledWith('/share')
    expect(setNextPathMock).not.toHaveBeenCalled()
  })

  test('a share intent with nothing routable (e.g. an unsupported type) is never queued or pushed', async () => {
    mockHasShareIntent = true
    mockShareIntent = {}
    await renderHook(() => useShareIntentRouting())
    expect(setNextPathMock).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('resetting (true -> false) never routes, and the NEXT share after it is treated as warm, not cold', async () => {
    mockHasShareIntent = true
    mockShareIntent = { webUrl: 'https://example.com' }
    const { rerender } = await renderHook(() => useShareIntentRouting())
    expect(setNextPathMock).toHaveBeenCalledTimes(1) // the cold-start share above

    mockHasShareIntent = false
    mockShareIntent = null
    await rerender(undefined)
    expect(mockPush).not.toHaveBeenCalled()
    expect(setNextPathMock).toHaveBeenCalledTimes(1) // still just the one, from cold start

    mockHasShareIntent = true
    mockShareIntent = { text: 'a second, later share' }
    await rerender(undefined)
    expect(mockPush).toHaveBeenCalledWith('/share')
    expect(setNextPathMock).toHaveBeenCalledTimes(1) // unchanged — the second share was warm
  })
})
