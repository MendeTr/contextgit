import type {
  Agent,
  AgentInput,
  Branch,
  BranchInput,
  Commit,
  CommitInput,
  Pagination,
  Project,
  ProjectInput,
  SearchResult,
  SessionSnapshot,
  SnapshotFormat,
  Thread,
} from '@contexthub/core'

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
  getSessionSnapshot(projectId: string, branchId: string): Promise<SessionSnapshot>
  getFormattedSnapshot(projectId: string, branchId: string, format: SnapshotFormat): Promise<string>

  // Threads
  listOpenThreads(projectId: string): Promise<Thread[]>
  listOpenThreadsByBranch(branchId: string): Promise<Thread[]>

  // Search
  semanticSearch(query: string, projectId: string, limit: number): Promise<SearchResult[]>
  fullTextSearch(query: string, projectId: string): Promise<SearchResult[]>

  // Agents
  upsertAgent(agent: AgentInput): Promise<Agent>
  listAgents(projectId: string): Promise<Agent[]>
}
