import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, cookie }) })],
})

describe('devices router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let ann: ReturnType<typeof client>
  beforeAll(async () => {
    t = await createTestApi(); const base = await listen(t.app)
    ann = client(base, (await signInWithOtp(t.app, t.mail, 'ann@example.com', 'Ann')).cookie)
    await ann.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
  })
  afterAll(async () => { await t.close() })

  it('register is an upsert per (org, user, token); list never returns the token; unregister disables', async () => {
    const first = await ann.devices.register.mutate({ expoPushToken: 'ExponentPushToken[aaa]', platform: 'ios', deviceName: 'Ann’s iPhone' })
    await new Promise((r) => setTimeout(r, 20))
    const second = await ann.devices.register.mutate({ expoPushToken: 'ExponentPushToken[aaa]', platform: 'ios' })
    expect(second.id).toBe(first.id)
    const list = await ann.devices.list.query()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: first.id, platform: 'ios', disabledAt: null })
    expect(JSON.stringify(list)).not.toContain('ExponentPushToken')
    await ann.devices.unregister.mutate({ expoPushToken: 'ExponentPushToken[aaa]' })
    expect((await ann.devices.list.query())[0]!.disabledAt).toBeInstanceOf(Date)
    await expect(ann.devices.register.mutate({ expoPushToken: 'fcm:nope', platform: 'android' })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })
})
