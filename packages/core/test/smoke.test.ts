import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.ts'

describe('workspace smoke', () => {
  it('resolves the core package', () => {
    expect(PACKAGE_NAME).toBe('@aesa/core')
  })
})
