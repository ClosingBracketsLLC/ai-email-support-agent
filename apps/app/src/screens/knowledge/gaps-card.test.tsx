import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { GapsCard } from './gaps-card'

interface GapsData {
  windowDays: number
  drafts: number
  uncited: number
  questions: { text: string; count: number; lastTicketId: string; lastAt: Date }[]
}

let mockGaps: GapsData = { windowDays: 30, drafts: 0, uncited: 0, questions: [] }

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    knowledge: {
      gaps: { queryOptions: () => ({ queryKey: ['knowledge', 'gaps'], queryFn: () => Promise.resolve(mockGaps) }) },
    },
  }),
}))

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<GapsCard />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockGaps = { windowDays: 30, drafts: 0, uncited: 0, questions: [] }
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('summarizes how many of the last N days\' drafts cited no knowledge', async () => {
  mockGaps = { windowDays: 30, drafts: 42, uncited: 9, questions: [] }
  await setup()
  await waitFor(() => expect(screen.getByTestId('gaps-summary')).toBeTruthy())
  expect(screen.getByText('9 of 42 drafts in the last 30 days cited no knowledge')).toBeTruthy()
})

test('lists the top unanswered questions with their counts', async () => {
  mockGaps = {
    windowDays: 30, drafts: 10, uncited: 3,
    questions: [
      { text: 'Do you ship to Canada?', count: 5, lastTicketId: 't1', lastAt: new Date() },
      { text: 'What is your return window?', count: 2, lastTicketId: 't2', lastAt: new Date() },
    ],
  }
  await setup()
  await waitFor(() => expect(screen.getByTestId('gap-question-0')).toBeTruthy())
  expect(screen.getByText('Do you ship to Canada?')).toBeTruthy()
  expect(screen.getByText('5×')).toBeTruthy()
  expect(screen.getByTestId('gap-question-1')).toBeTruthy()
})
