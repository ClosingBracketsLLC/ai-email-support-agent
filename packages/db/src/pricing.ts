import { desc, lte, sql } from 'drizzle-orm'
import type { ModelPricing } from '@aesa/llm'
import type { Db } from './client.ts'
import { modelPricing } from './schema/index.ts'

/** The platform's price table as `@aesa/llm`'s `ModelPricing[]`: the newest row per id whose
 * `effective_from` has passed, most specific pattern first (`findPricing` takes the FIRST match, and
 * `^gpt-5(-|$)` would otherwise swallow `gpt-5-mini`). Empty table → `[]`, and the caller falls back
 * to `PRICING_SEED`. Type-only import from `@aesa/llm`, like `metering.ts`. */
export async function loadModelPricing(db: Db): Promise<ModelPricing[]> {
  const rows = await db.select().from(modelPricing).where(lte(modelPricing.effectiveFrom, sql`now()`))
    .orderBy(desc(sql`length(${modelPricing.pattern})`), desc(modelPricing.effectiveFrom))
  const seen = new Set<string>()
  const out: ModelPricing[] = []
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, pattern: new RegExp(r.pattern), inputPerMtok: r.inputPerMtok, outputPerMtok: r.outputPerMtok, cacheReadPerMtok: r.cacheReadPerMtok, cacheWrite5mPerMtok: r.cacheWrite5mPerMtok, cacheWrite1hPerMtok: r.cacheWrite1hPerMtok })
  }
  return out
}
