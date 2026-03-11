// git-sync.ts — git metadata capture and hook installation.
//
// captureGitMetadata: used by context_commit (MCP) and commit CLI command to
//   auto-populate gitCommitSha on every context commit.
//
// installGitHooks: idempotent hook installer — writes post-commit,
//   post-checkout, post-merge scripts into .git/hooks/.

import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { simpleGit } from 'simple-git'

const SENTINEL = '# contextgit'
const HOOKS_LOG = join(homedir(), '.contextgit', 'hooks.log')

// ─── captureGitMetadata ────────────────────────────────────────────────────────

/**
 * Capture the current git commit SHA and branch name.
 * Returns null on any error — must never block a context commit.
 */
export async function captureGitMetadata(
  cwd: string,
): Promise<{ sha: string; branch: string } | null> {
  try {
    const git = simpleGit(cwd)
    const [sha, branch] = await Promise.all([
      git.revparse(['HEAD']),
      git.revparse(['--abbrev-ref', 'HEAD']),
    ])
    return { sha: sha.trim(), branch: branch.trim() }
  } catch {
    return null
  }
}

// ─── installGitHooks ──────────────────────────────────────────────────────────

const HOOK_SCRIPTS: Record<string, string> = {
  'post-commit': `#!/bin/sh
${SENTINEL}
contextgit commit -m "git: $(git log -1 --pretty=%s)" 2>>"${HOOKS_LOG}" || true
`,
  'post-checkout': `#!/bin/sh
${SENTINEL}
contextgit context --quiet 2>>"${HOOKS_LOG}" || true
`,
  'post-merge': `#!/bin/sh
${SENTINEL}
contextgit commit -m "Merged into $(git rev-parse --abbrev-ref HEAD)" 2>>"${HOOKS_LOG}" || true
`,
}

/**
 * Install contextgit git hooks into <projectRoot>/.git/hooks/.
 * Idempotent: checks for the sentinel comment before appending.
 * Hook failures are logged to ~/.contextgit/hooks.log — never to stderr.
 */
export async function installGitHooks(projectRoot: string): Promise<void> {
  const hooksDir = join(resolve(projectRoot), '.git', 'hooks')
  mkdirSync(hooksDir, { recursive: true })

  for (const [hookName, script] of Object.entries(HOOK_SCRIPTS)) {
    const hookPath = join(hooksDir, hookName)

    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8')
      if (existing.includes(SENTINEL)) continue  // already installed
      // Append to existing hook
      writeFileSync(hookPath, existing.trimEnd() + '\n\n' + script)
    } else {
      writeFileSync(hookPath, script)
    }

    // Make executable (chmod +x)
    try {
      const { chmodSync } = await import('fs')
      chmodSync(hookPath, 0o755)
    } catch {
      logHookError(`chmod failed for ${hookPath}`)
    }
  }
}

function logHookError(msg: string): void {
  try {
    const dir = join(homedir(), '.contextgit')
    mkdirSync(dir, { recursive: true })
    appendFileSync(HOOKS_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // truly silent
  }
}
