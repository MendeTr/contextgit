// set-remote — configure push/pull remote target.
//
// Usage:
//   contextgit set-remote supabase https://xyzproject.supabase.co
//     → writes supabaseUrl to config. Key via SUPABASE_SERVICE_KEY env var.
//   contextgit set-remote https://api.example.com
//     → writes remote (HTTP RemoteStore URL) to config. Existing behaviour.

import { Command, Args } from '@oclif/core'
import { loadConfig, saveConfig } from '../config.js'

export default class SetRemoteCmd extends Command {
  static description = 'Set the remote push/pull target (Supabase or self-hosted API)'

  static args = {
    typeOrUrl: Args.string({
      description: '"supabase" keyword, or an HTTP API URL',
      required: true,
    }),
    url: Args.string({
      description: 'Supabase project URL (required when first arg is "supabase")',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(SetRemoteCmd)
    const config = loadConfig()

    if (args.typeOrUrl === 'supabase') {
      if (!args.url) {
        this.error('URL required: contextgit set-remote supabase <url>', { exit: 1 })
      }
      saveConfig({ supabaseUrl: args.url })   // saveConfig merges internally — spread not needed
      this.log(`Supabase remote set: ${args.url}`)
      this.log(`Set SUPABASE_SERVICE_KEY in your shell to authenticate.`)
      this.log(`Run 'contextgit push' to sync commits to Supabase.`)
    } else {
      const url = args.typeOrUrl
      const previous = config.remote
      saveConfig({ remote: url })             // saveConfig merges internally — spread not needed
      if (previous) {
        this.log(`Remote updated: ${previous} → ${url}`)
      } else {
        this.log(`Remote set: ${url}`)
      }
      this.log(`Use 'contextgit push' to sync commits to this remote.`)
    }
  }
}
