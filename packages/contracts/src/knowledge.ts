import { z } from 'zod'
import { HttpUrl } from './workspace.ts'

export const KNOWLEDGE_SOURCE_KINDS = ['upload', 'paste', 'crawl'] as const
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number]
export const KNOWLEDGE_SOURCE_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const
export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUSES)[number]
export const KNOWLEDGE_UPLOAD_MIMES = [
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/markdown', 'text/plain',
] as const
export type KnowledgeUploadMime = (typeof KNOWLEDGE_UPLOAD_MIMES)[number]
export const KNOWLEDGE_FAILURE_REASONS = [
  'too_large', 'wrong_type', 'parse_failed', 'parse_timeout', 'no_text', 'embed_failed', 'crawl_failed', 'crawl_no_pages', 'cap_reached',
] as const
export type KnowledgeFailureReason = (typeof KNOWLEDGE_FAILURE_REASONS)[number]

export const KNOWLEDGE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const KNOWLEDGE_MAX_PASTE_CHARS = 50_000
export const KNOWLEDGE_CHUNK_MAX_CHARS = 3000
export const KNOWLEDGE_DEFAULT_CRAWL_PAGES = 50

/** A file name for display and for the object key's last segment: no path separators, no control characters. */
const FileName = z.string().trim().min(1).max(200)
  .refine((s) => !/[/\\]/.test(s) && !/\p{Cc}/u.test(s), { message: 'file name must not contain path separators or control characters' })

export const StartUploadInput = z.object({
  fileName: FileName,
  mime: z.enum(KNOWLEDGE_UPLOAD_MIMES),
  byteSize: z.number().int().min(1).max(KNOWLEDGE_MAX_UPLOAD_BYTES),
})
export type StartUploadInput = z.infer<typeof StartUploadInput>
export const CompleteUploadInput = z.object({ sourceId: z.uuid() })
export const PasteInput = z.object({ title: z.string().trim().min(1).max(120), text: z.string().min(1).max(KNOWLEDGE_MAX_PASTE_CHARS) })
export type PasteInput = z.infer<typeof PasteInput>
export const StartCrawlInput = z.object({ url: HttpUrl, maxPages: z.number().int().min(1).max(1000) })
export type StartCrawlInput = z.infer<typeof StartCrawlInput>
export const SourceIdInput = z.object({ sourceId: z.uuid() })
export const ChunkIdInput = z.object({ chunkId: z.uuid() })
