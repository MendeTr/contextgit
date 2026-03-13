import { describe, it, expect, afterEach } from 'vitest'
import { LocalStore } from './index.js'

// Helpers to set up a minimal project + branch
async function setupStore() {
  const store = new LocalStore(':memory:')
  const project = await store.createProject({ name: 'test-project' })
  const branch = await store.createBranch({
    projectId: project.id,
    name: 'main',
    gitBranch: 'main',
  })
  return { store, project, branch }
}

describe('claimTask', () => {
  afterEach(() => {
    // stores are :memory: — closed per test via store.close()
  })

  it('creates a claim with correct fields', async () => {
    const { store, project, branch } = await setupStore()

    const claim = await store.claimTask(project.id, branch.id, {
      task: 'build auth module',
      agentId: 'agent-1',
      role: 'dev',
    })

    expect(claim.id).toBeTruthy()
    expect(claim.projectId).toBe(project.id)
    expect(claim.branchId).toBe(branch.id)
    expect(claim.task).toBe('build auth module')
    expect(claim.agentId).toBe('agent-1')
    expect(claim.role).toBe('dev')
    expect(claim.status).toBe('proposed')
    expect(claim.ttl).toBe(7_200_000)
    expect(claim.claimedAt).toBeInstanceOf(Date)
    expect(claim.releasedAt).toBeUndefined()

    store.close()
  })

  it('respects custom status and ttl', async () => {
    const { store, project, branch } = await setupStore()

    const claim = await store.claimTask(project.id, branch.id, {
      task: 'write tests',
      agentId: 'agent-2',
      role: 'test',
      status: 'active',
      ttl: 3_600_000, // 1h
    })

    expect(claim.status).toBe('active')
    expect(claim.ttl).toBe(3_600_000)

    store.close()
  })
})

describe('listActiveClaims', () => {
  it('returns proposed and active claims', async () => {
    const { store, project, branch } = await setupStore()

    await store.claimTask(project.id, branch.id, { task: 'task-a', agentId: 'agent-1', role: 'dev', status: 'proposed' })
    await store.claimTask(project.id, branch.id, { task: 'task-b', agentId: 'agent-2', role: 'test', status: 'active' })

    const claims = await store.listActiveClaims(project.id)
    expect(claims).toHaveLength(2)

    store.close()
  })

  it('excludes released claims', async () => {
    const { store, project, branch } = await setupStore()

    const c1 = await store.claimTask(project.id, branch.id, { task: 'task-a', agentId: 'agent-1', role: 'dev' })
    await store.claimTask(project.id, branch.id, { task: 'task-b', agentId: 'agent-2', role: 'dev' })
    await store.unclaimTask(c1.id)

    const claims = await store.listActiveClaims(project.id)
    expect(claims).toHaveLength(1)
    expect(claims[0].task).toBe('task-b')

    store.close()
  })

  it('excludes TTL-expired claims', async () => {
    const { store, project, branch } = await setupStore()

    // Create a claim with 1ms TTL (already expired)
    await store.claimTask(project.id, branch.id, { task: 'expired', agentId: 'agent-1', role: 'dev', ttl: 1 })
    // Wait a tick to ensure the TTL has elapsed
    await new Promise((r) => setTimeout(r, 10))
    await store.claimTask(project.id, branch.id, { task: 'active', agentId: 'agent-2', role: 'dev', ttl: 7_200_000 })

    const claims = await store.listActiveClaims(project.id)
    expect(claims).toHaveLength(1)
    expect(claims[0].task).toBe('active')

    store.close()
  })
})

describe('unclaimTask', () => {
  it('sets status to released and sets releasedAt', async () => {
    const { store, project, branch } = await setupStore()

    const claim = await store.claimTask(project.id, branch.id, { task: 'do work', agentId: 'agent-1', role: 'solo' })
    await store.unclaimTask(claim.id)

    const active = await store.listActiveClaims(project.id)
    expect(active).toHaveLength(0)

    store.close()
  })
})

describe('createCommit auto-release', () => {
  it('releases this agent\'s claims on this branch after commit', async () => {
    const { store, project, branch } = await setupStore()

    await store.claimTask(project.id, branch.id, { task: 'my task', agentId: 'agent-1', role: 'dev' })
    // Second agent's claim should NOT be released
    await store.claimTask(project.id, branch.id, { task: 'other task', agentId: 'agent-2', role: 'dev' })

    await store.createCommit({
      branchId: branch.id,
      agentId: 'agent-1',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'done',
      content: 'finished',
      summary: 'finished',
      commitType: 'manual',
    })

    const remaining = await store.listActiveClaims(project.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].agentId).toBe('agent-2')

    store.close()
  })

  it('does not release claims on other branches', async () => {
    const { store, project, branch } = await setupStore()
    const otherBranch = await store.createBranch({
      projectId: project.id,
      name: 'feature',
      gitBranch: 'feature/x',
    })

    // agent-1 has a claim on the other branch
    await store.claimTask(project.id, otherBranch.id, { task: 'other branch task', agentId: 'agent-1', role: 'dev' })

    await store.createCommit({
      branchId: branch.id,
      agentId: 'agent-1',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'commit on main',
      content: 'work',
      summary: 'work',
      commitType: 'manual',
    })

    const remaining = await store.listActiveClaims(project.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].task).toBe('other branch task')

    store.close()
  })
})

describe('snapshot activeClaims', () => {
  it('includes active claims in session snapshot', async () => {
    const { store, project, branch } = await setupStore()

    await store.claimTask(project.id, branch.id, { task: 'build feature', agentId: 'agent-1', role: 'dev' })

    const snapshot = await store.getSessionSnapshot(project.id, branch.id)
    expect(snapshot.activeClaims).toHaveLength(1)
    expect(snapshot.activeClaims[0].task).toBe('build feature')

    store.close()
  })
})

describe('getContextDelta', () => {
  it('returns newCommits created after since', async () => {
    const { store, project, branch } = await setupStore()
    const before = Date.now() - 1

    await store.createCommit({
      branchId: branch.id,
      agentId: 'agent-1',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'commit after',
      content: 'work',
      summary: 'work',
      commitType: 'manual',
    })

    const delta = await store.getContextDelta(project.id, branch.id, before)
    expect(delta.newCommits).toHaveLength(1)
    expect(delta.newCommits[0].message).toBe('commit after')
    expect(delta.checkedAt).toBeGreaterThanOrEqual(before)

    store.close()
  })

  it('returns activeClaims in delta', async () => {
    const { store, project, branch } = await setupStore()

    await store.claimTask(project.id, branch.id, { task: 'delta task', agentId: 'agent-1', role: 'dev' })

    const delta = await store.getContextDelta(project.id, branch.id, 0)
    expect(delta.activeClaims).toHaveLength(1)
    expect(delta.activeClaims[0].task).toBe('delta task')

    store.close()
  })

  it('returns empty arrays when nothing changed since', async () => {
    const { store, project, branch } = await setupStore()

    await store.createCommit({
      branchId: branch.id,
      agentId: 'agent-1',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'old commit',
      content: 'work',
      summary: 'work',
      commitType: 'manual',
    })

    const since = Date.now() + 10_000 // future
    const delta = await store.getContextDelta(project.id, branch.id, since)
    expect(delta.newCommits).toHaveLength(0)
    expect(delta.openedThreads).toHaveLength(0)
    expect(delta.closedThreads).toHaveLength(0)

    store.close()
  })
})
