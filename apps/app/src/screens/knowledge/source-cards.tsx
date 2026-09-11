import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { KNOWLEDGE_DEFAULT_CRAWL_PAGES, KNOWLEDGE_MAX_PASTE_CHARS, KNOWLEDGE_MAX_UPLOAD_BYTES, KNOWLEDGE_UPLOAD_MIMES, type KnowledgeUploadMime } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import type { PickedFile } from '@/lib/upload'
import { radius, spacing, useColors } from '@/theme'
import { DropZone } from './drop-zone'
import { type PendingUpload, type UploadFailureReason, useUpload } from './use-upload'

export interface KnowledgeCaps { maxSources: number; maxCrawlPages: number }

/** The crawl page-cap segmented control's fixed options (task brief), filtered down to whatever the
 * org's actual plan (`caps.maxCrawlPages`) allows — the api further clamps anything sent, but there
 * is no reason to ever OFFER a value the plan can't honor. */
const PAGE_CAP_OPTIONS = [20, 50, 100] as const

/** The largest offered option ≤ the plan cap, preferring the spec default (50) when it still fits —
 * `options` is `PAGE_CAP_OPTIONS` already filtered to `<= maxCrawlPages`; empty means even 20 is over
 * the plan cap, so the caller falls back to the cap itself (the "single fixed cap line" case). */
function defaultMaxPages(options: readonly number[], maxCrawlPages: number): number {
  if (options.length === 0) return maxCrawlPages
  return options.includes(KNOWLEDGE_DEFAULT_CRAWL_PAGES) ? KNOWLEDGE_DEFAULT_CRAWL_PAGES : options[options.length - 1]!
}

const UPLOAD_PROGRESS_LABEL: Record<PendingUpload['progress'], string> = {
  signing: 'Preparing…', uploading: 'Uploading…', queued: 'Queued for processing', failed: 'Failed',
}
/** In the owner's own words — never a bare error code (same discipline as `source-list.tsx`'s
 * `FAILURE_LABEL`). The shared cap banner (below) carries the plan's actual number; this per-file
 * line stays short since it sits next to several others. */
const UPLOAD_REASON_LABEL: Record<UploadFailureReason, string> = {
  too_large: `Over the ${Math.round(KNOWLEDGE_MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`,
  wrong_type: 'Not a supported file type',
  unknown_size: "Couldn't read this file's size",
  cap: 'Skipped — plan limit reached',
  upload_failed: 'Could not upload this file',
}
/** Derived from the contracts enum, not hand-typed — a fifth accepted MIME added to
 * `KNOWLEDGE_UPLOAD_MIMES` shows up here without a matching edit. */
const MIME_LABEL: Record<KnowledgeUploadMime, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'text/markdown': 'MD',
  'text/plain': 'TXT',
}
const ACCEPTED_TYPES_LABEL = KNOWLEDGE_UPLOAD_MIMES.map((m) => MIME_LABEL[m]).join(', ')
const UPLOAD_MAX_MB = Math.round(KNOWLEDGE_MAX_UPLOAD_BYTES / 1024 / 1024)

/** Same `{data:{code}}` shape `sandbox-card.tsx`/`connect-card.tsx` read off a tRPC error. */
function errorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | null)?.data?.code
}
function errorMessage(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message ?? fallback
}

function PageCapControl({ value, onChange, maxCrawlPages }: { value: number; onChange: (v: number) => void; maxCrawlPages: number }) {
  const c = useColors()
  const options = PAGE_CAP_OPTIONS.filter((o) => o <= maxCrawlPages)
  if (options.length === 0) {
    return <Muted testID="page-cap-fixed">{`Plan cap: ${maxCrawlPages} pages`}</Muted>
  }
  return (
    <View style={styles.pageCapRow} accessibilityRole="radiogroup">
      {options.map((opt) => (
        <Pressable
          key={opt} role="radio" accessibilityState={{ checked: value === opt }}
          onPress={() => onChange(opt)} testID={`page-cap-${opt}`}
          style={[styles.pageCapOption, { borderColor: value === opt ? c.primary : c.border, backgroundColor: value === opt ? c.primaryTint : c.bg }]}
        >
          <Body>{opt}</Body>
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
 * `FORBIDDEN` from any of the three (the plan's source cap) surfaces as one shared error banner
 * whose text is always composed from `caps.maxSources` — never the server's own message, which can
 * change wording without this screen following along.
 */
export function SourceCards({ websiteUrl, caps }: { websiteUrl: string | null; caps: KnowledgeCaps }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const upload = useUpload()

  const pageCapOptions = PAGE_CAP_OPTIONS.filter((o) => o <= caps.maxCrawlPages)

  const [crawlUrl, setCrawlUrl] = useState(websiteUrl ?? '')
  const [maxPages, setMaxPages] = useState<number>(() => defaultMaxPages(pageCapOptions, caps.maxCrawlPages))
  const [crawlUrlError, setCrawlUrlError] = useState<string | null>(null)
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [capReached, setCapReached] = useState(false)

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.knowledge.list.queryKey() })
  const capBannerText = `Your plan allows ${caps.maxSources} sources. Delete one to add another.`

  const startCrawl = useMutation(trpc.knowledge.startCrawl.mutationOptions({
    onSuccess: () => { setCrawlUrlError(null); void refresh() },
    onError: (err) => {
      if (errorCode(err) === 'BAD_REQUEST') setCrawlUrlError(errorMessage(err, 'Enter a valid https:// address.'))
      else setCapReached(true)
    },
  }))
  const paste = useMutation(trpc.knowledge.paste.mutationOptions({
    onSuccess: () => { setPasteTitle(''); setPasteText(''); void refresh() },
    onError: () => setCapReached(true),
  }))

  // The effective page cap actually sent: the segmented value once one is offered, otherwise the
  // plan's own fixed cap (PageCapControl's "single fixed cap line" case, where nothing is selectable).
  const effectiveMaxPages = pageCapOptions.length === 0 ? caps.maxCrawlPages : maxPages

  function submitCrawl() {
    setCrawlUrlError(null)
    setCapReached(false)
    startCrawl.mutate({ url: crawlUrl.trim(), maxPages: effectiveMaxPages })
  }
  function submitPaste() {
    setCapReached(false)
    paste.mutate({ title: pasteTitle.trim(), text: pasteText })
  }
  async function handleFiles(files: PickedFile[]) {
    setCapReached(false)
    const outcome = await upload.start(files)
    if (outcome.stoppedBy === 'cap') setCapReached(true)
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
        <PageCapControl value={maxPages} onChange={setMaxPages} maxCrawlPages={caps.maxCrawlPages} />
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
        <Muted>{`${ACCEPTED_TYPES_LABEL} · up to ${UPLOAD_MAX_MB} MB each`}</Muted>
        {upload.pending.map((p) => (
          <Muted key={p.id} testID={`upload-progress-${p.id}`}>
            {`${p.name} — ${UPLOAD_PROGRESS_LABEL[p.progress]}${p.reason ? ` (${UPLOAD_REASON_LABEL[p.reason]})` : ''}`}
          </Muted>
        ))}
      </Card>

      {capReached ? <Banner tone="error" testID="knowledge-cap-error">{capBannerText}</Banner> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  pageCapRow: { flexDirection: 'row', gap: spacing.sm },
  pageCapOption: { flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: radius.pill, paddingVertical: spacing.xs },
})
