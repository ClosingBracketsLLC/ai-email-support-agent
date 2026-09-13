import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Secret } from '@aesa/crypto'
import type { ObjectStore } from './types.ts'

export interface CreateS3StoreOptions {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: Secret
  forcePathStyle: boolean
}

function isNotFound(err: unknown): boolean {
  if (err instanceof NotFound) return true
  const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
  return metadata?.httpStatusCode === 404
}

/** S3 (and S3-compatible — minio locally and in CI) `ObjectStore`. Every UPLOAD is a browser PUT
 * against a presigned URL this issues; the api/worker never proxy an upload's bytes themselves. The
 * Phase 7 export is the mirror case — the worker builds the bundle and `put`s it, the owner GETs it
 * through `presignGet` — see `types.ts` for why that one is safe to call from the api. */
export function createS3Store(cfg: CreateS3StoreOptions): ObjectStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey.expose() },
  })

  return {
    async presignPut(key, opts) {
      const command = new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: opts.contentType })
      const url = await getSignedUrl(client, command, { expiresIn: opts.expiresSeconds })
      return { url, headers: { 'content-type': opts.contentType } }
    },
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: bytes, ContentType: contentType }))
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }))
        return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType ?? null }
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
      if (!res.Body) throw new Error(`s3: object body missing for key ${key}`)
      return res.Body.transformToByteArray()
    },
    async presignGet(key, opts) {
      // No request is made: `getSignedUrl` installs a middleware that resolves the stack before the
      // HTTP handler, and the credentials above are static, so nothing reaches IMDS/STS either.
      // The api calls this inside a request (Task 8's `exportStatus`) and must not block on the net.
      const command = new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
      return getSignedUrl(client, command, { expiresIn: opts.expiresSeconds })
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
    },
  }
}
