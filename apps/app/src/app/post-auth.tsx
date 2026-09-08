import { Redirect } from 'expo-router'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function PostAuth() {
  const href = hrefFor(useGate())
  return href ? <Redirect href={href} /> : <Loading />
}
