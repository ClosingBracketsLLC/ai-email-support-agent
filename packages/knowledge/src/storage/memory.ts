import type { ObjectStore } from './types.ts'

export interface MemoryObject {
  bytes: Uint8Array
  contentType: string
}

export interface MemoryStore extends ObjectStore {
  objects: Map<string, MemoryObject>
}

/** In-process `ObjectStore` for tests — no bucket, no network. `presignPut`/`presignGet` return a
 * fake `memory://` URL rather than issuing a real presigned request; nothing fetches against it, so
 * callers that need the round-trip use `put()`/`get()` directly instead. */
export function createMemoryStore(): MemoryStore {
  const objects = new Map<string, MemoryObject>()

  return {
    objects,
    async put(key, bytes, contentType) {
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
    async presignGet(key) {
      return `memory://${key}`
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}
