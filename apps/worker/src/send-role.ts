/**
 * The `send` role's job wiring: `send.execute`. Split out of `index.ts` for the same reason
 * `agent-role.ts` was — so the production-refuses/dev-warns-and-skips gating is unit-testable
 * without a real pg-boss instance; `register` is an injectable seam defaulting to the real registrar.
 *
 * The gate mirrors the `sync` role's, because the send path needs exactly the same two things the
 * sync path does: the KEK ring (mailbox credentials are sealed under it, and `getAccessToken` is the
 * only way to reach a provider) and at least one OAuth client pair (there is no third way to refresh
 * a token). A `send`-role replica missing either would sit there looking healthy while every
 * approved reply silently failed to go out, so production refuses to boot; dev/test warns and skips
 * so a local box without credentials still boots for every other role.
 *
 * The `limiter` is NOT created here: `index.ts` creates exactly ONE `createMailLimiter()` and hands
 * the same instance to `mailbox.sync` and to this role. Per-connection concurrency 1 is what
 * serializes a send against a poll of the same mailbox, and two limiter instances would silently
 * lose that.
 */
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import type { Db } from '@aesa/db'
import type { MailLimiter } from '@aesa/mail'
import type { WorkerConfig } from './config.ts'
import { registerSendExecute, type SendExecuteDeps } from './jobs/send-execute.ts'

export interface SendRoleDeps {
  boss: PgBoss
  db: Db
  config: WorkerConfig
  /** The ONE process-wide limiter, shared with `mailbox.sync`. */
  limiter: MailLimiter
  logger: pino.Logger
  enqueueNotify: SendExecuteDeps['enqueueNotify']
  enqueueDraft: SendExecuteDeps['enqueueDraft']
  /** index.ts wires this to `enqueueMemoryCapture` — Phase 5's `memory.capture`, fired post-commit. */
  onSent?: SendExecuteDeps['onSent']
}

export type SendRoleRegistrar = (boss: PgBoss, deps: SendExecuteDeps) => Promise<void>

export async function maybeRegisterSendRole(deps: SendRoleDeps, register: SendRoleRegistrar = registerSendExecute): Promise<void> {
  if (!deps.config.roles.has('send')) return

  if (!deps.config.kekRing) {
    if (deps.config.env === 'production') {
      throw new Error('AESA_KEK_V<n> and AESA_KEK_ACTIVE are required in production when WORKER_ROLES includes `send` (mailbox credentials)')
    }
    deps.logger.warn('AESA_KEK_V<n>/AESA_KEK_ACTIVE missing; skipping send.execute registration (send role inactive)')
    return
  }

  if (!deps.config.gmailOauth && !deps.config.msOauth) {
    if (deps.config.env === 'production') {
      throw new Error('GMAIL_OAUTH_CLIENT_ID/_SECRET or MS_OAUTH_CLIENT_ID/_SECRET is required in production when WORKER_ROLES includes `send`')
    }
    deps.logger.warn('no GMAIL_OAUTH/MS_OAUTH client pair configured; skipping send.execute registration (send role inactive)')
    return
  }

  await register(deps.boss, {
    db: deps.db,
    ring: deps.config.kekRing,
    config: deps.config,
    limiter: deps.limiter,
    logger: deps.logger,
    enqueueNotify: deps.enqueueNotify,
    enqueueDraft: deps.enqueueDraft,
    onSent: deps.onSent,
  })
}
