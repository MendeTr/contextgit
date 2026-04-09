import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalStore } from './index.js'

describe('LocalStore (in-memory)', () => {
  let store: LocalStore

  beforeEach(() => {
    store = new LocalStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('creates and retrieves a project', async () => {
    const project = await store.createProject({ name: 'test-project', description: 'A test' })
    expect(project.id).toBeTruthy()
    expect(project.name).toBe('test-project')

    const fetched = await store.getProject(project.id)
    expect(fetched).toBeTruthy()
    expect(fetched!.name).toBe('test-project')
  })

  it('creates and retrieves a branch', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({
      projectId: project.id,
      name: 'main',
      gitBranch: 'main',
    })
    expect(branch.id).toBeTruthy()
    expect(branch.gitBranch).toBe('main')

    const byGit = await store.getBranchByGitName(project.id, 'main')
    expect(byGit!.id).toBe(branch.id)
  })

  it('creates a commit, opens a thread, closes it', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })

    // Upsert agent first (required for commit attribution)
    await store.upsertAgent({
      id: 'agent-1',
      projectId: project.id,
      role: 'dev',
      tool: 'claude-code',
      workflowType: 'interactive',
    })

    const commit1 = await store.createCommit({
      branchId: branch.id,
      agentId: 'agent-1',
      agentRole: 'dev',
      tool: 'claude-code',
      workflowType: 'interactive',
      message: 'Initial commit',
      content: 'Set up project structure',
      summary: 'Project scaffolded',
      commitType: 'manual',
      threads: { open: ['Authentication approach not decided'] },
    })
    expect(commit1.id).toBeTruthy()
    expect(commit1.message).toBe('Initial commit')

    // Thread should be open
    const openThreads = await store.listOpenThreads(project.id)
    expect(openThreads).toHaveLength(1)
    expect(openThreads[0].description).toBe('Authentication approach not decided')
    const threadId = openThreads[0].id

    // Second commit closes the thread
    const commit2 = await store.createCommit({
      branchId: branch.id,
      agentId: 'agent-1',
      agentRole: 'dev',
      tool: 'claude-code',
      workflowType: 'interactive',
      message: 'Choose JWT auth',
      content: 'Implemented JWT RS256',
      summary: 'JWT RS256 chosen, implemented',
      commitType: 'manual',
      threads: { close: [{ id: threadId, note: 'Using JWT RS256' }] },
    })
    expect(commit2.id).toBeTruthy()

    const stillOpen = await store.listOpenThreads(project.id)
    expect(stillOpen).toHaveLength(0)
  })

  it('getSessionSnapshot returns project/branch summaries and threads', async () => {
    const project = await store.createProject({ name: 'snap-test' })
    const main = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const feature = await store.createBranch({
      projectId: project.id,
      name: 'feature/auth',
      gitBranch: 'feature/auth',
      parentBranchId: main.id,
    })

    await store.upsertAgent({ id: 'ag', projectId: project.id, role: 'dev', tool: 'cli', workflowType: 'interactive' })

    await store.createCommit({
      branchId: main.id, agentId: 'ag', agentRole: 'dev', tool: 'cli',
      workflowType: 'interactive', message: 'main commit', content: 'content',
      summary: 'Main branch summary', commitType: 'manual',
    })
    await store.createCommit({
      branchId: feature.id, agentId: 'ag', agentRole: 'dev', tool: 'cli',
      workflowType: 'interactive', message: 'feature commit', content: 'feature content',
      summary: 'Feature branch summary', commitType: 'manual',
      threads: { open: ['Open thread on feature'] },
    })

    const snapshot = await store.getSessionSnapshot(project.id, feature.id)
    expect(snapshot.projectSummary).toBe('Main branch summary')
    expect(snapshot.branchSummary).toBe('Feature branch summary')
    expect(snapshot.branchName).toBe('feature/auth')
    expect(snapshot.recentCommits).toHaveLength(1)
    expect(snapshot.openThreads).toHaveLength(1)
    expect(snapshot.openThreads[0].description).toBe('Open thread on feature')
  })

  it('getSessionSnapshot sets isInitiated=false when branch has no commits', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({
      projectId: project.id,
      name: 'main',
      gitBranch: 'main',
    })

    const snapshot = await store.getSessionSnapshot(project.id, branch.id)
    expect(snapshot.isInitiated).toBe(false)
  })

  it('getSessionSnapshot sets isInitiated=true after a commit exists', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({
      projectId: project.id,
      name: 'main',
      gitBranch: 'main',
    })
    await store.upsertAgent({
      id: 'agent-init',
      projectId: project.id,
      role: 'solo',
      tool: 'claude-code',
      workflowType: 'interactive',
    })
    await store.createCommit({
      branchId: branch.id,
      agentId: 'agent-init',
      agentRole: 'solo',
      tool: 'claude-code',
      workflowType: 'interactive',
      message: 'context initiation: My Project',
      content: 'Initial context captured.',
      summary: 'Initial context captured.',
      commitType: 'manual',
    })

    const snapshot = await store.getSessionSnapshot(project.id, branch.id)
    expect(snapshot.isInitiated).toBe(true)
  })

  it('getFormattedSnapshot returns text format', async () => {
    const project = await store.createProject({ name: 'fmt-test' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const text = await store.getFormattedSnapshot(project.id, branch.id, 'text')
    expect(text).toContain('=== PROJECT STATE ===')
    expect(text).toContain('=== CURRENT BRANCH: main ===')
    expect(text).toContain('=== OPEN THREADS ===')
  })

  it('mergeBranch carries open threads to target and marks source merged', async () => {
    const project = await store.createProject({ name: 'merge-test' })
    const main = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const feat = await store.createBranch({ projectId: project.id, name: 'feat', gitBranch: 'feat', parentBranchId: main.id })

    await store.upsertAgent({ id: 'ag', projectId: project.id, role: 'dev', tool: 'cli', workflowType: 'interactive' })

    await store.createCommit({
      branchId: main.id, agentId: 'ag', agentRole: 'dev', tool: 'cli',
      workflowType: 'interactive', message: 'main init', content: 'c', summary: 's', commitType: 'branch-init',
    })
    await store.createCommit({
      branchId: feat.id, agentId: 'ag', agentRole: 'dev', tool: 'cli',
      workflowType: 'interactive', message: 'feat work', content: 'c', summary: 's', commitType: 'manual',
      threads: { open: ['Thread from feat'] },
    })

    const mergeCommit = await store.mergeBranch(feat.id, main.id, 'Merged feat into main')
    expect(mergeCommit.commitType).toBe('merge')
    expect(mergeCommit.branchId).toBe(main.id)

    // Source branch is merged
    const updatedFeat = await store.getBranch(feat.id)
    expect(updatedFeat!.status).toBe('merged')

    // Thread carried to main
    const mainThreads = await store.listOpenThreadsByBranch(main.id)
    expect(mainThreads).toHaveLength(1)
    expect(mainThreads[0].description).toBe('Thread from feat')
  })

  it('uses explicit dbPath when provided, ignoring projectId for path computation', async () => {
    // Passing ':memory:' as dbPath bypasses projectId-based path computation entirely.
    // If projectId were used, it would try to open ~/.contextgit/projects/ignored-id.db.
    const store2 = new LocalStore('ignored-id', ':memory:')
    await expect(store2.createProject({ id: 'p1', name: 'Test' })).resolves.toMatchObject({ id: 'p1' })
    store2.close()
  })
})
