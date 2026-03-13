// init — create .contextgit/config.json + project + branch in LocalStore.

import { Command, Flags } from '@oclif/core'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { nanoid } from 'nanoid'
import { simpleGit } from 'simple-git'
import { LocalStore } from '@contextgit/store'
import type { ContextGitConfig } from '@contextgit/core'
import { installGitHooks } from '../git-hooks.js'

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
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Init)
    const cwd = process.cwd()
    const configDir  = join(cwd, '.contextgit')
    const configPath = join(configDir, 'config.json')
    const promptPath = join(configDir, 'system-prompt.md')

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
      this.log(SYSTEM_PROMPT_FRAGMENT)
      if (flags.hooks) {
        installGitHooks(cwd)
        this.log('Git hooks installed (.git/hooks/post-commit, post-checkout, post-merge)')
      }
      return
    }

    // ── Fresh init ─────────────────────────────────────────────────────────────
    const projectName = flags.name ?? basename(cwd)
    const projectId = nanoid()

    // Open store (creates DB + runs migrations).
    const store = new LocalStore(projectId)
    await store.createProject({ id: projectId, name: projectName })

    const gitBranch = await detectGitBranch(cwd)

    await store.createBranch({
      projectId,
      name: `Context: ${gitBranch}`,
      gitBranch,
    })

    // Write config
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
    if (flags.hooks) {
      installGitHooks(cwd)
      this.log(`Git hooks installed (.git/hooks/post-commit, post-checkout, post-merge)`)
    } else {
      this.log(`Tip: run "contextgit init --hooks" to auto-capture context on every git commit`)
    }
    this.log(``)
    this.log(`Add the following to your MCP system prompt (.contextgit/system-prompt.md):`)
    this.log(``)
    this.log(SYSTEM_PROMPT_FRAGMENT)
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
