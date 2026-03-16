// init — create .contextgit/config.json + project + branch in LocalStore.

import { Command, Flags } from '@oclif/core'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { join, basename } from 'path'
import { nanoid } from 'nanoid'
import { simpleGit } from 'simple-git'
import { LocalStore } from '@contextgit/store'
import type { ContextGitConfig } from '@contextgit/core'
import { installGitHooks } from '../git-hooks.js'
import { detectClients, injectMcpServer } from '../lib/client-config.js'

const MCP_SYSTEM_PROMPT = `You have access to ContextGit memory tools.

At the start of every session, call context_get with scope=global immediately — before reading any files, before asking any questions, before doing any work. Do not skip this step.

After completing significant work (a feature, a decision, a resolved problem), call context_commit with a message describing what was done, what was decided, and any open questions. Include the current git branch and commit hash at the top of the message.

If you are about to explore a risky or experimental approach, call context_branch first to create an isolated context workspace.`

const SYSTEM_PROMPT_FRAGMENT = `\
You have access to ContextGit memory tools.

## Session Start (do this every time)
Call context_get with scope=global immediately.
Do not ask questions first. Read the snapshot, then start working.
Start the highest priority item from the snapshot.

## What counts as one task (commit after each)
Match the grain of your plan:
- Numbered steps in a plan → each numbered step = one commit
- User stories → each accepted story = one commit
- No plan → each logical unit of change (one file, one feature, one fix) = one commit

Do NOT batch unrelated changes into one commit.
When in doubt, commit more often rather than less.

## After EVERY completed task
Immediately, without being asked:
\`\`\`
context_commit "what was built | key decisions | next task"
\`\`\`
Do not proceed to the next task until the current one is committed.

## When scope changes mid-session
1. Write a context_commit with replan: prefix BEFORE building new scope:
   context_commit "replan: <what changed and why>"
2. Then build the new scope
3. Write a normal context_commit when done

## Session End (do this every time)
Call context_commit with:
- what was built
- key decisions and why
- open threads
- the first concrete task for the next session
`

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
    const promptPath = join(configDir, 'system-prompt.md')
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

      const store = new LocalStore(existing.projectId)
      const gitBranch = await detectGitBranch(cwd)
      const branch = await store.getBranchByGitName(existing.projectId, gitBranch)

      if (branch) {
        // BUG-2 fix: --hooks on already-initialized project always installs
        if (flags.hooks) {
          installGitHooks(cwd)
          this.log('Git hooks installed (.git/hooks/post-commit, post-checkout, post-merge)')
        }
        this.log('ContextGit already initialized. Config found at .contextgit/config.json')
        return
      }

      // DB missing or empty — recreate project + branch
      this.log('Config found but DB is empty — recreating project and branch in DB.')
      await store.createProject({ id: existing.projectId, name: existing.project })
      await store.createBranch({
        projectId: existing.projectId,
        name: `Context: ${gitBranch}`,
        gitBranch,
      })
      writeSystemPrompt(promptPath)
      this.log(`Recreated project "${existing.project}" (${existing.projectId}) for branch: ${gitBranch}`)
      this.log(`System prompt: .contextgit/system-prompt.md`)
      if (flags.hooks) {
        installGitHooks(cwd)
        this.log('Git hooks installed (.git/hooks/post-commit, post-checkout, post-merge)')
      }
      return
    }

    // ── Fresh init ─────────────────────────────────────────────────────────────
    const projectName = flags.name ?? basename(cwd)
    const projectId = nanoid()

    const store = new LocalStore(projectId)
    await store.createProject({ id: projectId, name: projectName })

    const gitBranch = await detectGitBranch(cwd)
    await store.createBranch({
      projectId,
      name: `Context: ${gitBranch}`,
      gitBranch,
    })

    mkdirSync(configDir, { recursive: true })
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
    writeSystemPrompt(promptPath)

    this.log(`Initialized ContextGit for project: ${projectName}`)
    this.log(`Project ID:  ${projectId}`)
    this.log(`Branch:      ${gitBranch}`)
    this.log(`Config:      .contextgit/config.json`)
    this.log(`DB:          ~/.contextgit/projects/${projectId}.db`)
    this.log(``)

    // BUG-3 fix: prompt for hooks unless user was explicit about it
    let installHooks = flags.hooks
    if (!hooksExplicit) {
      installHooks = await promptYesNo(
        'Install git hooks to auto-capture context on every git commit? (Y/n) '
      )
    }

    if (installHooks) {
      installGitHooks(cwd)
      this.log(`Git hooks installed (.git/hooks/post-commit, post-checkout, post-merge)`)
    } else {
      this.log(`Skipped hooks. Run "contextgit init --hooks" anytime to install them.`)
    }

    this.log(``)
    this.log(`System prompt written to .contextgit/system-prompt.md`)
    this.log(``)

    // ── Auto-configure MCP clients ─────────────────────────────────────────────
    try {
      const clients = detectClients()
      if (clients.length === 0) {
        this.log(`⚠️  No MCP clients detected.`)
        this.log(``)
        this.log(`Add the following to your MCP client config manually:`)
        this.log(``)
        this.log(`  "contextgit": {`)
        this.log(`    "command": "npx",`)
        this.log(`    "args": ["contextgit", "mcp"],`)
        this.log(`    "systemPrompt": "${MCP_SYSTEM_PROMPT.replace(/\n/g, '\\n')}"`)
        this.log(`  }`)
        this.log(``)
        this.log(`Searched:`)
        this.log(`  ~/.claude.json`)
        this.log(`  ~/.cursor/mcp.json`)
        this.log(`  ~/Library/Application Support/Claude/claude_desktop_config.json`)
      } else {
        let anyInjected = false
        for (const client of clients) {
          const result = injectMcpServer(client.path, client.type, MCP_SYSTEM_PROMPT)
          const label = clientLabel(client.type).padEnd(14)
          const shortPath = client.path.replace(process.env['HOME'] ?? '', '~')
          if (result.status === 'injected') {
            this.log(`✅ Configured ${label} (${shortPath})`)
            anyInjected = true
          } else if (result.status === 'already-present') {
            this.log(`⏭  ${label} already configured (skipped)`)
          } else if (result.status === 'error') {
            this.log(`❌ ${label} config error: ${result.reason}`)
            this.log(`   Path: ${shortPath}`)
            this.log(`   Fix manually or re-run after repairing the file.`)
          } else {
            this.log(`⏭  ${label} not found (skipped)`)
          }
        }
        if (anyInjected) {
          this.log(``)
          this.log(`ContextGit is ready. Open Claude Code in this project and start a session.`)
          this.log(`The agent will call context_get automatically on every session start.`)
        }
      }
    } catch (err) {
      this.log(`⚠️  Could not auto-configure MCP clients: ${String(err)}`)
      this.log(`Add the MCP server entry manually — see .contextgit/system-prompt.md`)
    }
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

function writeSystemPrompt(promptPath: string): void {
  writeFileSync(promptPath, SYSTEM_PROMPT_FRAGMENT)
}

function clientLabel(type: string): string {
  if (type === 'claude-code') return 'Claude Code'
  if (type === 'cursor') return 'Cursor'
  if (type === 'claude-desktop') return 'Claude Desktop'
  return type
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
