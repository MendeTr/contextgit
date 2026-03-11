// keygen — generate an API key and save it to .contextgit/config.json.

import { Command, Flags } from '@oclif/core'
import { readFileSync, writeFileSync } from 'fs'
import { nanoid } from 'nanoid'
import { findConfigPath, loadConfig } from '../config.js'

export default class KeygenCmd extends Command {
  static description = 'Generate an API key for securing the ContextGit API server'

  static flags = {
    save: Flags.boolean({
      description: 'Save the generated key to .contextgit/config.json as apiKey',
      default: false,
    }),
    length: Flags.integer({
      description: 'Key length (default 32)',
      default: 32,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(KeygenCmd)

    // Use nanoid for URL-safe random token
    const key = nanoid(flags.length)

    this.log(`API Key: ${key}`)

    if (flags.save) {
      const configPath = findConfigPath()
      const config = loadConfig()
      const updated = { ...config, apiKey: key }
      writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n')
      this.log(`Saved to ${configPath}`)
      this.log(`\nSet this key in the Authorization header when calling the API:`)
      this.log(`  Authorization: Bearer ${key}`)
    } else {
      this.log(`\nTo save this key, re-run with --save`)
      this.log(`Or add manually to .contextgit/config.json:  "apiKey": "${key}"`)
    }
  }
}
