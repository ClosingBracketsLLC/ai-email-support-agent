import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, id, orgId, tenantPolicies } from './helpers.ts'

/** One Expo push token per (org, user, device). The worker's notify.dispatch (Phase 2) reads these; the api only writes. */
export const notificationDevices = pgTable('notification_devices', {
  id: id(),
  orgId: orgId(),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expoPushToken: text('expo_push_token').notNull(),
  platform: text('platform').notNull(),
  deviceName: text('device_name'),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('notification_devices_org_user_token_uidx').on(t.orgId, t.userId, t.expoPushToken),
  check('notification_devices_platform_check', sql`${t.platform} IN ('ios','android')`),
  ...tenantPolicies(t.orgId, 'notification_devices'),
])
