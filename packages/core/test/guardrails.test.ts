import { DRAFT_BODY_MAX } from '@aesa/contracts'
import { describe, expect, it } from 'vitest'
import { buildWorkspacePolicy, collectGroundedNumbers } from '../src/guardrails/policy.ts'
import type { WorkspacePolicy } from '../src/guardrails/policy.ts'
import { appendSignature, extractNumberTokens, validateReplyBody } from '../src/guardrails/validator.ts'

// Fixed policy so the doge-buddy reference's bodies (apps/ops/src/support/validator.ts,
// apps/ops/test/support-validator.test.ts) port unchanged.
const POLICY: WorkspacePolicy = {
  allowedHostnames: ['dogebuddy.com', 'www.dogebuddy.com'],
  allowedEmailDomains: ['dogebuddy.com'],
  allowedPhoneNumbers: [],
  allowedExactUrls: [],
  maxChars: 4000,
  locale: 'en',
  expectedLanguage: null,
  trustedTexts: [],
}

// -- Plain text --

describe('validateReplyBody: plain text', () => {
  it('rejects a body containing an HTML tag', () => {
    const result = validateReplyBody('Hi <b>there</b>, thanks for writing in.', POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'html_not_allowed')).toBe(true)
  })

  it('rejects a body over the max chars', () => {
    const result = validateReplyBody('a'.repeat(4001), POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'body_too_long')).toBe(true)
  })

  it('rejects a body that is empty after normalization', () => {
    const result = validateReplyBody('​​', POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'empty_body')).toBe(true)
  })

  it('rejects a body containing a \\p{Cc} control character other than \\n/\\r/\\t', () => {
    const result = validateReplyBody('Thanks\u0001 for reaching out.', POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.map((f) => f.code)).toEqual(['invisible_chars'])
  })

  it('a body with only \\n, \\r and \\t as controls passes (invisible_chars never trips on those)', () => {
    const body = 'Thanks for reaching out.\nLine two.\r\nColumn:\ttab.'
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('accepts an ordinary plain-text body, returning the unchanged normalizedBody', () => {
    const body = 'Thanks for reaching out, we will look into it.'
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(true)
    expect(result.normalizedBody).toBe(body)
    expect(result.findings).toEqual([])
    expect(result.warningCount).toBe(0)
  })
})

// -- FR5: zero-width / format characters must not defeat any screen --

describe('validateReplyBody: zero-width / format character stripping', () => {
  const ZWSP = '​'
  const BOM = '﻿'

  it('a promise broken by a ZWSP inside "refund" still trips promised_action', () => {
    const result = validateReplyBody(`Your ref${ZWSP}und has been issued today.`, POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'promised_action')).toBe(true)
  })

  it('a phone number broken by a ZWSP still trips contact_channel', () => {
    const result = validateReplyBody(`Call 888${ZWSP}5550142 for help.`, POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'contact_channel')).toBe(true)
  })

  it('a bare domain broken by a ZWSP still trips url_not_allowed', () => {
    const result = validateReplyBody(`Visit evil${ZWSP}.com for more.`, POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'url_not_allowed')).toBe(true)
  })

  it('a bare domain broken by a U+FEFF (BOM) variant still trips url_not_allowed', () => {
    const result = validateReplyBody(`Visit evil${BOM}.com for more.`, POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'url_not_allowed')).toBe(true)
  })

  it('a legit body with no format chars is unchanged and normalizedBody equals input', () => {
    const body = 'Thanks for reaching out — we will look into your order and follow up shortly.'
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(true)
    expect(result.normalizedBody).toBe(body)
  })
})

// -- Promised-action screen --

describe('validateReplyBody: promised-action screen', () => {
  it('hits across a newline within 200 chars ("your refund has been\\nprocessed")', () => {
    const result = validateReplyBody('Good news — your refund has been\nprocessed today.', POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'promised_action')).toBe(true)
  })

  it('a body with no action/promise proximity passes', () => {
    const body = 'Thanks so much for your patience while our team looks into this.'
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(true)
    expect(result.normalizedBody).toBe(body)
  })

  // Ported verbatim from doge-buddy's mustCatchPhrases (support-validator.test.ts:218-247) — every
  // token was added or removed there for a documented false positive/negative. The reference array
  // holds 22 entries (the brief's count of 24 does not match the actual reference content; ported
  // as-is, see task-5-report.md).
  const mustCatchPhrases = [
    'You have been refunded $19.99 to your original payment method.',
    "We've refunded your order in full.",
    "I've gone ahead and refunded you.", // caught via "gone ahead and" (PROMISE), not bare "i've"
    'Your refund is complete.',
    'Refund complete — expect it in 3-5 days.',
    'Your refund is on the way.',
    'We have cancelled your order.',
    'Your order has been cancelled.',
    'A replacement has shipped.',
    'Expect the funds back in 5 business days.', // caught via "funds back" (ACTION), not bare "funds"
    'Your refund has been initiated.',
    'Your refund has been submitted to your bank.',
    'Your refund has been authorized.',
    "We've started your refund.",
    'We have begun processing your refund.',
    'Your refund will be credited to your account within 3 business days.',
    "Within 5 business days you'll see the money back in your account.", // reversed receipt-timeframe
    "We've issued you a 15% discount code.",
    'Your coupon has been sent to your email.',
    'A discount code is on its way to you.',
    "I've applied a 15% discount to your order.",
    'Your promo code will be emailed within 24 hours.',
  ]
  it.each(mustCatchPhrases)('"%s" is caught by the promised-action screen', (phrase) => {
    const result = validateReplyBody(phrase, POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'promised_action')).toBe(true)
  })

  // Explicitly documented as an accepted gap (doge-buddy I3 ruling): no ACTION+PROMISE proximity
  // under the enumerated token screen — stays uncaught.
  it('"Consider it refunded." is NOT caught (enumerated screen, accepted gap)', () => {
    const body = 'Consider it refunded.'
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(true)
    expect(result.normalizedBody).toBe(body)
  })

  // Must-PASS phrasings ported verbatim: policy-explanation/decline sentences, the SORRY10 quotes,
  // and the four funds sentences (support-validator.test.ts:266-422).
  const mustPassPhrases = [
    'We have received your message and will take a look shortly.',
    "I've reviewed your order and unfortunately we can't offer a refund under our 30-day policy.",
    "I've attached our refund policy for reference.",
    "I've asked our warehouse about a replacement and will follow up.",
    'We have received your request for a replacement and will review it.',
    'We have no record of a refund request on this order.',
    'Returns are accepted within 30 days of delivery, but the item needs to be unopened, unused, ' +
      'and still sealed in its original manufacturer packaging to qualify for a refund. If the item ' +
      "has been opened or used, we're unable to process a return for it.",
    "Unfortunately we can't offer a refund for an item that simply wasn't to your dog's taste — " +
      'returns are only accepted within 30 days for unopened, unused products.',
    'Use code SORRY10 for 10% off your next order.',
    "Here's a discount code for a future order: SORRY10.",
    "We can't offer a refund or a return, but here's a discount code for your next order: SORRY10 (10% off, one use per customer).",
    "All sales are final, so I can't set up a return — but please use coupon SORRY10 for 10% off next time.",
    'Could you confirm whether the funds have been taken from your account?',
    "I've checked with the carrier; the funds are still held by your bank.",
    'Would you like the funds back on your card?',
    'Can I get the funds back today?',
  ]
  it.each(mustPassPhrases)('"%s" passes (no unbacked promise)', (phrase) => {
    const result = validateReplyBody(phrase, POLICY)
    expect(result.ok).toBe(true)
    expect(result.normalizedBody).toBe(phrase)
  })

  it('"You\'ll see your refund back within 5 business days." is CAUGHT (forward receipt-timeframe promise)', () => {
    const result = validateReplyBody("You'll see your refund back within 5 business days.", POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'promised_action')).toBe(true)
  })

  it('"Your refund will be credited to your card within 3-5 days." is CAUGHT (will be + resolution verb)', () => {
    const result = validateReplyBody('Your refund will be credited to your card within 3-5 days.', POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'promised_action')).toBe(true)
  })
})

// -- URL / domain screen --

describe('validateReplyBody: URL/domain screen', () => {
  const cases: { name: string; body: string; ok: boolean }[] = [
    { name: 'https://dogebuddy.com/track passes', body: 'Track it here: https://dogebuddy.com/track', ok: true },
    { name: 'https://www.dogebuddy.com passes', body: 'Visit https://www.dogebuddy.com for info.', ok: true },
    { name: 'http://dogebuddy.com fails (not https)', body: 'Visit http://dogebuddy.com for info.', ok: false },
    { name: 'https://evil.com fails', body: 'Visit https://evil.com for info.', ok: false },
    { name: 'https://dogebuddy.com.evil.com/x fails', body: 'Visit https://dogebuddy.com.evil.com/x for info.', ok: false },
    { name: 'bare dogebuddy-help.com fails', body: 'Please see dogebuddy-help.com for details.', ok: false },
    { name: 'bare dogebuddy.com passes', body: 'Please see dogebuddy.com for details.', ok: true },
    { name: 'admin.dogebuddy.com fails (subdomain excluded)', body: 'Please see admin.dogebuddy.com for details.', ok: false },
    // A bare `@domain.tld` mention with NO email local part must still be caught by the URL/domain
    // screen.
    { name: '@evil.com (bare, no local part) fails', body: 'Contact @evil.com for help.', ok: false },
    { name: 'Message us at @dogepay.shop fails', body: 'Message us at @dogepay.shop for a faster reply.', ok: false },
    { name: 'Telegram: @refund-help.com fails', body: 'Telegram: @refund-help.com — DM us there.', ok: false },
    // NFKC normalization folds Unicode dot look-alikes to a plain '.' before the domain regexes run.
    { name: 'evil․com (U+2024 ONE DOT LEADER) fails', body: 'Please see evil․com for details.', ok: false },
    { name: 'evil．com (U+FF0E FULLWIDTH FULL STOP) fails', body: 'Please see evil．com for details.', ok: false },
    // Trailing prose punctuation and a `<...>` wrap are stripped before parsing/comparing.
    { name: 'trailing period after a schemed URL passes', body: 'Track your order at https://dogebuddy.com.', ok: true },
    { name: 'angle-bracket-wrapped URL passes (not HTML)', body: 'See <https://dogebuddy.com/help> for details.', ok: true },
  ]

  it.each(cases)('$name', ({ body, ok }) => {
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(ok)
    if (!ok) expect(result.findings.some((f) => f.code === 'url_not_allowed')).toBe(true)
  })

  // With the contact screen running BEFORE the URL/domain screen, a URL whose userinfo section
  // looks like an email is caught by the EMAIL check first (contact_channel); the URL screen
  // independently also adds url_not_allowed since evil.com is not an allowed hostname.
  it('https://dogebuddy.com@evil.com/ fails, first as contact_channel (userinfo looks like an email)', () => {
    const result = validateReplyBody('Visit https://dogebuddy.com@evil.com/ for info.', POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings[0]?.code).toBe('contact_channel')
    expect(result.findings.some((f) => f.code === 'url_not_allowed')).toBe(true)
  })

  it('policy.allowedExactUrls passes byte-equal and fails on a one-character mismatch', () => {
    const policy: WorkspacePolicy = { ...POLICY, allowedExactUrls: ['https://carrier.example.com/trk?id=ABC123'] }

    const trackingUrl = 'https://carrier.example.com/trk?id=ABC123'
    const passResult = validateReplyBody(`Track it here: ${trackingUrl}`, policy)
    expect(passResult.ok).toBe(true)

    const mismatchUrl = 'https://carrier.example.com/trk?id=ABC124'
    const failResult = validateReplyBody(`Track it here: ${mismatchUrl}`, policy)
    expect(failResult.ok).toBe(false)
    expect(failResult.findings.some((f) => f.code === 'url_not_allowed')).toBe(true)
  })
})

// -- Contact screen --

describe('validateReplyBody: contact screen', () => {
  const cases: { name: string; body: string; ok: boolean }[] = [
    { name: 'help@gmail.com fails (contact screen runs before URL/domain)', body: 'You can also reach us at help@gmail.com any time.', ok: false },
    { name: 'help@gmail․com with a U+2024 ONE DOT LEADER still fails', body: 'You can also reach us at help@gmail․com any time.', ok: false },
    { name: 'support@dogebuddy.com passes', body: 'You can also reach us at support@dogebuddy.com any time.', ok: true },
    { name: '+1 (888) 555-0142 fails', body: 'Feel free to call us at +1 (888) 555-0142 anytime.', ok: false },
    { name: 'spaced-digit "8 8 8 5 5 5 0 1 4 2" still fails', body: 'Call us at 8 8 8 5 5 5 0 1 4 2 any time.', ok: false },
    { name: 'standalone 10-digit run fails', body: 'Please call 8885550142 for faster service.', ok: false },
    { name: 'standalone 11-digit run fails', body: 'Call 18885550142 anytime.', ok: false },
    { name: '4-2-2-regrouped phone number fails (not a real ISO date)', body: 'Call 5551-23-4567 today', ok: false },
    { name: '4-2-2-regrouped phone number with country code fails', body: 'Reach me at +1 8885-55-0142', ok: false },
    { name: 'a 10-digit run embedded in an alphanumeric reference id passes', body: 'Your reference is REF1234567890 for tracking.', ok: true },
    { name: 'order #12345 passes (digits < 7 with separators)', body: 'Please reference order #12345 when you write back.', ok: true },
    { name: 'unseparated digit run with no leading +/( passes', body: 'Order 10023481 shipped', ok: true },
    { name: 'alphanumeric tracking token passes', body: 'Your tracking number is 1Z999AA10123456784.', ok: true },
    { name: 'ISO dates pass (excluded explicitly)', body: 'Ordered on 2024-01-15 and shipped 2024-01-18.', ok: true },
    { name: 'two adjacent ISO dates merged into one phone-regex candidate pass', body: 'Window: 2024-01-15 2024-01-18', ok: true },
    { name: 'three adjacent ISO dates merged into one candidate pass', body: 'Dates: 2024-01-15 2024-01-18 2024-01-20', ok: true },
    { name: 'a long digit run inside an allowed dogebuddy.com URL path passes', body: 'Your tracking link: https://dogebuddy.com/track/9405511899223197428490', ok: true },
  ]

  it.each(cases)('$name', ({ body, ok }) => {
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(ok)
    if (!ok) expect(result.findings.some((f) => f.code === 'contact_channel')).toBe(true)
  })

  it('a byte-equal allowedExactUrls entry containing separated digits passes (allowed spans exempt the phone screen too)', () => {
    const exactUrl = 'https://carrier.example.com/trk?ref=1-800-555-0199#nums=LZ123456789CN'
    const policy: WorkspacePolicy = { ...POLICY, allowedExactUrls: [exactUrl] }
    const result = validateReplyBody(`Track it here: ${exactUrl}`, policy)
    expect(result.ok).toBe(true)
  })

  // New: policy.allowedPhoneNumbers digit-equality exemption, applied BEFORE the phone screen fails.
  it('allowedPhoneNumbers lets an exact-digit-match phone pass while any other number still fails', () => {
    const policy: WorkspacePolicy = { ...POLICY, allowedPhoneNumbers: ['8885550142'] }

    const passResult = validateReplyBody('Call us at (888) 555-0142 anytime.', policy)
    expect(passResult.ok).toBe(true)

    const failResult = validateReplyBody('Call us at (888) 555-0143 anytime.', policy)
    expect(failResult.ok).toBe(false)
    expect(failResult.findings.some((f) => f.code === 'contact_channel')).toBe(true)
  })
})

// -- secret_leak screen (new) --

describe('validateReplyBody: secret_leak screen', () => {
  const cases: { name: string; body: string }[] = [
    { name: 'sk-style API key', body: 'Here is the key: sk-abcdEFGH12345678ijkl' },
    { name: 'Bearer token', body: 'Use header: Bearer abcdEFGH12345678ijkl' },
    { name: 'PEM private key block', body: '-----BEGIN RSA PRIVATE KEY-----\nMIIExampleKeyData\n-----END RSA PRIVATE KEY-----' },
    { name: 'AWS access key id', body: 'Access key: AKIAABCDEFGHIJKLMNOP' },
    { name: 'Slack token', body: 'Token: xoxb-1234567890-abcdefghij' },
    { name: 'GitHub personal access token', body: `Token: ghp_${'a'.repeat(36)}` },
  ]
  it.each(cases)('$name fails secret_leak', ({ body }) => {
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'secret_leak')).toBe(true)
  })
})

// -- trusted_text_leak screen (new) --

describe('validateReplyBody: trusted_text_leak screen', () => {
  const trustedText = 'Never offer refunds on sale items unless the owner has explicitly approved it in writing first.'
  const policy: WorkspacePolicy = { ...POLICY, trustedTexts: [trustedText] }

  it('fails when the reply quotes ten consecutive words of a trusted text verbatim', () => {
    // Shares the trusted text's shingle "unless the owner has explicitly approved it in writing
    // first" — deliberately free of any ACTION_RE token, so this isolates trusted_text_leak
    // without also tripping promised_action.
    const body = 'As stated in our policy, unless the owner has explicitly approved it in writing first, no exception applies.'
    const result = validateReplyBody(body, policy)
    expect(result.ok).toBe(false)
    expect(result.findings.map((f) => f.code)).toEqual(['trusted_text_leak'])
  })

  it('passes a paraphrase that shares no 10-word shingle with the trusted text', () => {
    const body =
      "Just so you know, we generally won't issue money back for sale merchandise without the owner's direct written sign-off beforehand."
    const result = validateReplyBody(body, policy)
    expect(result.ok).toBe(true)
    expect(result.findings.some((f) => f.code === 'trusted_text_leak')).toBe(false)
  })

  it('a trusted text of nine words never trips, even if quoted verbatim', () => {
    const nineWordText = 'Please respond within one business day whenever possible today'
    const shortPolicy: WorkspacePolicy = { ...POLICY, trustedTexts: [nineWordText] }
    const body = 'Please respond within one business day whenever possible today, as per our policy.'
    const result = validateReplyBody(body, shortPolicy)
    expect(result.ok).toBe(true)
    expect(result.findings.some((f) => f.code === 'trusted_text_leak')).toBe(false)
  })
})

// -- unbacked_number screen (new, warning) --

describe('validateReplyBody: unbacked_number screen (warning)', () => {
  it('does not warn when every number in the reply is grounded', () => {
    const result = validateReplyBody('That costs $19.99 and ships in 30 days', POLICY, {
      groundedNumbers: ['$19.99', '30 days'],
    })
    expect(result.ok).toBe(true)
    expect(result.warningCount).toBe(0)
    expect(result.findings.some((f) => f.code === 'unbacked_number')).toBe(false)
  })

  it('warns (but stays ok) when a number is not grounded', () => {
    const result = validateReplyBody('That costs $24.99', POLICY, { groundedNumbers: ['$19.99', '30 days'] })
    expect(result.ok).toBe(true)
    expect(result.warningCount).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.code).toBe('unbacked_number')
    expect(result.findings[0]?.severity).toBe('warn')
  })

  it('never warns when opts.groundedNumbers is not supplied', () => {
    const result = validateReplyBody('That costs $24.99', POLICY)
    expect(result.findings.some((f) => f.code === 'unbacked_number')).toBe(false)
  })
})

// -- language_mismatch screen (new, warning) --

describe('validateReplyBody: language_mismatch screen (warning)', () => {
  it('warns when the reply language differs from the expected language', () => {
    const policy: WorkspacePolicy = { ...POLICY, expectedLanguage: 'en' }
    const result = validateReplyBody('Gracias por su mensaje.', policy, { replyLanguage: 'es' })
    expect(result.ok).toBe(true)
    expect(result.findings.some((f) => f.code === 'language_mismatch' && f.severity === 'warn')).toBe(true)
  })

  it('does not warn when only the region subtag differs (en-US vs en)', () => {
    const policy: WorkspacePolicy = { ...POLICY, expectedLanguage: 'en' }
    const result = validateReplyBody('Thanks for reaching out.', policy, { replyLanguage: 'en-US' })
    expect(result.findings.some((f) => f.code === 'language_mismatch')).toBe(false)
  })

  it('never warns when either side is unknown', () => {
    const result = validateReplyBody('Thanks for reaching out.', POLICY, { replyLanguage: 'es' })
    expect(result.findings.some((f) => f.code === 'language_mismatch')).toBe(false)
  })
})

// -- Findings are collected, in screen order --

describe('validateReplyBody: collected findings', () => {
  it('a body tripping two screens lists both findings in screen order', () => {
    const body = 'Your refund has been processed today. Also call us at 8885550142.'
    const result = validateReplyBody(body, POLICY)
    expect(result.ok).toBe(false)
    expect(result.findings.map((f) => f.code)).toEqual(['promised_action', 'contact_channel'])
  })
})

// -- appendSignature --

describe('appendSignature', () => {
  it('appends the signature after a blank line', () => {
    expect(appendSignature('Thanks!', 'Team Acme')).toBe('Thanks!\n\nTeam Acme')
  })

  it('is idempotent — does not double-append', () => {
    const once = appendSignature('Thanks!', 'Team Acme')
    expect(appendSignature(once, 'Team Acme')).toBe(once)
  })

  it('is a no-op for an empty signature', () => {
    expect(appendSignature('Thanks!', '')).toBe('Thanks!')
  })

  it('is a no-op for a whitespace-only signature', () => {
    expect(appendSignature('Thanks!', '   ')).toBe('Thanks!')
  })
})

// -- extractNumberTokens --

describe('extractNumberTokens', () => {
  it('extracts money, percent, and day-range tokens in order of appearance', () => {
    expect(extractNumberTokens('$12.50 within 3-5 business days, 15% off')).toEqual(['$12.50', '3-5 business days', '15%'])
  })
})

// -- buildWorkspacePolicy --

describe('buildWorkspacePolicy', () => {
  it('builds hostnames with www twins, email domains, phone digits and exact urls', () => {
    const policy = buildWorkspacePolicy({
      workspace: {
        allowedUrlHosts: ['dogebuddy.com'],
        allowedEmailDomains: ['dogebuddy.com'],
        contactPhone: '(888) 555-0142',
        contactUrls: ['https://carrier.example.com/trk?id=ABC123'],
        locale: 'en',
      },
      agentDomain: 'support.dogebuddy.com',
      trustedTexts: ['guidance text'],
      expectedLanguage: 'en',
    })
    expect([...policy.allowedHostnames].sort()).toEqual(
      ['dogebuddy.com', 'www.dogebuddy.com', 'support.dogebuddy.com', 'www.support.dogebuddy.com'].sort(),
    )
    expect(policy.allowedEmailDomains).toEqual(['dogebuddy.com', 'support.dogebuddy.com'])
    expect(policy.allowedPhoneNumbers).toEqual(['8885550142'])
    expect(policy.allowedExactUrls).toEqual(['https://carrier.example.com/trk?id=ABC123'])
    expect(policy.maxChars).toBe(DRAFT_BODY_MAX)
    expect(policy.locale).toBe('en')
    expect(policy.expectedLanguage).toBe('en')
    expect(policy.trustedTexts).toEqual(['guidance text'])
  })

  it('yields no phone exemptions when contactPhone is null', () => {
    const policy = buildWorkspacePolicy({
      workspace: {
        allowedUrlHosts: [],
        allowedEmailDomains: [],
        contactPhone: null,
        contactUrls: [],
        locale: 'en',
      },
      agentDomain: 'acme.com',
      trustedTexts: [],
      expectedLanguage: null,
    })
    expect(policy.allowedPhoneNumbers).toEqual([])
  })
})

// -- collectGroundedNumbers --

describe('collectGroundedNumbers', () => {
  it('extracts and dedupes number tokens across every source', () => {
    const tokens = collectGroundedNumbers(['ships in 3-5 business days', '$19.99'])
    expect([...tokens].sort()).toEqual(['$19.99', '3-5 business days'].sort())
  })
})
