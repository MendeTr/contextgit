

// ============================================
// Primitive Types
// ============================================

export type AgentRole = 
  | 'orchestrator' 
  | 'dev' 
  | 'test' 
  | 'review' 
  | 'background' 
  | 'ci' 
  | 'solo'

export type WorkflowType = 
  | 'interactive' 
  | 'ralph-loop' 
  | 'ci' 
  | 'background' 
  | 'custom'

export type CommitType = 
  | 'manual' 
  | 'auto' 
  | 'merge' 
  | 'branch-init'

export type BranchStatus =
  | 'active'
  | 'merged'
  | 'abandoned'

export type ClaimStatus =
  | 'proposed'
  | 'active'
  | 'released'

export type SnapshotFormat = 
  | 'agents-md' 
  | 'json' 
  | 'text'

export type ContextScope = 
  | 'global' 
  | 'branch' 
  | 'search' 
  | 'commit' 
  | 'raw'

// ============================================
// Core Entities
// ============================================

export interface Project {
  id: string
  name: string
  description?: string
  githubUrl?: string
  createdAt: Date
}

export interface Branch {
  id: string
  projectId: string
  name: string
  gitBranch: string
  githubPrUrl?: string
  parentBranchId?: string
  headCommitId?: string
  status: BranchStatus
  createdAt: Date
  mergedAt?: Date
}

export interface Commit {
  id: string
  branchId: string
  parentId?: string
  mergeSourceBranchId?: string
  agentId: string
  agentRole: AgentRole
  tool: string
  workflowType: WorkflowType
  loopIteration?: number
  ciRunId?: string
  pipelineName?: string
  message: string
  content: string
  summary: string
  commitType: CommitType
  gitCommitSha?: string
  createdAt: Date
}

export interface Thread {
  id: string
  projectId: string
  branchId: string
  description: string        // max 200 chars
  status: 'open' | 'closed'
  workflowType?: WorkflowType
  openedInCommit: string
  closedInCommit?: string
  closedNote?: string
  createdAt: Date
  updatedAt?: Date
}

export interface Agent {
  id: string
  projectId: string
  role: AgentRole
  tool: string
  workflowType: WorkflowType
  displayName?: string
  totalCommits: number
  lastSeen: Date
  createdAt: Date
}

export interface Claim {
  id: string
  projectId: string
  branchId: string
  task: string
  agentId: string
  role: AgentRole
  claimedAt: Date
  status: ClaimStatus
  ttl: number          // ms, default 7_200_000 (2h)
  releasedAt?: Date
  threadId?: string
}

// ============================================
// Input Types (for creating entities)
// ============================================

export interface ProjectInput {
  id?: string           // caller-supplied ID; LocalStore generates nanoid() if omitted
  name: string
  description?: string
  githubUrl?: string
}

export interface BranchInput {
  id?: string           // caller-supplied ID; LocalStore generates nanoid() if omitted
  projectId: string
  name: string
  gitBranch: string
  parentBranchId?: string
  githubPrUrl?: string
}

export interface CommitInput {
  id?: string           // caller-supplied ID; LocalStore generates nanoid() if omitted
  branchId: string
  parentId?: string
  agentId: string
  agentRole: AgentRole
  tool: string
  workflowType: WorkflowType
  loopIteration?: number
  ciRunId?: string
  pipelineName?: string
  message: string
  content: string
  summary: string
  commitType: CommitType
  gitCommitSha?: string
  threads?: {
    open?: string[]
    close?: Array<{ id: string; note: string }>
  }
}

export interface AgentInput {
  id: string
  projectId: string
  role: AgentRole
  tool: string
  workflowType: WorkflowType
  displayName?: string
}

export interface ClaimInput {
  task: string
  agentId: string
  role: AgentRole
  status?: ClaimStatus   // defaults to 'proposed'
  ttl?: number           // ms, defaults to 7_200_000 (2h)
  threadId?: string
}

// ============================================
// Session Snapshot
// ============================================

export interface SessionSnapshot {
  projectSummary: string       // max 2000 tokens
  branchName: string
  branchSummary: string        // max 500 tokens
  recentCommits: Commit[]      // last 3
  openThreads: Thread[]
  activeClaims: Claim[]        // non-released, non-TTL-expired claims
}

export interface ContextDelta {
  newCommits: Commit[]
  openedThreads: Thread[]
  closedThreads: Thread[]
  activeClaims: Claim[]
  checkedAt: number
}

// ============================================
// Search
// ============================================

export interface SearchResult {
  commit: Commit
  score: number
  matchType: 'semantic' | 'fulltext'
}

// ============================================
// Config
// ============================================

export interface ContextGitConfig {
  project: string
  projectId: string
  store: 'local' | string      // 'local' or remote URL
  remote?: string              // remote ContextGit API URL for push/pull
  supabaseUrl?: string          // Supabase project URL for push/pull
  supabaseServiceKey?: string   // Fallback when SUPABASE_SERVICE_KEY env var is not injected (VS Code extension bug)
  agentRole: AgentRole
  workflowType: WorkflowType
  autoSnapshot: boolean
  snapshotInterval: number
  embeddingModel: 'local' | 'openai'
  apiKey?: string
}

// ============================================
// Pagination
// ============================================

export interface Pagination {
  limit: number
  offset: number
}