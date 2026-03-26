import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolveDbPath } from './resolve-db-path.js'

const EXTERNAL = (id: string) => join(homedir(), '.contextgit', 'projects', `${id}.db`)

function makeTmpDb(size: number): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `cg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'context.db'), Buffer.alloc(size))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('resolveDbPath', () => {
  it('returns :memory: for :memory: projectId, ignoring configDir', () => {
    expect(resolveDbPath(':memory:')).toBe(':memory:')
    expect(resolveDbPath(':memory:', '/some/dir')).toBe(':memory:')
  })

  it('returns local path when context.db exists and is populated (> 8 KB)', () => {
    const { dir, cleanup } = makeTmpDb(9 * 1024)
    try {
      expect(resolveDbPath('proj-abc', dir)).toBe(join(dir, 'context.db'))
    } finally {
      cleanup()
    }
  })

  it('falls back to external when context.db exists but is too small (empty schema)', () => {
    const { dir, cleanup } = makeTmpDb(4 * 1024) // 4 KB — mimics a freshly-init'd in-repo DB
    try {
      expect(resolveDbPath('proj-abc', dir)).toBe(EXTERNAL('proj-abc'))
    } finally {
      cleanup()
    }
  })

  it('falls back to external when context.db is exactly at the threshold (8 KB)', () => {
    const { dir, cleanup } = makeTmpDb(8 * 1024)
    try {
      expect(resolveDbPath('proj-abc', dir)).toBe(EXTERNAL('proj-abc'))
    } finally {
      cleanup()
    }
  })

  it('falls back to external when configDir is provided but context.db does not exist', () => {
    expect(resolveDbPath('proj-abc', '/nonexistent/project/.contextgit')).toBe(EXTERNAL('proj-abc'))
  })

  it('returns external path when configDir is not provided', () => {
    expect(resolveDbPath('proj-abc')).toBe(EXTERNAL('proj-abc'))
  })
})
