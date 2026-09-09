import { renderHook } from '@testing-library/react-native'
import { setNextPath as mockSetNextPath } from './next-path'
import { pathForNotification, usePushRouting } from './push-routing'

describe('pathForNotification', () => {
  test('escalation kind with a ticketId routes to the ticket thread', () => {
    expect(pathForNotification({ kind: 'escalation', ticketId: 't1' })).toBe('/ticket/t1')
  })
  test('mailbox_reauth kind routes to the mailboxes settings screen', () => {
    expect(pathForNotification({ kind: 'mailbox_reauth', connectionId: 'c1' })).toBe('/settings/mailboxes')
  })
  test('digest kind routes to the inbox', () => {
    expect(pathForNotification({ kind: 'digest' })).toBe('/inbox')
  })

  // The worker now stamps `kind` onto every push's `data` (notify-dispatch.ts / notify-digest.ts),
  // but a push already sitting in a device's notification tray from before that change has neither
  // — these are that backward-compatibility fallback's shapes, kept so an old, undelivered
  // escalation/reauth push tapped after an app update still routes correctly.
  test('no kind, but a ticketId — infers escalation (a pre-fix escalation payload)', () => {
    expect(pathForNotification({ ticketId: 't2' })).toBe('/ticket/t2')
  })
  test('no kind, but a connectionId — infers mailbox_reauth (a pre-fix reauth payload)', () => {
    expect(pathForNotification({ connectionId: 'c2' })).toBe('/settings/mailboxes')
  })
  test('no data at all — falls back to the inbox (a pre-fix digest payload)', () => {
    expect(pathForNotification(undefined)).toBe('/inbox')
    expect(pathForNotification(null)).toBe('/inbox')
    expect(pathForNotification({})).toBe('/inbox')
  })
  test('ambiguous payload with no kind, both ticketId and connectionId present — ticketId wins (escalation is the more urgent event)', () => {
    expect(pathForNotification({ ticketId: 'x', connectionId: 'y' })).toBe('/ticket/x')
  })
})

let mockLastResponse: unknown = undefined
const mockPush = jest.fn()
const mockClearLastNotificationResponse = jest.fn()

// A stable object across renders, matching the real `useRouter()` — see push-routing.ts's own
// defensive note about why the effect must not rely on that stability regardless.
const mockRouter = { push: mockPush }
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}))
jest.mock('expo-notifications', () => ({
  useLastNotificationResponse: () => mockLastResponse,
  clearLastNotificationResponse: () => mockClearLastNotificationResponse(),
}))
jest.mock('./next-path', () => ({ setNextPath: jest.fn() }))
const setNextPathMock = jest.mocked(mockSetNextPath)

function response(data: Record<string, unknown>) {
  return { notification: { request: { content: { data } } } }
}

beforeEach(() => {
  mockLastResponse = undefined
  mockPush.mockClear()
  mockClearLastNotificationResponse.mockClear()
  setNextPathMock.mockClear()
})

test('undefined (native has not reported in yet) does nothing', async () => {
  const { rerender } = await renderHook(() => usePushRouting())
  await rerender(undefined)
  expect(setNextPathMock).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockClearLastNotificationResponse).not.toHaveBeenCalled()
})

test('first resolution is null (cold start, no tap involved) — no navigation, nothing cleared', async () => {
  const { rerender } = await renderHook(() => usePushRouting())
  mockLastResponse = null
  await rerender(undefined)
  expect(setNextPathMock).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockClearLastNotificationResponse).not.toHaveBeenCalled()
})

test('first resolution is a response (a cold-start tap) — queued through next-path, never pushed directly', async () => {
  const { rerender } = await renderHook(() => usePushRouting())
  mockLastResponse = response({ ticketId: 't1' })
  await rerender(undefined)
  expect(setNextPathMock).toHaveBeenCalledWith('/ticket/t1')
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockClearLastNotificationResponse).toHaveBeenCalledTimes(1)
})

test('a response present at the very first render (mount) is also treated as the cold-start case', async () => {
  mockLastResponse = response({ connectionId: 'c1' })
  await renderHook(() => usePushRouting())
  expect(setNextPathMock).toHaveBeenCalledWith('/settings/mailboxes')
  expect(mockPush).not.toHaveBeenCalled()
})

test('a later change, after the cold-start state is already known, is a warm tap — pushed directly', async () => {
  const { rerender } = await renderHook(() => usePushRouting())
  mockLastResponse = null // cold-start resolution: no tap
  await rerender(undefined)
  expect(setNextPathMock).not.toHaveBeenCalled()

  mockLastResponse = response({ ticketId: 't9' })
  await rerender(undefined)
  expect(mockPush).toHaveBeenCalledWith('/ticket/t9')
  expect(setNextPathMock).not.toHaveBeenCalled()
  expect(mockClearLastNotificationResponse).toHaveBeenCalledTimes(1)
})
