// doctor — diagnose the ContextGit installation and report issues.

import os from 'os'
import { join, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { Command } from '@oclif/core'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import { loadConfig, findConfigPath } from '../config.js'

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
    let config: (import('@contextgit/core').ContextGitConfig & { configDir: string }) | null = null
    let configDir: string | null = null
    try {
      const loaded = loadConfig(process.cwd())
      config = loaded
      configDir = loaded.configDir
      check('Config file found and valid JSON', true)
    } catch {
      check('Config file found and valid JSON', false, 'Run: contextgit init')
    }

    // ── 2. DB reachable ───────────────────────────────────────────────────────
    if (config?.projectId && configDir) {
      try {
        const projectId = config.projectId as string
        const dbPath = resolveDbPath(projectId, configDir)
        const store = new LocalStore(projectId, dbPath)
        await store.getProject(projectId)
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
      'Run: contextgit init',
    )

    // ── 6. Supabase remote ────────────────────────────────────────────────────
    const supabaseUrl = config?.supabaseUrl as string | undefined
    if (!supabaseUrl) {
      // Not an error — Supabase is optional
      this.log('  [ ] Supabase: not configured (optional)')
    } else {
      const serviceKey = process.env['SUPABASE_SERVICE_KEY']
      if (!serviceKey) {
        check(
          'Supabase: URL set but SUPABASE_SERVICE_KEY missing',
          false,
          'Set SUPABASE_SERVICE_KEY in your shell or Claude Code env config',
        )
      } else {
        // Probe connectivity: any 2xx/3xx = connected, 401 = key rejected
        try {
          const res = await fetch(`${supabaseUrl}/rest/v1/projects?limit=1`, {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
          })
          if (res.status === 401) {
            check('Supabase: reachable but SUPABASE_SERVICE_KEY rejected', false,
              'Check SUPABASE_SERVICE_KEY — it may be the anon key instead of the service role key')
          } else if (res.status < 400) {
            check('Supabase: connected', true)
          } else {
            check(`Supabase: HTTP ${res.status}`, false, `Check ${supabaseUrl} is reachable`)
          }
        } catch (err) {
          check('Supabase: unreachable', false, `${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    this.log('')
    this.log(`${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  }
}
