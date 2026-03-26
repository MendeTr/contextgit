// pull — pull context commits from a remote ContextGit API server into local store.
//
// Requires `remote` in .contextgit/config.json.
// Algorithm:
//   1. Ensure project exists locally (by ID — already initialized)
//   2. For each remote branch: ensure branch exists locally
//   3. For each branch: collect remote commits not present locally, write them

import { Command, Flags } from '@oclif/core'
import { LocalStore, resolveDbPath } from '@contextgit/store'
import type { ContextStore } from '@contextgit/store'
import type { Pagination } from '@contextgit/core'
import { loadConfig } from '../config.js'
import { resolveRemoteStore } from '../lib/remote-store.js'

const PAGE = 100

async function allCommits(
  store: ContextStore,
  branchId: string,
): Promise<import('@contextgit/core').Commit[]> {
  const acc: import('@contextgit/core').Commit[] = []
  let offset = 0
  const pg: Pagination = { limit: PAGE, offset }
  while (true) {
    pg.offset = offset
    const page = await store.listCommits(branchId, pg)
    acc.push(...page)
    if (page.length < PAGE) break
    offset += PAGE
  }
  return acc
}

export default class PullCmd extends Command {
  static description = 'Pull context commits from a remote ContextGit API'

  static flags = {
    remote: Flags.string({
      char: 'r',
      description: 'Remote API URL (overrides config.remote)',
      required: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Show what would be pulled without writing locally',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(PullCmd)
    const config = loadConfig()

    const local = new LocalStore(config.projectId, resolveDbPath(config.projectId, config.configDir))
    const remote = resolveRemoteStore(config, flags.remote)
    const dryRun = flags['dry-run']

    // Verify project exists on remote
    const remoteProject = await remote.getProject(config.projectId).catch(() => null)
    if (!remoteProject) {
      this.error(`Project ${config.projectId} not found on remote. Push first.`)
    }

    // Ensure project exists locally before creating branches (FK requirement)
    const localProject = await local.getProject(config.projectId).catch(() => null)
    if (!localProject && !dryRun) {
      await local.createProject({ id: config.projectId, name: config.project })
      this.log(`[project] created locally: ${config.project}`)
    }

    // List all remote branches
    const remoteBranches = await remote.listBranches(config.projectId)
    let totalPulled = 0

    for (const branch of remoteBranches) {
      // Ensure branch exists locally
      const localBranch = await local.getBranch(branch.id).catch(() => null)
      if (!localBranch) {
        if (!dryRun) {
          await local.createBranch({
            id: branch.id,
            projectId: branch.projectId,
            name: branch.name,
            gitBranch: branch.gitBranch,
            parentBranchId: branch.parentBranchId,
          })
        }
        this.log(`[branch] ${dryRun ? 'would create' : 'created'}: ${branch.name}`)
      }

      // Collect local commit IDs for this branch
      const localCommits = await allCommits(local, branch.id)
      const localCommitIds = new Set(localCommits.map(c => c.id))

      // Pull missing commits from remote
      const remoteCommits = await allCommits(remote, branch.id)
      // Reverse to pull oldest-first — parent_id FK requires parent to exist before child
      const missing = remoteCommits.filter(c => !localCommitIds.has(c.id)).reverse()

      if (missing.length === 0) {
        this.log(`[branch] ${branch.name}: up to date (${remoteCommits.length} commits)`)
        continue
      }

      this.log(`[branch] ${branch.name}: pulling ${missing.length} commit(s)…`)

      for (const commit of missing) {
        if (!dryRun) {
          await local.createCommit({
            id: commit.id,
            branchId: commit.branchId,
            parentId: commit.parentId,
            agentId: commit.agentId,
            agentRole: commit.agentRole,
            tool: commit.tool,
            workflowType: commit.workflowType,
            loopIteration: commit.loopIteration,
            ciRunId: commit.ciRunId,
            pipelineName: commit.pipelineName,
            message: commit.message,
            content: commit.content,
            summary: commit.summary,
            commitType: commit.commitType,
            gitCommitSha: commit.gitCommitSha,
          })
        }
        totalPulled++
      }
    }

    // Thread sync: pull open threads that are missing locally
    const remoteThreads = await remote.listOpenThreads(config.projectId)
    const localThreads = await local.listOpenThreads(config.projectId)
    const localThreadIds = new Set(localThreads.map(t => t.id))
    const missingThreads = remoteThreads.filter(t => !localThreadIds.has(t.id))
    if (missingThreads.length > 0) {
      this.log(`\n[threads] pulling ${missingThreads.length} open thread(s)…`)
      for (const thread of missingThreads) {
        if (!dryRun) {
          await local.syncThread(thread)
        }
        this.log(`  ${dryRun ? 'would pull' : 'pulled'}: ${thread.description}`)
      }
    }

    this.log(`\nDone. ${dryRun ? '(dry run) ' : ''}${totalPulled} commit(s), ${missingThreads.length} thread(s) pulled.`)
  }
}
