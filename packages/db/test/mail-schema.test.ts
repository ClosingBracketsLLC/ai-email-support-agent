import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createDb } from '../src/raw.ts'
import { createTestDatabase } from '../src/testing.ts'

let url: string, drop: () => Promise<void>, admin: pg.Pool
let orgId: string, connectionId: string

beforeAll(async () => {
  ;({ url, drop } = await createTestDatabase())
  admin = new pg.Pool({ connectionString: url })
  const org = await admin.query<{ id: string }>(
    `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
    ['Acme', `acme-${randomBytes(4).toString('hex')}`],
  )
  orgId = org.rows[0]!.id
  const usr = await admin.query<{ id: string }>(
    `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
    ['Owner', `owner-${randomBytes(4).toString('hex')}@example.com`],
  )
  const userId = usr.rows[0]!.id
  const conn = await admin.query<{ id: string }>(
    `INSERT INTO mailbox_connections (org_id, provider, provider_account_id, email_address, status, connected_by_user_id)
     VALUES ($1, 'gmail', 'acct-1', 'support@acme.com', 'connected', $2) RETURNING id`,
    [orgId, userId],
  )
  connectionId = conn.rows[0]!.id
})
afterAll(async () => {
  await admin.end()
  await drop()
})

describe('mailbox_credentials privilege boundary', () => {
  it('aesa_app has NO privilege on the credentials table; aesa_platform has full DML', async () => {
    // a real LOGIN role that is a member of aesa_app ONLY — the production api shape (STATUS.md carry-over:
    // CI finally exercises the privilege boundary through a non-superuser LOGIN role). Randomized per test
    // db: roles are cluster-scoped, and other test files run concurrently against the same cluster.
    const roleName = `api_login_${randomBytes(4).toString('hex')}`
    await admin.query(`DO $$ BEGIN CREATE ROLE ${roleName} LOGIN PASSWORD 'x'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
    await admin.query(`GRANT aesa_app TO ${roleName}`)
    const dbName = new URL(url).pathname.slice(1)
    await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${roleName}`)
    const apiPool = new pg.Pool({ connectionString: url.replace(/\/\/[^@]+@/, `//${roleName}:x@`) })
    const c = await apiPool.connect()
    try {
      await c.query('SET ROLE aesa_app')
      await c.query(`SELECT set_config('app.org_id', $1, false)`, [orgId])
      for (const q of [
        ['SELECT refresh_token_ciphertext FROM mailbox_credentials'],
        [`INSERT INTO mailbox_credentials (connection_id, org_id, refresh_token_ciphertext, encryption) VALUES ($1, $2, $3, 'sealed')`, [connectionId, orgId, Buffer.from('x')]],
        [`UPDATE mailbox_credentials SET encryption = 'dek'`],
        ['DELETE FROM mailbox_credentials'],
      ] as const) {
        await expect(c.query(q[0] as string, (q[1] ?? []) as unknown[])).rejects.toMatchObject({ code: '42501' })
      }
      // sanity: the same login CAN read the tables the api legitimately uses
      await c.query(`SELECT count(*) FROM mailbox_connections`)
    } finally {
      c.release()
      await apiPool.end()
    }
  })

  it('aesa_platform has full DML on mailbox_credentials', async () => {
    const platformDb = createDb(url, { role: 'app' })
    try {
      const platformPool = platformDb.pool
      const c = await platformPool.connect()
      try {
        await c.query('SET ROLE aesa_platform')
        await c.query(
          `INSERT INTO mailbox_credentials (connection_id, org_id, refresh_token_ciphertext, encryption) VALUES ($1, $2, $3, 'sealed')`,
          [connectionId, orgId, Buffer.from('platform-write')],
        )
        const sel = await c.query('SELECT refresh_token_ciphertext FROM mailbox_credentials WHERE connection_id = $1', [connectionId])
        expect(sel.rows).toHaveLength(1)
        await c.query(`UPDATE mailbox_credentials SET encryption = 'dek' WHERE connection_id = $1`, [connectionId])
        await c.query('DELETE FROM mailbox_credentials WHERE connection_id = $1', [connectionId])
      } finally {
        c.release()
      }
    } finally {
      await platformDb.pool.end()
    }
  })
})

describe('SECURITY DEFINER resolvers', () => {
  let appDb: ReturnType<typeof createDb>
  let orgB: string
  let disabledOnlyEmail: string

  beforeAll(async () => {
    appDb = createDb(url, { role: 'app' })
    const org = await admin.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      ['Other Org', `other-${randomBytes(4).toString('hex')}`],
    )
    orgB = org.rows[0]!.id
    const usr = await admin.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      ['Owner B', `ownerb-${randomBytes(4).toString('hex')}@example.com`],
    )
    const userBId = usr.rows[0]!.id

    // the fixture connection (orgId/connectionId, set up in the top-level beforeAll) gets the push fields
    // this describe block asserts on
    await admin.query(
      `UPDATE mailbox_connections SET push_subscription_id = 'sub-123', push_client_state_hash = 'hash-abc' WHERE id = $1`,
      [connectionId],
    )

    // a DISABLED duplicate of the same (provider, email) in a different org — the partial unique index
    // (provider, email_address) WHERE status <> 'disabled' allows this to coexist; the resolver must not
    // return it in place of the connected row
    await admin.query(
      `INSERT INTO mailbox_connections (org_id, provider, provider_account_id, email_address, status, connected_by_user_id)
       VALUES ($1, 'gmail', 'acct-2', 'support@acme.com', 'disabled', $2)`,
      [orgB, userBId],
    )

    // a disabled-ONLY address: the resolver must return nothing for it
    disabledOnlyEmail = 'gone@old.com'
    await admin.query(
      `INSERT INTO mailbox_connections (org_id, provider, provider_account_id, email_address, status, connected_by_user_id)
       VALUES ($1, 'gmail', 'acct-3', $2, 'disabled', $3)`,
      [orgB, disabledOnlyEmail, userBId],
    )
  })
  afterAll(async () => {
    await appDb.pool.end()
  })

  it('resolves a connection by (provider, email) without aesa_platform and ignores disabled rows', async () => {
    // as aesa_app with NO app.org_id set: direct SELECT returns zero rows, the resolver returns the row
    const direct = await appDb.pool.query<{ count: string }>('SELECT count(*) FROM mailbox_connections')
    expect(direct.rows[0]!.count).toBe('0')

    const res = await appDb.pool.query(
      `SELECT * FROM resolve_mailbox_connection($1, $2)`,
      ['gmail', 'support@acme.com'],
    )
    expect(res.rows).toEqual([{ connection_id: connectionId, org_id: orgId, client_state_hash: 'hash-abc' }])

    const none = await appDb.pool.query(`SELECT * FROM resolve_mailbox_connection($1, $2)`, ['gmail', disabledOnlyEmail])
    expect(none.rows).toEqual([])
  })

  it('resolve_mailbox_subscription finds the row by push_subscription_id, carrying client_state_hash', async () => {
    const res = await appDb.pool.query(`SELECT * FROM resolve_mailbox_subscription($1)`, ['sub-123'])
    expect(res.rows).toEqual([{ connection_id: connectionId, org_id: orgId, client_state_hash: 'hash-abc' }])

    const none = await appDb.pool.query(`SELECT * FROM resolve_mailbox_subscription($1)`, ['no-such-sub'])
    expect(none.rows).toEqual([])
  })
})
