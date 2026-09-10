/** Every per-org setting: its type and code default. Plan defaults (plans.ts) and org rows override in that order. */
export const SETTINGS_CATALOG = {
  'notifications.digest_minutes': { kind: 'number', default: 15 },
  'autonomy.daily_draft_cap': { kind: 'number', default: 2000 },
  'autonomy.daily_auto_send_cap': { kind: 'number', default: 100 },
  'autonomy.daily_llm_usd_cap': { kind: 'number', default: 60 },
  'triage.daily_cap': { kind: 'number', default: 6000 },
  'sandbox.daily_cap': { kind: 'number', default: 100 },
  'mailboxes.max_connections': { kind: 'number', default: 5 },
  'support.spam_shortcircuit.always': { kind: 'boolean', default: false },
  'notifications.digest_email': { kind: 'boolean', default: true },
  'notifications.digest_email_hour': { kind: 'number', default: 8 }, // local hour in the workspace timezone
} as const satisfies Record<string, { kind: 'number' | 'boolean' | 'string'; default: number | boolean | string }>

export type SettingKey = keyof typeof SETTINGS_CATALOG
type KindOf<K extends SettingKey> = (typeof SETTINGS_CATALOG)[K]['kind']
export type SettingValue<K extends SettingKey> = KindOf<K> extends 'number' ? number : KindOf<K> extends 'boolean' ? boolean : string

export function resolveSetting<K extends SettingKey>(
  key: K,
  sources: { org?: Partial<Record<SettingKey, unknown>>; plan?: Partial<Record<SettingKey, unknown>> },
): SettingValue<K> {
  const entry = SETTINGS_CATALOG[key]
  const candidate = sources.org?.[key] ?? sources.plan?.[key] ?? entry.default
  if (typeof candidate !== entry.kind) throw new TypeError(`setting ${key}: expected ${entry.kind}, got ${typeof candidate}`)
  return candidate as SettingValue<K>
}
