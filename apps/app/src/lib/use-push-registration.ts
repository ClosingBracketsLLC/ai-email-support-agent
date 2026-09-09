import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { registerForPush } from './push'
import { useTRPC } from './trpc'

/** Once per launch, after the gate says `app`: re-register silently if permission was already granted. */
export function usePushRegistration() {
  const trpc = useTRPC()
  const register = useMutation(trpc.devices.register.mutationOptions())
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    registerForPush({ ask: false }).then((r) => { if (r.kind === 'ok') register.mutate({ expoPushToken: r.expoPushToken, platform: r.platform, ...(r.deviceName ? { deviceName: r.deviceName } : {}) }) }).catch(() => { /* never block the app on push */ })
  }, [register])
}
