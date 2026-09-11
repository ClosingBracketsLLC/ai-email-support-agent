import type { RejectAction } from '@aesa/contracts'
import { INVARIANTS } from './invariants.ts'

/** 2: original + 2 redrafts = the 3-runs/day per-ticket cap (checkInvariants pins it). */
export const REDRAFT_MAX = INVARIANTS.REDRAFT_MAX

/** Spread into EVERY write that transitions a ticket out of the redraft-eligible cycle (send flip, every entry into needs_owner, resolve). */
export function clearRedraftCycle(): { ownerRedraftFeedback: null; redraftCount: 0 } {
  return { ownerRedraftFeedback: null, redraftCount: 0 }
}

export type RejectResolution = { kind: 'redraft' } | { kind: 'escalate_terminal' } | { kind: 'escalate_limit' }

/**
 * Pure; shared by the tRPC reject and the review page so the two surfaces never diverge.
 * Guard ORDER is load-bearing: blank reason → terminal; wrong status → terminal; at cap → limit
 * regardless of the action; action !== 'redraft' → terminal; else redraft.
 */
export function resolveRejectAction(p: { reason: string; action: RejectAction; redraftCount: number; ticketStatus: string }): RejectResolution {
  if (p.reason.trim() === '') return { kind: 'escalate_terminal' }
  if (p.ticketStatus !== 'awaiting_review') return { kind: 'escalate_terminal' }
  if (p.redraftCount >= REDRAFT_MAX) return { kind: 'escalate_limit' }
  if (p.action !== 'redraft') return { kind: 'escalate_terminal' }
  return { kind: 'redraft' }
}
