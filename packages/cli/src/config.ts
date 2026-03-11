// config.ts — load and validate .contextgit/config.json
// Searches from CWD upwards until it finds the config file.

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { ContextGitConfig } from '@contextgit/core'

export class ConfigNotFoundError extends Error {
  constructor(startDir: string) {
    super(`No .contextgit/config.json found searching upward from: ${startDir}`)
    this.name = 'ConfigNotFoundError'
  }
}

/**
 * Search upward from `startDir` for `.contextgit/config.json`.
 * Returns the first match found, or throws ConfigNotFoundError.
 */
export function findConfigPath(startDir: string = process.cwd()): string {
  let current = startDir
  while (true) {
    const candidate = join(current, '.contextgit', 'config.json')
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        throw new ConfigNotFoundError(startDir)
      }
      current = parent
    }
  }
}

/**
 * Load and parse `.contextgit/config.json`.
 * Throws ConfigNotFoundError if not found, or Error if JSON is invalid.
 */
export function loadConfig(startDir?: string): ContextGitConfig {
  const configPath = findConfigPath(startDir)
  const raw = readFileSync(configPath, 'utf-8')
  const config = JSON.parse(raw) as ContextGitConfig

  if (!config.projectId) {
    throw new Error(`Invalid config at ${configPath}: missing required field 'projectId'`)
  }
  if (!config.project) {
    throw new Error(`Invalid config at ${configPath}: missing required field 'project'`)
  }

  return config
}

/**
 * Save updated config back to the config.json it was loaded from.
 */
export function saveConfig(updates: Partial<import('@contextgit/core').ContextGitConfig>, startDir?: string): void {
  const configPath = findConfigPath(startDir)
  const raw = readFileSync(configPath, 'utf-8')
  const existing = JSON.parse(raw) as import('@contextgit/core').ContextGitConfig
  const updated = { ...existing, ...updates }
  writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
}
