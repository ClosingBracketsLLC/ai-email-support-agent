/**
 * Assembly: the four (or five) system blocks plus the one user message, as a single
 * `ChatRequest<DraftDecision>`.
 *
 * Block order. The spec's layer list reads platform rules → profile → persona → knowledge →
 * guidance; the CACHE order the adapter enforces is static → agent → volatile, and knowledge is
 * the volatile one, so it goes last here. Nothing is lost: the guidance block states in words that
 * it is authoritative over the knowledge section that follows it.
 */
import type { ChatMeta, ChatRequest, SystemBlock } from '@aesa/llm'
import { guidanceBlock, knowledgeBlock, personaBlock, platformRulesBlock, workspaceProfileBlock, type WorkspaceProfile } from './blocks.ts'
import { DraftDecision } from './decision.ts'
import { buildUserMessage, type DraftUserInput } from './thread.ts'
import type { RetrievedAnswer, RetrievedChunk } from '../retrieval.ts'

export interface DraftPromptInput extends DraftUserInput {
  profile: WorkspaceProfile
  persona: Parameters<typeof personaBlock>[0]
  guidance: { workspaceGuidance: string; agentGuidance: string }
  knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }
  /** The opt-in 5-minute breakpoint on the last `agent` block — worth its write cost only above
   * ~12 drafts/hour for the org (spec §Prompt blocks → caching); the job counts and decides. */
  cacheAgentBlocks: boolean
  effort: 'medium' | 'high'
}

export const DRAFT_MODEL = 'claude-opus-5'
export const DRAFT_MAX_OUTPUT_TOKENS = 4096

export function buildDraftRequest(input: DraftPromptInput, meta: ChatMeta, signal: AbortSignal): ChatRequest<DraftDecision> {
  const guidance = guidanceBlock(input.guidance)
  const system: SystemBlock[] = [
    platformRulesBlock(),
    workspaceProfileBlock(input.profile),
    personaBlock(input.persona),
    ...(guidance ? [guidance] : []),
    knowledgeBlock(input.knowledge),
  ]

  return {
    model: DRAFT_MODEL,
    system,
    messages: [{ role: 'user', content: buildUserMessage(input) }],
    output: { name: 'draft_decision', schema: DraftDecision },
    effort: input.effort,
    cache: { agentBreakpoint: input.cacheAgentBlocks },
    maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
    signal,
    meta,
  }
}
