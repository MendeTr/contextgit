// branch — create a new context branch.

import { Command, Args, Flags } from '@oclif/core'
import { simpleGit } from 'simple-git'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import { loadConfig } from '../config.js'

async function currentGitBranch(cwd: string): Promise<string> {
  try {
    return (await simpleGit(cwd).revparse(['--abbrev-ref', 'HEAD'])).trim()
  } catch {
    return 'main'
  }
}

export default class BranchCmd extends Command {
  static description = 'Create a new context branch'

  static args = {
    name: Args.string({
      description: 'Branch name (human-readable label)',
      required: true,
    }),
  }

  static flags = {
    git: Flags.string({
      description: 'Git branch name to associate (defaults to current git branch)',
      required: false,
    }),
    parent: Flags.string({
      description: 'Parent branch ID',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId, resolveDbPath(config.projectId, config.configDir))
    const cwd = process.cwd()

    const gitBranch = flags.git ?? (await currentGitBranch(cwd))

    const branch = await store.createBranch({
      projectId: config.projectId,
      name: args.name,
      gitBranch,
      parentBranchId: flags.parent,
    })

    this.log(`Branch created.`)
    this.log(`ID:      ${branch.id}`)
    this.log(`Name:    ${branch.name}`)
    this.log(`Git:     ${branch.gitBranch}`)
    if (branch.parentBranchId) this.log(`Parent:  ${branch.parentBranchId}`)
  }
}
