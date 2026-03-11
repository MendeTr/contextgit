// RemoteStore — ContextStore backed by HTTP fetch against the ContextHub store API.
//
// All ContextStore methods map to endpoints on the /v1/store router.
// Float32Array is serialized as number[] in JSON for transport.
// Date fields are parsed from ISO strings returned by the API.

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
import type { ContextStore } from '../interface.js'

// ─── Date parsers ─────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>

function d(s: unknown): Date {
  return typeof s === 'string' ? new Date(s) : new Date(0)
}

function parseProject(raw: Raw): Project {
  return { ...(raw as unknown as Project), createdAt: d(raw['createdAt']) }
}

function parseBranch(raw: Raw): Branch {
  return {
    ...(raw as unknown as Branch),
    createdAt: d(raw['createdAt']),
    mergedAt: raw['mergedAt'] ? d(raw['mergedAt']) : undefined,
  }
}

function parseCommit(raw: Raw): Commit {
  return { ...(raw as unknown as Commit), createdAt: d(raw['createdAt']) }
}

function parseThread(raw: Raw): Thread {
  return { ...(raw as unknown as Thread), createdAt: d(raw['createdAt']) }
}

function parseAgent(raw: Raw): Agent {
  return {
    ...(raw as unknown as Agent),
    createdAt: d(raw['createdAt']),
    lastSeen: d(raw['lastSeen']),
  }
}

// ─── RemoteStore ──────────────────────────────────────────────────────────────

export class RemoteStore implements ContextStore {
  private readonly base: string

  /**
   * @param baseUrl  Root URL of a ContextHub API server, e.g. http://localhost:3141
   *                 The store router must be mounted at /v1/store on that server.
   */
  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/$/, '') + '/v1/store'
  }

  private url(path: string): string {
    return `${this.base}${path}`
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 204) return undefined as T
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`RemoteStore ${method} ${path} → ${res.status}: ${text}`)
    }
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) return res.json() as Promise<T>
    return res.text() as Promise<T>
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  async createProject(project: ProjectInput): Promise<Project> {
    const raw = await this.req<Raw>('POST', '/projects', project)
    return parseProject(raw)
  }

  async getProject(id: string): Promise<Project | null> {
    try {
      const raw = await this.req<Raw>('GET', `/projects/${id}`)
      return parseProject(raw)
    } catch {
      return null
    }
  }

  // ── Branches ────────────────────────────────────────────────────────────────

  async createBranch(branch: BranchInput): Promise<Branch> {
    const raw = await this.req<Raw>('POST', '/branches', branch)
    return parseBranch(raw)
  }

  async getBranch(id: string): Promise<Branch | null> {
    try {
      const raw = await this.req<Raw>('GET', `/branches/${id}`)
      return parseBranch(raw)
    } catch {
      return null
    }
  }

  async getBranchByGitName(projectId: string, gitBranch: string): Promise<Branch | null> {
    try {
      const raw = await this.req<Raw>(
        'GET',
        `/projects/${projectId}/branches?git=${encodeURIComponent(gitBranch)}`,
      )
      return parseBranch(raw)
    } catch {
      return null
    }
  }

  async listBranches(projectId: string): Promise<Branch[]> {
    const raw = await this.req<Raw[]>('GET', `/projects/${projectId}/branches`)
    return raw.map(parseBranch)
  }

  async updateBranchHead(branchId: string, commitId: string): Promise<void> {
    await this.req('PUT', `/branches/${branchId}/head`, { commitId })
  }

  async mergeBranch(
    sourceBranchId: string,
    targetBranchId: string,
    summary: string,
  ): Promise<Commit> {
    const raw = await this.req<Raw>('POST', `/branches/${sourceBranchId}/merge`, {
      targetBranchId,
      summary,
    })
    return parseCommit(raw)
  }

  // ── Commits ─────────────────────────────────────────────────────────────────

  async createCommit(commit: CommitInput): Promise<Commit> {
    const raw = await this.req<Raw>('POST', '/commits', commit)
    return parseCommit(raw)
  }

  async getCommit(id: string): Promise<Commit | null> {
    try {
      const raw = await this.req<Raw>('GET', `/commits/${id}`)
      return parseCommit(raw)
    } catch {
      return null
    }
  }

  async listCommits(branchId: string, pagination: Pagination): Promise<Commit[]> {
    const qs = `limit=${pagination.limit}&offset=${pagination.offset}`
    const raw = await this.req<Raw[]>('GET', `/branches/${branchId}/commits?${qs}`)
    return raw.map(parseCommit)
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  async getSessionSnapshot(projectId: string, branchId: string): Promise<SessionSnapshot> {
    const qs = `branchId=${encodeURIComponent(branchId)}`
    const raw = await this.req<{
      projectSummary: string
      branchName: string
      branchSummary: string
      recentCommits: Raw[]
      openThreads: Raw[]
    }>('GET', `/projects/${projectId}/session-snapshot?${qs}`)
    return {
      projectSummary: raw.projectSummary,
      branchName: raw.branchName,
      branchSummary: raw.branchSummary,
      recentCommits: raw.recentCommits.map(parseCommit),
      openThreads: raw.openThreads.map(parseThread),
    }
  }

  async getFormattedSnapshot(
    projectId: string,
    branchId: string,
    format: SnapshotFormat,
  ): Promise<string> {
    const qs = `branchId=${encodeURIComponent(branchId)}&format=${format}`
    return this.req<string>('GET', `/projects/${projectId}/snapshot?${qs}`)
  }

  // ── Threads ──────────────────────────────────────────────────────────────────

  async listOpenThreads(projectId: string): Promise<Thread[]> {
    const raw = await this.req<Raw[]>('GET', `/projects/${projectId}/threads`)
    return raw.map(parseThread)
  }

  async listOpenThreadsByBranch(branchId: string): Promise<Thread[]> {
    const raw = await this.req<Raw[]>('GET', `/branches/${branchId}/threads`)
    return raw.map(parseThread)
  }

  // ── Embeddings & Search ──────────────────────────────────────────────────────

  async indexEmbedding(commitId: string, vector: Float32Array): Promise<void> {
    await this.req('POST', `/commits/${commitId}/embedding`, { vector: Array.from(vector) })
  }

  async semanticSearch(
    vector: Float32Array,
    projectId: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const raw = await this.req<Raw[]>('POST', `/projects/${projectId}/search/semantic`, {
      vector: Array.from(vector),
      limit,
    })
    return raw.map(r => ({
      commit: parseCommit(r['commit'] as Raw),
      score: r['score'] as number,
      matchType: r['matchType'] as 'semantic' | 'fulltext',
    }))
  }

  async fullTextSearch(query: string, projectId: string): Promise<SearchResult[]> {
    const raw = await this.req<Raw[]>(
      'GET',
      `/projects/${projectId}/search?q=${encodeURIComponent(query)}`,
    )
    return raw.map(r => ({
      commit: parseCommit(r['commit'] as Raw),
      score: r['score'] as number,
      matchType: r['matchType'] as 'semantic' | 'fulltext',
    }))
  }

  // ── Agents ───────────────────────────────────────────────────────────────────

  async upsertAgent(agent: AgentInput): Promise<Agent> {
    const raw = await this.req<Raw>('POST', '/agents', agent)
    return parseAgent(raw)
  }

  async listAgents(projectId: string): Promise<Agent[]> {
    const raw = await this.req<Raw[]>('GET', `/projects/${projectId}/agents`)
    return raw.map(parseAgent)
  }
}
