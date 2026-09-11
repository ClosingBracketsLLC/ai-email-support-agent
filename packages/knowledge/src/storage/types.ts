/** The provider-agnostic object storage port: S3 (and S3-compatible, e.g. minio) in production and
 * local dev, an in-memory adapter for tests that never touch a real bucket. Every upload flows
 * through a browser-issued presigned PUT — the api never proxies file bytes. */
export interface ObjectStore {
  presignPut(key: string, opts: { contentType: string; expiresSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>
  head(key: string): Promise<{ contentLength: number; contentType: string | null } | null>
  get(key: string): Promise<Uint8Array>
  delete(key: string): Promise<void>
}
