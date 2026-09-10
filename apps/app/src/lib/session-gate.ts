import type { Href } from 'expo-router'
import type { OnboardingStep } from '@aesa/contracts'

export interface GateInput {
  /** undefined = still loading; null = signed out */
  session: { activeOrganizationId: string | null } | null | undefined
  /** Only consulted when the session has no active organization. */
  organizations: { id: string }[] | undefined
  /** Only consulted when there is an active organization. 'missing' = the org has no workspaces row. */
  workspace: { onboardingStep: OnboardingStep } | 'missing' | undefined
  /** The pathname being rendered. Only consulted for the one go-live exception below. */
  route?: string
}

/** The go-live step's "Review it" opens the agent's first draft — see `resolveGate`. */
const TICKET_ROUTE_PREFIX = '/ticket/'

export type GateTarget =
  | { kind: 'loading' }
  | { kind: 'sign-in' }
  | { kind: 'activate'; orgId: string }
  | { kind: 'create-workspace' }
  | { kind: 'onboarding'; step: Exclude<OnboardingStep, 'done'> }
  | { kind: 'app' }
  /** A session, activation or workspace lookup failed outright (not merely absent). resolveGate never produces this: it is raised by useGate. */
  | { kind: 'error'; message: string; retry: () => void }

/** Pure routing decision. Every layout renders what this says; nothing else decides where a user goes. */
export function resolveGate(i: GateInput): GateTarget {
  if (i.session === undefined) return { kind: 'loading' }
  if (i.session === null) return { kind: 'sign-in' }
  if (!i.session.activeOrganizationId) {
    if (i.organizations === undefined) return { kind: 'loading' }
    const first = i.organizations[0]
    return first ? { kind: 'activate', orgId: first.id } : { kind: 'create-workspace' }
  }
  if (i.workspace === undefined) return { kind: 'loading' }
  if (i.workspace === 'missing') return { kind: 'create-workspace' }
  if (i.workspace.onboardingStep !== 'done') {
    // The one hole in the onboarding wall: the go-live step's test-email box offers "Review it" on the
    // agent's first draft, and that ticket lives under `(app)`. Only that step, and only a ticket
    // route — every other step, and every other route during go_live, still goes back to onboarding.
    // Nothing can be sent from there: `drafts.approve` refuses with `agent_disabled` until the master
    // switch is on, which is the very thing this step exists to flip.
    const peekingAtTheFirstDraft = i.workspace.onboardingStep === 'go_live' && (i.route?.startsWith(TICKET_ROUTE_PREFIX) ?? false)
    if (!peekingAtTheFirstDraft) return { kind: 'onboarding', step: i.workspace.onboardingStep }
  }
  return { kind: 'app' }
}

export function hrefFor(t: GateTarget): Href | null {
  switch (t.kind) {
    case 'sign-in': return '/sign-in'
    case 'create-workspace': return '/create-workspace'
    case 'onboarding': return `/onboarding/${t.step}` as Href
    case 'app': return '/inbox'
    default: return null
  }
}
