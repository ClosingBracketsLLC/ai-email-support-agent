import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { OverageMode, PlanId } from '@aesa/contracts'
import { BILLING_ERROR_MESSAGES, OVERAGE_MODES } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Chip } from '@/components/chip'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Heading, Muted } from '@/components/typography'
import { formatCents } from '@/screens/activity/activity'
import { StatTile } from '@/screens/activity/stat-tile'
import { openExternal } from '@/lib/open-external'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'

const PLAN_LABEL: Record<PlanId, string> = { trial: 'Trial', standard: 'Standard' }

/** Same wording `billing-banner.tsx` uses for the identical state — the screen and the banner never
 * disagree about what a failed card means, even though (CLAUDE.md's "owner-facing prose, not a
 * contract") each keeps its own copy rather than sharing one. */
const PAST_DUE_TEXT = 'Payment failed — Autopilot is paused until the card is updated.'

const BILLING_ERROR_VALUES = new Set<string>(Object.values(BILLING_ERROR_MESSAGES))
/** The router's soft refusals already ARE the exact `BILLING_ERROR_MESSAGES` sentence — a whitelist,
 * not a translation, so anything unrecognized (a network error, an unexpected 500) never reaches the
 * owner as raw text. */
function billingErrorCopy(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && BILLING_ERROR_VALUES.has(message) ? message : 'Could not complete that. Try again.'
}

/** Same rounding `billing-banner.tsx` uses for its own trial countdown — each file keeps its own copy. */
function daysUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000))
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "12 of 50 conversations this month" while there is no overage, or "301 of 600 · 1 extra at
 * $0.12" once there is — the same number either way, just what it costs beyond the plan. */
function usageLine(used: number, allowance: number, overageUnits: number, overageUnitCents: number): string {
  const base = `${used} of ${allowance}`
  return overageUnits > 0 ? `${base} · ${plural(overageUnits, 'extra')} at ${formatCents(overageUnitCents)}` : `${base} conversations this month`
}

/**
 * Settings → Billing (route 26): plan, usage, the overage switch, and the two Stripe-hosted pages
 * (Checkout, the Customer Portal) this screen never renders itself — it only asks the api to mint a
 * url and opens it (`openExternal`, the `connect-card.tsx` popup-before-await shape).
 *
 * Mirrors `ai.tsx`'s shape: one `billing.get` read plus `workspace.get` for the role, a plain member
 * gets the same data read-only (`billing.get` is `orgProcedure` — what the workspace is on is every
 * teammate's business), and every mutation here is `ownerProcedure` (CLAUDE.md) so only an owner ever
 * sees a button that could call one.
 */
export function BillingSettingsScreen() {
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const params = useLocalSearchParams<{ checkout?: string }>()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const billing = useQuery(trpc.billing.get.queryOptions())
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [checkoutHandled, setCheckoutHandled] = useState(false)

  const startCheckout = useMutation(trpc.billing.startCheckout.mutationOptions({ onError: (err: unknown) => setError(billingErrorCopy(err)) }))
  const openPortal = useMutation(trpc.billing.openPortal.mutationOptions({ onError: (err: unknown) => setError(billingErrorCopy(err)) }))
  const setOverageMode = useMutation(trpc.billing.setOverageMode.mutationOptions({
    onSuccess: () => { setError(null); void queryClient.invalidateQueries({ queryKey: trpc.billing.get.queryKey() }) },
    onError: (err: unknown) => setError(billingErrorCopy(err)),
  }))

  // Stripe's own redirect back from Checkout (`?checkout=success`) — the api's `billingUrl` suffix.
  // Refetch once so the webhook's write (which may still be racing this redirect) is picked up as
  // soon as it lands, and never re-fire on a later re-render of the same params. Gated on the FIRST
  // fetch already having landed (`billing.data`) — invalidating a query that is still on its very
  // first, still in-flight fetch does not queue a second one, it just gets absorbed into that same
  // fetch, which is not a refetch this redirect can rely on.
  useEffect(() => {
    if (params.checkout !== 'success' || checkoutHandled || !billing.data) return
    setCheckoutHandled(true)
    void queryClient.invalidateQueries({ queryKey: trpc.billing.get.queryKey() })
  }, [params.checkout, checkoutHandled, billing.data, queryClient, trpc])

  if (!ws.data || !billing.data) return <Loading />
  const owner = ws.data.role === 'owner'
  const b = billing.data
  const days = b.trialEndsAt ? daysUntil(b.trialEndsAt) : null

  async function subscribe() {
    setError(null); setBlocked(null)
    await openExternal(() => startCheckout.mutateAsync(), { onBlocked: setBlocked })
  }
  async function manage() {
    setError(null); setBlocked(null)
    await openExternal(() => openPortal.mutateAsync(), { onBlocked: setBlocked })
  }

  const canSubscribe = b.state === 'trialing' || b.state === 'trial_expired' || b.state === 'canceled'
  const canManageBilling = b.state === 'active' || b.state === 'past_due'

  return (
    <Screen testID="billing">
      <Heading>Billing</Heading>
      {!owner ? <Muted testID="billing-readonly">Only the workspace owner can manage billing.</Muted> : null}

      {params.checkout === 'success' ? (
        <Banner tone="success" testID="billing-checkout-banner">
          {b.state === 'trialing' ? 'Stripe is confirming your payment…' : 'Thanks — your subscription is active.'}
        </Banner>
      ) : null}
      {error ? <Banner tone="error" testID="billing-error">{error}</Banner> : null}
      {blocked ? <Banner tone="error" testID="billing-blocked">{blocked}</Banner> : null}
      {b.state === 'past_due' ? <Banner tone="error" testID="billing-past-due">{PAST_DUE_TEXT}</Banner> : null}

      <Card testID="billing-summary">
        {b.state === 'trialing' ? (
          <>
            <Chip tone="primary" testID="billing-chip">Trial</Chip>
            {days !== null ? <Muted testID="billing-trial-ends">{`ends in ${plural(days, 'day')}`}</Muted> : null}
          </>
        ) : (
          <>
            <Text style={[typeScale.bodyStrong, { color: c.text }]}>{`${PLAN_LABEL[b.plan]} · ${plural(b.domainQuantity, 'domain')}`}</Text>
            <Muted>{`${formatCents(b.perDomainCents * b.domainQuantity)} / month`}</Muted>
            {b.activeDomains !== b.domainQuantity ? (
              <Muted testID="billing-active-domains">{`${plural(b.activeDomains, 'domain')} connected`}</Muted>
            ) : null}
          </>
        )}
        <StatTile testID="billing-usage" label="Usage" value={usageLine(b.used, b.allowance, b.overageUnits, b.overageUnitCents)} />
      </Card>

      {!b.configured ? (
        owner ? <Muted testID="billing-not-configured">{BILLING_ERROR_MESSAGES.not_configured}</Muted> : null
      ) : owner ? (
        <>
          {canSubscribe ? <Button label="Subscribe" onPress={subscribe} loading={startCheckout.isPending} testID="billing-subscribe" /> : null}
          {canManageBilling ? <Button label="Manage billing" onPress={manage} loading={openPortal.isPending} testID="billing-manage" /> : null}
        </>
      ) : null}

      {owner && b.configured && b.state !== 'trialing' ? (
        <View style={styles.block}>
          <Muted>How an overage beyond the plan is handled</Muted>
          <View style={styles.overageRow} accessibilityRole="radiogroup" testID="overage-mode">
            {OVERAGE_MODES.map((mode) => (
              <OverageOption
                key={mode} mode={mode} checked={b.overageMode === mode} disabled={setOverageMode.isPending}
                onPress={() => { if (!setOverageMode.isPending) setOverageMode.mutate({ mode }) }}
              />
            ))}
          </View>
        </View>
      ) : null}
    </Screen>
  )
}

const OVERAGE_LABEL: Record<OverageMode, string> = { automatic: 'Bill automatically', blocked: 'Stop at the limit' }

function OverageOption({ mode, checked, disabled, onPress }: { mode: OverageMode; checked: boolean; disabled: boolean; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable
      role="radio" accessibilityState={{ checked, disabled }} accessibilityLabel={OVERAGE_LABEL[mode]}
      onPress={onPress} disabled={disabled} testID={`overage-${mode}`}
      style={[styles.overageChip, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primaryTint : c.bg, opacity: disabled ? 0.6 : 1 }]}
    >
      <Text style={[typeScale.caption, { color: c.text }]}>{OVERAGE_LABEL[mode]}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  block: { gap: spacing.xs },
  overageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  overageChip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
})
