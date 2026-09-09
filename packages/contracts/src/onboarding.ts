/** Server-tracked onboarding position (workspaces.onboarding_step). The app renders the step the server says. */
export const ONBOARDING_STEPS = ['profile', 'mailbox', 'knowledge', 'go_live', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export function isOnboardingStep(value: string): value is OnboardingStep {
  return (ONBOARDING_STEPS as readonly string[]).includes(value)
}

/** Linear, forward only; `done` is absorbing. Skipping a step is the same call as finishing it. */
export function nextOnboardingStep(step: OnboardingStep): OnboardingStep {
  const i = ONBOARDING_STEPS.indexOf(step)
  return ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)]!
}
