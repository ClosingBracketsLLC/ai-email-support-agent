/** Send-recovery marker header: stamped on every outbound draft/reply so a crashed or retried send
 * can be recovered (or de-duplicated) by scanning the thread for it. Named once here so the
 * mailbox client, any test mock, and the send path never drift on the literal string. */
export const MARKER_HEADER = 'X-Aesa-Draft'

export interface NormalizedMessage {
  id: string // provider message id
  threadId: string
  fromAddr: string | null // parsed lowercase addr-spec
  toAddrs: string[] // ALL occurrences, parsed lowercase addr-specs
  ccAddrs: string[]
  deliveredTo: string[]
  subject: string | null
  rfcMessageId: string | null
  inReplyTo: string | null
  references: string[] // tokenized <id> list
  authenticationResults: string | null // topmost header
  autoSubmitted: string | null // Auto-Submitted header (automated-mail detection)
  precedence: string | null // Precedence header
  listId: string | null // List-Id header
  internalDate: Date
  labelIds: string[] // gmail labels; graph maps folders → 'SENT'|'DRAFT'|'JUNK'|'TRASH'|'INBOX'
  bodyText: string | null // null on metadata fetch
  hasAttachments: boolean
  attachments: { filename: string | null; mime: string | null; size: number | null }[]
  markerDraftId: string | null // value of X-Aesa-Draft when fetched with metadata/full
}

export interface ChangeRecord {
  id: string
  messageIds: { id: string; threadId: string }[]
}

export interface ListChangesResult {
  records: ChangeRecord[]
  nextPageToken?: string
  newCursor?: unknown
}

export interface SendReplyInput {
  threadId: string
  to: string
  subject: string
  inReplyTo: string
  references: string
  bodyText: string
  from?: string
  extraHeaders?: Record<string, string>
  /** Graph replies target a MESSAGE id (createReply); Gmail ignores it. */
  replyToProviderMessageId?: string
  /** Graph crash re-entry: a persisted createReply draft id skips re-creation. */
  existingDraftId?: string
}

export interface MailboxClient {
  profile(): Promise<{ emailAddress: string; cursor: unknown }>
  listChanges(cursor: unknown, pageToken?: string): Promise<ListChangesResult> // throws CursorExpiredError
  listMessagesForResync(
    addresses: string[],
    sinceDays: number,
    pageToken?: string,
  ): Promise<{ ids: { id: string; threadId: string }[]; nextPageToken?: string }>
  getThreadMessageIds(threadId: string): Promise<{ id: string }[]>
  getMessage(id: string, opts: { format: 'metadata' | 'full' }): Promise<NormalizedMessage> // throws MessageGoneError
  sendReply(input: SendReplyInput): Promise<{ id: string; threadId: string; providerDraftId?: string }> // NEVER retried inside the client
  subscribe(input: { topicOrUrl: string; clientState?: string }): Promise<{ subscriptionId: string; expiresAt: Date }>
  renewSubscription(subscriptionId: string, expiresAt?: Date): Promise<{ subscriptionId: string; expiresAt: Date }>
  unsubscribe(subscriptionId: string): Promise<void>
  findSentByMarker(threadId: string, draftId: string, scanLimit: number): Promise<string | null> // provider msg id or null
}

export interface TokenSet {
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: Date | null
}

export interface MailboxProvider {
  readonly kind: 'gmail' | 'microsoft'
  authorizationUrl(p: {
    clientId: string
    redirectUri: string
    state: string
    codeChallenge: string
    loginHint?: string
  }): string
  exchangeCode(p: {
    clientId: string
    clientSecret: string
    redirectUri: string
    code: string
    codeVerifier: string
  }): Promise<{ tokens: TokenSet; emailAddress: string; providerAccountId: string }>
  refresh(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenSet> // microsoft rotates the refresh token
  revoke(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<void>
  client(accessToken: string, selfAddress: string): MailboxClient
}
