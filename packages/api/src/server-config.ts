// server-config.ts — global server configuration at ~/.contextgit/server.json
//
// Stores the SHA-256 hash of the API key so the plaintext key never rests on disk.
// The server reads the hash on startup; keygen --save writes it.

import os from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'

const CONTEXTGIT_DIR = join(os.homedir(), '.contextgit')
const SERVER_CONFIG_PATH = join(CONTEXTGIT_DIR, 'server.json')

export interface ServerConfig {
  keyHash?: string   // SHA-256 hex digest of the API key
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function readServerConfig(): ServerConfig {
  try {
    const raw = readFileSync(SERVER_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as ServerConfig
  } catch {
    return {}
  }
}

export function writeServerConfig(config: ServerConfig): void {
  mkdirSync(CONTEXTGIT_DIR, { recursive: true })
  writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}
