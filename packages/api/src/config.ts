// config.ts — load and validate .contexthub/config.json
// Searches from CWD upwards until it finds the config file.

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import type { ContextHubConfig } from '@contexthub/core'

export class ConfigNotFoundError extends Error {
  constructor(startDir: string) {
    super(`No .contexthub/config.json found searching upward from: ${startDir}`)
    this.name = 'ConfigNotFoundError'
  }
}

export function findConfigPath(startDir: string = process.cwd()): string {
  let current = startDir
  while (true) {
    const candidate = join(current, '.contexthub', 'config.json')
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

export function loadConfig(startDir?: string): ContextHubConfig {
  const configPath = findConfigPath(startDir)
  const raw = readFileSync(configPath, 'utf-8')
  const config = JSON.parse(raw) as ContextHubConfig

  if (!config.projectId) {
    throw new Error(`Invalid config at ${configPath}: missing required field 'projectId'`)
  }
  if (!config.project) {
    throw new Error(`Invalid config at ${configPath}: missing required field 'project'`)
  }

  return config
}
