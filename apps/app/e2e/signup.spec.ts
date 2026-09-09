import { expect, test, type APIRequestContext } from '@playwright/test'

const API = process.env.E2E_API_URL ?? 'http://localhost:3001'

async function latestOtp(request: APIRequestContext, email: string): Promise<string> {
  const url = `${API}/__dev/mail/latest?to=${encodeURIComponent(email)}`
  await expect.poll(async () => (await request.get(url)).status(), { timeout: 15_000 }).toBe(200)
  const mail = (await (await request.get(url)).json()) as { text: string }
  const otp = mail.text.match(/\b(\d{6})\b/)?.[1]
  if (!otp) throw new Error('no code in the devsink mail')
  return otp
}

/**
 * Controller ruling (Task 20 review): the onboarding mailbox step gates its Continue button on
 * "≥ 1 connection is 'connected' AND ≥ 1 agent exists" (spec-normative — see MailboxStep's
 * `canContinue`). This suite's own `playwright.config.ts` `webServer` config for the api sets no
 * `GMAIL_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_ID`, so under THIS CI configuration `/meta.mail` is
 * `{gmail:false, microsoft:false}`: zero provider buttons render, and there is no way to complete a
 * real OAuth round trip (or fake `claimConnection`'s outcome) without a stub OAuth provider reachable
 * by this real HTTP process plus a headless browser — out of scope for a signup smoke test. So this
 * test now ENDS at the mailbox step: it still proves signup, workspace creation, the profile step,
 * and that the mailbox step is reached and resumable (reload, stale URL), then asserts the
 * providerless presentation (the neutral "no providers configured" line, no connect buttons) and that
 * Continue is disabled — it no longer walks through knowledge/go-live/inbox or the returning-user
 * sign-in-again path, since finishing onboarding is unreachable under this config.
 */
test('sign up with an email code, create a workspace, finish the profile step, and reach the gated mailbox step', async ({ page, request }) => {
  const email = `pw-${Date.now()}@example.com`
  await page.goto('/')
  await expect(page.getByTestId('sign-in')).toBeVisible()
  await page.getByTestId('email').fill(email)
  await page.getByTestId('send-code').click()
  await expect(page.getByTestId('verify')).toBeVisible()
  await page.getByTestId('otp').fill(await latestOtp(request, email))
  await page.getByTestId('verify-code').click()

  await expect(page.getByTestId('create-workspace')).toBeVisible()
  // Better Auth may or may not leave a brand-new OTP user with an empty `name`; the create-workspace
  // screen only renders `your-name` when the session user has no name yet.
  const name = page.getByTestId('your-name')
  if (await name.count()) await name.fill('Playwright Owner')
  await page.getByTestId('business-name').fill('Playwright Socks')
  await page.getByTestId('create').click()

  await expect(page.getByTestId('onboarding-profile')).toBeVisible()
  await page.getByTestId('website').fill('https://www.playwright-socks.example')
  await expect(page.getByTestId('guardrail-summary')).toContainText('playwright-socks.example')
  await page.getByTestId('save-profile').click()
  await expect(page.getByTestId('onboarding-mailbox')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('onboarding-mailbox')).toBeVisible()          // the server owns the step
  await page.goto('/onboarding/profile')
  await expect(page.getByTestId('onboarding-mailbox')).toBeVisible()          // a stale URL is corrected

  // Providerless config: the connect card shows the neutral "no providers configured" line instead of
  // either provider's button, and Continue stays disabled (Task 20's onboarding gate). ("Connect a
  // mailbox" appears twice — the step's own title and the card's heading — so testID, not text, is
  // what's asserted here.)
  await expect(page.getByTestId('connect-card')).toBeVisible()
  await expect(page.getByTestId('no-mail-providers')).toContainText('No mailbox providers are configured')
  await expect(page.getByTestId('connect-gmail')).toHaveCount(0)
  await expect(page.getByTestId('connect-microsoft')).toHaveCount(0)
  await expect(page.getByTestId('continue')).toBeDisabled()
})
