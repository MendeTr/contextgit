import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * Resolve the SQLite DB path for a LocalStore.
 *
 * Rules:
 *   1. projectId === ':memory:' → ':memory:' (tests; configDir ignored)
 *   2. configDir provided AND <configDir>/context.db exists → <configDir>/context.db
 *   3. Otherwise → ~/.contextgit/projects/<projectId>.db (legacy external path)
 *
 * Migration-safe: existing projects without a context.db fall back to the
 * legacy external path, preserving history until contextgit init bootstraps
 * the in-repo DB.
 */
export function resolveDbPath(projectId: string, configDir?: string): string {
  if (projectId === ':memory:') return ':memory:'
  if (configDir !== undefined) {
    const localPath = join(configDir, 'context.db')
    if (existsSync(localPath)) return localPath
  }
  return join(homedir(), '.contextgit', 'projects', `${projectId}.db`)
}
