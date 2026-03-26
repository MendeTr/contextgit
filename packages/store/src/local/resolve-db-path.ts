import { homedir } from 'os'
import { join } from 'path'
import { existsSync, statSync } from 'fs'

/** Minimum file size (bytes) for an in-repo context.db to be considered populated. */
const MIN_DB_SIZE = 8 * 1024 // 8 KB

/**
 * Resolve the SQLite DB path for a LocalStore.
 *
 * Rules:
 *   1. projectId === ':memory:' → ':memory:' (tests; configDir ignored)
 *   2. configDir provided AND <configDir>/context.db exists AND size > 8 KB → <configDir>/context.db
 *   3. Otherwise → ~/.contextgit/projects/<projectId>.db (legacy external path)
 *
 * Migration-safe: existing projects whose in-repo context.db is empty (just
 * the schema, ≤ 8 KB) fall back to the legacy external path, preserving
 * history until real data has been migrated into the in-repo DB.
 */
export function resolveDbPath(projectId: string, configDir?: string): string {
  if (projectId === ':memory:') return ':memory:'
  if (configDir !== undefined) {
    const localPath = join(configDir, 'context.db')
    if (existsSync(localPath) && statSync(localPath).size > MIN_DB_SIZE) return localPath
  }
  return join(homedir(), '.contextgit', 'projects', `${projectId}.db`)
}
