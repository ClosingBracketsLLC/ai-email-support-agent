import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface LocalOrigin {
  port: number
  close(): Promise<void>
}

/**
 * Starts `handler` on 127.0.0.1 on an ephemeral port, for the SSRF suites that need a real socket.
 * Every caller names the host `pinned.invalid` — a host that cannot resolve — and pins 127.0.0.1,
 * so a response at all proves the dispatcher connected to the PINNED address rather than to DNS.
 */
export async function startLocalOrigin(handler: RequestListener): Promise<LocalOrigin> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}
