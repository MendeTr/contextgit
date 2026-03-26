// init — create .contextgit/config.json + project + branch in LocalStore.

import { Command, Flags } from '@oclif/core'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { join, basename } from 'path'
import { nanoid } from 'nanoid'
import { simpleGit } from 'simple-git'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import type { ContextGitConfig } from '@contextgit/core'
import { installGitHooks } from '../git-hooks.js'
import { writeClaude, writeSkills, registerMcp, patchGitignore } from '../lib/init-helpers.js'

export default class Init extends Command {
  static description = 'Initialize ContextGit in this project'

  static flags = {
    name: Flags.string({
      char: 'n',
      description: 'Project name (defaults to current directory name)',
      required: false,
    }),
    hooks: Flags.boolean({
      description: 'Install git hooks to auto-capture context on every git commit',
      default: false,
      allowNo: true,   // --no-hooks to explicitly skip and suppress prompt
    }),
  }

  async run(): Promise<void> {
    const { flags, argv } = await this.parse(Init)
    const cwd = process.cwd()
    const configDir  = join(cwd, '.contextgit')
    const configPath = join(configDir, 'config.json')
    // True if the user explicitly passed --hooks or --no-hooks
    const hooksExplicit = argv.some(a => String(a).startsWith('--hooks') || String(a) === '--no-hooks')

    // ── Self-heal: config exists but DB may be empty ───────────────────────────
    if (existsSync(configPath)) {
      let existing: ContextGitConfig
      try {
        existing = JSON.parse(readFileSync(configPath, 'utf8')) as ContextGitConfig
      } catch {
        this.error('Found .contextgit/config.json but could not parse it. Delete it and re-run init.')
      }

      const store = new LocalStore(existing.projectId, resolveDbPath(existing.projectId, configDir))
      const gitBranch = await detectGitBranch(cwd)
      const branch = await store.getBranchByGitName(existing.projectId, gitBranch)

      if (branch) {
        // BUG-2 fix: --hooks on already-initialized project always installs
        if (flags.hooks) {
          installGitHooks(cwd)
          this.log('Git hooks installed (.git/hooks/post-commit, post-checkout, post-merge)')
        }

        // Write CLAUDE.md + skills even on re-init (idempotent)
        const claudeResult = writeClaude(cwd)
        if (claudeResult.status === 'written') {
          this.log(`✅ CLAUDE.md updated            (contextgit memory section appended)`)
        }
        const skillsResult = writeSkills(cwd)
        if (skillsResult.status === 'written') {
          this.log(`✅ Skills installed             (.claude/skills/context-commit, .claude/skills/context-branch)`)
        }

        const mcpResult = registerMcp()
        if (mcpResult.status === 'registered') {
          this.log(`✅ MCP server registered        (~/.claude.json)`)
        }

        const gitignoreResult = patchGitignore(cwd)
        if (gitignoreResult.status === 'patched' || gitignoreResult.status === 'created') {
          this.log(`✅ .gitignore updated           (context DB committed to git)`)
        }

        this.log('ContextGit already initialized. Config found at .contextgit/config.json')
        return
      }

      // DB exists (e.g. cloned) or empty — ensure project + branch exist without duplicating
      const project = await store.getProject(existing.projectId)
      if (!project) {
        await store.createProject({ id: existing.projectId, name: existing.project })
      }
      await store.createBranch({
        projectId: existing.projectId,
        name: `Context: ${gitBranch}`,
        gitBranch,
      })
      const verb = project ? 'Registered' : 'Recreated'
      this.log(`${verb} branch for project "${existing.project}" (${existing.projectId}): ${gitBranch}`)
      if (flags.hooks) {
        installGitHooks(cwd)
        this.log('Git hooks installed (.git/hooks/post-commit, post-checkout, post-merge)')
      }
      const gitignoreResultRecreate = patchGitignore(cwd)
      if (gitignoreResultRecreate.status === 'patched' || gitignoreResultRecreate.status === 'created') {
        this.log(`✅ .gitignore updated           (context DB committed to git)`)
      }
      return
    }

    // ── Fresh init ─────────────────────────────────────────────────────────────
    const projectName = flags.name ?? basename(cwd)
    const projectId = nanoid()

    mkdirSync(configDir, { recursive: true })
    // Use the local path directly — resolveDbPath falls back to legacy when context.db
    // doesn't exist yet, but init is the command that creates it.
    const store = new LocalStore(projectId, join(configDir, 'context.db'))
    await store.createProject({ id: projectId, name: projectName })

    const gitBranch = await detectGitBranch(cwd)
    await store.createBranch({
      projectId,
      name: `Context: ${gitBranch}`,
      gitBranch,
    })

    const config: ContextGitConfig = {
      project: projectName,
      projectId,
      store: 'local',
      agentRole: 'solo',
      workflowType: 'interactive',
      autoSnapshot: false,
      snapshotInterval: 10,
      embeddingModel: 'local',
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

    this.log(`✅ Project initialized          (.contextgit.json)`)
    this.log(`   Project:  ${projectName}`)
    this.log(`   ID:       ${projectId}`)
    this.log(`   Branch:   ${gitBranch}`)
    this.log(``)

    // ── Patch .gitignore ───────────────────────────────────────────────────────
    const gitignoreResult = patchGitignore(cwd)
    if (gitignoreResult.status === 'patched' || gitignoreResult.status === 'created') {
      this.log(`✅ .gitignore updated           (context DB committed to git)`)
    } else {
      this.log(`⏭  .gitignore already configured (skipped)`)
    }

    // BUG-3 fix: prompt for hooks unless user was explicit about it
    let installHooks = flags.hooks
    if (!hooksExplicit) {
      installHooks = await promptYesNo(
        'Install git hooks to auto-capture context on every git commit? (Y/n) '
      )
    }

    if (installHooks) {
      installGitHooks(cwd)
      this.log(`✅ Git hooks installed          (.git/hooks/post-commit, post-checkout, post-merge)`)
    } else {
      this.log(`⏭  Git hooks skipped           (run "contextgit init --hooks" anytime to install)`)
    }

    // ── Write CLAUDE.md fragment ───────────────────────────────────────────────
    const claudeResult = writeClaude(cwd)
    if (claudeResult.status === 'written') {
      this.log(`✅ CLAUDE.md updated            (contextgit memory section appended)`)
    } else if (claudeResult.status === 'already-present') {
      this.log(`⏭  CLAUDE.md already configured (skipped)`)
    } else {
      this.log(`⚠️  CLAUDE.md not updated        (${claudeResult.reason})`)
    }

    // ── Write project-level skills ─────────────────────────────────────────────
    const skillsResult = writeSkills(cwd)
    if (skillsResult.status === 'written') {
      this.log(`✅ Skills installed             (.claude/skills/context-commit, .claude/skills/context-branch)`)
    } else {
      this.log(`⚠️  Skills not installed        (could not write to .claude/skills/ — create manually)`)
    }

    // ── Register MCP server in ~/.claude.json ──────────────────────────────────
    const mcpResult = registerMcp()
    if (mcpResult.status === 'registered') {
      this.log(`✅ MCP server registered        (~/.claude.json)`)
    } else if (mcpResult.status === 'already-present') {
      this.log(`⏭  MCP server already registered (skipped)`)
    } else {
      this.log(`⚠️  MCP server not registered   (${mcpResult.reason})`)
      this.log(`   Add manually: contextgit-mcp in ~/.claude.json mcpServers`)
    }

    this.log(``)
    this.log(`ContextGit is ready. Start a Claude Code session in this project.`)
    this.log(`The agent will load project memory automatically via MCP tool discovery.`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function detectGitBranch(cwd: string): Promise<string> {
  try {
    const git = simpleGit(cwd)
    return (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
  } catch {
    return 'main'
  }
}

/** Prompt the user with a yes/no question. Defaults to yes on empty input. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise(resolve => {
    // Non-interactive environment (CI, piped stdin) — default to yes
    if (!process.stdin.isTTY) {
      resolve(true)
      return
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() !== 'n')
    })
  })
}
