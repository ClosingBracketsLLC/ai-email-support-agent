import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { platformRulesBlock, personaBlock } from '../src/index.ts'
import { buildReplyPolicy, personaFor, type PolicyAgent } from '../src/policy.ts'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const AGENT: PolicyAgent = {
  domain: 'acme.test',
  displayName: 'Acme Support',
  address: 'support@acme.test',
  replyFromAddress: null,
  personaPreset: 'support',
  personaText: 'Always mention the return window.',
}

const WORKSPACE = {
  allowedUrlHosts: ['acme.test'],
  allowedEmailDomains: ['acme.test'],
  contactPhone: '+1 555 0100',
  contactUrls: ['https://acme.test/contact'],
  locale: 'en',
}

describe('personaFor', () => {
  it('prefers the reply-from address, falling back to the mailbox address', () => {
    expect(personaFor(AGENT).address).toBe('support@acme.test')
    expect(personaFor({ ...AGENT, replyFromAddress: 'help@acme.test' }).address).toBe('help@acme.test')
  })

  it('carries the preset, the persona text and the display name through unchanged', () => {
    expect(personaFor(AGENT)).toMatchObject({
      preset: 'support',
      personaText: 'Always mention the return window.',
      displayName: 'Acme Support',
    })
  })
})

describe('buildReplyPolicy', () => {
  it('carries the four trusted texts, in order: platform rules, persona, workspace guidance, agent guidance', () => {
    const policy = buildReplyPolicy({
      workspace: WORKSPACE,
      agent: AGENT,
      workspaceGuidance: 'Refunds within 30 days.',
      agentGuidance: 'Mention the loyalty programme.',
      expectedLanguage: 'en',
    })

    expect(policy.trustedTexts).toEqual([
      platformRulesBlock().text,
      personaBlock(personaFor(AGENT)).text,
      'Refunds within 30 days.',
      'Mention the loyalty programme.',
    ])
    expect(policy.expectedLanguage).toBe('en')
    expect(policy.allowedHostnames).toContain('acme.test')
    expect(policy.allowedEmailDomains).toContain('acme.test')
  })

  it('is deterministic — two gates building it from the same inputs get byte-identical policies', () => {
    const args = {
      workspace: WORKSPACE,
      agent: AGENT,
      workspaceGuidance: 'Refunds within 30 days.',
      agentGuidance: '',
      expectedLanguage: null,
    }
    expect(buildReplyPolicy(args)).toEqual(buildReplyPolicy(args))
  })
})

describe('the @aesa/agent/policy sub-path is pure', () => {
  // P4: the api builds the SAME policy as the worker's gates, and per CLAUDE.md the api never calls
  // a model. This walks the REAL module graph (node + tsx, exactly how the apps run) rather than
  // vitest's, so a value import of `@aesa/llm` anywhere under src/policy.ts fails the test — the
  // Anthropic SDK must never be pulled into an api process by this import.
  it('imports without pulling in @aesa/llm or @anthropic-ai/sdk', () => {
    const probe = `
      import { registerHooks } from 'node:module'
      const seen = []
      registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context) } })
      const mod = await import('@aesa/agent/policy')
      console.log(JSON.stringify({ exports: Object.keys(mod).sort(), seen }))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { exports: string[]; seen: string[] }

    expect(result.exports).toEqual(['buildReplyPolicy', 'personaFor'])
    expect(result.seen).toContain('@aesa/agent/policy')   // the probe really resolved the sub-path
    expect(result.seen.filter((s) => s.includes('@aesa/llm') || s.includes('@anthropic-ai'))).toEqual([])
  })
})
