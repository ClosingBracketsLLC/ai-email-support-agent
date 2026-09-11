import { describe, expect, it } from 'vitest'
import { Secret } from '@aesa/crypto'
import { createMemoryStore, createS3Store, parseS3Env, uploadKey } from '../src/index.ts'

describe('uploadKey / parseS3Env', () => {
  it('keys under orgs/<orgId>/uploads/<sourceId>/<fileName>', () => {
    expect(uploadKey('org1', 'src1', 'Returns policy.pdf')).toBe('orgs/org1/uploads/src1/Returns policy.pdf')
  })
  it('parses the six variables as all-or-none', () => {
    expect(parseS3Env({})).toBeNull()
    expect(parseS3Env({ S3_ENDPOINT: 'http://localhost:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'aesa-dev', S3_ACCESS_KEY_ID: 'aesa', S3_SECRET_ACCESS_KEY: 'aesaaesa', S3_FORCE_PATH_STYLE: 'true' }))
      .toMatchObject({ endpoint: 'http://localhost:9000', bucket: 'aesa-dev', forcePathStyle: true })
    expect(() => parseS3Env({ S3_ENDPOINT: 'http://localhost:9000' })).toThrow(/all-or-none/)
  })
})

describe('createMemoryStore', () => {
  it('round-trips put/head/get/delete and presigns a memory: URL', async () => {
    const store = createMemoryStore()
    store.put('k', new Uint8Array([1, 2, 3]), 'text/plain')
    expect(await store.head('k')).toEqual({ contentLength: 3, contentType: 'text/plain' })
    expect([...(await store.get('k'))]).toEqual([1, 2, 3])
    expect((await store.presignPut('k2', { contentType: 'text/plain', expiresSeconds: 600 })).url).toMatch(/^memory:\/\/k2/)
    await store.delete('k'); expect(await store.head('k')).toBeNull()
  })
})

// Runs only where minio is up (CI, or `pnpm db:up && pnpm s3:init` locally).
const s3 = parseS3Env(process.env)
describe.skipIf(!s3)('createS3Store against minio', () => {
  it('presigns a PUT the browser can use, then head/get/delete see the object', async () => {
    const store = createS3Store({ ...s3!, secretAccessKey: new Secret(s3!.secretAccessKey) })
    const key = uploadKey('org-test', `src-${Date.now()}`, 'hello.txt')
    const { url, headers } = await store.presignPut(key, { contentType: 'text/plain', expiresSeconds: 60 })
    const res = await fetch(url, { method: 'PUT', body: 'hello', headers })
    expect(res.ok).toBe(true)
    expect(await store.head(key)).toEqual({ contentLength: 5, contentType: 'text/plain' })
    expect(new TextDecoder().decode(await store.get(key))).toBe('hello')
    await store.delete(key); expect(await store.head(key)).toBeNull()
  })

  it('clears a real cross-origin preflight and PUT — minio\'s server-wide MINIO_API_CORS_ALLOW_ORIGIN, not a per-bucket policy', async () => {
    const store = createS3Store({ ...s3!, secretAccessKey: new Secret(s3!.secretAccessKey) })
    const key = uploadKey('org-test', `src-cors-${Date.now()}`, 'hello.txt')
    const { url, headers } = await store.presignPut(key, { contentType: 'text/plain', expiresSeconds: 60 })

    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    })
    const allowOrigin = preflight.headers.get('access-control-allow-origin')
    expect(allowOrigin === 'http://localhost:8081' || allowOrigin === '*').toBe(true)

    const res = await fetch(url, { method: 'PUT', body: 'hello', headers: { ...headers, origin: 'http://localhost:8081' } })
    expect(res.ok).toBe(true)

    await store.delete(key)
  })
})
