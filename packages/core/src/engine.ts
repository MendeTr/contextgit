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
  Commit,
  CommitType,
  ContextScope,
  SessionSnapshot,
  WorkflowType,
} from './types.js'
import { RollingSummarizer } from './summarizer.js'

// ─── Store subset the engine requires ─────────────────────────────────────────

export interface EngineStore {
  getBranch(id: string): Promise<{ headCommitId?: string } | null>
  getCommit(id: string): Promise<{ summary: string } | null>
  createCommit(input: EngineCommitStoreInput): Promise<Commit>
  getSessionSnapshot(projectId: string, branchId: string): Promise<SessionSnapshot>
  upsertAgent(agent: EngineAgentInput): Promise<unknown>
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
  threads?: {
    open?: string[]
    close?: Array<{ id: string; note: string }>
  }
}

export interface EngineOptions {
  summarizer?: RollingSummarizer
}

export class ContextEngine {
  private projectId = ''
  private branchId  = ''
  private readonly summarizer: RollingSummarizer

  constructor(
    private readonly store: EngineStore,
    private readonly agentId: string,
    private readonly agentRole: AgentRole,
    private readonly tool: string,
    private readonly workflowType: WorkflowType,
    options: EngineOptions = {},
  ) {
    this.summarizer = options.summarizer ?? new RollingSummarizer()
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

    const summary = this.summarizer.summarize(input.content, previousSummary, 'branch')

    return this.store.createCommit({
      branchId:     this.branchId,
      agentId:      this.agentId,
      agentRole:    this.agentRole,
      tool:         this.tool,
      workflowType: this.workflowType,
      message:      input.message,
      content:      input.content,
      summary,
      commitType:   input.commitType ?? 'manual',
      threads:      input.threads,
    })
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

  private assertInitialized(): void {
    if (!this.projectId || !this.branchId) {
      throw new Error(
        'ContextEngine not initialized — call engine.init(projectId, branchId) first.',
      )
    }
  }
}
