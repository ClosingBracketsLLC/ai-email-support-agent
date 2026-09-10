import type { MailProvider } from '@aesa/contracts'
import type { OutgoingMail } from './transport.ts'

export function otpMail(to: string, otp: string): OutgoingMail {
  return {
    to,
    subject: `${otp} is your aesa sign-in code`,
    text: `Your sign-in code is ${otp}\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.`,
  }
}

export function invitationMail(p: { to: string; inviterName: string; orgName: string; url: string }): OutgoingMail {
  return {
    to: p.to,
    subject: `${p.inviterName} invited you to ${p.orgName} on aesa`,
    text: `${p.inviterName} invited you to join the ${p.orgName} workspace on aesa.\n\nOpen this link to accept:\n${p.url}\n\nThe invitation expires in 48 hours. If you were not expecting it, ignore this email.`,
  }
}

/** The claim-time email (Phase 3 pre-flight): sent to the mailbox address itself, not the claiming user —
 * it's the mailbox owner's only record of who attached this workspace to their inbox. Closes most of the
 * reverse-phish window named in the Phase 2 review. */
export function mailboxClaimedMail(p: { to: string; emailAddress: string; provider: MailProvider; claimedByEmail: string; settingsUrl: string }): OutgoingMail {
  return {
    to: p.to,
    subject: `Your mailbox ${p.emailAddress} was connected to aesa`,
    text: `${p.claimedByEmail} connected this mailbox (${p.provider}) to the aesa workspace. If that wasn't you, disconnect it here: ${p.settingsUrl}.`,
  }
}
