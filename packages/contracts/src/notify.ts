export const NOTIFICATION_KINDS = ['escalation', 'mailbox_reauth', 'digest', 'draft_review', 'auto_send', 'graduation', 'demotion', 'memory_sample', 'provider_health', 'billing', 'workspace'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export const PUSH_DAILY_CAP = 30
