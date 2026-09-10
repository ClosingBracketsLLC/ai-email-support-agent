/**
 * The ONE construction of a tenant's `WorkspacePolicy` (and of the persona identity that feeds it)
 * used by every worker-side guardrail pass: `ticket.draft`'s screen (and its second, post-redraft
 * screen) and `send.execute`'s third pass over the owner-approved `final_body`.
 *
 * It lives here rather than in either job because the two passes MUST screen against the same
 * policy: the send gate exists to catch what an owner edit smuggled past the draft gate, and a
 * policy that differed by one trusted text or one allowed host between the two would either block
 * an approved reply the draft gate had already cleared, or wave through the very edit the send gate
 * is there to catch.
 *
 * The four trusted texts are fixed and ordered: platform hard rules, the persona block, the
 * workspace's operating guidance, the agent's extra guidance — the same four the draft prompt is
 * built from, which is exactly what makes `trusted_text_leak` able to spot a reply quoting them.
 */
import { personaBlock, platformRulesBlock } from '@aesa/agent'
import type { PersonaPreset } from '@aesa/contracts'
import { buildWorkspacePolicy, type PolicySource, type WorkspacePolicy } from '@aesa/core'

/** The agent columns both the persona block and the policy need. */
export interface PolicyAgent {
  domain: string
  displayName: string
  address: string
  replyFromAddress: string | null
  personaPreset: string
  personaText: string
}

/** The identity the model answers as — and the address a reply is stamped `From:`. */
export function personaFor(agent: PolicyAgent): { preset: PersonaPreset; personaText: string; displayName: string; address: string } {
  return {
    preset: agent.personaPreset as PersonaPreset,
    personaText: agent.personaText,
    displayName: agent.displayName,
    address: agent.replyFromAddress ?? agent.address,
  }
}

export function buildReplyPolicy(p: {
  workspace: PolicySource
  agent: PolicyAgent
  workspaceGuidance: string
  agentGuidance: string
  /** `tickets.language` — a reply in another language is a WARNING, never a block. */
  expectedLanguage: string | null
}): WorkspacePolicy {
  return buildWorkspacePolicy({
    workspace: p.workspace,
    agentDomain: p.agent.domain,
    trustedTexts: [platformRulesBlock().text, personaBlock(personaFor(p.agent)).text, p.workspaceGuidance, p.agentGuidance],
    expectedLanguage: p.expectedLanguage,
  })
}
