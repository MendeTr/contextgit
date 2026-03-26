import { homedir } from 'os'
import { join } from 'path'

/**
 * Resolve the SQLite DB path for a LocalStore.
 *
 * Rules:
 *   1. projectId === ':memory:' → ':memory:' (tests; configDir ignored)
 *   2. configDir provided → <configDir>/context.db (always; SQLite creates file on open)
 *   3. No configDir → ~/.contextgit/projects/<projectId>.db (legacy external path)
 *
 * Pure function — no filesystem side effects.
 */
export function resolveDbPath(projectId: string, configDir?: string): string {
  if (projectId === ':memory:') return ':memory:'
  if (configDir !== undefined) return join(configDir, 'context.db')
  return join(homedir(), '.contextgit', 'projects', `${projectId}.db`)
}
