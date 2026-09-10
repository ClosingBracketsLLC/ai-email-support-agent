import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { SANDBOX_QUESTION_MAX, type DecisionAction, type SandboxOutputView } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC, useTRPCClient } from '@/lib/trpc'
import { DECISION_REASON_LABEL } from '@/screens/inbox/reason-labels'
import { spacing } from '@/theme'

const DEFAULT_POLL_MS = 1_500
const DEFAULT_MAX_POLLS = 80

/** `decide()`'s four verdicts (spec §Decision), in the owner's words — the sandbox's own
 * `decisionReason` label comes from `reason-labels.ts`'s `DECISION_REASON_LABEL`. */
const DECISION_ACTION_LABEL: Record<DecisionAction, string> = { send: 'Send', review: 'Review', escalate: 'Escalate', no_action: 'No action' }

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'succeeded'; output: SandboxOutputView }
  | { kind: 'failed'; errorCode: string | null }
  | { kind: 'error'; message: string }

/** Resolves early if `signal` aborts, so a cancelled poll doesn't sit out its own tick before
 * actually stopping — same helper as `connect-card.tsx`'s. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal.aborted) { clearTimeout(timer); resolve(); return }
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
function errorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | null)?.data?.code
}
function findingText(f: { code: string; detail: string }): string {
  return f.detail ? `${f.code}: ${f.detail}` : f.code
}

/**
 * The owner's "Try it" — one hand-typed question through the real draft pipeline, against a
 * synthetic thread (spec §"Try it"/Task 18's `agents.sandboxStart`/`sandboxGet`). Self-contained by
 * design: unlike every other tRPC call in this app, `sandboxGet` here is a manual poll through the
 * vanilla client (the `ConnectMailboxCard` poll idiom) rather than `useQuery`'s `refetchInterval` —
 * that idiom is what gives an unmount and a `maxPolls` cap a clean place to stop the loop.
 */
export function SandboxCard({
  agentId,
  pollMs = DEFAULT_POLL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}: {
  agentId: string
  /** Test-only timing overrides — defaults are the real production values. */
  pollMs?: number
  maxPolls?: number
}) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [question, setQuestion] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  // One controller per in-flight run — an unmount (or a second Run) must stop the PREVIOUS run's
  // poll loop and stop it from ever calling `setPhase` again on a stale closure.
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  const start = useMutation(trpc.agents.sandboxStart.mutationOptions({
    onError: (error) => {
      setPhase({
        kind: 'error',
        message: errorCode(error) === 'TOO_MANY_REQUESTS'
          ? 'Daily sandbox limit reached — try again tomorrow.'
          : 'Could not start. Try again.',
      })
    },
  }))

  const running = phase.kind === 'running'
  const busy = running || start.isPending

  async function poll(runId: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      if (signal.aborted) return
      try {
        const result = await trpcClient.agents.sandboxGet.query({ runId })
        if (signal.aborted) return
        if (result.status === 'running') {
          await sleep(pollMs, signal)
          continue
        }
        if (result.status === 'succeeded' && result.output) {
          setPhase({ kind: 'succeeded', output: result.output })
          return
        }
        // 'failed' or 'aborted' (or a 'succeeded' row whose stored output didn't parse, per
        // `agents.sandboxGet`'s defensive `safeParse` — `output: null` either way): the same
        // "could not answer" copy, keyed off whatever `errorCode` the run recorded.
        setPhase({ kind: 'failed', errorCode: result.errorCode })
        return
      } catch {
        if (!signal.aborted) setPhase({ kind: 'error', message: 'Could not read the result. Try again.' })
        return
      }
    }
    if (!signal.aborted) setPhase({ kind: 'error', message: 'Taking too long. Try again.' })
  }

  function run() {
    if (busy || !question.trim()) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setPhase({ kind: 'running' })
    start.mutate({ agentId, question: question.trim() }, {
      onSuccess: (data) => { void poll(data.runId, controller.signal) },
    })
  }

  return (
    <Card testID="sandbox-card">
      <Heading>Try it</Heading>
      <TextField
        label="Ask a question the way a customer would" value={question} onChangeText={setQuestion}
        maxLength={SANDBOX_QUESTION_MAX} multiline numberOfLines={3} testID="sandbox-question"
      />
      <Button label="Run" onPress={run} loading={busy} disabled={busy || !question.trim()} testID="sandbox-run" />

      {phase.kind === 'succeeded' ? <SandboxResult output={phase.output} /> : null}
      {phase.kind === 'failed' ? <Banner tone="error">{`The agent could not answer (${phase.errorCode ?? 'unknown'}).`}</Banner> : null}
      {phase.kind === 'error' ? <Banner tone="error">{phase.message}</Banner> : null}
    </Card>
  )
}

/** The sandbox's own `decide()` verdict is informational only (it never acts on it) — this renders
 * exactly what the owner would have gotten: the reply itself for `outcome: 'reply'`, or the model's
 * own reason plus its rationale for `escalate`/`no_reply`. */
function SandboxResult({ output }: { output: SandboxOutputView }) {
  if (output.outcome === 'reply') {
    const pct = output.confidence === null ? null : Math.round(output.confidence * 100)
    const findings = output.guardrail?.findings ?? []
    const blocked = findings.filter((f) => f.severity === 'fail')
    const warnings = findings.filter((f) => f.severity === 'warn')
    return (
      <View testID="sandbox-result" style={styles.result}>
        <Body>{output.normalizedBody}</Body>
        {pct !== null ? <Muted>{`${pct}% confidence`}</Muted> : null}
        <Muted>{`Would go to: ${DECISION_ACTION_LABEL[output.decision]} (${DECISION_REASON_LABEL[output.decisionReason]})`}</Muted>
        {blocked.length > 0 ? <Muted>{`Blocked: ${blocked.map(findingText).join('; ')}`}</Muted> : null}
        {warnings.length > 0 ? <Muted>{`Heads up: ${warnings.map(findingText).join('; ')}`}</Muted> : null}
      </View>
    )
  }
  return (
    <View testID="sandbox-result" style={styles.result}>
      <Body>{output.reason ?? 'No reason given.'}</Body>
      <Muted>{output.rationale}</Muted>
    </View>
  )
}

const styles = StyleSheet.create({ result: { gap: spacing.xs } })
