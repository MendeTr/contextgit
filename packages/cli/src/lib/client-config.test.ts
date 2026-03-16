import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectClients, injectMcpServer, isAlreadyInjected } from './client-config.js'

const SYSTEM_PROMPT = 'test system prompt'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'contextgit-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// 1. detectClients returns empty array when no config files exist
it('detectClients returns empty array when no config files exist', () => {
  const result = detectClients(tmpDir)
  expect(result).toEqual([])
})

// 2. detectClients returns Claude Code entry when ~/.claude.json exists
it('detectClients returns claude-code when .claude.json exists', () => {
  writeFileSync(join(tmpDir, '.claude.json'), '{}')
  const result = detectClients(tmpDir)
  expect(result).toHaveLength(1)
  expect(result[0].type).toBe('claude-code')
  expect(result[0].path).toBe(join(tmpDir, '.claude.json'))
})

// 3. injectMcpServer writes correct JSON structure to a new empty config file
it('injectMcpServer writes correct JSON to a new empty config file', () => {
  const configPath = join(tmpDir, '.claude.json')
  // file does not exist yet
  const result = injectMcpServer(configPath, 'claude-code', SYSTEM_PROMPT)
  expect(result.status).toBe('injected')
  const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const servers = written['mcpServers'] as Record<string, unknown>
  expect(servers).toBeDefined()
  const entry = servers['contextgit'] as Record<string, unknown>
  expect(entry['command']).toBe('npx')
  expect(entry['args']).toEqual(['contextgit', 'mcp'])
  expect(entry['systemPrompt']).toBe(SYSTEM_PROMPT)
})

// 4. injectMcpServer merges into existing config without touching other keys
it('injectMcpServer merges without touching other keys', () => {
  const configPath = join(tmpDir, '.claude.json')
  writeFileSync(configPath, JSON.stringify({
    someOtherKey: 'keep-me',
    mcpServers: { 'other-server': { command: 'npx', args: ['other'] } },
  }))
  const result = injectMcpServer(configPath, 'claude-code', SYSTEM_PROMPT)
  expect(result.status).toBe('injected')
  const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  expect(written['someOtherKey']).toBe('keep-me')
  const servers = written['mcpServers'] as Record<string, unknown>
  expect(servers['other-server']).toBeDefined()
  expect(servers['contextgit']).toBeDefined()
})

// 5. injectMcpServer returns already-present if contextgit key exists
it('injectMcpServer returns already-present if contextgit exists', () => {
  const configPath = join(tmpDir, '.claude.json')
  writeFileSync(configPath, JSON.stringify({
    mcpServers: { contextgit: { command: 'npx', args: ['contextgit', 'mcp'] } },
  }))
  const result = injectMcpServer(configPath, 'claude-code', SYSTEM_PROMPT)
  expect(result.status).toBe('already-present')
})

// 6. injectMcpServer returns error and does not write if existing file is invalid JSON
it('injectMcpServer returns error and does not write if file is invalid JSON', () => {
  const configPath = join(tmpDir, '.claude.json')
  writeFileSync(configPath, 'NOT JSON {{{')
  const originalContent = readFileSync(configPath, 'utf8')
  const result = injectMcpServer(configPath, 'claude-code', SYSTEM_PROMPT)
  expect(result.status).toBe('error')
  expect(result.reason).toContain('not valid JSON')
  // File must not have been overwritten
  expect(readFileSync(configPath, 'utf8')).toBe(originalContent)
})

// 7. injectMcpServer uses atomic write (temp file + rename)
it('injectMcpServer cleans up temp file after write', () => {
  const configPath = join(tmpDir, '.claude.json')
  injectMcpServer(configPath, 'claude-code', SYSTEM_PROMPT)
  // Temp file should not exist after successful rename
  expect(existsSync(configPath + '.contextgit-tmp')).toBe(false)
  // Final file should exist
  expect(existsSync(configPath)).toBe(true)
})

// 8. isAlreadyInjected returns true when contextgit is present under mcpServers
describe('isAlreadyInjected', () => {
  it('returns true when contextgit is under mcpServers', () => {
    expect(isAlreadyInjected({ mcpServers: { contextgit: {} } })).toBe(true)
  })

  it('returns false when contextgit is absent', () => {
    expect(isAlreadyInjected({ mcpServers: { other: {} } })).toBe(false)
  })

  it('returns false when mcpServers is missing', () => {
    expect(isAlreadyInjected({})).toBe(false)
  })
})
