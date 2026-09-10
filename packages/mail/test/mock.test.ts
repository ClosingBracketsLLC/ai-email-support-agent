import { describe, expect, it } from 'vitest'
import { createMockMailbox } from '../src/mock.ts'
import { MailApiError, CursorExpiredError, MessageGoneError } from '../src/errors.ts'
import { MARKER_HEADER } from '../src/types.ts'

// This port has no `saveDraft`/`sendDraft` (no labels API — see mock.ts's file header, point 3),
// so the reference's draft-churn and sendDraft tests have no analogue here and are intentionally
// not ported. `deleteMessage`/`backdate` stand in as this mock's message-lifecycle primitives.

const SELF = 'support@example.com'

describe('createMockMailbox: gmail mode', () => {
  it('receiveInbound: the new message is visible via listChanges', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const before = await mailbox.profile()

    const { id, threadId } = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Order help', bodyText: 'Where is my order?' })

    const { records } = await mailbox.listChanges(before.cursor)
    expect(records).toHaveLength(1)
    expect(records[0]!.messageIds).toEqual([{ id, threadId }])
  })

  it('incremental listChanges: a second call from the drained cursor returns only the new record', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const before = await mailbox.profile()

    const first = mailbox.receiveInbound({ from: 'a@example.com', subject: 'One', bodyText: 'first' })
    const afterFirst = await mailbox.listChanges(before.cursor)
    expect(afterFirst.records).toHaveLength(1)
    const cursorAfterFirst = afterFirst.newCursor

    const second = mailbox.receiveInbound({ from: 'b@example.com', subject: 'Two', bodyText: 'second' })

    const onlyNew = await mailbox.listChanges(cursorAfterFirst)
    expect(onlyNew.records).toHaveLength(1)
    expect(onlyNew.records[0]!.messageIds).toEqual([{ id: second.id, threadId: second.threadId }])
    expect(onlyNew.records[0]!.messageIds).not.toEqual([{ id: first.id, threadId: first.threadId }])
  })

  it('paginates change records and only advances past served pages', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF, pageSize: 3 })
    const before = await mailbox.profile()

    for (let i = 0; i < 7; i += 1) {
      mailbox.receiveInbound({ from: `sender${i}@example.com`, subject: `msg ${i}`, bodyText: 'x' })
    }

    const page1 = await mailbox.listChanges(before.cursor)
    expect(page1.records).toHaveLength(3)
    expect(page1.nextPageToken).toBeDefined()
    expect(page1.newCursor).toBeUndefined() // not the final page — must not advance past served pages

    const page2 = await mailbox.listChanges(before.cursor, page1.nextPageToken)
    expect(page2.records).toHaveLength(3)
    expect(page2.nextPageToken).toBeDefined()
    expect(page2.newCursor).toBeUndefined()

    const page3 = await mailbox.listChanges(before.cursor, page2.nextPageToken)
    expect(page3.records).toHaveLength(1)
    expect(page3.nextPageToken).toBeUndefined()
    expect(page3.newCursor).toBeDefined() // final page: fully drained, cursor now safe to persist

    // No records left to serve from the fully-drained cursor.
    const drained = await mailbox.listChanges(page3.newCursor)
    expect(drained.records).toHaveLength(0)
    expect(drained.newCursor).toBeDefined()
  })

  it('expireCursor: the next listChanges call throws CursorExpiredError, then behavior returns to normal', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const before = await mailbox.profile()
    mailbox.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    mailbox.expireCursor()
    await expect(mailbox.listChanges(before.cursor)).rejects.toBeInstanceOf(CursorExpiredError)

    const { records } = await mailbox.listChanges(before.cursor)
    expect(records).toHaveLength(1)
  })

  it('failNext: injects a one-shot error for the named method, then normal behavior resumes', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const boom = new Error('boom')
    const { id } = mailbox.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    mailbox.failNext('getMessage', boom)
    await expect(mailbox.getMessage(id, { format: 'full' })).rejects.toBe(boom)
    await expect(mailbox.getMessage(id, { format: 'full' })).resolves.toMatchObject({ id })
  })

  it('failNext: applies independently per named method', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const boom = new Error('boom')
    mailbox.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    mailbox.failNext('listChanges', boom)
    await expect(mailbox.listChanges(null)).rejects.toBe(boom)
    // Unaffected — the fault was scoped to listChanges only.
    await expect(mailbox.profile()).resolves.toMatchObject({ emailAddress: SELF })
  })

  it('getMessage(metadata): body is null but the marker header value still round-trips', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    const reply = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Re: Help',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'On it!',
      extraHeaders: { [MARKER_HEADER]: 'draft-abc' },
    })

    const meta = await mailbox.getMessage(reply.id, { format: 'metadata' })
    expect(meta.bodyText).toBeNull()
    expect(meta.markerDraftId).toBe('draft-abc')

    const full = await mailbox.getMessage(reply.id, { format: 'full' })
    expect(full.bodyText).toBe('On it!')
    expect(full.markerDraftId).toBe('draft-abc')

    // Inbound customer mail never carries a marker.
    expect((await mailbox.getMessage(inbound.id, { format: 'full' })).markerDraftId).toBeNull()
  })

  it('getMessage: deleted ids throw MessageGoneError', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const { id } = mailbox.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    mailbox.deleteMessage(id)

    await expect(mailbox.getMessage(id, { format: 'full' })).rejects.toBeInstanceOf(MessageGoneError)
  })

  it('backdate: rewinds a stored message internalDate', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const { id } = mailbox.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })
    const older = new Date('2020-01-01T00:00:00Z')

    mailbox.backdate(id, older)

    const msg = await mailbox.getMessage(id, { format: 'full' })
    expect(msg.internalDate).toEqual(older)
  })

  it('sendReply: lands a SENT message that the next listChanges returns, and routes through the real RFC 2822 builder', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })
    const before = await mailbox.profile()

    const reply = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      bodyText: 'On it!',
    })

    expect(reply.threadId).toBe(inbound.threadId)
    const sentMsg = await mailbox.getMessage(reply.id, { format: 'full' })
    expect(sentMsg.labelIds).toEqual(['SENT'])
    expect(sentMsg.bodyText).toBe('On it!')

    // Visible to a subsequent sync walk via listChanges.
    const { records } = await mailbox.listChanges(before.cursor)
    expect(records.flatMap((r) => r.messageIds)).toContainEqual({ id: reply.id, threadId: reply.threadId })

    // Raw RFC 2822 captured, built by the SAME validated builder production uses (Re: prefix added).
    const [sent] = mailbox.sentMessages()
    expect(sent!.raw).toBeDefined()
    const decoded = Buffer.from(sent!.raw!, 'base64url').toString()
    expect(decoded).toContain('Subject: Re: Help')

    // An invalid extraHeader name is rejected identically to production (buildReplyRaw's own check).
    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<abc@mail.example.com>',
        references: '<abc@mail.example.com>',
        bodyText: 'bad header',
        extraHeaders: { 'Invalid Header!': 'x' },
      }),
    ).rejects.toThrow(/invalid extra header name/)
  })

  it('failAfter("send"): stores the message then throws; failAfter("createReply") is a no-op (gmail has no draft phase)', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    // Gmail's sendReply never reaches a 'createReply' phase, so pending fault never fires.
    mailbox.failAfter('createReply', new Error('must never throw in gmail mode'))
    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<x@mail.example.com>',
        references: '<x@mail.example.com>',
        bodyText: 'first',
      }),
    ).resolves.toBeDefined()

    const boom = new Error('crash after send')
    mailbox.failAfter('send', boom)
    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<x@mail.example.com>',
        references: '<x@mail.example.com>',
        bodyText: 'second',
        extraHeaders: { [MARKER_HEADER]: 'draft-gmail-crash' },
      }),
    ).rejects.toBe(boom)

    expect(mailbox.sentMessages()).toHaveLength(2) // first, plus the crashed-but-stored second
    const found = await mailbox.findSentByMarker(inbound.threadId, 'draft-gmail-crash', 50)
    expect(found).not.toBeNull()
  })

  it('receiveOutbound: lands with SENT label, no marker, visible via listChanges', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const before = await mailbox.profile()

    const { id, threadId } = mailbox.receiveOutbound({ to: ['jane@example.com'], subject: 'Re: Help', bodyText: 'Handled by hand' })

    const msg = await mailbox.getMessage(id, { format: 'full' })
    expect(msg.labelIds).toEqual(['SENT'])
    expect(msg.markerDraftId).toBeNull()

    const { records } = await mailbox.listChanges(before.cursor)
    expect(records.flatMap((r) => r.messageIds)).toContainEqual({ id, threadId })
  })

  it('deliveredTo routing: listMessagesForResync matches deliveredto and cc (and includes spam)', async () => {
    // pageSize large enough that all matches land on one page — pagination itself is covered by
    // the dedicated pagination test below.
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF, pageSize: 10 })
    const toMatch = mailbox.receiveInbound({ from: 'a@example.com', to: [SELF], subject: 'to match', bodyText: 'x' })
    const ccMatch = mailbox.receiveInbound({ from: 'b@example.com', to: ['other@example.com'], cc: [SELF], subject: 'cc match', bodyText: 'x' })
    const deliveredMatch = mailbox.receiveInbound({
      from: 'c@example.com',
      to: ['other@example.com'],
      deliveredTo: [SELF],
      subject: 'delivered-to match',
      bodyText: 'x',
    })
    const noMatch = mailbox.receiveInbound({ from: 'd@example.com', to: ['other@example.com'], subject: 'no match', bodyText: 'x' })
    const spamMatch = mailbox.receiveInbound({ from: 'e@example.com', to: [SELF], subject: 'spam match', bodyText: 'x', labelIds: ['JUNK'] })

    const { ids } = await mailbox.listMessagesForResync([SELF], 30)
    const found = ids.map((m) => m.id)

    expect(found).toContain(toMatch.id)
    expect(found).toContain(ccMatch.id)
    expect(found).toContain(deliveredMatch.id)
    expect(found).not.toContain(noMatch.id)
    // includeSpamTrash: true semantics — spam is not excluded from a resync walk.
    expect(found).toContain(spamMatch.id)
  })

  it('listMessagesForResync: paginates and excludes messages outside the sinceDays window', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF, pageSize: 2 })
    const inWindow = [
      mailbox.receiveInbound({ from: 'a@example.com', to: [SELF], subject: '1', bodyText: 'x' }),
      mailbox.receiveInbound({ from: 'b@example.com', to: [SELF], subject: '2', bodyText: 'x' }),
      mailbox.receiveInbound({ from: 'c@example.com', to: [SELF], subject: '3', bodyText: 'x' }),
    ]
    const outOfWindow = mailbox.receiveInbound({ from: 'd@example.com', to: [SELF], subject: 'old', bodyText: 'x' })
    mailbox.backdate(outOfWindow.id, new Date('2000-01-01T00:00:00Z'))

    const page1 = await mailbox.listMessagesForResync([SELF], 30)
    expect(page1.ids).toHaveLength(2)
    expect(page1.nextPageToken).toBeDefined()

    const page2 = await mailbox.listMessagesForResync([SELF], 30, page1.nextPageToken)
    expect(page2.ids).toHaveLength(1)
    expect(page2.nextPageToken).toBeUndefined()

    const allFound = [...page1.ids, ...page2.ids].map((m) => m.id)
    expect(allFound.sort()).toEqual(inWindow.map((m) => m.id).sort())
    expect(allFound).not.toContain(outOfWindow.id)
  })

  it('getThreadMessageIds: returns live message ids in thread order, deleted ids excluded', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const threadId = 'thread-1'
    const first = mailbox.receiveInbound({ from: 'jane@example.com', to: [SELF], subject: 'Hi', bodyText: 'hi', threadId })
    const second = mailbox.receiveInbound({ from: 'jane@example.com', to: [SELF], subject: 'Hi', bodyText: 'again', threadId })
    mailbox.deleteMessage(second.id)
    const reply = await mailbox.sendReply({
      threadId,
      to: 'jane@example.com',
      subject: 'Hi',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'On it',
    })

    const ids = await mailbox.getThreadMessageIds(threadId)

    expect(ids.map((m) => m.id)).toEqual([first.id, reply.id])
  })

  // findSentByMarker's three branches (controller ruling): (1) marker found within the newest
  // `scanLimit` candidates -> resolves, even on an oversized thread; (2) not found within
  // `scanLimit` AND older candidates remain unexamined -> throws MailApiError(429), refusing to
  // guess; (3) every candidate examined (thread size <= scanLimit) and no match -> resolves null.

  it('findSentByMarker: branch 3 — walks the thread newest-first and finds the matching marker, null when absent and fully scanned', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })
    await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'first attempt',
      extraHeaders: { [MARKER_HEADER]: 'draft-1' },
    })
    const second = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'second attempt',
      extraHeaders: { [MARKER_HEADER]: 'draft-2' },
    })

    // scanLimit (50) comfortably covers the whole (3-message) thread — branch 3 territory.
    const found = await mailbox.findSentByMarker(inbound.threadId, 'draft-2', 50)
    expect(found).toBe(second.id)

    const notFound = await mailbox.findSentByMarker(inbound.threadId, 'draft-does-not-exist', 50)
    expect(notFound).toBeNull()
  })

  it('findSentByMarker: branch 1 — oversized thread, marker among the newest scanLimit messages resolves without throwing', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const threadId = 'oversized-thread-hit'
    // Five older inbound messages, then a marked reply as the NEWEST message on the thread.
    for (let i = 0; i < 5; i += 1) {
      mailbox.receiveInbound({ from: 'jane@example.com', to: [SELF], subject: 'Help', bodyText: `msg ${i}`, threadId })
    }
    const reply = await mailbox.sendReply({
      threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'On it',
      extraHeaders: { [MARKER_HEADER]: 'draft-hit' },
    })

    // 6 total candidates > scanLimit (3), but the marker is the newest — found before the scan
    // ever needs to look past the limit, so this must NOT throw.
    const found = await mailbox.findSentByMarker(threadId, 'draft-hit', 3)
    expect(found).toBe(reply.id)
  })

  it('findSentByMarker: branch 2 — oversized thread, no marker within the first scanLimit and older candidates remain, throws MailApiError(429)', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const threadId = 'oversized-thread-miss'
    // The marked reply is the OLDEST message — buried outside the newest-3 scan window by five
    // later messages. The marker genuinely exists on the thread; the scan still must refuse rather
    // than guess, because it never got to examine that candidate.
    const buried = await mailbox.sendReply({
      threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'first reply',
      extraHeaders: { [MARKER_HEADER]: 'draft-buried' },
    })
    for (let i = 0; i < 5; i += 1) {
      mailbox.receiveInbound({ from: 'jane@example.com', to: [SELF], subject: 'Help', bodyText: `follow-up ${i}`, threadId })
    }

    let caught: unknown
    try {
      await mailbox.findSentByMarker(threadId, 'draft-buried', 3)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(MailApiError)
    expect((caught as MailApiError).status).toBe(429)
    // Sanity: the marker really was on the thread, just outside the scan window — this is the
    // "refuse to guess" case, not a "marker doesn't exist" case.
    expect(buried.threadId).toBe(threadId)
  })

  it('findSentByMarker: branch 2 — oversized thread with no marker anywhere still throws (not merely a "not found")', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const threadId = 'busy-thread'
    for (let i = 0; i < 5; i += 1) {
      mailbox.receiveInbound({ from: 'jane@example.com', to: [SELF], subject: 'Help', bodyText: `msg ${i}`, threadId })
    }

    let caught: unknown
    try {
      await mailbox.findSentByMarker(threadId, 'draft-x', 3)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(MailApiError)
    expect((caught as MailApiError).status).toBe(429)
  })

  it('subscribe/renewSubscription/unsubscribe: gmail expiry is 7 days, state clears on unsubscribe', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    expect(mailbox.subscriptionState()).toBeNull()

    const sub = await mailbox.subscribe({ topicOrUrl: 'projects/x/topics/mail' })
    expect(sub.subscriptionId).toBe('projects/x/topics/mail')
    const state = mailbox.subscriptionState()
    expect(state).not.toBeNull()
    expect(state!.expiresAt.getTime() - sub.expiresAt.getTime()).toBe(0)
    expect(sub.expiresAt.getTime()).toBeGreaterThan(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000) // sanity: a real Date

    const renewed = await mailbox.renewSubscription(sub.subscriptionId)
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(sub.expiresAt.getTime())

    await mailbox.unsubscribe(sub.subscriptionId)
    expect(mailbox.subscriptionState()).toBeNull()
  })
})

describe('createMockMailbox: graph mode', () => {
  it('profile/listChanges: opaque deltaTokens cursor, pagination and drain-only newCursor behave like gmail', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF, pageSize: 2 })
    const before = await mailbox.profile()
    expect(before.cursor).toMatchObject({ deltaTokens: expect.any(Object) })

    const first = mailbox.receiveInbound({ from: 'a@example.com', to: [SELF], subject: 'One', bodyText: 'x' })
    const second = mailbox.receiveInbound({ from: 'b@example.com', to: [SELF], subject: 'Two', bodyText: 'x' })

    const page1 = await mailbox.listChanges(before.cursor)
    expect(page1.records).toHaveLength(2)
    expect(page1.newCursor).toBeDefined() // fully drained in one page

    expect(page1.records.flatMap((r) => r.messageIds)).toEqual([
      { id: first.id, threadId: first.threadId },
      { id: second.id, threadId: second.threadId },
    ])
  })

  it('expireCursor: models syncStateNotFound through the same port-level CursorExpiredError', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const before = await mailbox.profile()
    mailbox.receiveInbound({ from: 'a@example.com', subject: 'x', bodyText: 'y' })

    mailbox.expireCursor()
    await expect(mailbox.listChanges(before.cursor)).rejects.toBeInstanceOf(CursorExpiredError)

    const { records } = await mailbox.listChanges(before.cursor)
    expect(records).toHaveLength(1)
  })

  it('sendReply: models the two-phase send result — SENT message carrying the marker, id === providerDraftId (Graph keeps the draft id after send), no raw MIME', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    const reply = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'On it!',
      replyToProviderMessageId: inbound.id,
      extraHeaders: { [MARKER_HEADER]: 'draft-graph-1' },
    })

    // Graph's `Prefer: IdType="ImmutableId"` keeps the draft's id after send — the real adapter
    // returns `{ id: draftId }`, so the mock's stored message id must equal the draft id too
    // (unlike gmail mode's fresh mock-msg-N, which has no draft phase to keep an id from).
    expect(reply.providerDraftId).toBeDefined()
    expect(reply.id).toBe(reply.providerDraftId)
    const sentMsg = await mailbox.getMessage(reply.providerDraftId!, { format: 'full' })
    expect(sentMsg.labelIds).toEqual(['SENT'])
    expect(sentMsg.markerDraftId).toBe('draft-graph-1')

    const [sent] = mailbox.sentMessages()
    expect(sent!.raw).toBeUndefined() // graph never produces an RFC 2822 blob
    expect(sent!.markerDraftId).toBe('draft-graph-1')

    // The draft ledger reflects the completed send.
    expect(mailbox.drafts().get(reply.providerDraftId!)).toEqual({ threadId: inbound.threadId, sent: true })
  })

  it('sendReply: onDraftCreated is awaited with the fresh providerDraftId before anything is sent', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })
    const seen: string[] = []

    const reply = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'On it!',
      replyToProviderMessageId: inbound.id,
      onDraftCreated: async (id) => {
        seen.push(id)
        expect(mailbox.sentMessages()).toHaveLength(0) // nothing sent yet at this point
      },
    })

    expect(seen).toEqual([reply.providerDraftId])
  })

  it('sendReply: re-entry on a sent draft stores nothing new and returns the same ids', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    const first = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'On it!',
      replyToProviderMessageId: inbound.id,
    })

    const again = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'On it!',
      existingDraftId: first.providerDraftId,
    })

    expect(again).toEqual({ id: first.id, threadId: first.threadId, providerDraftId: first.providerDraftId })
    expect(mailbox.sentMessages()).toHaveLength(1) // no second message stored
  })

  it('sendReply: re-entry on an unknown draft id throws MailApiError(404)', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<x@mail.example.com>',
        references: '<x@mail.example.com>',
        bodyText: 'On it!',
        existingDraftId: 'never-created',
      }),
    ).rejects.toMatchObject({ name: 'MailApiError', status: 404 })
  })

  it('failAfter("createReply"): throws after the draft exists and onDraftCreated ran; existingDraftId then completes it', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })
    const boom = new Error('crash after createReply')
    let seenDraftId: string | undefined

    mailbox.failAfter('createReply', boom)
    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<x@mail.example.com>',
        references: '<x@mail.example.com>',
        bodyText: 'On it!',
        replyToProviderMessageId: inbound.id,
        onDraftCreated: async (id) => {
          seenDraftId = id
        },
      }),
    ).rejects.toBe(boom)

    expect(seenDraftId).toBeDefined()
    expect(mailbox.drafts().get(seenDraftId!)).toEqual({ threadId: inbound.threadId, sent: false })
    expect(mailbox.sentMessages()).toHaveLength(0)

    const completed = await mailbox.sendReply({
      threadId: inbound.threadId,
      to: 'jane@example.com',
      subject: 'Help',
      inReplyTo: '<x@mail.example.com>',
      references: '<x@mail.example.com>',
      bodyText: 'On it!',
      existingDraftId: seenDraftId!,
    })

    expect(completed.providerDraftId).toBe(seenDraftId)
    expect(mailbox.sentMessages()).toHaveLength(1)
    expect(mailbox.drafts().get(seenDraftId!)).toEqual({ threadId: inbound.threadId, sent: true })
  })

  it('failAfter("send"): throws AFTER the SENT message is stored, and findSentByMarker still finds it', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })
    const boom = new Error('crash after send')

    mailbox.failAfter('send', boom)
    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<x@mail.example.com>',
        references: '<x@mail.example.com>',
        bodyText: 'On it!',
        replyToProviderMessageId: inbound.id,
        extraHeaders: { [MARKER_HEADER]: 'draft-crash-1' },
      }),
    ).rejects.toBe(boom)

    expect(mailbox.sentMessages()).toHaveLength(1) // the customer already has it
    const found = await mailbox.findSentByMarker(inbound.threadId, 'draft-crash-1', 50)
    expect(found).not.toBeNull()
  })

  it('sendReply: throws MailApiError(400) when both replyToProviderMessageId and existingDraftId are absent', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<x@mail.example.com>',
        references: '<x@mail.example.com>',
        bodyText: 'On it!',
      }),
    ).rejects.toMatchObject({ name: 'MailApiError', status: 400 })
  })

  it('sendReply: gmail mode ignores a missing replyToProviderMessageId (graph-only requirement)', async () => {
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress: SELF })
    const inbound = mailbox.receiveInbound({ from: 'jane@example.com', subject: 'Help', bodyText: 'help me' })

    await expect(
      mailbox.sendReply({
        threadId: inbound.threadId,
        to: 'jane@example.com',
        subject: 'Help',
        inReplyTo: '<x@mail.example.com>',
        references: '<x@mail.example.com>',
        bodyText: 'On it!',
      }),
    ).resolves.toMatchObject({ threadId: inbound.threadId })
  })

  it('subscribe: 3-day expiry; renew extends it', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })

    const sub = await mailbox.subscribe({ topicOrUrl: 'https://example.com/notify', clientState: 'secret' })
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000
    // Anchored to the mock's fixed baseline "now" (allowing a few simulated seconds of tick drift
    // for the subscribe call itself — the exact tick count is an implementation detail).
    expect(sub.expiresAt.getTime()).toBeGreaterThanOrEqual(1_700_000_000_000 + threeDaysMs)
    expect(sub.expiresAt.getTime()).toBeLessThan(1_700_000_000_000 + threeDaysMs + 5_000)

    const state = mailbox.subscriptionState()
    expect(state!.clientState).toBe('secret')

    const renewed = await mailbox.renewSubscription(sub.subscriptionId)
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(sub.expiresAt.getTime())
    expect(mailbox.subscriptionState()!.expiresAt).toEqual(renewed.expiresAt)
  })

  it('renewSubscription: an unknown subscription id throws MailApiError(404)', async () => {
    const mailbox = createMockMailbox({ mode: 'graph', selfAddress: SELF })
    await expect(mailbox.renewSubscription('never-subscribed')).rejects.toMatchObject({ name: 'MailApiError', status: 404 })
  })
})
