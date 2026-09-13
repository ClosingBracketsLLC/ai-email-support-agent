import { renderHook } from '@testing-library/react-native'
import { setNextPath as mockSetNextPath } from './next-path'
import { actionForResponse, pathForNotification, usePushRouting } from './push-routing'

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
  test('draft_review kind with a ticketId routes to the ticket thread', () => {
    expect(pathForNotification({ kind: 'draft_review', ticketId: 't3', draftId: 'd3' })).toBe('/ticket/t3')
  })
  test('draft_review kind with no ticketId falls back to the inbox', () => {
    expect(pathForNotification({ kind: 'draft_review', draftId: 'd3' })).toBe('/inbox')
  })

  // Phase 5's four new kinds.
  test('auto_send kind opens the ticket whose reply is on its way out', () => {
    expect(pathForNotification({ kind: 'auto_send', ticketId: 't4', draftId: 'd4' })).toBe('/ticket/t4')
  })
  test('auto_send kind with no ticketId falls back to the inbox', () => {
    expect(pathForNotification({ kind: 'auto_send', draftId: 'd4' })).toBe('/inbox')
  })
  test('graduation and demotion open the Autopilot screen', () => {
    expect(pathForNotification({ kind: 'graduation' })).toBe('/settings/autopilot')
    expect(pathForNotification({ kind: 'demotion' })).toBe('/settings/autopilot')
  })
  test('memory_sample opens the Learned answers screen', () => {
    expect(pathForNotification({ kind: 'memory_sample' })).toBe('/settings/memory')
  })

  // Phase 6's kind.
  test('provider_health opens the AI settings screen', () => {
    expect(pathForNotification({ kind: 'provider_health', credentialId: 'cred1' })).toBe('/settings/ai')
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

describe('actionForResponse', () => {
  test("the notification's Hold button carries the draft id to hold, alongside the path it opens", () => {
    expect(actionForResponse({ actionIdentifier: 'hold', ...response({ kind: 'draft_review', ticketId: 't1', draftId: 'd1' }) }))
      .toEqual({ path: '/ticket/t1', holdDraftId: 'd1' })
  })
  test("the notification's Review button only opens the ticket", () => {
    expect(actionForResponse({ actionIdentifier: 'review', ...response({ kind: 'draft_review', ticketId: 't1', draftId: 'd1' }) }))
      .toEqual({ path: '/ticket/t1', holdDraftId: null })
  })
  test('a plain tap on the notification body holds nothing', () => {
    expect(actionForResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', ...response({ kind: 'draft_review', ticketId: 't1', draftId: 'd1' }) }))
      .toEqual({ path: '/ticket/t1', holdDraftId: null })
  })
  test("the auto_send push's Hold button holds the send it is about", () => {
    expect(actionForResponse({ actionIdentifier: 'hold', ...response({ kind: 'auto_send', ticketId: 't5', draftId: 'd5' }) }))
      .toEqual({ path: '/ticket/t5', holdDraftId: 'd5' })
  })
  test('Hold on a payload that carries no draft id holds nothing', () => {
    expect(actionForResponse({ actionIdentifier: 'hold', ...response({ kind: 'escalation', ticketId: 't1' }) }))
      .toEqual({ path: '/ticket/t1', holdDraftId: null })
  })
})

let mockLastResponse: unknown = undefined
const mockPush = jest.fn()
const mockClearLastNotificationResponse = jest.fn()
const mockHold = jest.fn<Promise<{ held: boolean }>, [unknown]>(async () => ({ held: true }))

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
// The factory itself never touches `mockHold` — only the nested arrow does, and that runs at render
// time, long after this file's own top-level declarations.
jest.mock('./trpc', () => ({ useTRPCClient: () => ({ drafts: { hold: { mutate: (input: unknown) => mockHold(input) } } }) }))
const setNextPathMock = jest.mocked(mockSetNextPath)

function response(data: Record<string, unknown>) {
  return { notification: { request: { content: { data } } } }
}

beforeEach(() => {
  mockLastResponse = undefined
  mockPush.mockClear()
  mockClearLastNotificationResponse.mockClear()
  setNextPathMock.mockClear()
  mockHold.mockClear()
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

test('a warm Hold tap holds the draft BEFORE it opens the ticket', async () => {
  const { rerender } = await renderHook(() => usePushRouting())
  mockLastResponse = null // cold-start resolution: no tap
  await rerender(undefined)

  mockLastResponse = { actionIdentifier: 'hold', ...response({ kind: 'draft_review', ticketId: 't7', draftId: 'd7' }) }
  await rerender(undefined)
  expect(mockHold).toHaveBeenCalledWith({ draftId: 'd7' })
  expect(mockPush).toHaveBeenCalledWith('/ticket/t7')
  expect(mockHold.mock.invocationCallOrder[0]!).toBeLessThan(mockPush.mock.invocationCallOrder[0]!)
})

test('a warm Review tap opens the ticket without holding anything', async () => {
  const { rerender } = await renderHook(() => usePushRouting())
  mockLastResponse = null
  await rerender(undefined)

  mockLastResponse = { actionIdentifier: 'review', ...response({ kind: 'draft_review', ticketId: 't8', draftId: 'd8' }) }
  await rerender(undefined)
  expect(mockHold).not.toHaveBeenCalled()
  expect(mockPush).toHaveBeenCalledWith('/ticket/t8')
})

test('a cold-start Hold tap still holds, and queues the ticket through next-path', async () => {
  mockLastResponse = { actionIdentifier: 'hold', ...response({ kind: 'draft_review', ticketId: 't9', draftId: 'd9' }) }
  await renderHook(() => usePushRouting())
  expect(mockHold).toHaveBeenCalledWith({ draftId: 'd9' })
  expect(setNextPathMock).toHaveBeenCalledWith('/ticket/t9')
  expect(mockPush).not.toHaveBeenCalled()
})

// The hold is fire-and-forget on purpose: the server may answer `not_holdable` (a pending draft has
// nothing to hold) or the request may fail outright — either way the tap still opens the ticket.
test('a hold that the server refuses never blocks the routing', async () => {
  mockHold.mockRejectedValueOnce(new Error('not_holdable'))
  const { rerender } = await renderHook(() => usePushRouting())
  mockLastResponse = null
  await rerender(undefined)

  mockLastResponse = { actionIdentifier: 'hold', ...response({ kind: 'draft_review', ticketId: 't10', draftId: 'd10' }) }
  await rerender(undefined)
  expect(mockPush).toHaveBeenCalledWith('/ticket/t10')
})
