// LocalStore — better-sqlite3 + sqlite-vec implementation of ContextStore.
//
// Key invariants:
//   • All SQLite calls are synchronous (better-sqlite3).
//   • The ContextStore interface returns Promises, so we wrap at the boundary
//     with Promise.resolve() / Promise.reject().
//   • IDs are nanoid() TEXT — never auto-increment integers.
//   • DB path: ~/.contextgit/projects/<projectId>.db

import { homedir } from 'os'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'

const require = createRequire(import.meta.url)
import type {
  Agent,
  AgentInput,
  Branch,
  BranchInput,
  Claim,
  ClaimInput,
  Commit,
  CommitInput,
  ContextDelta,
  Pagination,
  Project,
  ProjectInput,
  SearchResult,
  SessionSnapshot,
  SnapshotFormat,
  Thread,
} from '@contextgit/core'
import { SnapshotFormatter } from '@contextgit/core'
import type { ContextStore } from '../interface.js'
import { runMigrations } from './migrations.js'
import { Queries } from './queries.js'

const snapshotFormatter = new SnapshotFormatter()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function msSince(date: Date): string {
  const ms = Date.now() - date.getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hour${hours !== 1 ? 's' : ''} ago`
}

// ─── LocalStore ───────────────────────────────────────────────────────────────

export class LocalStore implements ContextStore {
  private readonly db: Database.Database
  private readonly q: Queries

  /**
   * @param projectId  Used to derive the DB file path.
   *                   Pass ':memory:' for tests.
   */
  constructor(projectId: string) {
    let dbPath: string
    if (projectId === ':memory:') {
      dbPath = ':memory:'
    } else {
      const dir = join(homedir(), '.contextgit', 'projects')
      mkdirSync(dir, { recursive: true })
      dbPath = join(dir, `${projectId}.db`)
    }

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('foreign_keys = ON')

    // Attempt to load sqlite-vec extension — graceful failure if not available
    try {
      const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void }
      sqliteVec.load(this.db)
    } catch {
      // sqlite-vec not installed or ABI mismatch — semantic search disabled
    }

    runMigrations(this.db)
    this.q = new Queries(this.db)
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  createProject(project: ProjectInput): Promise<Project> {
    try {
      return Promise.resolve(this.q.insertProject({ id: project.id ?? nanoid(), ...project }))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  getProject(id: string): Promise<Project | null> {
    try {
      return Promise.resolve(this.q.getProject(id))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Branches ─────────────────────────────────────────────────────────────

  createBranch(branch: BranchInput): Promise<Branch> {
    try {
      const id = branch.id ?? nanoid()
      // Idempotent: if caller supplied an ID and it already exists, return existing
      if (branch.id) {
        const existing = this.q.getBranch(branch.id)
        if (existing) return Promise.resolve(existing)
      }
      return Promise.resolve(this.q.insertBranch({ ...branch, id }))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  getBranch(id: string): Promise<Branch | null> {
    try {
      return Promise.resolve(this.q.getBranch(id))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  getBranchByGitName(projectId: string, gitBranch: string): Promise<Branch | null> {
    try {
      return Promise.resolve(this.q.getBranchByGitName(projectId, gitBranch))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  listBranches(projectId: string): Promise<Branch[]> {
    try {
      return Promise.resolve(this.q.listBranches(projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  updateBranchHead(branchId: string, commitId: string): Promise<void> {
    try {
      this.q.updateBranchHead(branchId, commitId)
      return Promise.resolve()
    } catch (e) {
      return Promise.reject(e)
    }
  }

  mergeBranch(sourceBranchId: string, targetBranchId: string, summary: string): Promise<Commit> {
    try {
      const result = this.db.transaction((): Commit => {
        const sourceBranch = this.q.getBranch(sourceBranchId)
        if (!sourceBranch) throw new Error(`Source branch not found: ${sourceBranchId}`)
        const targetBranch = this.q.getBranch(targetBranchId)
        if (!targetBranch) throw new Error(`Target branch not found: ${targetBranchId}`)

        const mergeCommitInput: CommitInput = {
          branchId: targetBranchId,
          parentId: targetBranch.headCommitId,
          agentId: 'system',
          agentRole: 'orchestrator',
          tool: 'contextgit',
          workflowType: 'interactive',
          message: `Merge ${sourceBranch.name} into ${targetBranch.name}`,
          content: summary,
          summary,
          commitType: 'merge',
        }

        const mergeCommit = this.q.insertCommit(
          nanoid(),
          mergeCommitInput,
          targetBranch.headCommitId ?? null,
          sourceBranchId,
        )

        // Update target branch HEAD
        this.q.updateBranchHead(targetBranchId, mergeCommit.id)

        // Mark source branch as merged
        this.q.markBranchMerged(sourceBranchId)

        // Carry open threads from source branch to target branch
        this.q.reassignOpenThreads(sourceBranchId, targetBranchId)

        return mergeCommit
      })()

      return Promise.resolve(result)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Commits ──────────────────────────────────────────────────────────────

  createCommit(input: CommitInput): Promise<Commit> {
    try {
      // Idempotent: if caller supplied an ID and it already exists, return existing
      if (input.id) {
        const existing = this.q.getCommit(input.id)
        if (existing) return Promise.resolve(existing)
      }

      const result = this.db.transaction((): Commit => {
        const branch = this.q.getBranch(input.branchId)
        if (!branch) throw new Error(`Branch not found: ${input.branchId}`)

        const commitId = input.id ?? nanoid()
        const parentId = input.parentId ?? branch.headCommitId ?? null

        const commit = this.q.insertCommit(commitId, input, parentId)

        // Handle thread operations
        if (input.threads?.open?.length) {
          for (const description of input.threads.open) {
            this.q.insertThread(
              nanoid(),
              description,
              branch.projectId,
              input.branchId,
              commitId,
              input.workflowType ?? null,
            )
          }
        }

        if (input.threads?.close?.length) {
          for (const { id, note } of input.threads.close) {
            this.q.closeThread(id, commitId, note)
          }
        }

        // Update branch HEAD
        this.q.updateBranchHead(input.branchId, commitId)

        // Update agent stats
        this.q.incrementAgentCommits(input.agentId)

        // Auto-release this agent's claims on this branch (branch-scoped)
        this.q.releaseClaimsByAgent(input.agentId, input.branchId)

        return commit
      })()

      return Promise.resolve(result)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  getCommit(id: string): Promise<Commit | null> {
    try {
      return Promise.resolve(this.q.getCommit(id))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  listCommits(branchId: string, pagination: Pagination): Promise<Commit[]> {
    try {
      return Promise.resolve(this.q.listCommits(branchId, pagination))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Snapshots ────────────────────────────────────────────────────────────

  getSessionSnapshot(projectId: string, branchId: string, options?: { agentRole?: import('@contextgit/core').AgentRole }): Promise<SessionSnapshot> {
    try {
      return Promise.resolve(this.q.getSessionSnapshot(projectId, branchId, options))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  getFormattedSnapshot(projectId: string, branchId: string, format: SnapshotFormat): Promise<string> {
    try {
      const snapshot = this.q.getSessionSnapshot(projectId, branchId)
      return Promise.resolve(snapshotFormatter.format(snapshot, format))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Threads ──────────────────────────────────────────────────────────────

  listOpenThreads(projectId: string): Promise<Thread[]> {
    try {
      return Promise.resolve(this.q.listOpenThreads(projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  listOpenThreadsByBranch(branchId: string): Promise<Thread[]> {
    try {
      return Promise.resolve(this.q.listOpenThreadsByBranch(branchId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  syncThread(thread: Thread): Promise<Thread> {
    try {
      return Promise.resolve(this.q.syncThread(thread))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  indexEmbedding(commitId: string, vector: Float32Array): Promise<void> {
    this.q.insertEmbedding(this.db, commitId, vector)
    return Promise.resolve()
  }

  semanticSearch(vector: Float32Array, projectId: string, limit: number): Promise<SearchResult[]> {
    return Promise.resolve(this.q.semanticSearch(this.db, vector, projectId, limit))
  }

  fullTextSearch(query: string, projectId: string): Promise<SearchResult[]> {
    try {
      return Promise.resolve(this.q.fullTextSearch(this.db, query, projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Agents ───────────────────────────────────────────────────────────────

  upsertAgent(agent: AgentInput): Promise<Agent> {
    try {
      return Promise.resolve(this.q.upsertAgent(agent))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  listAgents(projectId: string): Promise<Agent[]> {
    try {
      return Promise.resolve(this.q.listAgents(projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Claims ───────────────────────────────────────────────────────────────

  claimTask(projectId: string, branchId: string, input: ClaimInput): Promise<Claim> {
    try {
      // Check for existing active claim on the same task (matches SupabaseStore behavior)
      const active = this.q.listActiveClaims(projectId)
      const conflict = active.find(c => c.task === input.task)
      if (conflict) {
        throw new Error(
          `Task "${input.task}" is already claimed by ${conflict.agentId} ` +
          `(claimed ${msSince(conflict.claimedAt)}). ` +
          `Pick a different task or wait for the claim to expire.`
        )
      }

      return Promise.resolve(this.q.insertClaim(nanoid(), projectId, branchId, input))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  unclaimTask(claimId: string): Promise<void> {
    try {
      this.q.updateClaimStatus(claimId, 'released', Date.now())
      return Promise.resolve()
    } catch (e) {
      return Promise.reject(e)
    }
  }

  listActiveClaims(projectId: string): Promise<Claim[]> {
    try {
      return Promise.resolve(this.q.listActiveClaims(projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  getContextDelta(projectId: string, branchId: string, since: number): Promise<ContextDelta> {
    try {
      const newCommits = this.q.listCommitsSince(branchId, since)
      const threadChanges = this.q.listThreadChangesSince(projectId, since)
      const openedThreads = threadChanges.filter((t) => t.status === 'open')
      const closedThreads = threadChanges.filter((t) => t.status === 'closed')
      const activeClaims = this.q.listActiveClaims(projectId)
      return Promise.resolve({ newCommits, openedThreads, closedThreads, activeClaims, checkedAt: Date.now() })
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.db.close()
  }
}
