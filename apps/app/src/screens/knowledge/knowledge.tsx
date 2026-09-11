import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Heading, Muted } from '@/components/typography'
import { useAdvance } from '@/screens/onboarding/mailbox'
import { Stepper } from '@/screens/onboarding/stepper'
import { useTRPC } from '@/lib/trpc'
import { FlaggedChunks } from './flagged-chunks'
import { GapsCard } from './gaps-card'
import { GuidanceEditor } from './guidance-editor'
import { SourceCards } from './source-cards'
import { SourceList } from './source-list'

const POLL_MS_DEFAULT = 5000

/** `list`'s own busy statuses (task brief) — the polling predicate, distinct from `canContinue`'s
 * narrower "processing only" gate below. */
function anyBusy(data: { sources: { status: string }[] } | undefined): boolean {
  return Boolean(data?.sources.some((s) => s.status === 'queued' || s.status === 'processing'))
}

export interface KnowledgeScreenProps {
  mode: 'settings' | 'onboarding'
  /** Test-only timing override — the default is the real production value. */
  pollMs?: number
}

/**
 * The Knowledge screen (spec §Product step 4), one body for both routes: Settings
 * (`app/(app)/settings/knowledge.tsx`) and onboarding step 3 (`screens/onboarding/knowledge.tsx`'s
 * `KnowledgeStep`). Three "add knowledge" cards, a live counter that polls while anything is still
 * queued or processing, the source list, flagged content (only while any exists), the guidance
 * editor, and the gaps report — plus, in onboarding mode only, Continue/Skip.
 */
export function KnowledgeScreen({ mode, pollMs = POLL_MS_DEFAULT }: KnowledgeScreenProps) {
  const trpc = useTRPC()
  const advance = useAdvance()
  const [skipConfirming, setSkipConfirming] = useState(false)

  const ws = useQuery(trpc.workspace.get.queryOptions())
  const list = useQuery(trpc.knowledge.list.queryOptions(undefined, {
    refetchInterval: (query) => (anyBusy(query.state.data) ? pollMs : false),
  }))

  const refreshList = () => { void list.refetch() }

  function handleSkip() {
    if (!skipConfirming) { setSkipConfirming(true); return }
    advance.mutate()
  }

  if (!ws.data || !list.data) return <Loading />

  const canContinue = list.data.counts.sources > 0 && !list.data.sources.some((s) => s.status === 'processing')

  return (
    <Screen testID={mode === 'onboarding' ? 'onboarding-knowledge' : 'knowledge'}>
      {mode === 'onboarding' ? <Stepper current="knowledge" /> : null}
      <Heading>Knowledge</Heading>

      <SourceCards websiteUrl={ws.data.websiteUrl} />

      <Muted testID="knowledge-counter">{`Ready: ${list.data.counts.sources} sources · ${list.data.counts.readyChunks} chunks`}</Muted>
      <SourceList sources={list.data.sources} onChanged={refreshList} />

      {list.data.counts.flaggedChunks > 0 ? <FlaggedChunks /> : null}

      <GuidanceEditor initial={ws.data.operatingGuidance} />

      <GapsCard />

      {mode === 'onboarding' ? (
        <>
          {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
          {skipConfirming ? <Banner tone="info">Without knowledge the agent answers from your profile and guidance only</Banner> : null}
          <Button label="Continue" onPress={() => advance.mutate()} loading={advance.isPending} disabled={!canContinue || advance.isPending} testID="continue" />
          <Button
            variant={skipConfirming ? 'danger' : 'secondary'}
            label={skipConfirming ? 'Confirm skip' : 'Skip for now'}
            onPress={handleSkip} loading={advance.isPending} testID="skip"
          />
        </>
      ) : null}
    </Screen>
  )
}
