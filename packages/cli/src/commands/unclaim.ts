// unclaim — manually release a task claim.
// Accepts either a claim ID (nanoid) or a task name string.
// When a task name is provided, finds the matching active claim and releases it.

import { Command, Args } from '@oclif/core'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import { loadConfig } from '../config.js'

export default class UnclaimCmd extends Command {
  static description = 'Release a previously claimed task (by claim ID or task name)'

  static args = {
    identifier: Args.string({
      description: 'Claim ID or task name to release',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(UnclaimCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId, resolveDbPath(config.projectId, config.configDir))

    const identifier = args.identifier

    // First try to release by exact claim ID
    const activeClaims = await store.listActiveClaims(config.projectId)
    const byId = activeClaims.find(c => c.id === identifier)

    if (byId) {
      await store.unclaimTask(byId.id)
      this.log(`Released claim: ${byId.id} ("${byId.task}")`)
      store.close()
      return
    }

    // Fall back to matching by task name (case-insensitive)
    const byTask = activeClaims.find(
      c => c.task.toLowerCase() === identifier.toLowerCase()
    )

    if (byTask) {
      await store.unclaimTask(byTask.id)
      this.log(`Released claim: ${byTask.id} ("${byTask.task}")`)
      store.close()
      return
    }

    store.close()
    this.error(
      `No active claim found matching "${identifier}". ` +
      `Use 'contextgit status' to see active claims.`
    )
  }
}
