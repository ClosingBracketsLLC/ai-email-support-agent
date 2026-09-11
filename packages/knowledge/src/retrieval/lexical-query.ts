/**
 * The question → `tsquery` translation the full-text leg runs on.
 *
 * `websearch_to_tsquery('simple', …)` cannot answer a support question: it ANDs every token it is
 * given, and the `simple` configuration strips no stop words, so
 * "How long do I have to return an item?" becomes
 * `'how' & 'long' & 'do' & 'i' & 'have' & 'to' & 'return' & 'an' & 'item'` — a query no chunk on
 * earth matches. Measured over the phase's golden set, that leg answered 0 of 20 questions, which
 * would make a Voyage outage mean NO grounding rather than weaker grounding (spec §Launch risks).
 *
 * So the leg queries a RELAXED tsquery instead, built here rather than in SQL: the question's
 * content words, OR-ed, each as a prefix match. Prefix matching is what stands in for stemming —
 * the stored `tsv` is `to_tsvector('simple', content)`, which does not stem, so `return:*` is what
 * reaches "returns". The stored column is unchanged; only the query side relaxes.
 *
 * Recall over precision is deliberate: `ts_rank_cd` still orders the matches, the retriever caps a
 * lexical-only score at 0.5 so it can never outrank a vector cosine, and fusion only ever adds a
 * list — a loose lexical leg costs ranking, a strict one costs the whole leg.
 */

/**
 * Function words that carry no retrieval signal and would match nearly every chunk. Tokens shorter
 * than three characters are dropped by length before this list is consulted, so it only needs the
 * three-letter-and-longer ones.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
  'can', 'could', 'will', 'would', 'should', 'does', 'did', 'have', 'has', 'had', 'are', 'was',
  'were', 'been', 'being', 'this', 'that', 'these', 'those', 'there', 'their', 'them', 'they',
  'from', 'into', 'onto', 'about', 'after', 'before', 'over', 'under', 'than', 'then', 'also',
  'just', 'only', 'not', 'but', 'any', 'all', 'some', 'more', 'most', 'much', 'many', 'our', 'out',
  'off', 'per', 'via',
])

const MIN_TOKEN_LENGTH = 3

/**
 * `null` when the question has no content word left — the caller skips the leg entirely rather
 * than sending Postgres an empty `to_tsquery`.
 *
 * The output is safe to bind into `to_tsquery('simple', $1)`: every token is stripped to letters
 * and digits, so no tsquery operator, quote or parenthesis can survive from the customer's text.
 */
export function relaxedTsQuery(question: string): string | null {
  const tokens = question.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const terms: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.length < MIN_TOKEN_LENGTH || STOP_WORDS.has(token)) continue
    // Belt and braces: the split above already yields letters and digits only, but the result of
    // this function is interpolated by Postgres into a tsquery, so nothing else may leave here.
    const term = token.replace(/[^\p{L}\p{N}]/gu, '')
    if (term.length < MIN_TOKEN_LENGTH || seen.has(term)) continue
    seen.add(term)
    terms.push(`${term}:*`)
  }
  return terms.length === 0 ? null : terms.join(' | ')
}
