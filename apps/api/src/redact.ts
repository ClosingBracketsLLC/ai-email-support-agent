/** Every query value and any path segment that looks like a token (base64url, 32+ chars) is masked before logging. */
export function redactUrl(url: string): string {
  const [path, query] = url.split('?', 2)
  const safePath = path!.split('/').map((seg) => (/^[A-Za-z0-9_-]{32,}$/.test(seg) && !/^[0-9a-f-]{36}$/i.test(seg) ? '[redacted]' : seg)).join('/')
  if (query === undefined) return safePath
  const safeQuery = query.split('&').map((pair) => { const i = pair.indexOf('='); return i === -1 ? pair : `${pair.slice(0, i)}=[redacted]` }).join('&')
  return `${safePath}?${safeQuery}`
}
