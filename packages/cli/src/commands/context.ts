// context — print the current project snapshot to stdout.

import { Command, Flags } from '@oclif/core'
import { simpleGit } from 'simple-git'
import { LocalStore } from '@contexthub/store'
import type { SnapshotFormat } from '@contexthub/core'
import { loadConfig } from '../config.js'

export default class ContextCmd extends Command {
  static description = 'Print the current project context snapshot'

  static flags = {
    format: Flags.string({
      char: 'f',
      description: 'Output format',
      options: ['agents-md', 'json', 'text'],
      default: 'text',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ContextCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId)

    // Detect current git branch
    let gitBranch = 'main'
    try {
      const git = simpleGit(process.cwd())
      gitBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    } catch {
      // fallback to 'main'
    }

    const branch = await store.getBranchByGitName(config.projectId, gitBranch)
    if (!branch) {
      this.error(
        `No context branch found for git branch '${gitBranch}'. Run 'contexthub init' first.`,
      )
    }

    const format = (flags.format ?? 'text') as SnapshotFormat
    const snapshot = await store.getFormattedSnapshot(config.projectId, branch.id, format)
    this.log(snapshot)
  }
}
