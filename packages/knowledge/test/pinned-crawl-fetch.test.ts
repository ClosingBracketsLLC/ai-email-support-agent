import { PinnedFetchError } from '@aesa/crypto'
import { describe, expect, it } from 'vitest'
import { translatePinnedFetchError } from '../src/index.ts'

// `createPinnedCrawlFetch` (the production `CrawlFetch`) needs a real network call to exercise
// end-to-end, so its `PinnedFetchError` -> `CrawlFetch` result translation is tested here in
// isolation instead: constructing the error directly, no mocking and no real network.
describe('translatePinnedFetchError', () => {
  it('translates body_too_large into a bodyless, zero-status result', () => {
    expect(translatePinnedFetchError(new PinnedFetchError('response body exceeds 2097152 bytes', 'body_too_large'))).toEqual({
      status: 0,
      headers: {},
      body: '',
    })
  })

  it('translates redirect_not_followed by recovering the status from the error message', () => {
    expect(translatePinnedFetchError(new PinnedFetchError('redirects are not followed for outbound URLs (301)', 'redirect_not_followed'))).toEqual({
      status: 301,
      headers: {},
      body: '',
    })
    expect(translatePinnedFetchError(new PinnedFetchError('redirects are not followed for outbound URLs (308)', 'redirect_not_followed'))).toEqual({
      status: 308,
      headers: {},
      body: '',
    })
  })

  it('falls back to a generic 302 if the message somehow carries no status', () => {
    expect(translatePinnedFetchError(new PinnedFetchError('redirects are not followed for outbound URLs', 'redirect_not_followed'))).toEqual({
      status: 302,
      headers: {},
      body: '',
    })
  })

  it('returns null for anything that is not a PinnedFetchError, so the caller re-throws it', () => {
    expect(translatePinnedFetchError(new Error('boom'))).toBeNull()
    expect(translatePinnedFetchError('not even an error')).toBeNull()
  })
})
