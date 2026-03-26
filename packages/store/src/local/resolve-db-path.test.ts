import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { resolveDbPath } from './resolve-db-path.js'

describe('resolveDbPath', () => {
  it('returns :memory: for :memory: projectId, ignoring configDir', () => {
    expect(resolveDbPath(':memory:')).toBe(':memory:')
    expect(resolveDbPath(':memory:', '/some/dir')).toBe(':memory:')
  })

  it('returns local path when configDir is provided', () => {
    const result = resolveDbPath('proj-abc', '/home/user/project/.contextgit')
    expect(result).toBe('/home/user/project/.contextgit/context.db')
  })

  it('returns local path even when context.db does not exist yet (no filesystem check)', () => {
    const result = resolveDbPath('new-project', '/brand/new/project/.contextgit')
    expect(result).toBe('/brand/new/project/.contextgit/context.db')
  })

  it('returns external path when configDir is not provided', () => {
    const result = resolveDbPath('proj-abc')
    expect(result).toBe(join(homedir(), '.contextgit', 'projects', 'proj-abc.db'))
  })
})
