import { KnowledgeScreen } from '@/screens/knowledge/knowledge'

/** Step 3 of the onboarding funnel (spec §Product step 4): the same body Settings renders, in
 * `mode="onboarding"` — the `Screen` root keeps `testID="onboarding-knowledge"` and its own
 * `Stepper`, both owned by `KnowledgeScreen` itself now. */
export function KnowledgeStep() {
  return <KnowledgeScreen mode="onboarding" />
}
