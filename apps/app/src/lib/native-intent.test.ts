import { redirectSystemPath } from '../app/+native-intent'

// Lives OUTSIDE `src/app` on purpose: a file under the app directory is a route to Expo Router.
describe('+native-intent redirectSystemPath (ruling R34)', () => {
  test("the iOS share relaunch (aesa://dataUrl=aesaShareKey) is sent to '/', where the shell and useShareIntentRouting mount", () => {
    expect(redirectSystemPath({ path: 'aesa://dataUrl=aesaShareKey', initial: true })).toBe('/')
    expect(redirectSystemPath({ path: 'aesa://dataUrl=aesaShareKey', initial: false })).toBe('/')
    // Expo Router may hand over the extracted path rather than the full url.
    expect(redirectSystemPath({ path: 'dataUrl=aesaShareKey', initial: true })).toBe('/')
    expect(redirectSystemPath({ path: '/dataUrl=aesaShareKey', initial: true })).toBe('/')
  })

  test('every other url is passed through UNCHANGED (a falsy return would drop it, not route it): invitations, review links, the inbox', () => {
    expect(redirectSystemPath({ path: 'aesa://invite/abc', initial: true })).toBe('aesa://invite/abc')
    expect(redirectSystemPath({ path: 'https://app.example.com/a/draft-1?t=tok', initial: false })).toBe(
      'https://app.example.com/a/draft-1?t=tok',
    )
    expect(redirectSystemPath({ path: '/inbox', initial: false })).toBe('/inbox')
    expect(redirectSystemPath({ path: '', initial: true })).toBe('')
  })

  test('never throws on a shape the router should not produce', () => {
    expect(redirectSystemPath({ path: undefined as unknown as string, initial: true })).toBeNull()
  })
})
