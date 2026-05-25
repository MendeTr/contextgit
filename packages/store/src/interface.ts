import type {
  Agent,
  AgentInput,
  AgentRole,
  ArchivedThread,
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
  TraceEntry,
} from '@contextgit/core'

export interface ContextStore {
  // Projects
  createProject(project: ProjectInput): Promise<Project>
  getProject(id: string): Promise<Project | null>

  // Branches
  createBranch(branch: BranchInput): Promise<Branch>
  getBranch(id: string): Promise<Branch | null>
  getBranchByGitName(projectId: string, gitBranch: string): Promise<Branch | null>
  listBranches(projectId: string): Promise<Branch[]>
  updateBranchHead(branchId: string, commitId: string): Promise<void>
  mergeBranch(sourceBranchId: string, targetBranchId: string, summary: string): Promise<Commit>

  // Commits
  createCommit(commit: CommitInput): Promise<Commit>
  getCommit(id: string): Promise<Commit | null>
  listCommits(branchId: string, pagination: Pagination): Promise<Commit[]>

  // Snapshots
  getSessionSnapshot(projectId: string, branchId: string, options?: { agentRole?: AgentRole; commitWindow?: number }): Promise<SessionSnapshot>
  getFormattedSnapshot(projectId: string, branchId: string, format: SnapshotFormat): Promise<string>

  // Threads
  listOpenThreads(projectId: string): Promise<Thread[]>
  listOpenThreadsByBranch(branchId: string): Promise<Thread[]>
  syncThread(thread: Thread): Promise<Thread>

  // Thread lifecycle (03 DELTA) — optional until SupabaseStore/RemoteStore implement
  archiveThread?(threadId: string, reason: ArchivedThread['archivedReason'], closedInCommit: string | null): Promise<ArchivedThread>
  restoreThread?(threadId: string): Promise<Thread>
  listArchivedThreads?(projectId: string): Promise<ArchivedThread[]>
  findOpenThreadByHandle?(projectId: string, handle: string): Promise<Thread | undefined>
  findArchivedThreadByHandle?(projectId: string, handle: string): Promise<ArchivedThread | undefined>
  sweepStaleThreads?(projectId: string, now: number): Promise<{ archived: number; byReason: Record<'stale-age' | 'stale-distance' | 'watch-expired', number> }>

  // Trace tier (02 DELTA Step 5) — append-only, pull-only, NEVER auto-loaded.
  // Optional on the interface: legacy stores may not implement these yet.
  appendTraceEntry?(input: { projectId: string; branchId: string; note: string; gitCommitSha?: string }): Promise<TraceEntry>
  listTraceEntries?(projectId: string, pagination: Pagination): Promise<TraceEntry[]>

  // Search
  // vector is a 384-dim Float32Array produced by EmbeddingService in core.
  // Callers that cannot generate a vector should skip this and use fullTextSearch.
  indexEmbedding(commitId: string, vector: Float32Array): Promise<void>
  semanticSearch(vector: Float32Array, projectId: string, limit: number): Promise<SearchResult[]>
  fullTextSearch(query: string, projectId: string): Promise<SearchResult[]>

  // Agents
  upsertAgent(agent: AgentInput): Promise<Agent>
  listAgents(projectId: string): Promise<Agent[]>

  // Claims
  claimTask(projectId: string, branchId: string, input: ClaimInput): Promise<Claim>
  unclaimTask(claimId: string): Promise<void>
  listActiveClaims(projectId: string): Promise<Claim[]>

  // Delta (polling)
  getContextDelta(projectId: string, branchId: string, since: number): Promise<ContextDelta>
}
