/** Where to go after sign-in when the user arrived through a deep link (an invitation). Process-local on purpose. */
let next: string | null = null
export function setNextPath(path: string | undefined | null) { if (path && path.startsWith('/') && !path.startsWith('//')) next = path }
export function takeNextPath(): string | null { const n = next; next = null; return n }
