import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Redirect, useRouter } from 'expo-router'
import { useState } from 'react'
import { Platform, Pressable, StyleSheet, View } from 'react-native'
import { StartCrawlInput } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Body, Heading, Muted } from '@/components/typography'
import { defaultMaxPages } from '@/screens/knowledge/source-cards'
import { useUpload } from '@/screens/knowledge/use-upload'
import { useShareIntentSafe } from '@/lib/share-intent'
import { hrefFor } from '@/lib/session-gate'
import { useTRPC } from '@/lib/trpc'
import { useGate } from '@/lib/use-gate'
import { radius, spacing, useColors } from '@/theme'

/** Same three fixed page-cap options `source-cards.tsx`'s `PageCapControl` offers — kept as its own
 * small literal here (not exported/shared) since `defaultMaxPages`, the piece actually worth
 * reusing, is the one thing the task brief calls out. */
const PAGE_CAP_OPTIONS = [20, 50, 100] as const
/** Same fixed copy `source-cards.tsx` uses for a `BAD_REQUEST` on the crawl field. */
const CRAWL_URL_MESSAGE = 'Enter a full https:// address'
/** How much of a shared text block the Text card actually shows — the FULL text is still what gets
 * sent to `knowledge.paste`; this only bounds the on-screen preview (a share-sheet text can be an
 * entire pasted article). */
const TEXT_PREVIEW_MAX_CHARS = 500

interface ShareFile { fileName: string; mimeType: string; path: string; size: number | null }
interface ShareIntentShape { webUrl?: string | null; text?: string | null; files?: readonly ShareFile[] | null }
type ShareKind = 'link' | 'text' | 'file' | 'empty'

function kindFor(intent: ShareIntentShape | null): ShareKind {
  if (!intent) return 'empty'
  if (intent.webUrl) return 'link'
  if (intent.text && intent.text.trim()) return 'text'
  if (intent.files && intent.files.length > 0) return 'file'
  return 'empty'
}

/** Same `{data:{code}}` shape `source-cards.tsx`'s own `errorCode` reads off a tRPC error. */
function errorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | null)?.data?.code
}
/** Same copy `source-cards.tsx` composes for a `FORBIDDEN` (the plan's source cap) on any of the
 * three add-knowledge mutations. */
function capBannerText(maxSources: number): string {
  return `Your plan allows ${maxSources} sources. Delete one to add another.`
}
function boundedPreview(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TEXT_PREVIEW_MAX_CHARS ? `${trimmed.slice(0, TEXT_PREVIEW_MAX_CHARS)}…` : trimmed
}
/** Same bytes-to-label shape `inbox/message-bubble.tsx`'s own (unexported) `formatBytes` uses. */
function formatBytes(size: number | null): string {
  if (size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Native share-sheet intake (spec's Phase 7 item, route 27): an owner shares a link, some text or a
 * file from any other app into aesa and lands here. Sits OUTSIDE `(app)` (like `create-workspace`)
 * so it does not inherit that group's gate — it runs `useGate()` itself, below, and redirects on
 * anything but `app`, so a signed-out tap never reaches a screen that calls tRPC without a session.
 *
 * `expo-share-intent` has no web build (see `lib/share-intent.ts`), so the web branch returns before
 * ANY hook is called — `Platform.OS` is fixed for the life of the process, so this is safe despite
 * reading like a conditional hook.
 */
export function ShareScreen() {
  if (Platform.OS === 'web') {
    return (
      <Screen testID="share">
        <Banner tone="info" testID="share-web-banner">Sharing into aesa works from the iOS and Android apps.</Banner>
      </Screen>
    )
  }

  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind === 'error') return <GateError target={gate} />
  if (gate.kind !== 'app') return <Redirect href={hrefFor(gate)!} />
  return <ShareScreenBody />
}

/** Split out from `ShareScreen` so the gate's early returns above never skip a hook this component
 * calls — a NEW component only mounting once the gate settles to `app` is an ordinary conditional
 * render, not a hooks-rule violation the way an early return INSIDE one render would be. */
function ShareScreenBody() {
  const trpc = useTRPC()
  const router = useRouter()
  const { shareIntent, resetShareIntent } = useShareIntentSafe()
  const list = useQuery(trpc.knowledge.list.queryOptions())

  function notNow() {
    resetShareIntent()
    router.replace('/inbox')
  }

  if (!list.data) {
    return (
      <Screen testID="share">
        {list.isError ? (
          <>
            <Banner tone="error">Could not load your knowledge base.</Banner>
            <Button label="Try again" onPress={() => void list.refetch()} testID="share-retry" />
          </>
        ) : <Loading />}
      </Screen>
    )
  }

  const { caps, canManage } = list.data

  if (!canManage) {
    return (
      <Screen testID="share">
        <Muted testID="share-readonly">Only owners and admins can add knowledge.</Muted>
        <Button variant="secondary" label="Not now" onPress={notNow} testID="share-not-now" />
      </Screen>
    )
  }

  // `resetShareIntent()` + this replace is the SAME "done" outcome every card ends on — a fresh
  // source was minted, so the owner lands where it (and everything else already learned) lives.
  const onDone = () => { resetShareIntent(); router.replace('/settings/knowledge') }
  const kind = kindFor(shareIntent)

  return (
    <Screen testID="share">
      {kind === 'link' ? <LinkCard url={shareIntent!.webUrl ?? ''} maxCrawlPages={caps.maxCrawlPages} maxSources={caps.maxSources} onDone={onDone} /> : null}
      {kind === 'text' ? <TextCard text={shareIntent!.text ?? ''} maxSources={caps.maxSources} onDone={onDone} /> : null}
      {kind === 'file' ? <FileCard file={shareIntent!.files![0]!} maxSources={caps.maxSources} onDone={onDone} /> : null}
      {kind === 'empty' ? <Muted testID="share-empty">Nothing to add yet.</Muted> : null}
      <Button variant="secondary" label="Not now" onPress={notNow} testID="share-not-now" />
    </Screen>
  )
}

function LinkCard({ url, maxCrawlPages, maxSources, onDone }: { url: string; maxCrawlPages: number; maxSources: number; onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const c = useColors()
  const pageCapOptions = PAGE_CAP_OPTIONS.filter((o) => o <= maxCrawlPages)

  const [crawlUrl, setCrawlUrl] = useState(url)
  const [maxPages, setMaxPages] = useState<number>(() => defaultMaxPages(pageCapOptions, maxCrawlPages))
  const [urlError, setUrlError] = useState<string | null>(null)
  const [capReached, setCapReached] = useState(false)
  const [failed, setFailed] = useState(false)

  const startCrawl = useMutation(trpc.knowledge.startCrawl.mutationOptions({
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: trpc.knowledge.list.queryKey() }); onDone() },
    onError: (err) => {
      const code = errorCode(err)
      if (code === 'BAD_REQUEST') setUrlError(CRAWL_URL_MESSAGE)
      else if (code === 'FORBIDDEN') setCapReached(true)
      else setFailed(true)
    },
  }))

  const effectiveMaxPages = pageCapOptions.length === 0 ? maxCrawlPages : maxPages

  function submit() {
    setUrlError(null); setCapReached(false); setFailed(false)
    const parsed = StartCrawlInput.safeParse({ url: crawlUrl.trim(), maxPages: effectiveMaxPages })
    if (!parsed.success) { setUrlError(CRAWL_URL_MESSAGE); return }
    startCrawl.mutate(parsed.data)
  }

  return (
    <Card testID="link-card">
      <Heading>Crawl this site</Heading>
      <TextField
        label="Website URL" value={crawlUrl} onChangeText={setCrawlUrl} error={urlError}
        autoCapitalize="none" autoCorrect={false} keyboardType="url" testID="share-crawl-url"
      />
      <Muted>Pages to crawl</Muted>
      {pageCapOptions.length === 0 ? (
        <Muted testID="share-page-cap-fixed">{`Plan cap: ${maxCrawlPages} pages`}</Muted>
      ) : (
        <View style={styles.pageCapRow} accessibilityRole="radiogroup">
          {pageCapOptions.map((opt) => (
            <Pressable
              key={opt} role="radio" accessibilityState={{ checked: maxPages === opt }}
              onPress={() => setMaxPages(opt)} testID={`share-page-cap-${opt}`}
              style={[styles.pageCapOption, { borderColor: maxPages === opt ? c.primary : c.border, backgroundColor: maxPages === opt ? c.primaryTint : c.bg }]}
            >
              <Body>{opt}</Body>
            </Pressable>
          ))}
        </View>
      )}
      <Button label="Crawl this site" onPress={submit} loading={startCrawl.isPending} disabled={!crawlUrl.trim() || startCrawl.isPending} testID="share-start-crawl" />
      {capReached ? <Banner tone="error" testID="knowledge-cap-error">{capBannerText(maxSources)}</Banner> : null}
      {failed ? <Banner tone="error" testID="share-crawl-error">Could not start the crawl. Try again.</Banner> : null}
    </Card>
  )
}

function TextCard({ text, maxSources, onDone }: { text: string; maxSources: number; onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [capReached, setCapReached] = useState(false)
  const [failed, setFailed] = useState(false)

  const paste = useMutation(trpc.knowledge.paste.mutationOptions({
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: trpc.knowledge.list.queryKey() }); onDone() },
    onError: (err) => { if (errorCode(err) === 'FORBIDDEN') setCapReached(true); else setFailed(true) },
  }))

  function submit() {
    setCapReached(false); setFailed(false)
    paste.mutate({ title: title.trim(), text })
  }

  return (
    <Card testID="text-card">
      <Heading>Add as a note</Heading>
      <TextField label="Title" value={title} onChangeText={setTitle} maxLength={120} testID="share-paste-title" />
      <Muted testID="share-text-preview" numberOfLines={6}>{boundedPreview(text)}</Muted>
      <Button label="Add as a note" onPress={submit} loading={paste.isPending} disabled={!title.trim() || paste.isPending} testID="share-add-paste" />
      {capReached ? <Banner tone="error" testID="knowledge-cap-error">{capBannerText(maxSources)}</Banner> : null}
      {failed ? <Banner tone="error" testID="share-paste-error">Could not add the text. Try again.</Banner> : null}
    </Card>
  )
}

function FileCard({ file, maxSources, onDone }: { file: ShareFile; maxSources: number; onDone: () => void }) {
  const upload = useUpload()
  const [capReached, setCapReached] = useState(false)
  const busy = upload.pending.some((p) => p.progress === 'signing' || p.progress === 'uploading')

  async function submit() {
    setCapReached(false)
    const outcome = await upload.start([{ name: file.fileName, mime: file.mimeType, size: file.size, uri: file.path }])
    if (outcome.stoppedBy === 'cap') { setCapReached(true); return }
    onDone()
  }

  return (
    <Card testID="file-card">
      <Heading>Upload this file</Heading>
      <Body>{file.fileName}</Body>
      <Muted>{formatBytes(file.size)}</Muted>
      <Button label="Upload" onPress={() => void submit()} loading={busy} disabled={busy} testID="share-upload" />
      {capReached ? <Banner tone="error" testID="knowledge-cap-error">{capBannerText(maxSources)}</Banner> : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  pageCapRow: { flexDirection: 'row', gap: spacing.sm },
  pageCapOption: { flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: radius.pill, paddingVertical: spacing.xs },
})
