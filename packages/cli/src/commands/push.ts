// push — push local context commits to a remote ContextGit API server.
//
// Requires `remote` in .contextgit/config.json.
// Algorithm:
//   1. Ensure project exists on remote (idempotent via ID)
//   2. For each local branch: ensure branch exists on remote
//   3. For each branch: collect local commits not present on remote, POST them

import { Command, Flags } from '@oclif/core'
import { LocalStore, RemoteStore } from '@contextgit/store'
import type { Pagination } from '@contextgit/core'
import { loadConfig } from '../config.js'

const PAGE = 100

async function allCommits(
  store: LocalStore | RemoteStore,
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

export default class PushCmd extends Command {
  static description = 'Push local context commits to a remote ContextGit API'

  static flags = {
    remote: Flags.string({
      char: 'r',
      description: 'Remote API URL (overrides config.remote)',
      required: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Show what would be pushed without actually pushing',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(PushCmd)
    const config = loadConfig()

    const remoteUrl = flags.remote ?? config.remote
    if (!remoteUrl) {
      this.error('No remote configured. Use: contextgit set-remote <url>', { exit: 1 })
    }

    const local = new LocalStore(config.projectId)
    const remote = new RemoteStore(remoteUrl)
    const dryRun = flags['dry-run']

    // 1. Ensure project on remote
    const existingProject = await remote.getProject(config.projectId).catch(() => null)
    if (!existingProject) {
      if (!dryRun) {
        await remote.createProject({ id: config.projectId, name: config.project })
      }
      this.log(`[project] ${dryRun ? 'would create' : 'created'}: ${config.project}`)
    } else {
      this.log(`[project] already exists: ${config.project}`)
    }

    // 2. List all local branches
    const branches = await local.listBranches(config.projectId)
    let totalPushed = 0

    for (const branch of branches) {
      // Ensure branch on remote
      const remoteBranch = await remote.getBranch(branch.id).catch(() => null)
      if (!remoteBranch) {
        if (!dryRun) {
          await remote.createBranch({
            id: branch.id,
            projectId: branch.projectId,
            name: branch.name,
            gitBranch: branch.gitBranch,
            parentBranchId: branch.parentBranchId,
          })
        }
        this.log(`[branch] ${dryRun ? 'would create' : 'created'}: ${branch.name}`)
      }

      // Collect remote commit IDs for this branch
      let remoteCommitIds: Set<string>
      try {
        const remoteCommits = await allCommits(remote, branch.id)
        remoteCommitIds = new Set(remoteCommits.map(c => c.id))
      } catch {
        remoteCommitIds = new Set()
      }

      // Push missing commits
      const localCommits = await allCommits(local, branch.id)
      const missing = localCommits.filter(c => !remoteCommitIds.has(c.id))

      if (missing.length === 0) {
        this.log(`[branch] ${branch.name}: up to date (${localCommits.length} commits)`)
        continue
      }

      this.log(`[branch] ${branch.name}: pushing ${missing.length} commit(s)…`)

      for (const commit of missing) {
        if (!dryRun) {
          await remote.createCommit({
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
        totalPushed++
      }
    }

    this.log(`\nDone. ${dryRun ? '(dry run) ' : ''}${totalPushed} commit(s) pushed to ${remoteUrl}`)
  }
}
