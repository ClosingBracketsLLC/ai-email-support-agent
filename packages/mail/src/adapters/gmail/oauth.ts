/**
 * Gmail OAuth: 3-legged PKCE authorization-code flow (spec §Mailbox providers → Gmail).
 * `authorizationUrl`/`exchangeCode`/`refresh`/`revoke` are the four legs `MailboxProvider` declares;
 * none of this exists in doge-buddy (it used a service-account + domain-wide-delegation JWT flow —
 * `auth.ts` in the reference — which per-user OAuth replaces entirely), so this file is new, not
 * ported.
 */
import { MailApiError, ProviderAuthError } from '../../errors.ts'
import type { TokenSet } from '../../types.ts'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'

/** Least privilege (spec): read-only + send + identity, never `gmail.modify` — this product never
 * mutates the mailbox (no labels, no trash). */
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email'

export function gmailAuthorizationUrl(p: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  loginHint?: string
}): string {
  const url = new URL(AUTH_URL)
  url.searchParams.set('client_id', p.clientId)
  url.searchParams.set('redirect_uri', p.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  // offline + consent: without both, a returning user who already granted consent gets no
  // refresh_token on a second authorization (Google only issues one on the FIRST consent grant
  // unless prompt=consent forces the consent screen again).
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('code_challenge', p.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', p.state)
  if (p.loginHint) url.searchParams.set('login_hint', p.loginHint)
  return url.toString()
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token?: string
  token_type?: string
  scope?: string
}

interface OAuthErrorBody {
  error?: string
  error_description?: string
}

async function readOAuthError(res: Response): Promise<OAuthErrorBody> {
  try {
    return (await res.json()) as OAuthErrorBody
  } catch {
    return {}
  }
}

/**
 * Decodes (WITHOUT verifying) the `sub` claim off an id_token's payload segment. No signature
 * check is needed: the token arrived directly from `oauth2.googleapis.com` over TLS in this same
 * response, not from an untrusted third party — verification is Google's own job at issuance time.
 */
function decodeIdTokenSub(idToken: string): string {
  const segments = idToken.split('.')
  const payloadSegment = segments[1]
  if (segments.length < 2 || !payloadSegment) {
    throw new ProviderAuthError('Gmail id_token was malformed')
  }
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'))
  } catch {
    throw new ProviderAuthError('Gmail id_token payload was not valid JSON')
  }
  const sub = (payload as { sub?: unknown } | null)?.sub
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new ProviderAuthError('Gmail id_token had no sub claim')
  }
  return sub
}

async function postForm(url: string, params: Record<string, string>, fetchFn: typeof fetch, signal?: AbortSignal): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    ...(signal ? { signal } : {}),
  })
}

export async function gmailExchangeCode(
  p: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string },
  fetchFn: typeof fetch,
): Promise<{ tokens: TokenSet; emailAddress: string; providerAccountId: string }> {
  const res = await postForm(
    TOKEN_URL,
    {
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      code: p.code,
      code_verifier: p.codeVerifier,
      grant_type: 'authorization_code',
    },
    fetchFn,
  )

  if (!res.ok) {
    const body = await readOAuthError(res)
    if (body.error === 'invalid_grant') {
      throw new ProviderAuthError(body.error_description ?? 'Gmail rejected the authorization code')
    }
    throw new MailApiError(body.error_description ?? `Gmail token exchange failed (${res.status})`, res.status, body.error)
  }

  const data = (await res.json()) as TokenResponse
  if (!data.refresh_token) {
    throw new ProviderAuthError('Gmail did not return a refresh token (missing access_type=offline / prompt=consent?)')
  }
  if (!data.id_token) {
    throw new ProviderAuthError('Gmail did not return an id_token')
  }
  const providerAccountId = decodeIdTokenSub(data.id_token)

  const profileRes = await fetchFn(PROFILE_URL, { headers: { Authorization: `Bearer ${data.access_token}` } })
  if (!profileRes.ok) {
    throw new MailApiError(`Gmail profile fetch failed (${profileRes.status})`, profileRes.status)
  }
  const profile = (await profileRes.json()) as { emailAddress: string }

  return {
    tokens: {
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
    },
    emailAddress: profile.emailAddress.toLowerCase(),
    providerAccountId,
  }
}

export async function gmailRefresh(
  p: { clientId: string; clientSecret: string; refreshToken: string; signal?: AbortSignal },
  fetchFn: typeof fetch,
): Promise<TokenSet> {
  const res = await postForm(
    TOKEN_URL,
    {
      client_id: p.clientId,
      client_secret: p.clientSecret,
      refresh_token: p.refreshToken,
      grant_type: 'refresh_token',
    },
    fetchFn,
    p.signal,
  )

  if (!res.ok) {
    const body = await readOAuthError(res)
    // invalid_grant is Google's terminal signal: the refresh token was revoked, expired, or the
    // consent was withdrawn — reauth_required, not a transient failure worth retrying.
    if (body.error === 'invalid_grant') {
      throw new ProviderAuthError(body.error_description ?? 'Gmail refresh token was rejected')
    }
    throw new MailApiError(body.error_description ?? `Gmail token refresh failed (${res.status})`, res.status, body.error)
  }

  const data = (await res.json()) as TokenResponse
  return {
    // Google's refresh grant does NOT echo a refresh_token — the caller (credentials.ts) refuses
    // to overwrite the stored token with an empty one, so this layer must hand back the token it
    // was given rather than `undefined`.
    refreshToken: data.refresh_token ?? p.refreshToken,
    accessToken: data.access_token,
    accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
  }
}

export async function gmailRevoke(p: { clientId: string; clientSecret: string; refreshToken: string }, fetchFn: typeof fetch): Promise<void> {
  const res = await postForm(REVOKE_URL, { token: p.refreshToken }, fetchFn)
  // Google returns 400 invalid_token when the token is already revoked/expired — that is the
  // outcome we wanted anyway, so treat it as success rather than surfacing an error.
  if (!res.ok && res.status !== 400) {
    const body = await readOAuthError(res)
    throw new MailApiError(body.error_description ?? `Gmail token revoke failed (${res.status})`, res.status, body.error)
  }
}
