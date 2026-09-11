import { useQuery } from '@tanstack/react-query'
import { Link, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { Banner } from '@/components/banner'
import { Lockup } from '@/components/brand'
import { Button } from '@/components/button'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { setNextPath } from '@/lib/next-path'
import { fetchMeta } from '@/lib/trpc'

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

export function SignInScreen() {
  const router = useRouter()
  const { next } = useLocalSearchParams<{ next?: string }>()
  useEffect(() => { setNextPath(next) }, [next])
  const meta = useQuery({ queryKey: ['meta'], queryFn: fetchMeta, staleTime: Infinity })
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendCode() {
    if (busy) return
    const address = email.trim().toLowerCase()
    setBusy(true); setError(null)
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: address, type: 'sign-in' })
    setBusy(false)
    if (error) return setError(error.status === 429 ? 'Too many codes requested. Wait a minute and try again.' : 'We could not send a code to that address.')
    router.push({ pathname: '/verify', params: { email: address } })
  }

  async function social(provider: 'google' | 'microsoft') {
    if (busy) return
    setBusy(true); setError(null)
    const callbackURL = Platform.OS === 'web' ? `${window.location.origin}/post-auth` : '/post-auth'
    const { error } = await authClient.signIn.social({ provider, callbackURL })
    setBusy(false)
    if (error) setError(`${provider === 'google' ? 'Google' : 'Microsoft'} sign-in did not complete.`)
  }

  return (
    <Screen testID="sign-in">
      <Lockup height={28} testID="brand-lockup" />
      <Title>Sign in</Title>
      <Muted>We email you a 6-digit code. No password to remember.</Muted>
      <TextField label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" testID="email" onSubmitEditing={sendCode} />
      <Button label="Send code" onPress={sendCode} loading={busy} disabled={!looksLikeEmail(email)} testID="send-code" />
      {meta.data?.providers.google ? <Button variant="secondary" label="Continue with Google" onPress={() => social('google')} testID="google" /> : null}
      {meta.data?.providers.microsoft ? <Button variant="secondary" label="Continue with Microsoft" onPress={() => social('microsoft')} testID="microsoft" /> : null}
      {error ? <Banner tone="error" testID="sign-in-error">{error}</Banner> : null}
      <Muted>By continuing you agree to the <Link href="/terms">Terms</Link> and the <Link href="/privacy">Privacy Policy</Link>.</Muted>
    </Screen>
  )
}
