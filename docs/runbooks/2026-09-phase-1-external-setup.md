# Phase 1 external setup (Robert)

Everything Phase 1 needs that CI cannot do. Values in angle brackets are yours to fill in. `APP_BASE_URL` is the
api's public origin (e.g. `https://api.<product>.com`), `APP_WEB_ORIGIN` the web app's (e.g. `https://app.<product>.com`).

## 1. Better Auth secret and production env (api)

- `BETTER_AUTH_SECRET`: `openssl rand -base64 48`.
- `APP_BASE_URL`, `APP_WEB_ORIGIN`, `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `MAIL_FROM` (see §4), `NODE_ENV=production`.
- Add extra web origins (staging) to `AUTH_TRUSTED_ORIGINS` (comma-separated). Every `http(s)` entry there is a
  real web origin, not only a Better Auth trusted one: CORS and the `/trpc` CSRF guard accept it too, so a
  documented staging web origin actually works end to end. If the web app and the api are on different
  registrable domains, set `AUTH_CROSS_SITE_COOKIES=true` (cookies become `SameSite=None; Secure`).
- `TRUST_PROXY`: prefer the CIDR/IP list of the proxy that sits directly in front of the api (e.g.
  `10.0.0.0/8` for a VPC load balancer) over the bare `true`. Better Auth's `getIPFromHeader` returns null
  for a multi-value `x-forwarded-for` when `trustedProxies` is unset, so an *appending* proxy (most load
  balancers) would otherwise collapse every client into its rate limiter's single fallback bucket. Use
  `TRUST_PROXY=true` only behind a proxy that *replaces* the header rather than appending to it.
  `AUTH_RATE_LIMIT=on` (the default) requires one of these to be set in production — `loadConfig` refuses to
  start otherwise.

## 2. Google sign-in (consent screen + brand verification)

1. Google Cloud console → APIs & Services → OAuth consent screen: External; app name `<product>`; support email;
   app domain `<APP_WEB_ORIGIN>`; privacy `<APP_WEB_ORIGIN>/privacy`; terms `<APP_WEB_ORIGIN>/terms`.
2. Scopes: only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (non-sensitive; no verification
   audit for sign-in alone — Gmail scopes arrive in Phase 2 and start CASA).
3. Credentials → OAuth client (Web application): authorised JavaScript origin `<APP_WEB_ORIGIN>`, authorised
   redirect URI `<APP_BASE_URL>/api/auth/callback/google`. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the api.
4. Submit brand verification (logo + homepage + privacy/terms) now; it takes days and Phase 2 needs it.

## 3. Microsoft sign-in (Entra app registration + publisher verification)

1. Entra admin center → App registrations → New: name `<product>`; supported account types: *Accounts in any
   organizational directory and personal Microsoft accounts*; redirect URI (Web) `<APP_BASE_URL>/api/auth/callback/microsoft`.
2. Certificates & secrets → new client secret (24 months). Set `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`.
3. API permissions: only `openid`, `profile`, `email` (delegated). No `User.Read`: the app reads the id token.
4. Branding & properties → Publisher domain `<APP_WEB_ORIGIN host>` and start **publisher verification** with the
   Partner Center (MPN) account; unverified publishers show a warning on the consent prompt and Phase 2's mail
   scopes need it done.

## 4. Resend (platform mail only)

1. Resend → Domains → add `mail.<product>.com`; add the DKIM CNAMEs, the SPF TXT and a DMARC record
   (`v=DMARC1; p=quarantine; rua=mailto:dmarc@<product>.com`) at the DNS host; wait for *Verified*.
2. API key with sending permission → `RESEND_API_KEY`; `MAIL_FROM="<product> <no-reply@mail.<product>.com>"`.
3. Send yourself a code from the production api and check headers show SPF, DKIM and DMARC `pass`.

## 5. EAS: project, dev builds, web hosting

    cd apps/app
    eas login
    eas init                                   # writes extra.eas.projectId into app.json — commit it (push tokens need it)
    eas build --profile development --platform ios      # dev client for a real iPhone (push needs a device)
    eas build --profile development --platform android
    # web: export with the production api URL, then deploy the server output
    EXPO_PUBLIC_API_URL=https://api.<product>.com pnpm export:web
    eas deploy --prod

Set the three `EXPO_PUBLIC_API_URL` values in `eas.json` (dev = this machine's LAN IP, preview = staging, production).
Point `app.<product>.com` at the EAS Hosting deployment and set `APP_WEB_ORIGIN` accordingly on the api.

## 6. Phase 1 verification walk (spec)

- Sign up on iOS (dev build), Android (dev build) and web with the same email; the onboarding step you left on one
  device is the one you land on with the other.
- `SELECT actor, action FROM audit_log WHERE org_id = '<org>' ORDER BY id` shows `user:<uuid>` rows for
  `workspace.create`, `workspace.profile.update`, `workspace.onboarding.advance`, `team.invite`, `team.join`,
  `device.register`.
- Settings → Notifications on a device: enable → the row appears; send a test push with Expo's push tool to the
  token in `notification_devices` (the worker's dispatcher arrives in Phase 2).
- CI green on the branch: typecheck, lint, tests, drift check, web export, Playwright smoke.
