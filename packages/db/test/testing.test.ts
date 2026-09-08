import { describe, expect, it } from 'vitest'
import { testDatabaseUrl } from '../src/testing.ts'

describe('testDatabaseUrl', () => {
  it('swaps the database name', () => {
    expect(testDatabaseUrl('postgres://aesa:aesa@localhost:5434/aesa_dev', 'aesa_test_1'))
      .toBe('postgres://aesa:aesa@localhost:5434/aesa_test_1')
  })

  it('preserves a query string (a regex on the path drops it)', () => {
    expect(testDatabaseUrl('postgres://aesa:aesa@localhost:5434/aesa_dev?sslmode=disable', 'aesa_test_2'))
      .toBe('postgres://aesa:aesa@localhost:5434/aesa_test_2?sslmode=disable')
  })
})
