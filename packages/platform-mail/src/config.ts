import { Secret } from '@aesa/crypto'

/** How a process sends PLATFORM mail. Customer mail never goes through here (that is `@aesa/mail`). */
export type MailConfig = { transport: 'resend'; apiKey: Secret; from: string } | { transport: 'devsink'; from: string }

/** Resend's shared onboarding sender — good enough for dev, tests and the Playwright smoke. */
export const DEVSINK_DEFAULT_FROM = 'aesa <onboarding@resend.dev>'

export interface MailEnv {
  EMAIL_TRANSPORT?: string | undefined
  RESEND_API_KEY?: string | undefined
  MAIL_FROM?: string | undefined
}

export interface ParseMailConfigOptions {
  production: boolean
  /**
   * Whether THIS process actually sends platform mail. The api always does (`true`). A worker only
   * does under the `cron` role (the daily digest email), so a production `WORKER_ROLES=sync` replica
   * with no Resend key must still boot: with `false` it lands on the devsink it will never call,
   * instead of failing at config load over a credential it has no use for.
   */
  requireInProduction: boolean
}

/**
 * The four rules, formerly inlined in `apps/api/src/config.ts`:
 *   1. transport = EMAIL_TRANSPORT ?? (production-and-required ? 'resend' : 'devsink')
 *   2. devsink is refused where real mail is required in production
 *   3. resend needs BOTH RESEND_API_KEY and MAIL_FROM
 *   4. devsink falls back to DEVSINK_DEFAULT_FROM when MAIL_FROM is unset
 * `production && requireInProduction` is one flag ("this process must really send mail"); for the
 * api that is exactly `production`, so its behaviour is unchanged by the move.
 */
export function parseMailConfig(env: MailEnv, opts: ParseMailConfigOptions): MailConfig {
  const mustSend = opts.production && opts.requireInProduction
  const raw = env.EMAIL_TRANSPORT
  if (raw !== undefined && raw !== 'resend' && raw !== 'devsink') {
    throw new Error(`EMAIL_TRANSPORT must be 'resend' or 'devsink', got ${JSON.stringify(raw)}`)
  }
  const transport = raw ?? (mustSend ? 'resend' : 'devsink')

  if (transport === 'devsink') {
    if (mustSend) throw new Error('EMAIL_TRANSPORT=devsink is not allowed in production')
    return { transport, from: env.MAIL_FROM || DEVSINK_DEFAULT_FROM }
  }

  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when EMAIL_TRANSPORT=resend')
  if (!env.MAIL_FROM) throw new Error('MAIL_FROM is required when EMAIL_TRANSPORT=resend')
  return { transport, apiKey: new Secret(env.RESEND_API_KEY), from: env.MAIL_FROM }
}
