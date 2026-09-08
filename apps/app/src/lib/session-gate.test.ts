import { hrefFor, resolveGate } from './session-gate'

describe('resolveGate', () => {
  it('loads until the session is known, then sends anonymous users to sign-in', () => {
    expect(resolveGate({ session: undefined, organizations: undefined, workspace: undefined })).toEqual({ kind: 'loading' })
    expect(resolveGate({ session: null, organizations: undefined, workspace: undefined })).toEqual({ kind: 'sign-in' })
  })
  it('without an active organization: activates the first membership, otherwise creates a workspace', () => {
    const session = { activeOrganizationId: null }
    expect(resolveGate({ session, organizations: undefined, workspace: undefined })).toEqual({ kind: 'loading' })
    expect(resolveGate({ session, organizations: [{ id: 'o1' }, { id: 'o2' }], workspace: undefined })).toEqual({ kind: 'activate', orgId: 'o1' })
    expect(resolveGate({ session, organizations: [], workspace: undefined })).toEqual({ kind: 'create-workspace' })
  })
  it('with an active organization: missing workspace → create, unfinished onboarding → that step, else the app', () => {
    const session = { activeOrganizationId: 'o1' }
    expect(resolveGate({ session, organizations: [], workspace: undefined })).toEqual({ kind: 'loading' })
    expect(resolveGate({ session, organizations: [], workspace: 'missing' })).toEqual({ kind: 'create-workspace' })
    expect(resolveGate({ session, organizations: [], workspace: { onboardingStep: 'knowledge' } })).toEqual({ kind: 'onboarding', step: 'knowledge' })
    expect(resolveGate({ session, organizations: [], workspace: { onboardingStep: 'done' } })).toEqual({ kind: 'app' })
  })
  it('maps targets to routes', () => {
    expect(hrefFor({ kind: 'sign-in' })).toBe('/sign-in')
    expect(hrefFor({ kind: 'create-workspace' })).toBe('/create-workspace')
    expect(hrefFor({ kind: 'onboarding', step: 'mailbox' })).toBe('/onboarding/mailbox')
    expect(hrefFor({ kind: 'app' })).toBe('/inbox')
    expect(hrefFor({ kind: 'loading' })).toBeNull()
    expect(hrefFor({ kind: 'activate', orgId: 'o1' })).toBeNull()
    expect(hrefFor({ kind: 'error', message: 'nope', retry: () => {} })).toBeNull()
  })
})
