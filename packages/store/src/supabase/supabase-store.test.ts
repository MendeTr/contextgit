import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @supabase/supabase-js before importing SupabaseStore ─────────────────
// The Supabase client uses a builder pattern. We mock createClient to return
// a fake db object. Individual tests configure mockResolvedValue on the chain.

const mockSingle = vi.fn()
const mockMaybeSingle = vi.fn()

function makeChain(resolved: unknown) {
  // A chainable builder that resolves when awaited.
  // Each method returns `this` so chains like .select().eq().single() work.
  const chain: Record<string, unknown> = {}
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is', 'in',
    'filter', 'order', 'limit', 'range', 'textSearch',
  ]
  methods.forEach(m => { chain[m] = vi.fn().mockReturnValue(chain) })
  chain['single'] = vi.fn().mockResolvedValue(resolved)
  chain['maybeSingle'] = vi.fn().mockResolvedValue(resolved)
  // Make the chain itself thenable (for `await db.from(...).select()`)
  chain['then'] = (resolve: (v: unknown) => void) => resolve(resolved)
  return chain
}

const mockDb = {
  from: vi.fn(),
  rpc: vi.fn(),
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockDb),
}))

import { SupabaseStore } from './index.js'

describe('SupabaseStore', () => {
  let store: SupabaseStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new SupabaseStore('https://test.supabase.co', 'service-key')
  })

  // ── Error handling ────────────────────────────────────────────────────────

  it('throws when Supabase returns an error', async () => {
    mockDb.from.mockReturnValue(makeChain({ data: null, error: { message: 'db error' } }))
    await expect(store.getProject('any')).rejects.toThrow('db error')
  })

  // ── Projects ──────────────────────────────────────────────────────────────

  it('getProject returns null when not found', async () => {
    mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
    const result = await store.getProject('nonexistent')
    expect(result).toBeNull()
  })

  it('getProject parses timestamps and optional fields', async () => {
    const iso = '2026-03-18T10:00:00.000Z'
    mockDb.from.mockReturnValue(makeChain({
      data: { id: 'p1', name: 'MyProject', description: 'desc', github_url: 'https://gh.com', summary: '', created_at: iso },
      error: null,
    }))
    const project = await store.getProject('p1')
    expect(project).not.toBeNull()
    expect(project!.createdAt).toBeInstanceOf(Date)
    expect(project!.createdAt.toISOString()).toBe(iso)
    expect(project!.description).toBe('desc')
    expect(project!.githubUrl).toBe('https://gh.com')
  })

  it('createProject inserts and returns a Project', async () => {
    const iso = '2026-03-18T10:00:00.000Z'
    mockDb.from.mockReturnValue(makeChain({
      data: { id: 'p1', name: 'Test', description: null, github_url: null, summary: '', created_at: iso },
      error: null,
    }))
    const project = await store.createProject({ name: 'Test' })
    expect(project.id).toBeDefined()
    expect(project.name).toBe('Test')
    expect(project.createdAt).toBeInstanceOf(Date)
  })

  // ── Branches ──────────────────────────────────────────────────────────────

  it('getBranch returns null when not found', async () => {
    mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
    expect(await store.getBranch('missing')).toBeNull()
  })

  it('getBranch parses branch row correctly', async () => {
    const iso = '2026-03-18T10:00:00.000Z'
    mockDb.from.mockReturnValue(makeChain({
      data: { id: 'br1', project_id: 'p1', name: 'main', git_branch: 'main',
              summary: '', github_pr_url: null, parent_branch_id: null,
              head_commit_id: 'c1', status: 'active', created_at: iso, merged_at: null },
      error: null,
    }))
    const branch = await store.getBranch('br1')
    expect(branch!.projectId).toBe('p1')
    expect(branch!.headCommitId).toBe('c1')
    expect(branch!.createdAt).toBeInstanceOf(Date)
    expect(branch!.mergedAt).toBeUndefined()
  })

  it('createBranch is idempotent when ID already exists', async () => {
    const iso = new Date().toISOString()
    const existing = { id: 'br1', project_id: 'p1', name: 'main', git_branch: 'main',
                       summary: '', github_pr_url: null, parent_branch_id: null,
                       head_commit_id: null, status: 'active', created_at: iso, merged_at: null }
    // First call (getBranch check) returns existing; second call (insert) should not be reached
    mockDb.from.mockReturnValue(makeChain({ data: existing, error: null }))
    const result = await store.createBranch({ id: 'br1', projectId: 'p1', name: 'main', gitBranch: 'main' })
    expect(result.id).toBe('br1')
  })

  // ── Commits ───────────────────────────────────────────────────────────────

  it('createCommit resolves projectId via getBranch and caches it', async () => {
    const branchIso = new Date().toISOString()
    const commitIso = new Date().toISOString()
    const branchRow = { id: 'br1', project_id: 'proj1', name: 'main', git_branch: 'main',
                        summary: '', github_pr_url: null, parent_branch_id: null,
                        head_commit_id: null, status: 'active', created_at: branchIso, merged_at: null }
    const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'proj1', parent_id: null,
                        agent_id: 'agent1', agent_role: 'solo', tool: 'cli',
                        workflow_type: 'interactive', message: 'hello', content: 'c',
                        summary: 's', commit_type: 'manual', git_commit_sha: null,
                        created_at: commitIso }

    // Call 1: getBranch for cache population; Call 2: insert commit
    mockDb.from
      .mockReturnValueOnce(makeChain({ data: branchRow, error: null }))  // getBranch
      .mockReturnValueOnce(makeChain({ data: commitRow, error: null }))  // insert commit

    const commit = await store.createCommit({
      branchId: 'br1', agentId: 'agent1', agentRole: 'solo', tool: 'cli',
      workflowType: 'interactive', message: 'hello', content: 'c', summary: 's', commitType: 'manual',
    })

    expect(commit.branchId).toBe('br1')
    expect(commit.message).toBe('hello')
    // projectId is NOT on the Commit domain type — verify it's absent
    expect((commit as unknown as Record<string, unknown>)['projectId']).toBeUndefined()

    // Cache populated: second createCommit on same branch should NOT call getBranch again
    mockDb.from.mockReturnValueOnce(makeChain({ data: commitRow, error: null }))  // only insert

    await store.createCommit({
      branchId: 'br1', agentId: 'agent1', agentRole: 'solo', tool: 'cli',
      workflowType: 'interactive', message: 'hello 2', content: 'c2', summary: 's2', commitType: 'manual',
    })

    // from() called 3 times total: getBranch (1) + insert commit 1 (1) + insert commit 2 (1)
    expect(mockDb.from).toHaveBeenCalledTimes(3)
  })

  it('createCommit is idempotent when commit ID already exists', async () => {
    const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'proj1', parent_id: null,
                        agent_id: 'a', agent_role: 'solo', tool: 'cli',
                        workflow_type: 'interactive', message: 'm', content: 'c',
                        summary: 's', commit_type: 'manual', git_commit_sha: null,
                        created_at: new Date().toISOString() }
    // getCommit check returns existing
    mockDb.from.mockReturnValueOnce(makeChain({ data: commitRow, error: null }))
    const result = await store.createCommit({
      id: 'c1', branchId: 'br1', agentId: 'a', agentRole: 'solo', tool: 'cli',
      workflowType: 'interactive', message: 'm', content: 'c', summary: 's', commitType: 'manual',
    })
    expect(result.id).toBe('c1')
    // Should not have called insert
    expect(mockDb.from).toHaveBeenCalledTimes(1)
  })

  // ── Snapshots ─────────────────────────────────────────────────────────────

  it('getSessionSnapshot assembles a SessionSnapshot', async () => {
    const now = new Date().toISOString()
    const branchRow = { id: 'br1', project_id: 'p1', name: 'main', git_branch: 'main',
                        summary: '', parent_branch_id: null, head_commit_id: 'c1',
                        status: 'active', created_at: now, merged_at: null, github_pr_url: null }
    const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                        agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                        message: 'init', content: 'c', summary: 'project summary here',
                        commit_type: 'manual', git_commit_sha: null, created_at: now }

    // Call sequence (matches the corrected implementation):
    // 1. getBranch(branchId) — branch has parentBranchId=null, headCommitId='c1'
    // 2. getCommit('c1') — fetched once, used for both projectSummary and branchSummary
    // 3. commitsQuery (listCommits), threadsQuery (listOpenThreadsByBranch), rpc (list_active_claims) — parallel
    mockDb.from
      .mockReturnValueOnce(makeChain({ data: branchRow, error: null }))    // getBranch
      .mockReturnValueOnce(makeChain({ data: commitRow, error: null }))    // getCommit (head)
      .mockReturnValueOnce(makeChain({ data: [commitRow], error: null }))  // listCommits (parallel)
      .mockReturnValueOnce(makeChain({ data: [], error: null }))           // listOpenThreadsByBranch (parallel)
    mockDb.rpc.mockResolvedValueOnce({ data: [], error: null })            // list_active_claims (parallel)

    const snapshot = await store.getSessionSnapshot('p1', 'br1')
    expect(snapshot.projectSummary).toBe('project summary here')
    expect(snapshot.branchName).toBe('main')
    expect(snapshot.recentCommits).toHaveLength(1)
    expect(snapshot.openThreads).toHaveLength(0)
    expect(snapshot.activeClaims).toHaveLength(0)
  })

  // ── Threads ───────────────────────────────────────────────────────────────

  it('listOpenThreads returns only open threads for the project', async () => {
    const now = new Date().toISOString()
    const threadRow = { id: 't1', project_id: 'p1', branch_id: 'br1', description: 'todo',
                        status: 'open', workflow_type: null, opened_in_commit: 'c1',
                        closed_in_commit: null, closed_note: null, created_at: now, updated_at: now }
    mockDb.from.mockReturnValue(makeChain({ data: [threadRow], error: null }))
    const threads = await store.listOpenThreads('p1')
    expect(threads).toHaveLength(1)
    expect(threads[0]!.status).toBe('open')
    expect(threads[0]!.createdAt).toBeInstanceOf(Date)
  })

  it('syncThread upserts on id conflict', async () => {
    const now = new Date().toISOString()
    const thread: import('@contextgit/core').Thread = { id: 't1', projectId: 'p1', branchId: 'br1', description: 'todo',
                              status: 'closed', openedInCommit: 'c1', closedInCommit: 'c2',
                              closedNote: 'done', createdAt: new Date(), }
    const threadRow = { id: 't1', project_id: 'p1', branch_id: 'br1', description: 'todo',
                        status: 'closed', workflow_type: null, opened_in_commit: 'c1',
                        closed_in_commit: 'c2', closed_note: 'done', created_at: now, updated_at: now }
    mockDb.from.mockReturnValue(makeChain({ data: threadRow, error: null }))
    const result = await store.syncThread(thread)
    expect(result.status).toBe('closed')
    expect(result.closedNote).toBe('done')
  })

  // ── Search ────────────────────────────────────────────────────────────────

  it('indexEmbedding updates the embedding column on the commit row', async () => {
    mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
    await store.indexEmbedding('c1', new Float32Array([0.1, 0.2, 0.3]))
    expect(mockDb.from).toHaveBeenCalledWith('commits')
  })

  it('semanticSearch calls match_commits RPC and maps results', async () => {
    const now = new Date().toISOString()
    const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                        agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                        message: 'm', content: 'c', summary: 's', commit_type: 'manual',
                        git_commit_sha: null, created_at: now }
    // RPC returns { id, score } rows; then we fetch full commit rows
    mockDb.rpc.mockResolvedValueOnce({ data: [{ id: 'c1', score: 0.95 }], error: null })
    mockDb.from.mockReturnValue(makeChain({ data: [commitRow], error: null }))

    const results = await store.semanticSearch(new Float32Array(384), 'p1', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.score).toBe(0.95)
    expect(results[0]!.matchType).toBe('semantic')
    expect(mockDb.rpc).toHaveBeenCalledWith('match_commits', expect.objectContaining({ project_id: 'p1', match_count: 5 }))
  })

  it('fullTextSearch uses textSearch on fts column', async () => {
    const now = new Date().toISOString()
    const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                        agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                        message: 'hello world', content: 'c', summary: 's', commit_type: 'manual',
                        git_commit_sha: null, created_at: now }
    mockDb.from.mockReturnValue(makeChain({ data: [commitRow], error: null }))
    const results = await store.fullTextSearch('hello', 'p1')
    expect(results).toHaveLength(1)
    expect(results[0]!.matchType).toBe('fulltext')
    expect(results[0]!.score).toBe(1.0)
  })

  // ── Agents ────────────────────────────────────────────────────────────────

  it('upsertAgent upserts on id conflict', async () => {
    const now = new Date().toISOString()
    const agentRow = { id: 'agent1', project_id: 'p1', role: 'solo', tool: 'cli',
                       workflow_type: 'interactive', display_name: null,
                       total_commits: 5, last_seen: now, created_at: now }
    mockDb.from.mockReturnValue(makeChain({ data: agentRow, error: null }))
    const agent = await store.upsertAgent({
      id: 'agent1', projectId: 'p1', role: 'solo', tool: 'cli', workflowType: 'interactive'
    })
    expect(agent.id).toBe('agent1')
    expect(agent.totalCommits).toBe(5)
    expect(agent.lastSeen).toBeInstanceOf(Date)
  })

  // ── Claims ────────────────────────────────────────────────────────────────

  it('listActiveClaims calls list_active_claims RPC', async () => {
    mockDb.rpc.mockResolvedValueOnce({ data: [], error: null })
    const claims = await store.listActiveClaims('p1')
    expect(claims).toHaveLength(0)
    expect(mockDb.rpc).toHaveBeenCalledWith('list_active_claims', { p_project_id: 'p1' })
  })

  it('unclaimTask updates status to released', async () => {
    mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
    await expect(store.unclaimTask('claim1')).resolves.toBeUndefined()
  })

  // ── Delta ─────────────────────────────────────────────────────────────────

  it('getContextDelta filters by since using ISO string, strictly greater than', async () => {
    const since = Date.now() - 60_000  // 1 minute ago
    const sinceIso = new Date(since).toISOString()
    const now = new Date().toISOString()

    const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                        agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                        message: 'm', content: 'c', summary: 's', commit_type: 'manual',
                        git_commit_sha: null, created_at: now }

    mockDb.from
      .mockReturnValueOnce(makeChain({ data: [commitRow], error: null }))  // commits since
      .mockReturnValueOnce(makeChain({ data: [], error: null }))           // threads since
    mockDb.rpc.mockResolvedValueOnce({ data: [], error: null })            // active claims

    const delta = await store.getContextDelta('p1', 'br1', since)
    expect(delta.newCommits).toHaveLength(1)
    expect(delta.openedThreads).toHaveLength(0)
    expect(delta.closedThreads).toHaveLength(0)
    expect(delta.checkedAt).toBeGreaterThan(since)

    // Verify strictly-greater-than filter used the correct ISO string
    // (guards against accidental use of gte which would include the since boundary)
    const commitsChain = mockDb.from.mock.results[0]?.value as ReturnType<typeof makeChain>
    expect(commitsChain.gt).toHaveBeenCalledWith('created_at', sinceIso)
  })
})
