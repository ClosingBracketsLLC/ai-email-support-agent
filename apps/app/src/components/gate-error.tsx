import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Screen } from '@/components/screen'
import type { GateTarget } from '@/lib/session-gate'

/** Rendered wherever useGate() reports a hard failure (session, activation or workspace lookup). */
export function GateError({ target }: { target: Extract<GateTarget, { kind: 'error' }> }) {
  return (
    <Screen testID="gate-error">
      <Banner tone="error">{target.message}</Banner>
      <Button label="Try again" onPress={target.retry} testID="gate-retry" />
    </Screen>
  )
}
