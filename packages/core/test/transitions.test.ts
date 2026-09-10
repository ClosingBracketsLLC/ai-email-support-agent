import { describe, expect, it } from 'vitest'
import * as contracts from '@aesa/contracts'
import {
  AGENT_RUN_STATUSES, DRAFT_STATUSES, IllegalTransitionError, OUTBOUND_SEND_STATUSES, agentRunTransitions,
  defineTransitions, draftTransitions, outboundSendTransitions, ticketTransitions,
} from '../src/transitions.ts'

describe('transitions', () => {
  it('self-transitions are always illegal', () => {
    for (const s of ['new', 'triaged', 'resolved'] as const) expect(ticketTransitions.can(s, s)).toBe(false)
  })
  it('ticket happy path: new → triaged → awaiting_review → waiting_on_customer → new (reopen)', () => {
    expect(ticketTransitions.can('new', 'triaged')).toBe(true)
    expect(ticketTransitions.can('triaged', 'awaiting_review')).toBe(true)
    expect(ticketTransitions.can('awaiting_review', 'waiting_on_customer')).toBe(true)
    expect(ticketTransitions.can('waiting_on_customer', 'new')).toBe(true)
    expect(ticketTransitions.can('resolved', 'triaged')).toBe(false)
  })
  it('draft terminal states have no exits', () => {
    for (const s of ['sent', 'rejected', 'superseded', 'expired', 'failed'] as const)
      expect(draftTransitions.can(s, 'pending')).toBe(false)
    expect(() => draftTransitions.assert('sent', 'pending')).toThrow(IllegalTransitionError)
  })
  it('defineTransitions rejects a matrix that lists a self-transition', () => {
    expect(() => defineTransitions({ a: ['a'], b: [] } as const)).toThrow(/self/)
  })
  it('rejects an unknown status key at compile time when the status type is explicit', () => {
    type S = 'x' | 'y'
    // @ts-expect-error 'bogus' is not a status
    defineTransitions<S>({ x: ['y'], y: [], bogus: [] })
    expect(true).toBe(true)
  })

  it('outbound-send happy path: queued → claimed → sent', () => {
    expect(outboundSendTransitions.can('queued', 'claimed')).toBe(true)
    expect(outboundSendTransitions.can('claimed', 'sent')).toBe(true)
  })
  it('outbound-send: claimed → queued is legal (released for retry-later)', () => {
    expect(outboundSendTransitions.can('claimed', 'queued')).toBe(true)
  })
  it('outbound-send terminal states: sent has no exits; failed only re-queues', () => {
    expect(outboundSendTransitions.can('sent', 'queued')).toBe(false)
    expect(() => outboundSendTransitions.assert('sent', 'queued')).toThrow(IllegalTransitionError)
    expect(outboundSendTransitions.can('failed', 'queued')).toBe(true)
    expect(outboundSendTransitions.can('failed', 'claimed')).toBe(false)
    expect(outboundSendTransitions.can('failed', 'held')).toBe(false)
  })

  it('agent-run happy path: running → succeeded', () => {
    expect(agentRunTransitions.can('running', 'succeeded')).toBe(true)
  })
  it('agent-run terminal states have no exits', () => {
    for (const s of ['succeeded', 'failed', 'aborted'] as const) expect(agentRunTransitions.can(s, 'running')).toBe(false)
    expect(() => agentRunTransitions.assert('succeeded', 'running')).toThrow(IllegalTransitionError)
  })

  it('DRAFT_STATUSES, OUTBOUND_SEND_STATUSES and AGENT_RUN_STATUSES equal their @aesa/contracts mirrors', () => {
    expect(DRAFT_STATUSES).toEqual(contracts.DRAFT_STATUSES)
    expect(OUTBOUND_SEND_STATUSES).toEqual(contracts.OUTBOUND_SEND_STATUSES)
    expect(AGENT_RUN_STATUSES).toEqual(contracts.AGENT_RUN_STATUSES)
  })
})
