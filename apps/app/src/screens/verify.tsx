import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'

export function VerifyScreen() {
  const router = useRouter()
  const { email = '' } = useLocalSearchParams<{ email?: string }>()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [resendBusy, setResendBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)

  async function verify() {
    if (busy) return
    setBusy(true); setError(null)
    const { error } = await authClient.signIn.emailOtp({ email, otp: code.trim() })
    setBusy(false)
    // On success the session appears and the (auth) layout's gate redirects; nothing to do here.
    if (error) setError('That code is not right or has expired.')
  }

  async function resend() {
    if (resendBusy) return
    setResendBusy(true); setError(null); setResent(false)
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })
    setResendBusy(false)
    if (error) setError('Could not resend the code. Wait a minute and try again.'); else setResent(true)
  }

  return (
    <Screen testID="verify">
      <Title>Check your email</Title>
      <Muted>We sent a 6-digit code to {email}.</Muted>
      <TextField label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} testID="otp" onSubmitEditing={verify} />
      <Button label="Continue" onPress={verify} loading={busy} disabled={code.trim().length !== 6} testID="verify-code" />
      <Button variant="secondary" label="Send a new code" onPress={resend} loading={resendBusy} />
      <Button variant="secondary" label="Use a different email" onPress={() => router.replace('/sign-in')} />
      {resent ? <Banner tone="success">A new code is on its way.</Banner> : null}
      {error ? <Banner tone="error" testID="verify-error">{error}</Banner> : null}
    </Screen>
  )
}
