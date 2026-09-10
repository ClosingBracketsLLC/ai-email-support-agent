/**
 * The ONE construction of a tenant's `WorkspacePolicy` (and of the persona identity that feeds it),
 * shared by every guardrail pass in the product: `ticket.draft`'s screen and its post-redraft
 * screen, `agent.sandbox`, `send.execute`'s pass over the owner-approved `final_body`, and the api's
 * approve gate.
 *
 * All of them MUST screen against the same policy. The send gate exists to catch what an owner edit
 * smuggled past the draft gate, and a policy that differed by one trusted text or one allowed host
 * between two gates would either block an approved reply an earlier gate had already cleared, or
 * wave through the very edit a later gate is there to catch. (It did: the api's approve gate used to
 * build its own policy with `trustedTexts: []`, so an owner edit quoting ten words of the workspace
 * guidance passed approve and was then destroyed by `send.execute` — final-E I1.)
 *
 * The four trusted texts are fixed and ordered: platform hard rules, the persona block, the
 * workspace's operating guidance, the agent's extra guidance — the same four the draft prompt is
 * built from, which is exactly what makes `trusted_text_leak` able to spot a reply quoting them.
 *
 * `@aesa/agent/policy` is its own entry point, and a deliberately pure one: it pulls in `@aesa/core`
 * and this package's own prompt-text modules, and nothing else. That is what lets the api — which
 * per CLAUDE.md never calls a model — build the identical policy without the Anthropic SDK entering
 * its module graph. `test/policy.test.ts` holds that line.
 */
import type { PersonaPreset } from '@aesa/contracts'
import { buildWorkspacePolicy, type PolicySource, type WorkspacePolicy } from '@aesa/core'
import { personaBlock, platformRulesBlock } from './draft/blocks.ts'

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
