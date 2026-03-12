// claim — create a task claim to prevent concurrent agent work.

import { Command, Args, Flags } from '@oclif/core'
import { LocalStore } from '@contextgit/store'
import { loadConfig } from '../config.js'

export default class ClaimCmd extends Command {
  static description = 'Claim a task to prevent other agents from picking it up simultaneously'

  static args = {
    task: Args.string({
      description: 'Short description of the task being claimed',
      required: true,
    }),
  }

  static flags = {
    ttl: Flags.integer({
      description: 'Time-to-live in hours before the claim auto-expires',
      default: 2,
    }),
    status: Flags.string({
      description: "Claim status: 'proposed' (plan mode) or 'active' (approved, work in progress)",
      default: 'proposed',
      options: ['proposed', 'active'],
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClaimCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId)

    // Resolve current branch
    const branch = await store.getBranchByGitName(config.projectId, 'main')
    const branches = await store.listBranches(config.projectId)
    const activeBranch = branches.find((b) => b.status === 'active') ?? branches[0]
    if (!activeBranch) {
      this.error('No branch found. Run contextgit init first.')
    }

    const claim = await store.claimTask(config.projectId, activeBranch.id, {
      task: args.task,
      agentId: `cli-${process.env.USER ?? 'unknown'}`,
      role: config.agentRole ?? 'solo',
      status: flags.status as 'proposed' | 'active',
      ttl: flags.ttl * 3_600_000,
    })

    this.log(`Claimed.`)
    this.log(`ID:     ${claim.id}`)
    this.log(`Task:   ${claim.task}`)
    this.log(`Status: ${claim.status}`)
    this.log(`TTL:    ${flags.ttl}h`)

    store.close()
  }
}
