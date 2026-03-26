// claim — create a task claim to prevent concurrent agent work.

import { Command, Args, Flags } from '@oclif/core'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import { loadConfig } from '../config.js'
import { getCliAgentId } from '../agent-id.js'

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
    'for-agent-id': Flags.string({
      description: 'Claim on behalf of this agent ID (pre-claiming by orchestrator)',
      required: false,
    }),
    'thread-id': Flags.string({
      description: 'Direct thread ID link for this claim',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClaimCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId, resolveDbPath(config.projectId, config.configDir))

    const branches = await store.listBranches(config.projectId)
    const activeBranch = branches.find((b) => b.status === 'active') ?? branches[0]
    if (!activeBranch) {
      this.error('No branch found. Run contextgit init first.')
    }

    // Use shared agent ID so claims match commits for auto-release
    const agentId = flags['for-agent-id'] ?? getCliAgentId()

    const claim = await store.claimTask(config.projectId, activeBranch.id, {
      task: args.task,
      agentId,
      role: config.agentRole ?? 'solo',
      status: flags.status as 'proposed' | 'active',
      ttl: flags.ttl * 3_600_000,
      threadId: flags['thread-id'],
    })

    this.log(`Claimed.`)
    this.log(`ID:        ${claim.id}`)
    this.log(`Task:      ${claim.task}`)
    this.log(`Agent:     ${claim.agentId}`)
    this.log(`Thread ID: ${claim.threadId ?? '(none)'}`)
    this.log(`Status:    ${claim.status}`)
    this.log(`TTL:       ${flags.ttl}h`)

    store.close()
  }
}
