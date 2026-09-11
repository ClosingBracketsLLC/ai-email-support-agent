/** `relaxedTsQuery` is pure — no database, no embedder. It is the whole reason the tsvector leg can
 * answer a support question, so its edges are pinned here rather than only through retrieval. */
import { describe, expect, it } from 'vitest'
import { relaxedTsQuery } from '../src/index.ts'

describe('relaxedTsQuery', () => {
  it('keeps the content words in order, drops stop words and short tokens, and prefix-matches each', () => {
    // 'how' and 'have' are stop words; 'do', 'i', 'to' and 'an' are shorter than three characters.
    expect(relaxedTsQuery('How long do I have to return an item?')).toBe('long:* | return:* | item:*')
  })

  it('returns null when nothing but stop words and short tokens survive', () => {
    expect(relaxedTsQuery('what can you do about this?')).toBeNull()
    expect(relaxedTsQuery('')).toBeNull()
    expect(relaxedTsQuery('?! ...')).toBeNull()
  })

  it('cleans punctuation, case and Unicode forms out of every token', () => {
    // Nothing a customer types can survive as a tsquery operator, quote or parenthesis.
    expect(relaxedTsQuery("Where's my T-shirt (size XXL)?")).toBe('shirt:* | size:* | xxl:*')
    expect(relaxedTsQuery("invoice' | pg_sleep(10) --")).toBe('invoice:* | sleep:*')   // the operator, quote, parens and digits are gone
    expect(relaxedTsQuery('CAFÉ café')).toBe('café:*')   // lowercased and deduped, accents kept
    // Combining marks stay INSIDE the term (`\p{M}`): without it the Devanagari "नमस्ते" split
    // into "नमस" + "त", the second below the 3-character floor — a Hindi question reached
    // Postgres as a fragment that matches nothing.
    expect(relaxedTsQuery('नमस्ते')).toBe('नमस्ते:*')
  })

  it('caps the term list at 24, keeping the first in order of appearance', () => {
    // The `text` fallback feeds up to 1,000 characters of the customer's own email in; every `:*`
    // expands over every tenant's lexemes in the GIN index before `org_id` narrows anything.
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    const capped = relaxedTsQuery(long)!
    expect(capped.split(' | ')).toHaveLength(24)
    expect(capped.split(' | ')).toEqual(Array.from({ length: 24 }, (_, i) => `word${i}:*`))

    const short = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
    expect(relaxedTsQuery(short)!.split(' | ')).toHaveLength(10)   // a 10-token question is untouched
  })

  it('dedupes while preserving first-seen order', () => {
    expect(relaxedTsQuery('refund my refund for the refund')).toBe('refund:*')
    expect(relaxedTsQuery('shipping refund shipping')).toBe('shipping:* | refund:*')
  })
})
