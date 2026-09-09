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

test('sign up with an email code, create a workspace, finish the profile step, resume at the mailbox step, reach the inbox', async ({ page, request }) => {
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

  await page.getByTestId('continue').click()
  await expect(page.getByTestId('onboarding-knowledge')).toBeVisible()
  await page.getByTestId('skip').click()
  await expect(page.getByTestId('onboarding-go-live')).toBeVisible()
  await page.getByTestId('finish').click()
  await expect(page.getByTestId('inbox')).toBeVisible()

  // Returning user: sign out, sign in again, straight to the inbox.
  await page.getByTestId('tab-settings').or(page.getByTestId('nav-settings')).first().click()
  await expect(page.getByTestId('settings')).toBeVisible()
  await page.getByTestId('sign-out').click()
  await expect(page.getByTestId('sign-in')).toBeVisible()
  await page.getByTestId('email').fill(email)
  await page.getByTestId('send-code').click()
  await page.getByTestId('otp').fill(await latestOtp(request, email))
  await page.getByTestId('verify-code').click()
  await expect(page.getByTestId('inbox')).toBeVisible()
})
