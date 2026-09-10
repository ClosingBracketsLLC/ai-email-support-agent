/**
 * The platform-mail templates. The otp/invitation/mailboxClaimed cases moved here verbatim from
 * `apps/api/test/mail.test.ts` when the transport and templates became `@aesa/platform-mail`.
 */
import { describe, expect, it } from 'vitest'
import { digestMail, DIGEST_MAX_ITEMS, invitationMail, mailboxClaimedMail, otpMail, type DigestDraftItem, type DigestEscalationItem } from '../src/templates.ts'

function draft(i: number, overrides: Partial<DigestDraftItem> = {}): DigestDraftItem {
  return {
    subject: `Where is order ${i}?`,
    customer: `customer${i}@x.test`,
    categoryLabel: 'Shipping',
    confidencePct: 80 + i,
    excerpt: `Hi, your order ${i} shipped yesterday.`,
    approveUrl: `https://api.test/a/draft-${i}?t=tok-${i}`,
    openUrl: `https://app.test/ticket/ticket-${i}`,
    ...overrides,
  }
}

function escalation(i: number, overrides: Partial<DigestEscalationItem> = {}): DigestEscalationItem {
  return { subject: `Angry about ${i}`, customer: `angry${i}@x.test`, reason: 'tripwire', openUrl: `https://app.test/ticket/esc-${i}`, ...overrides }
}

describe('templates', () => {
  it('templates carry the code and the invitation link', () => {
    const otp = otpMail('a@x.test', '123456')
    expect(otp.to).toBe('a@x.test'); expect(otp.subject).toContain('123456'); expect(otp.text).toContain('123456'); expect(otp.text).toContain('10 minutes')
    const inv = invitationMail({ to: 'b@x.test', inviterName: 'Robert', orgName: 'Acme', url: 'http://localhost:8081/invite/abc' })
    expect(inv.subject).toContain('Acme'); expect(inv.text).toContain('Robert'); expect(inv.text).toContain('http://localhost:8081/invite/abc'); expect(inv.text).toContain('48 hours')
  })

  it('mailboxClaimedMail names the address, the provider, the claiming user, and the settings link', () => {
    const claimed = mailboxClaimedMail({
      to: 'support@acme.test', emailAddress: 'support@acme.test', provider: 'gmail',
      claimedByEmail: 'owner@acme.test', settingsUrl: 'http://localhost:8081/settings/mailboxes',
    })
    expect(claimed.to).toBe('support@acme.test')
    expect(claimed.subject).toBe('Your mailbox support@acme.test was connected to aesa')
    expect(claimed.text).toContain('gmail')
    expect(claimed.text).toContain('owner@acme.test')
    expect(claimed.text).toContain('http://localhost:8081/settings/mailboxes')
  })
})

describe('digestMail', () => {
  it('renders at most DIGEST_MAX_ITEMS drafts, with an overflow line and every rendered approve/open link', () => {
    const drafts = Array.from({ length: 12 }, (_, i) => draft(i))
    const mail = digestMail({ to: 'owner@acme.test', businessName: 'Acme', drafts, escalations: [], inboxUrl: 'https://app.test/inbox' })

    expect(mail.to).toBe('owner@acme.test')
    expect(mail.subject).toBe('12 drafts waiting for review · Acme')
    expect(mail.text).toContain(`…and ${12 - DIGEST_MAX_ITEMS} more`)
    for (const d of drafts.slice(0, DIGEST_MAX_ITEMS)) {
      expect(mail.text).toContain(`Approve: ${d.approveUrl}`)
      expect(mail.text).toContain(`Open: ${d.openUrl}`)
      expect(mail.text).toContain(d.excerpt)
    }
    for (const d of drafts.slice(DIGEST_MAX_ITEMS)) expect(mail.text).not.toContain(d.approveUrl)
    expect(mail.text).toContain('https://app.test/inbox')
  })

  it('counts `moreDrafts` in the headline and the overflow line without rendering them', () => {
    // The digest job mints one single-use action token per RENDERED draft, so it passes only the
    // renderable slice and reports the remainder here (final-A2 M-2 / fix wave W7).
    const drafts = Array.from({ length: DIGEST_MAX_ITEMS }, (_, i) => draft(i))
    const mail = digestMail({ to: 'owner@acme.test', businessName: 'Acme', drafts, moreDrafts: 7, escalations: [], inboxUrl: 'https://app.test/inbox' })

    expect(mail.subject).toBe(`${DIGEST_MAX_ITEMS + 7} drafts waiting for review · Acme`)
    expect(mail.text).toContain(`${DIGEST_MAX_ITEMS + 7} drafts waiting for review:`)
    expect(mail.text).toContain('…and 7 more')
    expect([...mail.text.matchAll(/^Approve: /gm)]).toHaveLength(DIGEST_MAX_ITEMS)
  })

  it('singularises the subject for one draft and renders subject · customer · category · confidence', () => {
    const mail = digestMail({ to: 'owner@acme.test', businessName: 'Acme', drafts: [draft(1)], escalations: [], inboxUrl: 'https://app.test/inbox' })
    expect(mail.subject).toBe('1 draft waiting for review · Acme')
    expect(mail.text).toContain('Where is order 1? · customer1@x.test · Shipping · 81% confidence')
    expect(mail.text).not.toContain('…and')
  })

  it('omits the category and confidence segments when they are unknown', () => {
    const mail = digestMail({
      to: 'owner@acme.test', businessName: 'Acme', escalations: [], inboxUrl: 'https://app.test/inbox',
      drafts: [draft(2, { categoryLabel: null, confidencePct: null })],
    })
    expect(mail.text).toContain('Where is order 2? · customer2@x.test\n')
    expect(mail.text).not.toContain('confidence')
  })

  it('falls back to the escalation subject form when there are no drafts, and caps escalations too', () => {
    const escalations = Array.from({ length: 12 }, (_, i) => escalation(i))
    const mail = digestMail({ to: 'owner@acme.test', businessName: 'Acme', drafts: [], escalations, inboxUrl: 'https://app.test/inbox' })

    expect(mail.subject).toBe('12 tickets need you')
    // Mirrors the draft line's shape: subject · customer · … (reason, where a draft has category/confidence).
    expect(mail.text).toContain('Angry about 0 · angry0@x.test · tripwire')
    expect(mail.text).toContain(`Open: ${escalations[0]!.openUrl}`)
    expect(mail.text).toContain(`…and ${12 - DIGEST_MAX_ITEMS} more`)
    for (const e of escalations.slice(DIGEST_MAX_ITEMS)) expect(mail.text).not.toContain(e.openUrl)
  })

  it('singularises the no-drafts subject and its section heading for one escalation', () => {
    const mail = digestMail({ to: 'owner@acme.test', businessName: 'Acme', drafts: [], escalations: [escalation(1)], inboxUrl: 'https://app.test/inbox' })
    expect(mail.subject).toBe('1 ticket needs you')
    expect(mail.text).toContain('1 ticket needs you:')
  })

  it('keeps the draft subject form when drafts and escalations are both present', () => {
    const mail = digestMail({ to: 'owner@acme.test', businessName: 'Acme', drafts: [draft(1)], escalations: [escalation(1)], inboxUrl: 'https://app.test/inbox' })
    expect(mail.subject).toBe('1 draft waiting for review · Acme')
    expect(mail.text).toContain('Angry about 1 · angry1@x.test · tripwire')
  })
})
