import type { ReactNode } from 'react'

/**
 * Jest's stand-in for the REAL `expo-share-intent` package (wired in `package.json`'s
 * `jest.moduleNameMapper`, `^expo-share-intent$` -> this file) — the native module has no Node/jsdom
 * build, so any test that transitively imports it (chiefly `src/app/_layout.tsx`, which mounts the
 * real `ShareIntentProvider` on every non-web platform) would otherwise crash on module load. This
 * mock is a passthrough provider plus a context hook that always reports "nothing shared" —
 * `src/lib/share-intent.ts`'s `useShareIntentSafe()` is the seam a SCREEN mocks directly
 * (`share.test.tsx` mocks `@/lib/share-intent`, never this module), so this file only has to satisfy
 * whatever imports `expo-share-intent` itself, never a real intent.
 */
export interface MockShareIntentFile {
  fileName: string
  mimeType: string
  path: string
  size: number | null
  width: number | null
  height: number | null
  duration: number | null
}
export interface MockShareIntent {
  meta?: Record<string, string | undefined> | null
  text?: string | null
  files: MockShareIntentFile[] | null
  type: 'media' | 'file' | 'text' | 'weburl' | null
  webUrl: string | null
}

export const SHAREINTENT_DEFAULTVALUE: MockShareIntent = { meta: null, text: null, files: null, type: null, webUrl: null }

export function ShareIntentProvider({ children }: { children: ReactNode }) {
  return children
}

export function useShareIntentContext() {
  return { isReady: true, hasShareIntent: false, shareIntent: SHAREINTENT_DEFAULTVALUE, resetShareIntent: () => {}, error: null as string | null }
}

export function useShareIntent() {
  return useShareIntentContext()
}
