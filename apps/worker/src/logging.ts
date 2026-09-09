import pino from 'pino'

/** One structured logger for the worker; LOG_LEVEL finally has a consumer (Phase 1 carry-over). */
export function createWorkerLogger(level: string, stream?: { write(s: string): void }): pino.Logger {
  return pino(
    {
      level,
      redact: { paths: ['authorization', '*.authorization', 'headers.authorization', 'accessToken', '*.accessToken', 'refreshToken', '*.refreshToken'] },
      base: { service: 'aesa-worker' },
    },
    stream ?? pino.destination(1),
  )
}
