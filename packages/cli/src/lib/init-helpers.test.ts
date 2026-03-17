import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeClaude,
  writeSkills,
  CLAUDE_MD_SENTINEL_START,
  CLAUDE_MD_SENTINEL_END,
} from './init-helpers.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'contextgit-init-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── writeClaude ───────────────────────────────────────────────────────────────

describe('writeClaude', () => {
  it('creates CLAUDE.md with sentinel when file does not exist', () => {
    const result = writeClaude(tmpDir)
    expect(result.status).toBe('written')
    const content = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(content).toContain(CLAUDE_MD_SENTINEL_START)
    expect(content).toContain(CLAUDE_MD_SENTINEL_END)
    expect(content).toContain('project_memory_load')
  })

  it('appends sentinel to existing CLAUDE.md', () => {
    const claudePath = join(tmpDir, 'CLAUDE.md')
    writeFileSync(claudePath, '# My Project\n\nExisting content.\n')
    const result = writeClaude(tmpDir)
    expect(result.status).toBe('written')
    const content = readFileSync(claudePath, 'utf8')
    expect(content).toContain('# My Project')
    expect(content).toContain('Existing content.')
    expect(content).toContain(CLAUDE_MD_SENTINEL_START)
  })

  it('is idempotent — skips if sentinel already present', () => {
    const claudePath = join(tmpDir, 'CLAUDE.md')
    writeClaude(tmpDir) // first call
    const afterFirst = readFileSync(claudePath, 'utf8')
    writeClaude(tmpDir) // second call
    const afterSecond = readFileSync(claudePath, 'utf8')
    expect(afterSecond).toBe(afterFirst) // no change
    // sentinel appears exactly once
    const occurrences = afterSecond.split(CLAUDE_MD_SENTINEL_START).length - 1
    expect(occurrences).toBe(1)
  })
})

// ── writeSkills ───────────────────────────────────────────────────────────────

describe('writeSkills', () => {
  it('creates both skill files under .claude/skills/', () => {
    const result = writeSkills(tmpDir)
    expect(result.status).toBe('written')
    const commitSkill = join(tmpDir, '.claude', 'skills', 'context-commit', 'SKILL.md')
    const branchSkill = join(tmpDir, '.claude', 'skills', 'context-branch', 'SKILL.md')
    expect(existsSync(commitSkill)).toBe(true)
    expect(existsSync(branchSkill)).toBe(true)
  })

  it('context-commit skill contains correct name frontmatter', () => {
    writeSkills(tmpDir)
    const content = readFileSync(
      join(tmpDir, '.claude', 'skills', 'context-commit', 'SKILL.md'),
      'utf8',
    )
    expect(content).toContain('name: context-commit')
    expect(content).toContain('project_memory_save')
  })

  it('context-branch skill contains correct name frontmatter', () => {
    writeSkills(tmpDir)
    const content = readFileSync(
      join(tmpDir, '.claude', 'skills', 'context-branch', 'SKILL.md'),
      'utf8',
    )
    expect(content).toContain('name: context-branch')
    expect(content).toContain('project_memory_branch')
  })

  it('overwrites existing skill files on repeated calls', () => {
    writeSkills(tmpDir) // first call
    const result = writeSkills(tmpDir) // second call
    expect(result.status).toBe('written')
  })
})
