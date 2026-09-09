/** Where to go after sign-in when the user arrived through a deep link (an invitation). Process-local on purpose. */
let next: string | null = null
export function setNextPath(path: string | undefined | null) { if (path && path.startsWith('/') && !path.startsWith('//')) next = path }
/** Pure read — safe to call during render. Pair with clearNextPath() from an effect once the value has been consumed. */
export function peekNextPath(): string | null { return next }
export function clearNextPath(): void { next = null }
