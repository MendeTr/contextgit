import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeClaude,
  writeSkills,
  registerMcp,
  patchGitignore,
  patchClaudeSettings,
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

// ── registerMcp ───────────────────────────────────────────────────────────────

describe('registerMcp', () => {
  it('creates ~/.claude.json with contextgit entry when file does not exist', () => {
    const claudeJsonPath = join(tmpDir, '.claude.json')
    const result = registerMcp(claudeJsonPath)
    expect(result.status).toBe('registered')
    const json = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    expect(json.mcpServers.contextgit).toEqual({ command: 'contextgit-mcp', args: [], type: 'stdio' })
  })

  it('adds contextgit entry to existing file without overwriting other keys', () => {
    const claudeJsonPath = join(tmpDir, '.claude.json')
    writeFileSync(claudeJsonPath, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other-mcp' } } }, null, 2))
    const result = registerMcp(claudeJsonPath)
    expect(result.status).toBe('registered')
    const json = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    expect(json.theme).toBe('dark')
    expect(json.mcpServers.other).toBeDefined()
    expect(json.mcpServers.contextgit).toEqual({ command: 'contextgit-mcp', args: [], type: 'stdio' })
  })

  it('returns already-present and does not mutate file when contextgit entry exists', () => {
    const claudeJsonPath = join(tmpDir, '.claude.json')
    const initial = { mcpServers: { contextgit: { command: 'contextgit-mcp', args: [], type: 'stdio' } } }
    writeFileSync(claudeJsonPath, JSON.stringify(initial, null, 2))
    const result = registerMcp(claudeJsonPath)
    expect(result.status).toBe('already-present')
    expect(JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))).toEqual(initial)
  })

  it('returns error when file path is not writable', () => {
    const result = registerMcp('/nonexistent-dir/that/cannot/exist/.claude.json')
    expect(result.status).toBe('error')
    expect(result.reason).toBeDefined()
  })
})

// ── patchClaudeSettings ───────────────────────────────────────────────────────

describe('patchClaudeSettings', () => {
  it('creates .claude/settings.json with both hooks when file does not exist', () => {
    const result = patchClaudeSettings(tmpDir)
    expect(result.status).toBe('patched')
    const settingsPath = join(tmpDir, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)
    const json = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    // SessionStart (not UserPromptSubmit)
    expect(json.hooks.SessionStart).toHaveLength(1)
    expect(json.hooks.SessionStart[0].hooks[0].command).toContain('project_memory_load')
    // PostToolUse with native if condition
    expect(json.hooks.PostToolUse).toHaveLength(1)
    expect(json.hooks.PostToolUse[0].matcher).toBe('Bash')
    expect(json.hooks.PostToolUse[0].if).toBe('Bash(git commit*)')
    expect(json.hooks.PostToolUse[0].hooks[0].command).toContain('project_memory_save')
    // No UserPromptSubmit
    expect(json.hooks.UserPromptSubmit).toBeUndefined()
  })

  it('merges hooks into existing settings.json without overwriting other keys', () => {
    const settingsPath = join(tmpDir, '.claude', 'settings.json')
    require('fs').mkdirSync(join(tmpDir, '.claude'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(git:*)'] } }, null, 2))
    patchClaudeSettings(tmpDir)
    const json = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(json.permissions.allow).toContain('Bash(git:*)')
    expect(json.hooks.SessionStart).toBeDefined()
    expect(json.hooks.PostToolUse).toBeDefined()
  })

  it('is idempotent — returns already-present on second call', () => {
    patchClaudeSettings(tmpDir)
    const result = patchClaudeSettings(tmpDir)
    expect(result.status).toBe('already-present')
    const json = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'))
    // hooks not duplicated
    expect(json.hooks.SessionStart).toHaveLength(1)
  })
})

// ── patchGitignore ────────────────────────────────────────────────────────────

describe('patchGitignore', () => {
  it('creates .gitignore when none exists', () => {
    const result = patchGitignore(tmpDir)
    expect(result.status).toBe('created')
    const contents = readFileSync(join(tmpDir, '.gitignore'), 'utf-8')
    expect(contents).toContain('!.contextgit/context.db')
  })

  it('appends exception when .gitignore exists without it', () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\n*.db\n')
    const result = patchGitignore(tmpDir)
    expect(result.status).toBe('patched')
    const contents = readFileSync(join(tmpDir, '.gitignore'), 'utf-8')
    expect(contents).toContain('*.db')
    expect(contents).toContain('!.contextgit/context.db')
    // Exception must come after the *.db rule
    expect(contents.indexOf('*.db')).toBeLessThan(contents.indexOf('!.contextgit/context.db'))
  })

  it('returns already-present when exception already exists', () => {
    writeFileSync(join(tmpDir, '.gitignore'), '*.db\n!.contextgit/context.db\n')
    const result = patchGitignore(tmpDir)
    expect(result.status).toBe('already-present')
    // File unchanged
    const contents = readFileSync(join(tmpDir, '.gitignore'), 'utf-8')
    expect(contents).toBe('*.db\n!.contextgit/context.db\n')
  })

  it('works when .gitignore has no *.db rule', () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n')
    const result = patchGitignore(tmpDir)
    expect(result.status).toBe('patched')
    const contents = readFileSync(join(tmpDir, '.gitignore'), 'utf-8')
    expect(contents).toContain('!.contextgit/context.db')
  })
})
