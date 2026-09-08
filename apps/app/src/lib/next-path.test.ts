import { clearNextPath, peekNextPath, setNextPath } from './next-path'

describe('next-path', () => {
  afterEach(() => clearNextPath())

  it('remembers a path across repeated reads, and clear removes it', () => {
    setNextPath('/invite/abc')
    expect(peekNextPath()).toBe('/invite/abc')
    expect(peekNextPath()).toBe('/invite/abc')
    clearNextPath()
    expect(peekNextPath()).toBeNull()
  })

  it('ignores anything that is not a same-origin absolute path', () => {
    setNextPath('not-a-path')
    expect(peekNextPath()).toBeNull()

    setNextPath('//evil.example.com')
    expect(peekNextPath()).toBeNull()

    setNextPath(undefined)
    expect(peekNextPath()).toBeNull()

    setNextPath(null)
    expect(peekNextPath()).toBeNull()
  })

  it('a later valid call overwrites the pending path', () => {
    setNextPath('/invite/first')
    setNextPath('/invite/second')
    expect(peekNextPath()).toBe('/invite/second')
  })
})
