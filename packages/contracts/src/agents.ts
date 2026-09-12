import { z } from 'zod'

export const PERSONA_PRESETS = ['support', 'sales', 'concierge', 'billing'] as const
export type PersonaPreset = (typeof PERSONA_PRESETS)[number]

export const AGENT_STATUSES = ['pending_verification', 'active', 'disabled'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export const MAX_AGENTS_PER_DOMAIN = 3

export const UpdateAgentInput = z.object({
  agentId: z.uuid(),
  displayName: z.string().trim().min(1).max(120).optional(),
  signature: z.string().max(500).optional(),
  personaPreset: z.enum(PERSONA_PRESETS).optional(),
  personaText: z.string().max(4000).optional(),
  guidanceExtra: z.string().max(4000).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  replyFromAddress: z.email().max(254).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  autoGraduate: z.boolean().optional(),
  autoSendDelayMin: z.number().int().min(1).max(60).optional(),
})
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>

export const AgentIdInput = z.object({ agentId: z.uuid() })
export type AgentIdInput = z.infer<typeof AgentIdInput>
