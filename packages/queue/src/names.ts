/**
 * The single source of job-name truth: the worker's job registrars and the api's enqueue seam both
 * import these literals rather than typing the string twice. Values are load-bearing (pg-boss queue
 * names, singletonKey namespacing) — changing one here changes the queue on the next deploy.
 */
export const JOB_NAMES = {
  keysProvision: 'keys.provision',
  storeCredentials: 'mailbox.store-credentials',
  revokeMailbox: 'mailbox.revoke',
  mailboxSync: 'mailbox.sync',
  ticketTriage: 'ticket.triage',
  ticketDraft: 'ticket.draft',
  agentSandbox: 'agent.sandbox',
  sendExecute: 'send.execute',
  notifyDispatch: 'notify.dispatch',
  knowledgeIngest: 'knowledge.ingest',
  knowledgeCrawl: 'knowledge.crawl',
  knowledgeEmbedBatch: 'knowledge.embed-batch',
} as const

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES]
