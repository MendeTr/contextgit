// commit — record a context commit via engine.commit().

import { Args, Command, Flags } from '@oclif/core'
import { simpleGit } from 'simple-git'
import { bootstrap } from '../bootstrap.js'

async function captureGitSha(cwd: string): Promise<string | undefined> {
  try {
    return (await simpleGit(cwd).revparse(['HEAD'])).trim()
  } catch {
    return undefined
  }
}

export default class CommitCmd extends Command {
  static description = 'Record a context commit'

  // Positional arg — mirrors git commit behaviour: contextgit commit "message"
  static args = {
    message: Args.string({
      description: 'Short commit message (what was accomplished)',
      required: false,
    }),
  }

  static flags = {
    message: Flags.string({
      char: 'm',
      description: 'Short commit message — alternative to positional arg',
      required: false,
    }),
    content: Flags.string({
      char: 'c',
      description: 'Detailed commit content. Defaults to the message if omitted.',
      required: false,
    }),
    thread: Flags.string({
      char: 't',
      description: 'Open a new thread (can be repeated)',
      multiple: true,
      required: false,
    }),
    close: Flags.string({
      description: 'Close a thread by ID (can be repeated)',
      multiple: true,
      required: false,
    }),
    'ci-run-id': Flags.string({
      description: 'CI run ID (e.g. GitHub Actions run ID)',
      required: false,
      env: 'GITHUB_RUN_ID',
    }),
    pipeline: Flags.string({
      description: 'CI pipeline / workflow name',
      required: false,
      env: 'GITHUB_WORKFLOW',
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CommitCmd)

    // Positional arg takes precedence; -m flag is the fallback for scripts/hooks
    const message = args.message ?? flags.message
    if (!message) {
      this.error('A commit message is required. Usage: contextgit commit "your message" or contextgit commit -m "your message"')
    }

    const ctx = await bootstrap()

    const threads: {
      open?: string[]
      close?: Array<{ id: string; note: string }>
    } = {}
    if (flags.thread?.length) threads.open = flags.thread
    if (flags.close?.length) {
      threads.close = flags.close.map(id => ({ id, note: 'Closed via CLI' }))
    }

    const gitCommitSha = await captureGitSha(process.cwd())
    const commit = await ctx.engine.commit({
      message,
      content: flags.content ?? message,
      gitCommitSha,
      ciRunId: flags['ci-run-id'],
      pipelineName: flags.pipeline,
      ...(Object.keys(threads).length > 0 ? { threads } : {}),
    })

    this.log(`Commit recorded.`)
    this.log(`ID:      ${commit.id}`)
    this.log(`Message: ${commit.message}`)
  }
}
