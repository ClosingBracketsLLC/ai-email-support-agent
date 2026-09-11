import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { KNOWLEDGE_DEFAULT_CRAWL_PAGES, KNOWLEDGE_MAX_PASTE_CHARS } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import type { PickedFile } from '@/lib/upload'
import { radius, spacing, typeScale, useColors } from '@/theme'
import { DropZone } from './drop-zone'
import { type PendingUpload, useUpload } from './use-upload'

/** The crawl page-cap segmented control's fixed options (task brief) — the api further clamps
 * whatever is selected here to `knowledge.max_crawl_pages` for the org's plan
 * (`apps/api/src/knowledge/service.ts`'s `startCrawl`), which the app has no endpoint to read ahead of
 * time; offering only these three keeps every request inside a sane range regardless. */
const PAGE_CAP_OPTIONS = [20, 50, 100] as const

const UPLOAD_PROGRESS_LABEL: Record<PendingUpload['progress'], string> = {
  signing: 'Preparing…', uploading: 'Uploading…', queued: 'Queued for processing', failed: 'Failed',
}

/** Same `{data:{code}}` shape `sandbox-card.tsx`/`connect-card.tsx` read off a tRPC error. */
function errorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | null)?.data?.code
}
function errorMessage(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message ?? fallback
}

function PageCapControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const c = useColors()
  return (
    <View style={styles.pageCapRow}>
      {PAGE_CAP_OPTIONS.map((opt) => (
        <Pressable
          key={opt} role="radio" accessibilityState={{ checked: value === opt }}
          onPress={() => onChange(opt)} testID={`page-cap-${opt}`}
          style={[styles.pageCapOption, { borderColor: value === opt ? c.primary : c.border, backgroundColor: value === opt ? c.primaryTint : c.bg }]}
        >
          <Text style={[typeScale.body, { color: c.text }]}>{opt}</Text>
        </Pressable>
      ))}
    </View>
  )
}

/**
 * The three "add knowledge" cards (spec §Product step 4): Crawl, Paste, Upload. Self-contained — it
 * owns its own crawl/paste/upload mutations and error surfacing, and invalidates `knowledge.list`
 * itself on a crawl/paste success (the upload pipeline's own `use-upload.ts` already does that for
 * uploads). `startCrawl`'s `BAD_REQUEST` (a non-https URL) surfaces under the URL field; a
 * `FORBIDDEN` from any of the three (the plan's source cap) surfaces as one shared error banner.
 */
export function SourceCards({ websiteUrl }: { websiteUrl: string | null }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const upload = useUpload()

  const [crawlUrl, setCrawlUrl] = useState(websiteUrl ?? '')
  const [maxPages, setMaxPages] = useState<number>(KNOWLEDGE_DEFAULT_CRAWL_PAGES)
  const [crawlUrlError, setCrawlUrlError] = useState<string | null>(null)
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [capError, setCapError] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.knowledge.list.queryKey() })

  const startCrawl = useMutation(trpc.knowledge.startCrawl.mutationOptions({
    onSuccess: () => { setCrawlUrlError(null); void refresh() },
    onError: (err) => {
      if (errorCode(err) === 'BAD_REQUEST') setCrawlUrlError(errorMessage(err, 'Enter a valid https:// address.'))
      else setCapError(errorMessage(err, 'Could not start the crawl. Try again.'))
    },
  }))
  const paste = useMutation(trpc.knowledge.paste.mutationOptions({
    onSuccess: () => { setPasteTitle(''); setPasteText(''); void refresh() },
    onError: (err) => setCapError(errorMessage(err, 'Could not add this text. Try again.')),
  }))

  function submitCrawl() {
    setCrawlUrlError(null)
    setCapError(null)
    startCrawl.mutate({ url: crawlUrl.trim(), maxPages })
  }
  function submitPaste() {
    setCapError(null)
    paste.mutate({ title: pasteTitle.trim(), text: pasteText })
  }
  async function handleFiles(files: PickedFile[]) {
    setCapError(null)
    await upload.start(files)
  }

  const uploadBusy = upload.pending.some((p) => p.progress === 'signing' || p.progress === 'uploading')

  return (
    <View style={styles.stack}>
      <Card testID="crawl-card">
        <Heading>Crawl your website</Heading>
        <TextField
          label="Website URL" value={crawlUrl} onChangeText={setCrawlUrl} error={crawlUrlError}
          autoCapitalize="none" autoCorrect={false} keyboardType="url" testID="crawl-url"
        />
        <Muted>Pages to crawl</Muted>
        <PageCapControl value={maxPages} onChange={setMaxPages} />
        <Button label="Crawl site" onPress={submitCrawl} loading={startCrawl.isPending} disabled={!crawlUrl.trim() || startCrawl.isPending} testID="start-crawl" />
      </Card>

      <Card testID="paste-card">
        <Heading>Paste FAQs or policies</Heading>
        <TextField label="Title" value={pasteTitle} onChangeText={setPasteTitle} maxLength={120} testID="paste-title" />
        <TextField
          label="Text" value={pasteText} onChangeText={setPasteText}
          multiline numberOfLines={6} maxLength={KNOWLEDGE_MAX_PASTE_CHARS} testID="paste-text"
        />
        <Button label="Add text" onPress={submitPaste} loading={paste.isPending} disabled={!pasteTitle.trim() || !pasteText.trim() || paste.isPending} testID="add-paste" />
      </Card>

      <Card testID="upload-card">
        <Heading>Upload files</Heading>
        <DropZone onFiles={handleFiles} disabled={uploadBusy} />
        <Muted>PDF, DOCX, MD, TXT · up to 20 MB each</Muted>
        {upload.pending.map((p) => (
          <Muted key={p.name} testID={`upload-progress-${p.name}`}>{`${p.name} — ${UPLOAD_PROGRESS_LABEL[p.progress]}`}</Muted>
        ))}
      </Card>

      {capError ? <Banner tone="error" testID="knowledge-cap-error">{capError}</Banner> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  pageCapRow: { flexDirection: 'row', gap: spacing.sm },
  pageCapOption: { flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: radius.pill, paddingVertical: spacing.xs },
})
