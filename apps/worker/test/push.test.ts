/**
 * `createExpoPush`/`createNoopPush` against a fake `ExpoLikeClient` — no real network call, no
 * real Expo API. Proves the never-reject seam contract: every path resolves, never throws.
 */
import type { ExpoPushTicket } from 'expo-server-sdk'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { createExpoPush, createNoopPush, type ExpoLikeClient } from '../src/push.ts'

describe('createExpoPush', () => {
  it('sends no request and resolves ok for an empty recipient list', async () => {
    const client: ExpoLikeClient = {
      chunkPushNotifications: vi.fn(),
      sendPushNotificationsAsync: vi.fn(),
    }
    const send = createExpoPush(pino({ level: 'silent' }), client)

    const result = await send({ to: [], title: 't', body: 'b' })

    expect(result).toEqual({ ok: true, invalidTokens: [] })
    expect(client.chunkPushNotifications).not.toHaveBeenCalled()
    expect(client.sendPushNotificationsAsync).not.toHaveBeenCalled()
  })

  it('resolves ok with no invalid tokens when every ticket succeeds', async () => {
    const tickets: ExpoPushTicket[] = [{ status: 'ok', id: 'r1' }, { status: 'ok', id: 'r2' }]
    const client: ExpoLikeClient = {
      chunkPushNotifications: (messages) => [messages],
      sendPushNotificationsAsync: vi.fn(async () => tickets),
    }
    const send = createExpoPush(pino({ level: 'silent' }), client)

    const result = await send({ to: ['ExponentPushToken[a]', 'ExponentPushToken[b]'], title: 't', body: 'b' })

    expect(result).toEqual({ ok: true, invalidTokens: [] })
    expect(client.sendPushNotificationsAsync).toHaveBeenCalledTimes(1)
  })

  it('collects DeviceNotRegistered tickets as invalid tokens, keyed to their token by index', async () => {
    const tickets: ExpoPushTicket[] = [
      { status: 'ok', id: 'r1' },
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok', id: 'r3' },
    ]
    const client: ExpoLikeClient = {
      chunkPushNotifications: (messages) => [messages],
      sendPushNotificationsAsync: vi.fn(async () => tickets),
    }
    const send = createExpoPush(pino({ level: 'silent' }), client)

    const result = await send({ to: ['tok-good-1', 'tok-dead', 'tok-good-2'], title: 't', body: 'b' })

    expect(result.ok).toBe(true)
    expect(result.invalidTokens).toEqual(['tok-dead'])
  })

  it('ignores a non-DeviceNotRegistered ticket error (does not mark that token invalid)', async () => {
    const tickets: ExpoPushTicket[] = [{ status: 'error', message: 'rate limited', details: { error: 'MessageRateExceeded' } }]
    const client: ExpoLikeClient = {
      chunkPushNotifications: (messages) => [messages],
      sendPushNotificationsAsync: vi.fn(async () => tickets),
    }
    const send = createExpoPush(pino({ level: 'silent' }), client)

    const result = await send({ to: ['tok-1'], title: 't', body: 'b' })

    expect(result).toEqual({ ok: true, invalidTokens: [] })
  })

  it('spans multiple chunks, matching tickets back to the right token in each chunk', async () => {
    const client: ExpoLikeClient = {
      chunkPushNotifications: (messages) => {
        const [message] = messages
        const to = message!.to as string[]
        return [[{ ...message!, to: [to[0]!] }], [{ ...message!, to: [to[1]!] }]]
      },
      sendPushNotificationsAsync: vi.fn(async (chunk): Promise<ExpoPushTicket[]> => {
        const to = chunk[0]!.to as string[]
        return to.map((token) =>
          token === 'tok-dead'
            ? { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }
            : { status: 'ok', id: 'r' },
        )
      }),
    }
    const send = createExpoPush(pino({ level: 'silent' }), client)

    const result = await send({ to: ['tok-good', 'tok-dead'], title: 't', body: 'b' })

    expect(client.sendPushNotificationsAsync).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true, invalidTokens: ['tok-dead'] })
  })

  it('forwards an actionable categoryId to the Expo message, and omits it when unset', async () => {
    const seen: unknown[] = []
    const client: ExpoLikeClient = {
      chunkPushNotifications: (messages) => { seen.push(...messages); return [messages] },
      sendPushNotificationsAsync: vi.fn(async (): Promise<ExpoPushTicket[]> => [{ status: 'ok', id: 'r1' }]),
    }
    const send = createExpoPush(pino({ level: 'silent' }), client)

    await send({ to: ['tok-1'], title: 't', body: 'b', categoryId: 'draft_review' })
    await send({ to: ['tok-1'], title: 't', body: 'b' })

    expect(seen[0]).toMatchObject({ categoryId: 'draft_review' })
    expect(seen[1]).not.toHaveProperty('categoryId')
  })

  it('never rejects: a thrown error from the client resolves ok:false with no invalid tokens', async () => {
    const client: ExpoLikeClient = {
      chunkPushNotifications: (messages) => [messages],
      sendPushNotificationsAsync: vi.fn(async () => {
        throw new Error('network down')
      }),
    }
    const lines: string[] = []
    const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) })
    const send = createExpoPush(logger, client)

    const result = await send({ to: ['tok-1'], title: 't', body: 'b' })

    expect(result).toEqual({ ok: false, invalidTokens: [] })
    expect(lines.some((l) => JSON.parse(l).msg === 'expo_push_failed')).toBe(true)
  })
})

describe('createNoopPush', () => {
  it('never rejects: always resolves ok:false with no invalid tokens, and logs', async () => {
    const lines: string[] = []
    const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) })
    const send = createNoopPush(logger)

    const result = await send({ to: ['tok-1', 'tok-2'], title: 'hi', body: 'there' })

    expect(result).toEqual({ ok: false, invalidTokens: [] })
    expect(lines.some((l) => JSON.parse(l).msg === 'push_unconfigured')).toBe(true)
  })
})
