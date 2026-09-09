/**
 * Microsoft Graph OAuth: 3-legged PKCE authorization-code flow against the `common` tenant (spec
 * §Mailbox providers -> Microsoft 365). No doge-buddy reference exists for Graph at all — this
 * file is new code, structurally mirroring `../gmail/oauth.ts` (same four `MailboxProvider` legs,
 * same `readOAuthError`/`postForm` shape — Microsoft's token-error body is `{error,
 * error_description}`, identical to Google's) but with Microsoft-specific endpoints/scopes and the
 * one behavioral divergence the brief calls out: Microsoft ROTATES the refresh token on every
 * refresh (Google does not echo one at all on an ordinary refresh grant).
 */
import { MailApiError, ProviderAuthError } from '../../errors.ts'
import type { TokenSet } from '../../types.ts'

const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const ME_URL = 'https://graph.microsoft.com/v1.0/me'

/** Least privilege the send/threading flow needs (spec): `offline_access` for a refresh token,
 * `User.Read` for the profile lookup in `exchangeCode`, `Mail.ReadWrite` (delta sync — Graph has no
 * read-only-mail scope granular enough to still allow `createReply`) and `Mail.Send`. */
const SCOPES = 'offline_access User.Read Mail.ReadWrite Mail.Send'

export function graphAuthorizationUrl(p: {
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
  // Ensures the authorization code always comes back as a query param, never a fragment — the v2
  // endpoint's default response_mode for response_type=code IS query, but stating it explicitly
  // means a future scope/flow change here can't silently switch it.
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', SCOPES)
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

async function postForm(url: string, params: Record<string, string>, fetchFn: typeof fetch, signal?: AbortSignal): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    ...(signal ? { signal } : {}),
  })
}

interface GraphMeResponse {
  id: string
  mail?: string | null
  userPrincipalName?: string
}

export async function graphExchangeCode(
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
      scope: SCOPES,
    },
    fetchFn,
  )

  if (!res.ok) {
    const body = await readOAuthError(res)
    if (body.error === 'invalid_grant') {
      throw new ProviderAuthError(body.error_description ?? 'Microsoft rejected the authorization code')
    }
    throw new MailApiError(body.error_description ?? `Microsoft token exchange failed (${res.status})`, res.status, body.error)
  }

  const data = (await res.json()) as TokenResponse
  if (!data.refresh_token) {
    throw new ProviderAuthError('Microsoft did not return a refresh token (missing offline_access scope?)')
  }

  const meRes = await fetchFn(ME_URL, { headers: { Authorization: `Bearer ${data.access_token}` } })
  if (!meRes.ok) {
    throw new MailApiError(`Microsoft profile fetch failed (${meRes.status})`, meRes.status)
  }
  const me = (await meRes.json()) as GraphMeResponse

  return {
    tokens: {
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
    },
    emailAddress: (me.mail ?? me.userPrincipalName ?? '').toLowerCase(),
    providerAccountId: me.id,
  }
}

export async function graphRefresh(
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
      scope: SCOPES,
    },
    fetchFn,
    p.signal,
  )

  if (!res.ok) {
    const body = await readOAuthError(res)
    // invalid_grant is Microsoft's terminal signal too (revoked/expired/consent withdrawn) —
    // reauth_required, not worth retrying.
    if (body.error === 'invalid_grant') {
      throw new ProviderAuthError(body.error_description ?? 'Microsoft refresh token was rejected')
    }
    throw new MailApiError(body.error_description ?? `Microsoft token refresh failed (${res.status})`, res.status, body.error)
  }

  const data = (await res.json()) as TokenResponse
  return {
    // Microsoft ROTATES the refresh token on every refresh grant and always includes the new one
    // in the response — the `??` fallback exists only to guard a hypothetical missing value, the
    // same defensive shape as the Gmail adapter's `refresh` (credentials.ts refuses an empty
    // refresh token either way, so this layer never hands back `undefined`).
    refreshToken: data.refresh_token ?? p.refreshToken,
    accessToken: data.access_token,
    accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
  }
}

/**
 * Microsoft has no token-revocation endpoint for the authorization-code + refresh-token flow used
 * here (unlike Google's `/revoke`) — there is nothing to call. Disconnecting a mailbox still
 * removes the stored refresh token and cancels the Graph `/subscriptions` push registration
 * (`credentials.ts` / the disconnect flow); that removal, not a provider-side call, is what
 * actually revokes this product's access, so this is a documented no-op rather than a stub that
 * silently does nothing for an unclear reason.
 */
export async function graphRevoke(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<void> {
  void p
}
