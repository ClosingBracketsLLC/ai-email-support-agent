import { inspect } from 'node:util'

/** Wraps a secret string so accidental logging, JSON serialization or template interpolation prints [redacted]. */
export class Secret {
  readonly #value: string
  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Secret requires a non-empty string')
    this.#value = value
  }
  expose(): string { return this.#value }
  toString(): string { return '[redacted]' }
  toJSON(): string { return '[redacted]' }
  [inspect.custom](): string { return 'Secret([redacted])' }
}
