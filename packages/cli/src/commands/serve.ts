// serve — start the ContextGit API server from the CLI.

import os from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import { Command, Flags } from '@oclif/core'
import { createApp } from '@contextgit/api'

const SERVER_CONFIG_PATH = join(os.homedir(), '.contextgit', 'server.json')

function hasKeyConfigured(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(SERVER_CONFIG_PATH, 'utf-8')) as Record<string, unknown>
    return typeof cfg['keyHash'] === 'string' && cfg['keyHash'].length > 0
  } catch {
    return false
  }
}

export default class ServeCmd extends Command {
  static description = 'Start the ContextGit API server'

  static flags = {
    port: Flags.integer({
      char: 'p',
      description: 'Port to listen on',
      default: 3141,
      env: 'PORT',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ServeCmd)
    const port = flags.port

    const authConfigured = hasKeyConfigured()

    this.log('ContextGit API server starting...')
    this.log(`Port:   ${port}`)
    this.log(`Auth:   ${authConfigured ? 'key configured' : 'OPEN (no key set — run: contextgit keygen --save)'}`)
    this.log('')

    const app = await createApp()

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(port, () => {
        this.log(`Listening on http://localhost:${port}`)
        this.log('Press Ctrl+C to stop.')
      })

      server.on('error', reject)

      process.on('SIGINT', () => {
        server.close(() => resolve())
      })
      process.on('SIGTERM', () => {
        server.close(() => resolve())
      })
    })
  }
}
