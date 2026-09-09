import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { ListRow } from '@/components/list-row'
import { Screen } from '@/components/screen'
import { Body, Heading, Muted } from '@/components/typography'
import { registerForPush, type PushResult } from '@/lib/push'
import { useTRPC } from '@/lib/trpc'

export function NotificationsScreen() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const devices = useQuery(trpc.devices.list.queryOptions())
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() })
  const register = useMutation(trpc.devices.register.mutationOptions({ onSuccess: refresh }))
  const unregister = useMutation(trpc.devices.unregister.mutationOptions({ onSuccess: refresh }))
  const [state, setState] = useState<PushResult | null>(null)
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => { registerForPush({ ask: false }).then((r) => { setState(r); if (r.kind === 'ok') setToken(r.expoPushToken) }) }, [])

  async function enable() {
    if (register.isPending) return
    const r = await registerForPush({ ask: true })
    setState(r)
    if (r.kind === 'ok') { setToken(r.expoPushToken); register.mutate({ expoPushToken: r.expoPushToken, platform: r.platform, ...(r.deviceName ? { deviceName: r.deviceName } : {}) }) }
  }

  function stopNotifications() {
    if (unregister.isPending || !token) return
    unregister.mutate({ expoPushToken: token })
  }

  return (
    <Screen testID="notifications">
      <Card>
        <Heading>This device</Heading>
        {Platform.OS === 'web' ? <Body>Push notifications are for the phone app. On the web you will get in-app notices and the email digest.</Body>
          : state?.kind === 'ok' ? <Body>Push is on. You will be told when a draft needs review or a customer needs a human.</Body>
          : state?.kind === 'no-project' ? <Body>This build is not linked to an EAS project yet, so push tokens cannot be issued.</Body>
          : state?.kind === 'unsupported' ? <Body>Push needs a development build on a real device.</Body>
          : <Body>Get a push when a draft is ready to review — never for routine sends.</Body>}
        {Platform.OS !== 'web' && state?.kind !== 'ok' && state?.kind !== 'unsupported' ? <Button label="Enable push notifications" onPress={enable} loading={register.isPending} testID="enable-push" /> : null}
        {state?.kind === 'ok' && token ? <Button variant="secondary" label="Stop notifications on this device" onPress={stopNotifications} loading={unregister.isPending} /> : null}
      </Card>
      {devices.data?.length ? <Heading>Registered devices</Heading> : null}
      {devices.data?.map((d) => (
        <ListRow key={d.id} title={d.deviceName ?? d.platform} subtitle={d.disabledAt ? `Stopped ${d.disabledAt.toLocaleDateString()}` : `Last seen ${d.lastSeenAt.toLocaleString()}`} badge={d.platform} />
      ))}
      {state?.kind === 'denied' ? <Banner>Notifications are off for aesa in the system settings. Turn them on there, then come back.</Banner> : null}
      <Muted>Review and escalation pushes only. Auto-sent replies fold into the daily digest.</Muted>
    </Screen>
  )
}
