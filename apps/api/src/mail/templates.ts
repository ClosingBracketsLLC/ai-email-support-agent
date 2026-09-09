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
