// SupabaseStore — ContextStore backed by Supabase (Postgres + pgvector).
//
// This store is a push/pull sync target. LocalStore remains the live primary store.
// SUPABASE_SERVICE_KEY env var provides the service role key (never written to disk).
//
// Key design notes:
//   • TEXT primary keys (nanoid) — same as LocalStore, no ID translation on push/pull
//   • TIMESTAMPTZ in Postgres — parsed to Date at the boundary via d()
//   • branchProjectCache avoids N round-trips during batch commit pushes
//   • project_id on commits is a denormalized server-side column — not in Commit domain type
//   • All Supabase errors throw; no silent failures

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { nanoid } from 'nanoid'
import { SnapshotFormatter } from '@contextgit/core'
import type {
  Agent,
  AgentInput,
  AgentRole,
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
import type { ContextStore } from '../interface.js'

// ─── Row type ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

// ─── Date helper ──────────────────────────────────────────────────────────────

function d(s: unknown): Date {
  return typeof s === 'string' ? new Date(s) : new Date(0)
}

// ─── Row → domain parsers ─────────────────────────────────────────────────────

function parseProject(row: Row): Project {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string | undefined ?? undefined,
    githubUrl: row['github_url'] as string | undefined ?? undefined,
    createdAt: d(row['created_at']),
  }
}

function parseBranch(row: Row): Branch {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    name: row['name'] as string,
    gitBranch: row['git_branch'] as string,
    githubPrUrl: row['github_pr_url'] as string | undefined ?? undefined,
    parentBranchId: row['parent_branch_id'] as string | undefined ?? undefined,
    headCommitId: row['head_commit_id'] as string | undefined ?? undefined,
    status: row['status'] as Branch['status'],
    createdAt: d(row['created_at']),
    mergedAt: row['merged_at'] ? d(row['merged_at']) : undefined,
  }
}

function parseCommit(row: Row): Commit {
  return {
    id: row['id'] as string,
    branchId: row['branch_id'] as string,
    parentId: row['parent_id'] as string | undefined ?? undefined,
    agentId: row['agent_id'] as string,
    agentRole: row['agent_role'] as Commit['agentRole'],
    tool: row['tool'] as string,
    workflowType: row['workflow_type'] as Commit['workflowType'],
    loopIteration: row['loop_iteration'] as number | undefined ?? undefined,
    ciRunId: row['ci_run_id'] as string | undefined ?? undefined,
    pipelineName: row['pipeline_name'] as string | undefined ?? undefined,
    message: row['message'] as string,
    content: row['content'] as string,
    summary: row['summary'] as string,
    commitType: row['commit_type'] as Commit['commitType'],
    gitCommitSha: row['git_commit_sha'] as string | undefined ?? undefined,
    createdAt: d(row['created_at']),
    // NOTE: project_id is a server-side denormalized column; not in Commit domain type
  }
}

function parseThread(row: Row): Thread {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    branchId: row['branch_id'] as string,
    description: row['description'] as string,
    status: row['status'] as Thread['status'],
    workflowType: row['workflow_type'] as import('@contextgit/core').WorkflowType | undefined ?? undefined,
    openedInCommit: row['opened_in_commit'] as string,
    closedInCommit: row['closed_in_commit'] as string | undefined ?? undefined,
    closedNote: row['closed_note'] as string | undefined ?? undefined,
    createdAt: d(row['created_at']),
    updatedAt: row['updated_at'] ? d(row['updated_at']) : undefined,
  }
}

function parseClaim(row: Row): Claim {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    branchId: row['branch_id'] as string,
    task: row['task'] as string,
    agentId: row['agent_id'] as string,
    role: row['role'] as Claim['role'],
    claimedAt: d(row['claimed_at']),
    status: row['status'] as Claim['status'],
    ttl: row['ttl'] as number,
    releasedAt: row['released_at'] ? d(row['released_at']) : undefined,
    threadId: row['thread_id'] as string | undefined ?? undefined,
  }
}

function parseAgent(row: Row): Agent {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    role: row['role'] as Agent['role'],
    tool: row['tool'] as string,
    workflowType: row['workflow_type'] as Agent['workflowType'],
    displayName: row['display_name'] as string | undefined ?? undefined,
    totalCommits: row['total_commits'] as number,
    lastSeen: d(row['last_seen']),
    createdAt: d(row['created_at']),
  }
}

// ─── SupabaseStore ────────────────────────────────────────────────────────────

function msSince(date: Date): string {
  const ms = Date.now() - date.getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hour${hours !== 1 ? 's' : ''} ago`
}

const snapshotFormatter = new SnapshotFormatter()

export class SupabaseStore implements ContextStore {
  private readonly db: SupabaseClient
  // Cache branchId → projectId to avoid N round-trips during batch commit pushes.
  private readonly branchProjectCache = new Map<string, string>()

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey)
  }

  // Throws on Supabase error; returns T (not null).
  // Accepts PromiseLike so Supabase query builder types work without explicit casts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async q<T>(p: any): Promise<T> {
    const { data, error } = await p as { data: T | null; error: { message: string } | null }
    if (error) throw new Error(error.message)
    if (data === null) throw new Error('Unexpected null response from Supabase')
    return data
  }

  // Like q() but returns null instead of throwing when data is null.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async qNull<T>(p: any): Promise<T | null> {
    const { data, error } = await p as { data: T | null; error: { message: string } | null }
    if (error) throw new Error(error.message)
    return data
  }

  private async resolveProjectId(branchId: string): Promise<string> {
    if (this.branchProjectCache.has(branchId)) return this.branchProjectCache.get(branchId)!
    const branch = await this.getBranch(branchId)
    if (!branch) throw new Error(`Branch not found: ${branchId}`)
    this.branchProjectCache.set(branchId, branch.projectId)
    return branch.projectId
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async createProject(input: ProjectInput): Promise<Project> {
    const id = input.id ?? nanoid()
    const row = await this.q(
      this.db.from('projects').insert({
        id,
        name: input.name,
        description: input.description ?? null,
        github_url: input.githubUrl ?? null,
        summary: '',
      }).select().single()
    )
    return parseProject(row as Row)
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.qNull(
      this.db.from('projects').select('*').eq('id', id).maybeSingle()
    )
    return row ? parseProject(row as Row) : null
  }

  // ── Branches ──────────────────────────────────────────────────────────────

  async createBranch(input: BranchInput): Promise<Branch> {
    // Idempotent: if caller supplied an ID and it already exists, return existing
    if (input.id) {
      const existing = await this.getBranch(input.id)
      if (existing) return existing
    }
    const id = input.id ?? nanoid()
    const row = await this.q(
      this.db.from('branches').insert({
        id,
        project_id: input.projectId,
        name: input.name,
        git_branch: input.gitBranch,
        summary: '',
        github_pr_url: input.githubPrUrl ?? null,
        parent_branch_id: input.parentBranchId ?? null,
        status: 'active',
      }).select().single()
    )
    return parseBranch(row as Row)
  }

  async getBranch(id: string): Promise<Branch | null> {
    const row = await this.qNull(
      this.db.from('branches').select('*').eq('id', id).maybeSingle()
    )
    return row ? parseBranch(row as Row) : null
  }

  async getBranchByGitName(projectId: string, gitBranch: string): Promise<Branch | null> {
    const row = await this.qNull(
      this.db.from('branches').select('*')
        .eq('project_id', projectId)
        .eq('git_branch', gitBranch)
        .maybeSingle()
    )
    return row ? parseBranch(row as Row) : null
  }

  async listBranches(projectId: string): Promise<Branch[]> {
    const rows = await this.q(
      this.db.from('branches').select('*').eq('project_id', projectId)
    )
    return (rows as Row[]).map(parseBranch)
  }

  async updateBranchHead(branchId: string, commitId: string): Promise<void> {
    const { error } = await this.db.from('branches')
      .update({ head_commit_id: commitId })
      .eq('id', branchId)
    if (error) throw new Error(error.message)
  }

  async mergeBranch(sourceBranchId: string, targetBranchId: string, summary: string): Promise<Commit> {
    const [source, target] = await Promise.all([
      this.getBranch(sourceBranchId),
      this.getBranch(targetBranchId),
    ])
    if (!source) throw new Error(`Source branch not found: ${sourceBranchId}`)
    if (!target) throw new Error(`Target branch not found: ${targetBranchId}`)

    const commitId = nanoid()
    const row = await this.q(
      this.db.from('commits').insert({
        id: commitId,
        branch_id: targetBranchId,
        project_id: target.projectId,
        parent_id: target.headCommitId ?? null,
        merge_source_branch_id: sourceBranchId,
        agent_id: 'system',
        agent_role: 'orchestrator',
        tool: 'contextgit',
        workflow_type: 'interactive',
        message: `Merge ${source.name} into ${target.name}`,
        content: summary,
        summary,
        commit_type: 'merge',
      }).select().single()
    )

    // Update target HEAD and mark source merged (fire in parallel)
    await Promise.all([
      this.updateBranchHead(targetBranchId, commitId),
      this.db.from('branches').update({ status: 'merged', merged_at: new Date().toISOString() }).eq('id', sourceBranchId),
      // Carry open threads from source to target
      this.db.from('threads').update({ branch_id: targetBranchId }).eq('branch_id', sourceBranchId).eq('status', 'open'),
    ])

    return parseCommit(row as Row)
  }

  // ── Commits ───────────────────────────────────────────────────────────────

  async createCommit(input: CommitInput): Promise<Commit> {
    // Idempotent: if caller supplied an ID and it already exists, return existing
    if (input.id) {
      const existing = await this.getCommit(input.id)
      if (existing) return existing
    }
    const id = input.id ?? nanoid()
    const projectId = await this.resolveProjectId(input.branchId)

    const row = await this.q(
      this.db.from('commits').insert({
        id,
        branch_id: input.branchId,
        project_id: projectId,
        parent_id: input.parentId ?? null,
        agent_id: input.agentId,
        agent_role: input.agentRole,
        tool: input.tool,
        workflow_type: input.workflowType,
        loop_iteration: input.loopIteration ?? null,
        ci_run_id: input.ciRunId ?? null,
        pipeline_name: input.pipelineName ?? null,
        message: input.message,
        content: input.content,
        summary: input.summary,
        commit_type: input.commitType,
        git_commit_sha: input.gitCommitSha ?? null,
      }).select().single()
    )
    return parseCommit(row as Row)
  }

  async getCommit(id: string): Promise<Commit | null> {
    const row = await this.qNull(
      this.db.from('commits').select('*').eq('id', id).maybeSingle()
    )
    return row ? parseCommit(row as Row) : null
  }

  async listCommits(branchId: string, pagination: Pagination): Promise<Commit[]> {
    const rows = await this.q(
      this.db.from('commits').select('*')
        .eq('branch_id', branchId)
        .order('created_at', { ascending: false })
        .range(pagination.offset, pagination.offset + pagination.limit - 1)
    )
    return (rows as Row[]).map(parseCommit)
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  async getSessionSnapshot(
    projectId: string,
    branchId: string,
    options?: { agentRole?: AgentRole },
  ): Promise<SessionSnapshot> {
    const branch = await this.getBranch(branchId)
    if (!branch) throw new Error(`Branch not found: ${branchId}`)

    // Project summary: from parent branch head commit (child branch)
    // or from current branch head commit (main/root branch).
    // branchSummary and projectSummary may be the same commit on main — fetch once.
    let headCommit: Commit | null = null
    if (branch.headCommitId) {
      headCommit = await this.getCommit(branch.headCommitId)
    }

    let projectSummary = headCommit?.summary ?? ''
    if (branch.parentBranchId) {
      // Child branch: project summary comes from parent's head commit
      const parentBranch = await this.getBranch(branch.parentBranchId)
      if (parentBranch?.headCommitId) {
        const parentHead = await this.getCommit(parentBranch.headCommitId)
        projectSummary = parentHead?.summary ?? ''
      }
    }

    // Recent commits (role-filtered if requested)
    let commitsQuery = this.db.from('commits').select('*')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(3)
    if (options?.agentRole) {
      commitsQuery = (commitsQuery as unknown as { eq: (k: string, v: string) => typeof commitsQuery })
        .eq('agent_role', options.agentRole) as typeof commitsQuery
    }

    // Open threads scoped to branch (not whole project) to match LocalStore semantics
    const [commitsResult, threadsResult, claimsResult] = await Promise.all([
      commitsQuery,
      this.db.from('threads').select('*').eq('branch_id', branchId).eq('status', 'open'),
      this.db.rpc('list_active_claims', { p_project_id: projectId }),
    ])

    if (commitsResult.error) throw new Error(commitsResult.error.message)
    if (threadsResult.error) throw new Error(threadsResult.error.message)
    if (claimsResult.error) throw new Error(claimsResult.error.message)

    return {
      projectSummary,
      branchName: branch.name,
      branchSummary: headCommit?.summary ?? '',   // reuses the already-fetched commit
      recentCommits: ((commitsResult.data ?? []) as Row[]).map(parseCommit),
      openThreads: ((threadsResult.data ?? []) as Row[]).map(parseThread),
      activeClaims: ((claimsResult.data ?? []) as Row[]).map(parseClaim),
    }
  }

  async getFormattedSnapshot(projectId: string, branchId: string, format: SnapshotFormat): Promise<string> {
    const snapshot = await this.getSessionSnapshot(projectId, branchId)
    return snapshotFormatter.format(snapshot, format)
  }

  // ── Threads ───────────────────────────────────────────────────────────────

  async listOpenThreads(projectId: string): Promise<Thread[]> {
    const rows = await this.q(
      this.db.from('threads').select('*').eq('project_id', projectId).eq('status', 'open')
    )
    return (rows as Row[]).map(parseThread)
  }

  async listOpenThreadsByBranch(branchId: string): Promise<Thread[]> {
    const rows = await this.q(
      this.db.from('threads').select('*').eq('branch_id', branchId).eq('status', 'open')
    )
    return (rows as Row[]).map(parseThread)
  }

  async syncThread(thread: Thread): Promise<Thread> {
    // Upsert on id conflict — thread may have been closed since first push
    const row = await this.q(
      this.db.from('threads').upsert({
        id: thread.id,
        project_id: thread.projectId,
        branch_id: thread.branchId,
        description: thread.description,
        status: thread.status,
        workflow_type: thread.workflowType ?? null,
        opened_in_commit: thread.openedInCommit,
        closed_in_commit: thread.closedInCommit ?? null,
        closed_note: thread.closedNote ?? null,
      }, { onConflict: 'id' }).select().single()
    )
    return parseThread(row as Row)
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async indexEmbedding(commitId: string, vector: Float32Array): Promise<void> {
    const { error } = await this.db.from('commits')
      .update({ embedding: Array.from(vector) })
      .eq('id', commitId)
    if (error) throw new Error(error.message)
  }

  async semanticSearch(vector: Float32Array, projectId: string, limit: number): Promise<SearchResult[]> {
    const { data, error } = await this.db.rpc('match_commits', {
      query_embedding: Array.from(vector),
      project_id: projectId,
      match_count: limit,
    })
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) return []

    // Fetch full commit rows for the returned IDs
    const ids = (data as Array<{ id: string; score: number }>).map(r => r.id)
    const scoreMap = new Map((data as Array<{ id: string; score: number }>).map(r => [r.id, r.score]))

    const rows = await this.q(
      this.db.from('commits').select('*').in('id', ids)
    )
    return (rows as Row[]).map(row => ({
      commit: parseCommit(row),
      score: scoreMap.get(row['id'] as string) ?? 0,
      matchType: 'semantic' as const,
    }))
  }

  async fullTextSearch(query: string, projectId: string): Promise<SearchResult[]> {
    const rows = await this.q(
      this.db.from('commits').select('*')
        .eq('project_id', projectId)
        .textSearch('fts', query, { type: 'plain', config: 'english' })
    )
    // Supabase textSearch does not expose BM25 scores; fixed score of 1.0
    return (rows as Row[]).map(row => ({
      commit: parseCommit(row),
      score: 1.0,
      matchType: 'fulltext' as const,
    }))
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async upsertAgent(input: AgentInput): Promise<Agent> {
    // NOTE: AgentInput has no totalCommits field, so total_commits is not included
    // in the upsert payload. On Supabase the column defaults to 0 on first insert.
    // On subsequent upserts the column is reset to 0 — this is a known limitation.
    // total_commits is authoritative in LocalStore only; Supabase reflects push-time state.
    const row = await this.q(
      this.db.from('agents').upsert({
        id: input.id,
        project_id: input.projectId,
        role: input.role,
        tool: input.tool,
        workflow_type: input.workflowType,
        display_name: input.displayName ?? null,
        last_seen: new Date().toISOString(),
      }, { onConflict: 'id' }).select().single()
    )
    return parseAgent(row as Row)
  }

  async listAgents(projectId: string): Promise<Agent[]> {
    const rows = await this.q(
      this.db.from('agents').select('*').eq('project_id', projectId)
    )
    return (rows as Row[]).map(parseAgent)
  }

  // ── Claims ────────────────────────────────────────────────────────────────

  async claimTask(projectId: string, branchId: string, input: ClaimInput): Promise<Claim> {
    // Use listActiveClaims (RPC-backed, TTL-aware) to check for conflicts.
    // This reuses the already-tested TTL expiry path and avoids duplicating
    // the SQL `claimed_at + (ttl || ' milliseconds')::interval > NOW()` logic.
    const active = await this.listActiveClaims(projectId)
    const conflict = active.find(c => c.task === input.task)

    if (conflict) {
      throw new Error(
        `Task "${input.task}" is already claimed by ${conflict.agentId} ` +
        `(claimed ${msSince(conflict.claimedAt)}). ` +
        `Pick a different task or wait for the claim to expire.`
      )
    }

    const id = nanoid()
    const row = await this.q(
      this.db.from('claims').insert({
        id,
        project_id: projectId,
        branch_id: branchId,
        task: input.task,
        agent_id: input.agentId,
        role: input.role,
        status: input.status ?? 'proposed',
        ttl: input.ttl ?? 7_200_000,
        thread_id: input.threadId ?? null,
      }).select().single()
    )
    return parseClaim(row as Row)
  }

  async unclaimTask(claimId: string): Promise<void> {
    const { error } = await this.db.from('claims')
      .update({ status: 'released', released_at: new Date().toISOString() })
      .eq('id', claimId)
    if (error) throw new Error(error.message)
  }

  async listActiveClaims(projectId: string): Promise<Claim[]> {
    // TTL filter applied in SQL via the list_active_claims function
    const { data, error } = await this.db.rpc('list_active_claims', { p_project_id: projectId })
    if (error) throw new Error(error.message)
    return ((data ?? []) as Row[]).map(parseClaim)
  }

  // ── Delta ─────────────────────────────────────────────────────────────────

  async getContextDelta(projectId: string, branchId: string, since: number): Promise<ContextDelta> {
    // Strictly greater than — matches LocalStore semantics (> datetime(since/1000, 'unixepoch'))
    const sinceIso = new Date(since).toISOString()

    const [commitsResult, threadsResult, claimsResult] = await Promise.all([
      this.db.from('commits').select('*')
        .eq('branch_id', branchId)
        .gt('created_at', sinceIso)
        .order('created_at', { ascending: true }),
      this.db.from('threads').select('*')
        .eq('project_id', projectId)
        .gt('updated_at', sinceIso),
      this.db.rpc('list_active_claims', { p_project_id: projectId }),
    ])

    if (commitsResult.error) throw new Error(commitsResult.error.message)
    if (threadsResult.error) throw new Error(threadsResult.error.message)
    if (claimsResult.error) throw new Error(claimsResult.error.message)

    const allThreadChanges = ((threadsResult.data ?? []) as Row[]).map(parseThread)
    return {
      newCommits: ((commitsResult.data ?? []) as Row[]).map(parseCommit),
      openedThreads: allThreadChanges.filter(t => t.status === 'open'),
      closedThreads: allThreadChanges.filter(t => t.status === 'closed'),
      activeClaims: ((claimsResult.data ?? []) as Row[]).map(parseClaim),
      checkedAt: Date.now(),
    }
  }
}
