import { z } from 'zod'

export const INBOX_SECTIONS = ['to_review', 'auto_sending', 'recent'] as const
export type InboxSection = (typeof INBOX_SECTIONS)[number]

export const InboxListInput = z.object({
  section: z.enum(INBOX_SECTIONS),
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(50).default(20),
})
export type InboxListInput = z.infer<typeof InboxListInput>

export const TicketIdInput = z.object({ ticketId: z.uuid() })
export type TicketIdInput = z.infer<typeof TicketIdInput>

export const ResolveTicketInput = z.object({ ticketId: z.uuid() })
export type ResolveTicketInput = z.infer<typeof ResolveTicketInput>
