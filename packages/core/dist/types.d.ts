export type AgentRole = 'orchestrator' | 'dev' | 'test' | 'review' | 'background' | 'ci' | 'solo';
export type WorkflowType = 'interactive' | 'ralph-loop' | 'ci' | 'background' | 'custom';
export type CommitType = 'manual' | 'auto' | 'merge' | 'branch-init';
export type BranchStatus = 'active' | 'merged' | 'abandoned';
export type SnapshotFormat = 'agents-md' | 'json' | 'text';
export type ContextScope = 'global' | 'branch' | 'search' | 'commit' | 'raw';
export interface Project {
    id: string;
    name: string;
    description?: string;
    githubUrl?: string;
    createdAt: Date;
}
export interface Branch {
    id: string;
    projectId: string;
    name: string;
    gitBranch: string;
    githubPrUrl?: string;
    parentBranchId?: string;
    headCommitId?: string;
    status: BranchStatus;
    createdAt: Date;
    mergedAt?: Date;
}
export interface Commit {
    id: string;
    branchId: string;
    parentId?: string;
    mergeSourceBranchId?: string;
    agentId: string;
    agentRole: AgentRole;
    tool: string;
    workflowType: WorkflowType;
    loopIteration?: number;
    ciRunId?: string;
    pipelineName?: string;
    message: string;
    content: string;
    summary: string;
    commitType: CommitType;
    gitCommitSha?: string;
    createdAt: Date;
}
export interface Thread {
    id: string;
    projectId: string;
    branchId: string;
    description: string;
    status: 'open' | 'closed';
    workflowType?: WorkflowType;
    openedInCommit: string;
    closedInCommit?: string;
    closedNote?: string;
    createdAt: Date;
}
export interface Agent {
    id: string;
    projectId: string;
    role: AgentRole;
    tool: string;
    workflowType: WorkflowType;
    displayName?: string;
    totalCommits: number;
    lastSeen: Date;
    createdAt: Date;
}
export interface ProjectInput {
    id?: string;
    name: string;
    description?: string;
    githubUrl?: string;
}
export interface BranchInput {
    projectId: string;
    name: string;
    gitBranch: string;
    parentBranchId?: string;
    githubPrUrl?: string;
}
export interface CommitInput {
    branchId: string;
    parentId?: string;
    agentId: string;
    agentRole: AgentRole;
    tool: string;
    workflowType: WorkflowType;
    loopIteration?: number;
    ciRunId?: string;
    pipelineName?: string;
    message: string;
    content: string;
    summary: string;
    commitType: CommitType;
    gitCommitSha?: string;
    threads?: {
        open?: string[];
        close?: Array<{
            id: string;
            note: string;
        }>;
    };
}
export interface AgentInput {
    id: string;
    projectId: string;
    role: AgentRole;
    tool: string;
    workflowType: WorkflowType;
    displayName?: string;
}
export interface SessionSnapshot {
    projectSummary: string;
    branchName: string;
    branchSummary: string;
    recentCommits: Commit[];
    openThreads: Thread[];
}
export interface SearchResult {
    commit: Commit;
    score: number;
    matchType: 'semantic' | 'fulltext';
}
export interface ContextHubConfig {
    project: string;
    projectId: string;
    store: 'local' | string;
    agentRole: AgentRole;
    workflowType: WorkflowType;
    autoSnapshot: boolean;
    snapshotInterval: number;
    embeddingModel: 'local' | 'openai';
    apiKey?: string;
}
export interface Pagination {
    limit: number;
    offset: number;
}
//# sourceMappingURL=types.d.ts.map