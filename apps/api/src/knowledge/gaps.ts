/**
 * `knowledge.gaps` — a rolling read of what the agent could not answer over the last 30 days: how
 * many drafts were made, how many shipped with no chunk behind them at all (`cited_chunk_ids` is
 * empty), and which unresolved questions repeat most. The grouping pass needs `unnest`, which
 * drizzle's query builder has no shape for, so it is raw SQL — every identifier below is a literal
 * table/column name and every value is a bound parameter, the same discipline
 * `@aesa/knowledge`'s `retrieval/sql.ts` uses for its own hand-written queries.
 */
import { and, count, eq, gte, sql } from 'drizzle-orm'
import { drafts, type OrgTx } from '@aesa/db'

export const GAPS_WINDOW_DAYS = 30
const TOP_QUESTIONS = 20

export interface GapQuestion {
  /** The most recent occurrence's own text (original casing); rows are grouped by `lower(trim(q))`. */
  text: string
  count: number
  lastTicketId: string
  lastAt: Date
}

export interface GapsView {
  windowDays: 30
  drafts: number
  uncited: number
  questions: GapQuestion[]
}

interface QuestionRow {
  text: string
  cnt: number | string
  last_ticket_id: string
  last_at: Date
  [key: string]: unknown
}

export async function computeGaps(tx: OrgTx, orgId: string, now: Date): Promise<GapsView> {
  const since = new Date(now.getTime() - GAPS_WINDOW_DAYS * 86_400_000)

  const [draftsRow] = await tx.select({ value: count() })
    .from(drafts)
    .where(and(eq(drafts.orgId, orgId), gte(drafts.createdAt, since)))

  const [uncitedRow] = await tx.select({ value: count() })
    .from(drafts)
    .where(and(eq(drafts.orgId, orgId), gte(drafts.createdAt, since), sql`cardinality(${drafts.citedChunkIds}) = 0`))

  // One row per DISTINCT normalized question, its count, and the most recent occurrence's own
  // (original-case) text and ticket — `array_agg(... ORDER BY created_at DESC)` picks index 1 of
  // both in lockstep, so `text` and `lastTicketId`/`lastAt` always describe the SAME occurrence.
  const { rows } = await tx.execute<QuestionRow>(sql`
    SELECT
      (array_agg(q ORDER BY d.created_at DESC))[1] AS text,
      count(*)::int AS cnt,
      (array_agg(d.ticket_id ORDER BY d.created_at DESC))[1] AS last_ticket_id,
      max(d.created_at) AS last_at
    FROM drafts AS d, unnest(d.unresolved_questions) AS q
    WHERE d.org_id = ${orgId}::uuid AND d.created_at >= ${since}
    GROUP BY lower(trim(q))
    ORDER BY cnt DESC, last_at DESC
    LIMIT ${TOP_QUESTIONS}
  `)

  return {
    windowDays: GAPS_WINDOW_DAYS,
    drafts: draftsRow?.value ?? 0,
    uncited: uncitedRow?.value ?? 0,
    questions: rows.map((r) => ({ text: r.text, count: Number(r.cnt), lastTicketId: r.last_ticket_id, lastAt: new Date(r.last_at) })),
  }
}
