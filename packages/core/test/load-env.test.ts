import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDotEnv } from '../src/load-env.ts'

describe('loadDotEnv', () => {
  const dirs: string[] = []
  const envKeys: string[] = []

  afterEach(() => {
    for (const key of envKeys.splice(0)) delete process.env[key]
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('loads vars from .env resolved relative to the caller, without overriding an existing var', () => {
    const root = mkdtempSync(join(tmpdir(), 'aesa-load-env-'))
    dirs.push(root)
    // Caller lives two levels below root (root/src/index.ts), so `../.env` resolves to root/.env —
    // mirroring how apps/api/src/index.ts resolves apps/api/.env.
    writeFileSync(join(root, '.env'), 'FRESH_VAR=from-file\nEXISTING_VAR=from-file\n')
    const callerUrl = pathToFileURL(join(root, 'src', 'index.ts')).href

    envKeys.push('EXISTING_VAR', 'FRESH_VAR')
    process.env.EXISTING_VAR = 'from-env'

    const found = loadDotEnv(callerUrl)

    expect(found).toBe(true)
    expect(process.env.FRESH_VAR).toBe('from-file')
    expect(process.env.EXISTING_VAR).toBe('from-env')
  })

  it('returns false when the .env file is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'aesa-load-env-'))
    dirs.push(root)
    const callerUrl = pathToFileURL(join(root, 'src', 'index.ts')).href

    expect(loadDotEnv(callerUrl)).toBe(false)
  })
})
