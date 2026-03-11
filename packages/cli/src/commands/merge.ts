// merge — merge a context branch into the current branch.

import { Command, Args, Flags } from '@oclif/core'
import { bootstrap } from '../bootstrap.js'

export default class MergeCmd extends Command {
  static description = 'Merge a context branch into the current branch'

  static args = {
    sourceBranchId: Args.string({
      description: 'ID of the source branch to merge from',
      required: true,
    }),
  }

  static flags = {
    summary: Flags.string({
      char: 's',
      description: 'Summary of what was merged (defaults to a generic message)',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MergeCmd)
    const ctx = await bootstrap()

    const summary = flags.summary ?? `Merged branch ${args.sourceBranchId} into current branch`

    const mergeCommit = await ctx.store.mergeBranch(args.sourceBranchId, ctx.branchId, summary)

    this.log(`Branch merged.`)
    this.log(`Merge commit ID: ${mergeCommit.id}`)
    this.log(`Summary: ${mergeCommit.summary}`)
  }
}
