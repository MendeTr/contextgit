// keygen — generate an API key and optionally save its hash to ~/.contextgit/server.json.
//
// The plaintext key is shown once and never written to disk. Only the SHA-256
// hash is persisted so the server can verify Bearer tokens without storing secrets.

import os from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { Command, Flags } from '@oclif/core'
import { nanoid } from 'nanoid'

const CONTEXTGIT_DIR = join(os.homedir(), '.contextgit')
const SERVER_CONFIG_PATH = join(CONTEXTGIT_DIR, 'server.json')

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function readServerConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SERVER_CONFIG_PATH, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function saveKeyHash(hash: string): void {
  mkdirSync(CONTEXTGIT_DIR, { recursive: true })
  const cfg = { ...readServerConfig(), keyHash: hash }
  writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}

export default class KeygenCmd extends Command {
  static description = 'Generate an API key for securing the ContextGit API server'

  static flags = {
    save: Flags.boolean({
      description: 'Save the key hash to ~/.contextgit/server.json (key shown once, never stored)',
      default: false,
    }),
    length: Flags.integer({
      description: 'Key length (default 32)',
      default: 32,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(KeygenCmd)

    const key = nanoid(flags.length)

    this.log(`API Key: ${key}`)
    this.log(`(Copy this now — it will not be stored anywhere in plaintext)`)

    if (flags.save) {
      saveKeyHash(sha256hex(key))
      this.log(`\nKey hash saved to ~/.contextgit/server.json`)
      this.log(`Set this key in the Authorization header when calling the API:`)
      this.log(`  Authorization: Bearer ${key}`)
    } else {
      this.log(`\nTo activate this key, re-run with --save`)
    }
  }
}
