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
    await store.put('k', new Uint8Array([1, 2, 3]), 'text/plain')
    expect(await store.head('k')).toEqual({ contentLength: 3, contentType: 'text/plain' })
    expect([...(await store.get('k'))]).toEqual([1, 2, 3])
    expect((await store.presignPut('k2', { contentType: 'text/plain', expiresSeconds: 600 })).url).toMatch(/^memory:\/\/k2/)
    await store.delete('k'); expect(await store.head('k')).toBeNull()
  })

  it('presignGet returns a memory: URL for the key (Phase 7: the export download link)', async () => {
    const store = createMemoryStore()
    await store.put('orgs/o1/exports/e1.ndjson', new Uint8Array([7]), 'application/x-ndjson')
    expect(await store.presignGet('orgs/o1/exports/e1.ndjson', { expiresSeconds: 600 })).toBe('memory://orgs/o1/exports/e1.ndjson')
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

  it('put writes the bytes server-side and presignGet hands back a URL that GETs them (Phase 7: workspace.export)', async () => {
    const store = createS3Store({ ...s3!, secretAccessKey: new Secret(s3!.secretAccessKey) })
    const key = `orgs/org-test/exports/${Date.now()}.ndjson`
    await store.put(key, new TextEncoder().encode('{"kind":"manifest"}\n'), 'application/x-ndjson')
    expect(await store.head(key)).toEqual({ contentLength: 20, contentType: 'application/x-ndjson' })

    const url = await store.presignGet(key, { expiresSeconds: 60 })
    const res = await fetch(url)
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('{"kind":"manifest"}\n')

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

/** `presignGet` is a local SigV4 computation, never a request: `getSignedUrl` installs a middleware
 *  that short-circuits the stack before the HTTP handler, and `createS3Store` passes STATIC
 *  credentials, so no credential provider reaches IMDS/STS either. Task 8 calls it inside an api
 *  request, so prove it offline: an endpoint nothing is listening on still resolves, promptly. */
describe('createS3Store.presignGet performs no network I/O', () => {
  it('signs against an unreachable endpoint without throwing', async () => {
    const store = createS3Store({
      endpoint: 'http://127.0.0.1:1', region: 'us-east-1', bucket: 'nowhere',
      accessKeyId: 'a', secretAccessKey: new Secret('b'), forcePathStyle: true,
    })
    const started = Date.now()
    const url = await store.presignGet('orgs/o/exports/e.ndjson', { expiresSeconds: 3600 })
    expect(url).toContain('http://127.0.0.1:1/nowhere/orgs/o/exports/e.ndjson')
    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('X-Amz-Expires=3600')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
