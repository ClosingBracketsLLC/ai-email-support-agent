import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { openExternal } from '@/lib/open-external'
import { useTRPC } from '@/lib/trpc'

/** How many days out a trial starts warning — the trial itself is silent before this. */
const TRIAL_WARNING_DAYS = 3

/**
 * Owner-facing prose for every state this banner can be in — NOT a contract (CLAUDE.md: `packages/
 * contracts` is zod inputs and enums, never screen copy). `trialExpired` doubles as `canceled`'s own
 * text: from the owner's chair a lapsed trial and a cancelled subscription both read as "you are not
 * on a plan, and Autopilot is off until you are."
 */
export const BILLING_BANNER_COPY = {
  trialWarning: (days: number): string => `Your trial ends in ${days} day${days === 1 ? '' : 's'} — subscribe to keep Autopilot.`,
  trialExpired: 'Your trial has ended — replies wait for your review until you subscribe.',
  pastDue: 'Payment failed — Autopilot is paused until the card is updated.',
  deletion: (date: string): string => `This workspace will be deleted on ${date}. Turn this off in Settings → Workspace.`,
}

/** Same rounding `billing.tsx` uses for its own trial countdown — each screen keeps its own copy
 * rather than sharing one (the `activity.tsx`/`stat-tile.tsx` `relativeTime` convention). */
function daysUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000))
}
/** A plain, timezone-stable date for owner-facing prose — no `Intl` locale to drift between devices. */
function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

interface Spec { tone: 'warning' | 'error'; text: string; action?: { label: string; onPress: () => void; pending: boolean; testID: string } }

/**
 * Sits wherever the owner is already looking (the inbox, beside `AgentOffBanner`; the Settings index)
 * while the workspace's billing needs attention, or while it is on its way out. Deletion OUTRANKS
 * billing when both apply — a workspace that is about to be deleted has one thing to say, not two.
 *
 * Reads BOTH `workspace.get` (role, `deletionRequestedAt`, `purgeAfter`) and `billing.get` (state,
 * `trialEndsAt`) — the same two-query shape `billing.tsx` itself reads, because this banner is
 * answering the same question in miniature.
 */
export function BillingBanner() {
  const trpc = useTRPC()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const billing = useQuery(trpc.billing.get.queryOptions())
  const [blocked, setBlocked] = useState<string | null>(null)

  const startCheckout = useMutation(trpc.billing.startCheckout.mutationOptions())
  const openPortal = useMutation(trpc.billing.openPortal.mutationOptions())

  if (!ws.data || !billing.data) return null
  const owner = ws.data.role === 'owner'

  async function subscribe() {
    setBlocked(null)
    await openExternal(() => startCheckout.mutateAsync(), { onBlocked: setBlocked })
  }
  async function manage() {
    setBlocked(null)
    await openExternal(() => openPortal.mutateAsync(), { onBlocked: setBlocked })
  }

  const spec = bannerSpec(ws.data, billing.data, {
    subscribe: { onPress: subscribe, pending: startCheckout.isPending },
    manage: { onPress: manage, pending: openPortal.isPending },
  })
  if (!spec) return null

  return (
    <>
      <Banner tone={spec.tone} testID="billing-banner">{spec.text}</Banner>
      {owner && spec.action ? (
        <Button label={spec.action.label} onPress={spec.action.onPress} loading={spec.action.pending} testID={spec.action.testID} />
      ) : null}
      {blocked ? <Banner tone="error" testID="billing-banner-blocked">{blocked}</Banner> : null}
    </>
  )
}

/** Pure so the state → copy → action mapping is one readable table rather than four near-identical
 * JSX branches. `deletionRequestedAt` wins outright: nothing about billing matters once the workspace
 * itself is on its way out. */
function bannerSpec(
  ws: { deletionRequestedAt: Date | null; purgeAfter: Date | null },
  billing: { state: string; trialEndsAt: Date | null },
  actions: {
    subscribe: { onPress: () => void; pending: boolean }
    manage: { onPress: () => void; pending: boolean }
  },
): Spec | null {
  if (ws.deletionRequestedAt) {
    const date = formatDate(ws.purgeAfter ?? ws.deletionRequestedAt)
    return { tone: 'error', text: BILLING_BANNER_COPY.deletion(date) }
  }

  if (billing.state === 'trialing') {
    if (!billing.trialEndsAt) return null
    const days = daysUntil(billing.trialEndsAt)
    if (days > TRIAL_WARNING_DAYS) return null
    return { tone: 'warning', text: BILLING_BANNER_COPY.trialWarning(days), action: { label: 'Subscribe', testID: 'billing-banner-subscribe', ...actions.subscribe } }
  }
  if (billing.state === 'trial_expired' || billing.state === 'canceled') {
    return { tone: 'error', text: BILLING_BANNER_COPY.trialExpired, action: { label: 'Subscribe', testID: 'billing-banner-subscribe', ...actions.subscribe } }
  }
  if (billing.state === 'past_due') {
    return { tone: 'error', text: BILLING_BANNER_COPY.pastDue, action: { label: 'Manage billing', testID: 'billing-banner-manage', ...actions.manage } }
  }
  return null
}
