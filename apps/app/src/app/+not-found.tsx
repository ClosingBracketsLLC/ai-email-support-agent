import { Link } from 'expo-router'
import { Screen } from '@/components/screen'
import { Body, Title } from '@/components/typography'

export default function NotFound() {
  return (
    <Screen>
      <Title>Page not found</Title>
      <Link href="/"><Body>Go home</Body></Link>
    </Screen>
  )
}
