import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'

/** `workspace.updateGuidance`'s own cap (`UpdateGuidanceInput`, `packages/contracts/src/workspace.ts`). */
const GUIDANCE_MAX = 8000
/** The spec's three example bullets (§Product step 4), shown as placeholder copy rather than real
 * text so an empty box still teaches the shape of a good rule. */
const GUIDANCE_PLACEHOLDER = [
  'e.g. "we don\'t refund sale items"',
  '"sign as Team Acme"',
  '"never promise delivery dates"',
].join('\n')

/**
 * The operating-guidance box (spec §Product step 4): the ONE free-text trusted layer the owner edits
 * directly (`@aesa/agent/policy`'s `buildReplyPolicy` feeds it to every guardrail gate). Pristine-reset
 * discipline (Phase 1 ruling, `ProfileForm`, also followed by `agent-edit.tsx`): re-seed from `initial`
 * only while nothing has been edited since mount, so a background refetch never clobbers an in-progress edit.
 */
export function GuidanceEditor({ initial }: { initial: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [text, setText] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (!dirty) setText(initial) }, [dirty, initial])

  const save = useMutation(trpc.workspace.updateGuidance.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() })
      setDirty(false)
      setSaved(true)
    },
    onError: () => setError('Could not save guidance. Try again.'),
  }))

  function onChange(v: string) {
    setText(v)
    setDirty(true)
    setSaved(false)
  }
  function submit() {
    if (!dirty || save.isPending) return
    setError(null)
    save.mutate({ operatingGuidance: text })
  }

  return (
    <Card testID="guidance-editor">
      <Heading>Operating guidance</Heading>
      <TextField
        label="Rules the agent should always follow" value={text} onChangeText={onChange}
        multiline numberOfLines={6} maxLength={GUIDANCE_MAX} placeholder={GUIDANCE_PLACEHOLDER} testID="guidance-text"
      />
      <Muted testID="guidance-counter">{`${text.length}/${GUIDANCE_MAX}`}</Muted>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {saved ? <Banner tone="success">Saved.</Banner> : null}
      <Button label="Save guidance" onPress={submit} loading={save.isPending} disabled={!dirty || save.isPending} testID="save-guidance" />
    </Card>
  )
}
