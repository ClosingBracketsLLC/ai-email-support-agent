import { and, eq } from 'drizzle-orm'
import { RegisterDeviceInput, UnregisterDeviceInput } from '@aesa/contracts'
import { audit, notificationDevices } from '@aesa/db'
import { orgProcedure, router } from '../init.ts'

export const devicesRouter = router({
  /** Idempotent: the app calls it on every launch. Re-registering re-enables a device that was unregistered. */
  register: orgProcedure.input(RegisterDeviceInput).mutation(async ({ ctx, input }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [row] = await tx.insert(notificationDevices)
        .values({ orgId: ctx.orgId, userId: ctx.user.id, expoPushToken: input.expoPushToken, platform: input.platform, deviceName: input.deviceName ?? null })
        .onConflictDoUpdate({
          target: [notificationDevices.orgId, notificationDevices.userId, notificationDevices.expoPushToken],
          set: { lastSeenAt: new Date(), disabledAt: null, platform: input.platform, ...(input.deviceName ? { deviceName: input.deviceName } : {}) },
        })
        .returning({ id: notificationDevices.id })
      await audit(tx, { actor: ctx.actor, action: 'device.register', entityType: 'notification_device', entityId: row!.id, detail: { platform: input.platform }, ip: ctx.ip, userAgent: ctx.userAgent })
      return { id: row!.id }
    }),
  ),

  unregister: orgProcedure.input(UnregisterDeviceInput).mutation(async ({ ctx, input }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const rows = await tx.update(notificationDevices).set({ disabledAt: new Date() })
        .where(and(eq(notificationDevices.orgId, ctx.orgId), eq(notificationDevices.userId, ctx.user.id), eq(notificationDevices.expoPushToken, input.expoPushToken)))
        .returning({ id: notificationDevices.id })
      for (const r of rows) await audit(tx, { actor: ctx.actor, action: 'device.unregister', entityType: 'notification_device', entityId: r.id, ip: ctx.ip, userAgent: ctx.userAgent })
      return { disabled: rows.length }
    }),
  ),

  /** The caller's own devices. The token itself never leaves the database. */
  list: orgProcedure.query(async ({ ctx }) =>
    ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select({ id: notificationDevices.id, platform: notificationDevices.platform, deviceName: notificationDevices.deviceName, lastSeenAt: notificationDevices.lastSeenAt, disabledAt: notificationDevices.disabledAt })
        .from(notificationDevices)
        .where(and(eq(notificationDevices.orgId, ctx.orgId), eq(notificationDevices.userId, ctx.user.id))),
    ),
  ),
})
