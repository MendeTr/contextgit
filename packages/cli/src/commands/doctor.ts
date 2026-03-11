// doctor — diagnose the ContextGit installation and report issues.

import os from 'os'
import { join, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { Command } from '@oclif/core'
import { LocalStore } from '@contextgit/store'
import { findConfigPath } from '../config.js'

const SENTINEL = '# contextgit'

export default class DoctorCmd extends Command {
  static description = 'Check ContextGit setup and diagnose issues'

  async run(): Promise<void> {
    this.log('ContextGit Doctor\n')

    let passed = 0
    let failed = 0

    const check = (label: string, ok: boolean, hint?: string) => {
      const icon = ok ? '✓' : '✗'
      this.log(`  [${icon}] ${label}`)
      if (!ok && hint) this.log(`        → ${hint}`)
      ok ? passed++ : failed++
    }

    // ── 1. Config file ────────────────────────────────────────────────────────
    let configPath: string | null = null
    let config: Record<string, unknown> | null = null
    try {
      configPath = findConfigPath(process.cwd())
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      check('Config file found and valid JSON', true)
    } catch {
      check('Config file found and valid JSON', false, 'Run: contextgit init')
    }

    // ── 2. DB reachable ───────────────────────────────────────────────────────
    if (config?.projectId) {
      try {
        const store = new LocalStore(config.projectId as string)
        await store.getProject(config.projectId as string)
        check('Local DB reachable', true)
      } catch {
        check('Local DB reachable', false, 'DB file may be corrupted — try: contextgit init')
      }
    } else {
      check('Local DB reachable', false, 'No config to check DB against')
    }

    // ── 3. Git hooks installed ────────────────────────────────────────────────
    const gitHooksDir = resolve(process.cwd(), '.git', 'hooks')
    const postCommitPath = join(gitHooksDir, 'post-commit')
    const hooksInstalled = existsSync(postCommitPath) &&
      readFileSync(postCommitPath, 'utf-8').includes(SENTINEL)
    check(
      'Git hooks installed',
      hooksInstalled,
      'Run: contextgit init --hooks',
    )

    // ── 4. API key configured (only relevant if remote is set) ────────────────
    const remote = config?.remote as string | undefined
    if (remote) {
      const serverCfgPath = join(os.homedir(), '.contextgit', 'server.json')
      let hasKey = false
      try {
        const cfg = JSON.parse(readFileSync(serverCfgPath, 'utf-8')) as Record<string, unknown>
        hasKey = typeof cfg['keyHash'] === 'string' && cfg['keyHash'].length > 0
      } catch { /* not configured */ }
      check(
        `API key configured (remote: ${remote})`,
        hasKey,
        'Run: contextgit keygen --save',
      )
    } else {
      check('API key (no remote configured — skipped)', true)
    }

    // ── 5. MCP registered in ~/.claude.json ───────────────────────────────────
    const claudeJsonPath = join(os.homedir(), '.claude.json')
    let mcpRegistered = false
    try {
      const raw = readFileSync(claudeJsonPath, 'utf-8')
      mcpRegistered = raw.includes('contextgit')
    } catch { /* file missing */ }
    check(
      'MCP server registered in ~/.claude.json',
      mcpRegistered,
      'Add contextgit to mcpServers in ~/.claude.json',
    )

    // ── Summary ───────────────────────────────────────────────────────────────
    this.log('')
    this.log(`${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  }
}
