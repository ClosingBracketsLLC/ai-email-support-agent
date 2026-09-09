/**
 * ONE scenario file that any `MailboxClient` implementation must pass (spec §Mailbox providers).
 * `runMailboxConformance` registers a `describe(name, ...)` and drives every scenario through the
 * port alone (`MailboxClient`) plus the small harness seam below — never a mock-only method, so
 * the exact same test file runs unmodified against `createMockMailbox` AND a real adapter wired
 * to replayed fixtures (`packages/mail/test/fixtures/{gmail,graph}/`).
 *
 * Two scenarios are conditional because a fixture-replay harness cannot satisfy them:
 *   - `expireCursor` — a canned fixture response can't be forced into an error on demand, so a
 *     harness that can't simulate it simply omits the method and the scenario is skipped.
 *   - `supportsSend` — the reference rule (never send unsolicited mail against a fixture replay,
 *     which isn't a real mailbox that could dedupe/observe a resend) means the replay tier sets
 *     `supportsSend: false` and the round-trip scenario is skipped.
 *
 * A fixture-replay harness's `seedInbound` does not mutate anything real — canned fixtures can't
 * be made to grow a new message on demand — it instead returns the identity of a message the
 * harness's fixture set already knows how to serve back through `listChanges`/`getMessage`/
 * `listMessagesForResync`/`getThreadMessageIds`. Every scenario below asserts only against the
 * `{ id, threadId }` `seedInbound` hands back, so this is transparent to the scenario code: a mock
 * harness's `seedInbound` really did just create that message; a fixture harness's `seedInbound`
 * is really just naming a message its fixtures were authored (or recorded) to contain.
 *
 * Because of that, a NEGATIVE assertion ("this other message is excluded") can only be driven
 * against a harness whose `seedInbound` actually mutates state — a fixture harness's `seedInbound`
 * returns the SAME fixed identity every call, so a second "seed" is not a second message. Every
 * scenario that needs a negative check gates it on the explicit `seedInboundMutates` capability
 * field below (never on the harness's name), and simply skips the negative half for a harness that
 * reports `false`.
 */
import { expect, describe, it } from 'vitest'
import { CursorExpiredError, MessageGoneError, MARKER_HEADER, type MailboxClient } from '@aesa/mail'

export interface ConformanceHarness {
  makeClient(): Promise<MailboxClient>
  seedInbound(m: { from: string; to: string[]; subject: string; bodyText: string; threadId?: string }): Promise<{ id: string; threadId: string }>
  /** `true` when `seedInbound` performs a real, isolated mutation (a mock harness) — `false` when
   * it just names a fixed identity a canned fixture set already knows how to serve (a
   * fixture-replay harness). Scenarios that assert a message's EXCLUSION (not merely its
   * inclusion) can only be driven meaningfully when this is `true` — see the file header. */
  seedInboundMutates: boolean
  /** Absent → the cursor-expiry scenario is skipped (a fixture-replay tier can't force this). */
  expireCursor?(): Promise<void>
  /** `false` for the recorded-fixture tier — no unsolicited sends (reference rule) — the send
   * round-trip scenario is skipped. */
  supportsSend: boolean
}

/** A message id no harness — mock or fixture — ever mints for a real message, so every provider's
 * `getMessage` must treat it as gone. */
const UNKNOWN_MESSAGE_ID = 'does-not-exist-message-id'

export function runMailboxConformance(name: string, makeHarness: () => Promise<ConformanceHarness>): void {
  describe(name, () => {
    it('profile returns a usable cursor', async () => {
      const harness = await makeHarness()
      const client = await harness.makeClient()

      const profile = await client.profile()
      expect(profile.emailAddress).toBeTruthy()
      expect(profile.cursor).not.toBeNull()
      expect(profile.cursor).not.toBeUndefined()
    })

    it('a quiet poll returns no records, and a seeded inbound message appears on the next poll', async () => {
      const harness = await makeHarness()
      const client = await harness.makeClient()
      const { cursor } = await client.profile()

      const quiet = await client.listChanges(cursor)
      expect(quiet.records).toEqual([])

      const seeded = await harness.seedInbound({
        from: 'jane@example.com',
        to: ['support@acme.test'],
        subject: 'Order #4521',
        bodyText: 'Where is my order?',
      })

      const after = await client.listChanges(cursor)
      const seenMessageIds = after.records.flatMap((r) => r.messageIds)
      expect(seenMessageIds).toContainEqual({ id: seeded.id, threadId: seeded.threadId })
    })

    it('getMessage: metadata fetch has a null body with headers present; full fetch has a body', async () => {
      const harness = await makeHarness()
      const client = await harness.makeClient()
      const seeded = await harness.seedInbound({
        from: 'jane@example.com',
        to: ['support@acme.test'],
        subject: 'Order #4521',
        bodyText: 'Where is my order?',
      })

      const metadata = await client.getMessage(seeded.id, { format: 'metadata' })
      expect(metadata.bodyText).toBeNull()
      expect(metadata.subject).toBeTruthy()

      const full = await client.getMessage(seeded.id, { format: 'full' })
      expect(full.bodyText).toBeTruthy()
    })

    it('getMessage: an unknown id throws MessageGoneError', async () => {
      const harness = await makeHarness()
      const client = await harness.makeClient()
      await expect(client.getMessage(UNKNOWN_MESSAGE_ID, { format: 'full' })).rejects.toBeInstanceOf(MessageGoneError)
    })

    it('listMessagesForResync filters by the address window and finds the seeded message', async () => {
      const harness = await makeHarness()
      const client = await harness.makeClient()
      const seeded = await harness.seedInbound({
        from: 'jane@example.com',
        to: ['support@acme.test'],
        subject: 'Resync target',
        bodyText: 'Please find my order',
      })

      // A harness that can't seed a second, isolated message (a fixture replay — see the file
      // header) can only support the positive half of this scenario below.
      const decoy = harness.seedInboundMutates
        ? await harness.seedInbound({
            from: 'other@elsewhere.test',
            to: ['other@elsewhere.test'],
            subject: 'Unrelated to support',
            bodyText: 'Not addressed to the support mailbox at all',
          })
        : null

      const result = await client.listMessagesForResync(['support@acme.test'], 30)
      expect(result.ids).toContainEqual({ id: seeded.id, threadId: seeded.threadId })
      // A client that ignored the `addresses` argument entirely would still pass the assertion
      // above — this is what actually pins the filtering: a message addressed to someone else
      // must NOT show up in a resync window scoped to the support mailbox's own address.
      if (decoy) expect(result.ids.map((r) => r.id)).not.toContain(decoy.id)
    })

    it('getThreadMessageIds walks the thread and finds the seeded message', async () => {
      const harness = await makeHarness()
      const client = await harness.makeClient()
      const seeded = await harness.seedInbound({
        from: 'jane@example.com',
        to: ['support@acme.test'],
        subject: 'Thread walk',
        bodyText: 'body',
      })

      // Omitting `threadId` seeds a message on its OWN fresh thread — a harness that can't seed a
      // second, isolated message (a fixture replay — see the file header) can only support the
      // positive half of this scenario below.
      const otherThread = harness.seedInboundMutates
        ? await harness.seedInbound({
            from: 'jane@example.com',
            to: ['support@acme.test'],
            subject: 'A different thread entirely',
            bodyText: 'unrelated',
          })
        : null

      const ids = await client.getThreadMessageIds(seeded.threadId)
      expect(ids).toContainEqual({ id: seeded.id })
      // A client that walked every thread rather than just the requested one would still pass the
      // assertion above — this is what actually pins the scoping: a message on a DIFFERENT thread
      // must not appear in this thread's walk.
      if (otherThread) expect(ids.map((r) => r.id)).not.toContain(otherThread.id)
    })

    it('cursor expiry throws CursorExpiredError then recovers', async (ctx) => {
      const harness = await makeHarness()
      if (!harness.expireCursor) {
        ctx.skip()
        return
      }
      const client = await harness.makeClient()
      const { cursor } = await client.profile()

      await harness.expireCursor()
      await expect(client.listChanges(cursor)).rejects.toBeInstanceOf(CursorExpiredError)

      // Recovered: the same cursor now resolves normally again.
      await expect(client.listChanges(cursor)).resolves.toBeDefined()
    })

    it('sendReply round-trip: sent message visible with SENT label and the marker header readable back', async (ctx) => {
      const harness = await makeHarness()
      if (!harness.supportsSend) {
        ctx.skip()
        return
      }
      const client = await harness.makeClient()
      const seeded = await harness.seedInbound({
        from: 'jane@example.com',
        to: ['support@acme.test'],
        subject: 'Broken leash',
        bodyText: 'Hi, my order is late.',
      })

      const marker = 'conformance-marker-1'
      const sent = await client.sendReply({
        threadId: seeded.threadId,
        to: 'jane@example.com',
        subject: 'Re: Broken leash',
        inReplyTo: '<seed-1@mock.aesa>',
        references: '<seed-1@mock.aesa>',
        bodyText: 'Thanks, shipping today.',
        extraHeaders: { [MARKER_HEADER]: marker },
        // Required by Graph's two-phase send (`replyToProviderMessageId`); harmless for Gmail,
        // which ignores it.
        replyToProviderMessageId: seeded.id,
      })

      const sentMessage = await client.getMessage(sent.id, { format: 'metadata' })
      expect(sentMessage.labelIds).toContain('SENT')
      expect(sentMessage.markerDraftId).toBe(marker)
    })
  })
}
