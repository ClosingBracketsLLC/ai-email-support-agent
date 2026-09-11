#!/usr/bin/env tsx
/**
 * Idempotent bootstrap for the local/CI object store (minio): creates the dev bucket and attempts
 * to set its CORS policy so a browser can PUT a presigned upload from the Expo web origin. Safe to
 * run repeatedly — `BucketAlreadyOwnedByYou` on an existing bucket is swallowed, and `PutBucketCors`
 * always overwrites rather than appends.
 *
 * MinIO has no per-bucket CORS API — `PutBucketCors` always returns `501 NotImplemented` against it
 * (confirmed against the raw SDK, the AWS CLI, and minio's own `mc cors set`; see task-5-report.md).
 * CORS on minio is configured server-wide instead, via the `MINIO_API_CORS_ALLOW_ORIGIN` env var on
 * the minio container itself (`compose.yaml`'s `minio` service, and the CI `docker run` step) — this
 * script still issues the standard `PutBucketCors` call (a real S3 bucket in production DOES support
 * it), but tolerates ONLY minio's known 501 response and rethrows anything else, the same discipline
 * `CreateBucketCommand` above uses for `BucketAlreadyOwnedByYou`.
 *
 * Reads `S3_*` from the environment with the same dev defaults `compose.yaml`'s `minio` service
 * and `packages/db-init` use, so a bare `pnpm db:up && pnpm s3:init` works with no `.env` file.
 */
import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3'

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000'
const region = process.env.S3_REGION ?? 'us-east-1'
const bucket = process.env.S3_BUCKET ?? 'aesa-dev'
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'aesa'
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'aesaaesa'
const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true'
const corsOrigin = process.env.S3_CORS_ORIGIN ?? 'http://localhost:8081'

// `requestChecksumCalculation: 'WHEN_REQUIRED'` avoids an unnecessary flexible-checksum header on
// operations that don't need one (e.g. `CreateBucket`) — harmless here, though it has no effect on
// `PutBucketCors` below, which minio always 501s regardless of request headers (see module doc).
const client = new S3Client({
  endpoint,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
})

async function main() {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  } catch (err) {
    if (err instanceof Error && err.name !== 'BucketAlreadyOwnedByYou') throw err
  }

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [corsOrigin],
              AllowedMethods: ['PUT', 'GET'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    )
    console.log(`s3:init — bucket "${bucket}" ready at ${endpoint}, CORS allows ${corsOrigin}`)
  } catch (err) {
    const isMinioNotImplemented =
      err instanceof Error && (err.name === 'NotImplemented' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 501)
    if (!isMinioNotImplemented) throw err
    console.warn('s3:init — this endpoint has no per-bucket CORS API (MinIO): CORS is server-wide, set MINIO_API_CORS_ALLOW_ORIGIN to the web origin')
  }
}

await main()
