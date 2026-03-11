// git-hooks.ts — install contextgit git hooks into a project's .git/hooks/.
// Duplicated from packages/mcp/src/git-sync.ts to keep the dep graph clean
// (cli → core, store only — no dependency on mcp).

import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync, chmodSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

const SENTINEL = '# contextgit'
const HOOKS_LOG = join(homedir(), '.contextgit', 'hooks.log')

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
 */
export function installGitHooks(projectRoot: string): void {
  const hooksDir = join(resolve(projectRoot), '.git', 'hooks')
  mkdirSync(hooksDir, { recursive: true })

  for (const [hookName, script] of Object.entries(HOOK_SCRIPTS)) {
    const hookPath = join(hooksDir, hookName)

    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8')
      if (existing.includes(SENTINEL)) continue  // already installed
      writeFileSync(hookPath, existing.trimEnd() + '\n\n' + script)
    } else {
      writeFileSync(hookPath, script)
    }

    try {
      chmodSync(hookPath, 0o755)
    } catch {
      logError(`chmod failed for ${hookPath}`)
    }
  }
}

function logError(msg: string): void {
  try {
    mkdirSync(join(homedir(), '.contextgit'), { recursive: true })
    appendFileSync(HOOKS_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    // truly silent
  }
}
