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
/** How long a `queued` source keeps the screen polling. A `queued` upload only becomes `processing`
 * once its object has actually landed and `completeUpload` has enqueued the ingest job; if the
 * browser's PUT never finished, no job is coming and the row would otherwise poll forever. Ten
 * minutes is the presigned URL's own TTL (`UPLOAD_URL_TTL_SECONDS`, 600 s) — past it the upload can
 * no longer land at all. A `processing` source always keeps polling: a job IS running. */
const QUEUED_POLL_WINDOW_MS = 10 * 60 * 1000

/** The polling predicate, distinct from `canContinue`'s narrower "processing only" gate below. */
function anyBusy(data: { sources: { status: string; createdAt: Date }[] } | undefined, now: number): boolean {
  return Boolean(data?.sources.some((s) =>
    s.status === 'processing' || (s.status === 'queued' && now - s.createdAt.getTime() < QUEUED_POLL_WINDOW_MS)))
}

export interface KnowledgeScreenProps {
  mode: 'settings' | 'onboarding'
  /** Test-only timing override — the default is the real production value. */
  pollMs?: number
}

/**
 * The Knowledge screen (spec §Product step 4), one body for both routes: Settings
 * (`app/(app)/settings/knowledge.tsx`) and onboarding step 3 (`screens/onboarding/knowledge.tsx`'s
 * `KnowledgeStep`). Three "add knowledge" cards, a live counter that polls while a job is still
 * running (`anyBusy`), the source list, flagged content (only while any exists), the guidance
 * editor, and the gaps report — plus, in onboarding mode only, Continue/Skip. `knowledge.list`'s
 * `canManage` (the caller's own role, resolved server-side) gates the three add cards, every
 * Delete/Refresh/Allow, and the guidance editor's Save: a plain member gets a read-only view of the
 * SAME data, never a call that would just 403.
 */
export function KnowledgeScreen({ mode, pollMs = POLL_MS_DEFAULT }: KnowledgeScreenProps) {
  const trpc = useTRPC()
  const advance = useAdvance()
  const [skipConfirming, setSkipConfirming] = useState(false)

  const ws = useQuery(trpc.workspace.get.queryOptions())
  const list = useQuery(trpc.knowledge.list.queryOptions(undefined, {
    refetchInterval: (query) => (anyBusy(query.state.data, Date.now()) ? pollMs : false),
  }))

  const refreshList = () => { void list.refetch() }
  function retry() {
    void ws.refetch()
    void list.refetch()
  }
  function handleSkip() {
    if (!skipConfirming) { setSkipConfirming(true); return }
    advance.mutate()
  }

  const testID = mode === 'onboarding' ? 'onboarding-knowledge' : 'knowledge'
  const hasError = ws.isError || list.isError

  // Loading and error both keep the SAME shell (Screen + Stepper) `MailboxStep` keeps for its own
  // loading gate, rather than returning a bare `<Loading />` with no onboarding chrome — and in
  // onboarding mode, "Skip for now" stays available even if the load itself failed, so a knowledge
  // outage can never strand someone mid-funnel.
  if (!ws.data || !list.data) {
    return (
      <Screen testID={testID}>
        {mode === 'onboarding' ? <Stepper current="knowledge" /> : null}
        <Heading>Knowledge</Heading>
        {hasError ? (
          <>
            <Banner tone="error">Could not load your knowledge base.</Banner>
            <Button label="Try again" onPress={retry} testID="knowledge-retry" />
            {mode === 'onboarding' ? (
              <>
                {skipConfirming ? <Banner tone="warning">Without knowledge the agent answers from your profile and guidance only</Banner> : null}
                <Button
                  variant={skipConfirming ? 'danger' : 'secondary'}
                  label={skipConfirming ? 'Confirm skip' : 'Skip for now'}
                  onPress={handleSkip} loading={advance.isPending} testID="skip"
                />
              </>
            ) : null}
          </>
        ) : (
          <Loading />
        )}
      </Screen>
    )
  }

  const { caps, canManage, counts, sources } = list.data
  const canContinue = counts.sources > 0 && !sources.some((s) => s.status === 'processing')

  return (
    <Screen testID={testID}>
      {mode === 'onboarding' ? <Stepper current="knowledge" /> : null}
      <Heading>Knowledge</Heading>

      {canManage ? (
        <SourceCards websiteUrl={ws.data.websiteUrl} caps={caps} />
      ) : (
        <Muted testID="knowledge-readonly">Only owners and admins can change knowledge.</Muted>
      )}

      <Muted testID="knowledge-counter">{`${counts.sources} of ${caps.maxSources} sources · ${counts.readyChunks} chunks ready`}</Muted>
      <SourceList sources={sources} onChanged={refreshList} canManage={canManage} />

      {counts.flaggedChunks > 0 ? <FlaggedChunks canManage={canManage} /> : null}

      <GuidanceEditor initial={ws.data.operatingGuidance} canManage={canManage} />

      <GapsCard />

      {mode === 'onboarding' ? (
        <>
          {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
          {skipConfirming ? <Banner tone="warning">Without knowledge the agent answers from your profile and guidance only</Banner> : null}
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
