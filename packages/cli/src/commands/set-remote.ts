// set-remote — write a remote ContextGit API URL to config.json.

import { Command, Args } from '@oclif/core'
import { loadConfig, saveConfig } from '../config.js'

export default class SetRemoteCmd extends Command {
  static description = 'Set the remote ContextGit API URL in config'

  static args = {
    url: Args.string({
      description: 'Remote API URL (e.g. https://api.example.com)',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(SetRemoteCmd)
    const config = loadConfig()

    const previous = config.remote
    saveConfig({ remote: args.url })

    if (previous) {
      this.log(`Remote updated: ${previous} → ${args.url}`)
    } else {
      this.log(`Remote set: ${args.url}`)
    }
    this.log(`Use 'contextgit push' to sync commits to this remote.`)
  }
}
