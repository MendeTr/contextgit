// log — list context commits with formatting.

import { Command, Flags } from '@oclif/core'
import { simpleGit } from 'simple-git'
import { LocalStore } from '@contextgit/store'
import { loadConfig } from '../config.js'

export default class LogCmd extends Command {
  static description = 'List context commits for the current branch'

  static flags = {
    limit: Flags.integer({
      char: 'n',
      description: 'Max commits to show',
      default: 20,
    }),
    all: Flags.boolean({
      char: 'a',
      description: 'Show commits across all branches',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show full commit content',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(LogCmd)
    const config = loadConfig()
    const store = new LocalStore(config.projectId)
    const cwd = process.cwd()

    let gitBranch = 'main'
    try {
      gitBranch = (await simpleGit(cwd).revparse(['--abbrev-ref', 'HEAD'])).trim()
    } catch {
      // fallback
    }

    if (flags.all) {
      const branches = await store.listBranches(config.projectId)
      if (branches.length === 0) {
        this.log('No branches found. Run `contextgit init` first.')
        return
      }

      for (const branch of branches) {
        const commits = await store.listCommits(branch.id, { limit: flags.limit, offset: 0 })
        if (commits.length === 0) continue

        this.log(`\n── ${branch.name} (${branch.gitBranch}) ──`)
        this.printCommits(commits, flags.verbose)
      }
    } else {
      const branch = await store.getBranchByGitName(config.projectId, gitBranch)
      if (!branch) {
        this.error(
          `No context branch for git branch '${gitBranch}'. Run 'contextgit init' first.`,
        )
      }

      const commits = await store.listCommits(branch.id, { limit: flags.limit, offset: 0 })
      if (commits.length === 0) {
        this.log(`No commits on branch '${branch.name}'.`)
        return
      }

      this.log(`Branch: ${branch.name}  [${branch.gitBranch}]`)
      this.log(`Showing ${commits.length} commit(s)\n`)
      this.printCommits(commits, flags.verbose)
    }
  }

  private printCommits(
    commits: import('@contextgit/core').Commit[],
    verbose: boolean,
  ): void {
    for (const c of commits) {
      const ts = new Date(c.createdAt).toLocaleString()
      const sha = c.gitCommitSha ? `  git:${c.gitCommitSha.slice(0, 7)}` : ''
      const agent = c.agentId ? `  [${c.agentId}]` : ''
      this.log(`commit ${c.id}`)
      this.log(`Date:   ${ts}${sha}${agent}`)
      this.log(``)
      this.log(`    ${c.message}`)
      if (verbose && c.content && c.content !== c.message) {
        this.log(``)
        const lines = c.content.split('\n')
        for (const line of lines) {
          this.log(`    ${line}`)
        }
      }
      this.log(``)
    }
  }
}
