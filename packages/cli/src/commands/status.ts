// status — show current project/branch/thread status.

import { Command } from '@oclif/core'
import { simpleGit } from 'simple-git'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import { loadConfig } from '../config.js'

export default class StatusCmd extends Command {
  static description = 'Show current ContextGit status'

  async run(): Promise<void> {
    const config = loadConfig()
    const store = new LocalStore(config.projectId, resolveDbPath(config.projectId, config.configDir))
    const cwd = process.cwd()

    // Detect current git branch
    let gitBranch = 'main'
    try {
      gitBranch = (await simpleGit(cwd).revparse(['--abbrev-ref', 'HEAD'])).trim()
    } catch {
      // fallback
    }

    const branch = await store.getBranchByGitName(config.projectId, gitBranch)
    if (!branch) {
      this.error(
        `No context branch found for git branch '${gitBranch}'. Run 'contextgit init' first.`,
      )
    }

    const threads = await store.listOpenThreadsByBranch(branch.id)
    const commits = await store.listCommits(branch.id, { limit: 5, offset: 0 })
    const agents = await store.listAgents(config.projectId)
    const allBranches = await store.listBranches(config.projectId)
    const activeClaims = await store.listActiveClaims(config.projectId)

    this.log(`Project:  ${config.project}  (${config.projectId})`)
    this.log(`Branch:   ${branch.name}  [${branch.status}]`)
    this.log(`Git:      ${gitBranch}`)
    this.log(`Store:    ${config.store === 'local' ? 'local SQLite' : config.store}`)
    if (config.remote) this.log(`Remote:   ${config.remote}`)
    this.log('')
    this.log(`Branches: ${allBranches.length} total`)
    this.log(`Commits:  ${commits.length} recent (showing last 5)`)
    this.log(`Threads:  ${threads.length} open`)
    this.log(`Agents:   ${agents.length} registered`)
    this.log(`Claims:   ${activeClaims.length} active`)

    if (activeClaims.length > 0) {
      this.log('\nActive claims:')
      for (const c of activeClaims) {
        const ttlHours = Math.round(c.ttl / 3_600_000)
        this.log(`  [${c.id.slice(0, 8)}] "${c.task}" by ${c.agentId} (${c.status}, ${ttlHours}h TTL)`)
      }
    }

    if (threads.length > 0) {
      this.log('\nOpen threads:')
      for (const t of threads) {
        // Show inline claim status on threads
        const claim = activeClaims.find(c =>
          c.threadId === t.id ||
          t.description.toLowerCase().includes(c.task.toLowerCase()) ||
          c.task.toLowerCase().includes(t.description.toLowerCase())
        )
        const claimTag = claim ? ` [CLAIMED by ${claim.agentId}]` : ' [FREE]'
        this.log(`  [${t.id.slice(0, 8)}]${claimTag} ${t.description}`)
      }
    }

    if (commits.length > 0) {
      this.log('\nRecent commits:')
      for (const c of commits) {
        const ts = new Date(c.createdAt).toLocaleString()
        this.log(`  [${c.id.slice(0, 8)}] ${c.message}  (${ts})`)
      }
    }

    store.close()
  }
}
