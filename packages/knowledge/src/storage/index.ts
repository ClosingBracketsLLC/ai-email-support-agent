/**
 * `@aesa/knowledge/storage` — the pure object-store sub-path. This barrel (and every module it
 * re-exports: `types.ts`, `keys.ts`, `memory.ts`, `s3.ts`) must NEVER import `@aesa/llm`, anything
 * under `../parsers/`, `../chunker.ts`, `../embed/`, or `../crawler/engine.ts`.
 *
 * Why: the api process (`apps/api`) needs only the `ObjectStore` port — `startUpload`'s presigned
 * PUT and `deleteSource`'s cleanup — and CLAUDE.md says the api never calls a model. The package
 * ROOT barrel (`@aesa/knowledge`'s `index.ts`) also re-exports the chunker and the embedders, which
 * value-import `estimateTokens` from `@aesa/llm`'s root — which resolves the Anthropic SDK — and
 * the parsers/crawler engine, which pull `pdfjs-dist`, `mammoth` and `undici`. Importing THIS
 * sub-path instead (never the package root) is what keeps every one of those out of an api process's
 * module graph, the same shape `@aesa/agent/policy` uses to keep the api Anthropic-SDK-free. The
 * worker keeps using the root barrel unchanged — it is the one process meant to hold all of this.
 * `apps/api/test/error-surface.test.ts` walks the real module graph to hold this invariant.
 */
export { type ObjectStore } from './types.ts'
export { parseS3Env, uploadKey, type S3Config } from './keys.ts'
export { createMemoryStore } from './memory.ts'
export { createS3Store, type CreateS3StoreOptions } from './s3.ts'
