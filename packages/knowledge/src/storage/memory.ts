import type { ObjectStore } from './types.ts'

export interface MemoryObject {
  bytes: Uint8Array
  contentType: string
}

export interface MemoryStore extends ObjectStore {
  objects: Map<string, MemoryObject>
  put(key: string, bytes: Uint8Array, contentType: string): void
}

/** In-process `ObjectStore` for tests — no bucket, no network. `presignPut` returns a fake
 * `memory://` URL rather than issuing a real presigned request; nothing PUTs against it, so
 * callers that need the round-trip use `put()` directly instead. */
export function createMemoryStore(): MemoryStore {
  const objects = new Map<string, MemoryObject>()

  return {
    objects,
    put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType })
    },
    async presignPut(key, opts) {
      return { url: `memory://${key}`, headers: { 'content-type': opts.contentType } }
    },
    async head(key) {
      const object = objects.get(key)
      if (!object) return null
      return { contentLength: object.bytes.byteLength, contentType: object.contentType }
    },
    async get(key) {
      const object = objects.get(key)
      if (!object) throw new Error(`memory store: no object at key ${key}`)
      return object.bytes
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}
