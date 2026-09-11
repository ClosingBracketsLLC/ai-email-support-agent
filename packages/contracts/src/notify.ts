export const NOTIFICATION_KINDS = ['escalation', 'mailbox_reauth', 'digest', 'draft_review'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export const PUSH_DAILY_CAP = 30
