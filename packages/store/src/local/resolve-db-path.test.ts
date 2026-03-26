import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolveDbPath } from './resolve-db-path.js'

describe('resolveDbPath', () => {
  it('returns :memory: for :memory: projectId, ignoring configDir', () => {
    expect(resolveDbPath(':memory:')).toBe(':memory:')
    expect(resolveDbPath(':memory:', '/some/dir')).toBe(':memory:')
  })

  it('returns local path when configDir is provided and context.db exists', () => {
    const dir = join(tmpdir(), `cg-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'context.db'), '')
    try {
      expect(resolveDbPath('proj-abc', dir)).toBe(join(dir, 'context.db'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to external path when configDir is provided but context.db does not exist (migration safety)', () => {
    // Non-existent dir — context.db definitely absent
    const result = resolveDbPath('proj-abc', '/nonexistent/project/.contextgit')
    expect(result).toBe(join(homedir(), '.contextgit', 'projects', 'proj-abc.db'))
  })

  it('returns external path when configDir is not provided', () => {
    const result = resolveDbPath('proj-abc')
    expect(result).toBe(join(homedir(), '.contextgit', 'projects', 'proj-abc.db'))
  })
})
