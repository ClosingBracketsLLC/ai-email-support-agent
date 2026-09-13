/** The provider-agnostic object storage port: S3 (and S3-compatible, e.g. minio) in production and
 * local dev, an in-memory adapter for tests that never touch a real bucket. Uploads flow through a
 * browser-issued presigned PUT — the api never proxies an UPLOAD's bytes.
 *
 * `put`/`presignGet` are the Phase 7 pair the workspace export needs, and they are deliberately the
 * mirror image of that: the worker builds the NDJSON bundle itself and PUTs it server-side (no
 * browser is involved), and the owner later downloads it through a presigned GET the api hands them.
 * `presignGet` is a local SigV4 computation in the S3 adapter — `getSignedUrl` short-circuits the
 * client's middleware stack before the HTTP handler, and `createS3Store` passes static credentials —
 * so it is safe to call inside an api request (`packages/knowledge/test/storage.test.ts` pins that
 * against an endpoint nothing is listening on). */
export interface ObjectStore {
  presignPut(key: string, opts: { contentType: string; expiresSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>
  /** Server-side write, used by `workspace.export`; browser uploads still go through `presignPut`. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  head(key: string): Promise<{ contentLength: number; contentType: string | null } | null>
  get(key: string): Promise<Uint8Array>
  /** A time-limited download URL. No network I/O — see the port's doc comment. */
  presignGet(key: string, opts: { expiresSeconds: number }): Promise<string>
  delete(key: string): Promise<void>
}
