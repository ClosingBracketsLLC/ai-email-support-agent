#!/usr/bin/env tsx
/**
 * Idempotent bootstrap for the local/CI object store (minio): creates the dev bucket and sets its
 * CORS policy so a browser can PUT a presigned upload from the Expo web origin. Safe to run
 * repeatedly — `BucketAlreadyOwnedByYou` on an existing bucket is swallowed, and `PutBucketCors`
 * always overwrites rather than appends.
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
// operations that don't need one (e.g. `CreateBucket`) — harmless here, though it does NOT change
// the `PutBucketCors` behaviour below (see that comment).
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
    // `PutBucketCors` returns 501 NotImplemented against the current `minio/minio:latest`
    // (RELEASE.2025-09-07T16-13-09Z) — reproduced identically with the AWS CLI and with minio's
    // OWN `mc cors set` client talking to its own server, so this is a server-side gap in this
    // minio build, not a header/SDK-version mismatch on our end (ruled out: stripping every
    // checksum/MD5 header before signing made no difference). The dev bucket itself is still
    // created and fully usable — `createS3Store`'s presign/PUT/head/get/delete round-trip works
    // against this same minio — a real browser upload just won't clear CORS preflight until minio
    // fixes this or the image is pinned to a release where it works. Warn, don't fail the script:
    // failing here would also block the object-store round-trip tests that DO work.
    console.warn(`s3:init — WARNING: bucket "${bucket}" is ready, but setting its CORS policy failed (browser uploads will fail CORS preflight until this is fixed):`)
    console.warn(err instanceof Error ? err.message : String(err))
  }
}

await main()
