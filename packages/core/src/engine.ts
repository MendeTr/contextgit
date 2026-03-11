// ContextEngine — pure business logic layer, no I/O.
// All persistence is delegated to the injected ContextStore.
//
// Usage:
//   const engine = new ContextEngine(store, 'agent-1', 'dev', 'claude-code', 'interactive')
//   await engine.init(projectId, branchId)
//   await engine.commit({ message: '...', content: '...' })
//   const snapshot = await engine.context('global')

import type {
  AgentRole,
  Branch,
  Commit,
  CommitType,
  ContextScope,
  SearchResult,
  SessionSnapshot,
  WorkflowType,
} from './types.js'
import { RollingSummarizer } from './summarizer.js'
import { EmbeddingService } from './embeddings.js'

// ─── Store subset the engine requires ─────────────────────────────────────────

interface EngineBranchInput {
  projectId: string
  name: string
  gitBranch: string
  parentBranchId?: string
}

export interface EngineStore {
  getBranch(id: string): Promise<{ headCommitId?: string; gitBranch?: string; name?: string } | null>
  getCommit(id: string): Promise<{ summary: string } | null>
  createBranch(input: EngineBranchInput): Promise<Branch>
  createCommit(input: EngineCommitStoreInput): Promise<Commit>
  mergeBranch(sourceBranchId: string, targetBranchId: string, summary: string): Promise<Commit>
  getSessionSnapshot(projectId: string, branchId: string): Promise<SessionSnapshot>
  upsertAgent(agent: EngineAgentInput): Promise<unknown>
  indexEmbedding(commitId: string, vector: Float32Array): Promise<void>
  semanticSearch(vector: Float32Array, projectId: string, limit: number): Promise<SearchResult[]>
}

interface EngineCommitStoreInput {
  branchId: string
  agentId: string
  agentRole: AgentRole
  tool: string
  workflowType: WorkflowType
  message: string
  content: string
  summary: string
  commitType: CommitType
  gitCommitSha?: string
  ciRunId?: string
  pipelineName?: string
  threads?: {
    open?: string[]
    close?: Array<{ id: string; note: string }>
  }
}

interface EngineAgentInput {
  id: string
  projectId: string
  role: AgentRole
  tool: string
  workflowType: WorkflowType
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface EngineCommitInput {
  message: string
  content: string
  commitType?: CommitType
  gitCommitSha?: string
  ciRunId?: string
  pipelineName?: string
  threads?: {
    open?: string[]
    close?: Array<{ id: string; note: string }>
  }
}

export interface EngineOptions {
  summarizer?: RollingSummarizer
  embeddingService?: EmbeddingService
}

export class ContextEngine {
  private projectId = ''
  private branchId  = ''
  private readonly summarizer: RollingSummarizer
  private readonly embeddings: EmbeddingService | null

  constructor(
    private readonly store: EngineStore,
    private readonly agentId: string,
    private readonly agentRole: AgentRole,
    private readonly tool: string,
    private readonly workflowType: WorkflowType,
    options: EngineOptions = {},
  ) {
    this.summarizer = options.summarizer ?? new RollingSummarizer()
    this.embeddings = options.embeddingService ?? null
  }

  /**
   * Bind the engine to a project + branch and register this agent.
   * Must be called before commit() or context().
   */
  async init(projectId: string, branchId: string): Promise<void> {
    this.projectId = projectId
    this.branchId  = branchId
    await this.store.upsertAgent({
      id: this.agentId,
      projectId,
      role: this.agentRole,
      tool: this.tool,
      workflowType: this.workflowType,
    })
  }

  /**
   * Persist a context commit.  Summary is generated automatically via the
   * RollingSummarizer (Week 1: string truncation; Week 2: Claude Haiku).
   */
  async commit(input: EngineCommitInput): Promise<Commit> {
    this.assertInitialized()

    // Fetch previous summary from branch HEAD (if any)
    let previousSummary = ''
    const branch = await this.store.getBranch(this.branchId)
    if (branch?.headCommitId) {
      const head = await this.store.getCommit(branch.headCommitId)
      previousSummary = head?.summary ?? ''
    }

    const summary = await this.summarizer.summarize(input.content, previousSummary, 'branch')

    const commit = await this.store.createCommit({
      branchId:     this.branchId,
      agentId:      this.agentId,
      agentRole:    this.agentRole,
      tool:         this.tool,
      workflowType: this.workflowType,
      message:      input.message,
      content:      input.content,
      summary,
      commitType:   input.commitType ?? 'manual',
      gitCommitSha: input.gitCommitSha,
      ciRunId:      input.ciRunId,
      pipelineName: input.pipelineName,
      threads:      input.threads,
    })

    // Generate and index embedding asynchronously — never block the commit.
    if (this.embeddings) {
      const text = `${input.message}\n${input.content}`
      this.embeddings.embed(text).then(vector => {
        if (vector) return this.store.indexEmbedding(commit.id, vector)
      }).catch(() => { /* swallow — indexing is best-effort */ })
    }

    return commit
  }

  /**
   * Create a new branch from the current branch.
   * Writes a `branch-init` commit on the new branch carrying the parent HEAD
   * summary forward so the branch starts with full context.
   */
  async branch(gitBranch: string, name?: string): Promise<Branch> {
    this.assertInitialized()

    // Carry parent HEAD summary into the new branch
    const parentBranch = await this.store.getBranch(this.branchId)
    let parentSummary = ''
    if (parentBranch?.headCommitId) {
      const head = await this.store.getCommit(parentBranch.headCommitId)
      parentSummary = head?.summary ?? ''
    }

    const newBranch = await this.store.createBranch({
      projectId: this.projectId,
      name: name ?? gitBranch,
      gitBranch,
      parentBranchId: this.branchId,
    })

    // branch-init commit: carries parent summary, no rolling summarization needed
    await this.store.createCommit({
      branchId:     newBranch.id,
      agentId:      this.agentId,
      agentRole:    this.agentRole,
      tool:         this.tool,
      workflowType: this.workflowType,
      message:      `Branch ${gitBranch} created from ${parentBranch?.gitBranch ?? this.branchId}`,
      content:      parentSummary,
      summary:      parentSummary,
      commitType:   'branch-init',
    })

    return newBranch
  }

  /**
   * Merge a source branch into the current branch.
   * Generates a rolling summary for the merge commit, carries open threads
   * from source to target, and marks the source branch as merged.
   */
  async merge(sourceBranchId: string): Promise<Commit> {
    this.assertInitialized()

    // Source HEAD summary
    const sourceBranch = await this.store.getBranch(sourceBranchId)
    let sourceSummary = ''
    if (sourceBranch?.headCommitId) {
      const head = await this.store.getCommit(sourceBranch.headCommitId)
      sourceSummary = head?.summary ?? ''
    }

    // Target (current branch) HEAD summary as the rolling base
    const targetBranch = await this.store.getBranch(this.branchId)
    let targetSummary = ''
    if (targetBranch?.headCommitId) {
      const head = await this.store.getCommit(targetBranch.headCommitId)
      targetSummary = head?.summary ?? ''
    }

    const mergeContent = `Merged ${sourceBranch?.name ?? sourceBranchId}: ${sourceSummary}`
    const mergeSummary = await this.summarizer.summarize(mergeContent, targetSummary, 'branch')

    return this.store.mergeBranch(sourceBranchId, this.branchId, mergeSummary)
  }

  /**
   * Retrieve a SessionSnapshot for the current project+branch.
   *
   * scope='global'  → full project snapshot (project summary + branch state)
   * scope='branch'  → same as global for now (branch-scoped view, Week 2)
   * Other scopes    → throws until implemented in later weeks
   */
  async context(scope: ContextScope): Promise<SessionSnapshot> {
    this.assertInitialized()

    if (scope === 'global' || scope === 'branch') {
      return this.store.getSessionSnapshot(this.projectId, this.branchId)
    }

    throw new Error(`context scope '${scope}' is not yet implemented`)
  }

  /**
   * Semantic search over commits in the current project.
   * Requires an EmbeddingService to have been passed at construction time;
   * returns an empty array if embeddings are unavailable.
   */
  async semanticSearch(query: string, projectId: string, limit = 5): Promise<SearchResult[]> {
    if (!this.embeddings) return []
    const vector = await this.embeddings.embed(query)
    if (!vector) return []
    return this.store.semanticSearch(vector, projectId, limit)
  }

  private assertInitialized(): void {
    if (!this.projectId || !this.branchId) {
      throw new Error(
        'ContextEngine not initialized — call engine.init(projectId, branchId) first.',
      )
    }
  }
}
