import { TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import { describe, expect, it } from 'vitest'
import { mapAuthError } from '../src/trpc/auth-errors.ts'

describe('mapAuthError', () => {
  it.each([
    ['BAD_REQUEST', 'BAD_REQUEST'],
    ['UNAUTHORIZED', 'UNAUTHORIZED'],
    ['FORBIDDEN', 'FORBIDDEN'],
    ['NOT_FOUND', 'NOT_FOUND'],
    ['TOO_MANY_REQUESTS', 'TOO_MANY_REQUESTS'],
  ] as const)('APIError %s maps to TRPCError %s and keeps body.message', (status, code) => {
    const err = APIError.from(status, { code: 'SOME_CODE', message: 'the real auth message' })
    const mapped = mapAuthError(err, 'fallback message')
    expect(mapped).toBeInstanceOf(TRPCError)
    expect(mapped.code).toBe(code)
    expect(mapped.message).toBe('the real auth message')
  })

  it('an APIError status outside the mapped table (e.g. CONFLICT) becomes a masked INTERNAL_SERVER_ERROR', () => {
    const err = APIError.from('CONFLICT', { code: 'SOME_CODE', message: 'do not leak this' })
    const mapped = mapAuthError(err, 'fallback message')
    expect(mapped.code).toBe('INTERNAL_SERVER_ERROR')
    expect(mapped.message).toBe('fallback message')
  })

  it('a mapped 4xx APIError with no body.message falls back to the fallback message', () => {
    const err = APIError.fromStatus('FORBIDDEN')
    const mapped = mapAuthError(err, 'fallback message')
    expect(mapped.code).toBe('FORBIDDEN')
    expect(mapped.message).toBe('fallback message')
  })

  it('a non-APIError becomes a masked INTERNAL_SERVER_ERROR carrying the original as cause', () => {
    const original = new Error('boom')
    const mapped = mapAuthError(original, 'fallback message')
    expect(mapped.code).toBe('INTERNAL_SERVER_ERROR')
    expect(mapped.message).toBe('fallback message')
    expect(mapped.cause).toBe(original)
  })
})
