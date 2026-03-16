import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type ClientType = 'claude-code' | 'cursor' | 'claude-desktop'

export interface DetectedClient {
  type: ClientType
  path: string
}

export interface InjectionResult {
  status: 'injected' | 'already-present' | 'skipped' | 'error'
  reason?: string
}

const MCP_ENTRY = {
  command: 'npx',
  args: ['contextgit-mcp'],
}

/** Resolve known config paths for each client type. */
function clientPaths(home: string): Record<ClientType, string> {
  const appData = process.env['APPDATA'] ?? ''
  return {
    'claude-code': join(home, '.claude.json'),
    'cursor': join(home, '.cursor', 'mcp.json'),
    'claude-desktop':
      process.platform === 'win32'
        ? join(appData, 'Claude', 'claude_desktop_config.json')
        : join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  }
}

/** Return all MCP clients whose config file exists on disk. */
export function detectClients(home: string = homedir()): DetectedClient[] {
  const paths = clientPaths(home)
  return (Object.keys(paths) as ClientType[])
    .filter(type => existsSync(paths[type]))
    .map(type => ({ type, path: paths[type] }))
}

/** Check whether a contextgit entry already exists under mcpServers. */
export function isAlreadyInjected(config: Record<string, unknown>): boolean {
  const servers = config['mcpServers'] ?? (config['globalShortcuts'] as Record<string, unknown> | undefined)?.['mcpServers']
  if (!servers || typeof servers !== 'object') return false
  return 'contextgit' in (servers as object)
}

/**
 * Inject the contextgit MCP server entry into the given client config file.
 * Uses an atomic write (temp file + rename) so the original is never corrupted.
 */
export function injectMcpServer(
  configPath: string,
  _clientType: ClientType,
  systemPrompt: string,
): InjectionResult {
  // Read existing content — create empty object if file doesn't exist
  let raw = '{}'
  if (existsSync(configPath)) {
    raw = readFileSync(configPath, 'utf8')
  }

  let config: Record<string, unknown>
  try {
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {
      status: 'error',
      reason: 'existing config is not valid JSON — skipped to avoid data loss',
    }
  }

  if (isAlreadyInjected(config)) {
    return { status: 'already-present' }
  }

  // Resolve the mcpServers object — handle Claude Desktop's globalShortcuts wrapper
  let target: Record<string, unknown>
  if (
    config['globalShortcuts'] &&
    typeof config['globalShortcuts'] === 'object' &&
    'mcpServers' in (config['globalShortcuts'] as object)
  ) {
    target = (config['globalShortcuts'] as Record<string, unknown>)['mcpServers'] as Record<string, unknown>
  } else {
    if (!config['mcpServers']) config['mcpServers'] = {}
    target = config['mcpServers'] as Record<string, unknown>
  }

  target['contextgit'] = { ...MCP_ENTRY, systemPrompt }

  const tmpPath = configPath + '.contextgit-tmp'
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, configPath)

  return { status: 'injected' }
}
