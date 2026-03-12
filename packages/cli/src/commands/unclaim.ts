// unclaim — manually release a task claim.

import { Command, Args } from '@oclif/core'
import { LocalStore } from '@contextgit/store'
import { loadConfig } from '../config.js'

export default class UnclaimCmd extends Command {
  static description = 'Release a previously claimed task'

  static args = {
    claimId: Args.string({
      description: 'ID of the claim to release',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(UnclaimCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId)

    await store.unclaimTask(args.claimId)

    this.log(`Released: ${args.claimId}`)

    store.close()
  }
}
