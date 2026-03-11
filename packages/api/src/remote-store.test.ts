// Integration test: RemoteStore ↔ LocalStore
//
// Scenario: spin up an Express server with the store router backed by an
// in-memory LocalStore, then run CRUD through a RemoteStore client and verify
// the results match what LocalStore returns directly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'http'
import type { AddressInfo } from 'net'
import { LocalStore, RemoteStore } from '@contextgit/store'
import { createStoreRouter } from './store-router.js'

describe('RemoteStore ↔ LocalStore integration', () => {
  let server: http.Server
  let localStore: LocalStore
  let remote: RemoteStore

  beforeAll(async () => {
    localStore = new LocalStore(':memory:')

    const app = express()
    app.use(express.json())
    app.use('/v1/store', createStoreRouter(localStore))

    server = http.createServer(app)
    const port = await new Promise<number>(resolve =>
      server.listen(0, () => resolve((server.address() as AddressInfo).port)),
    )

    remote = new RemoteStore(`http://localhost:${port}`)
  })

  afterAll(() => {
    return new Promise<void>(resolve => {
      server.close(() => {
        localStore.close()
        resolve()
      })
    })
  })

  it('creates and retrieves a project via RemoteStore', async () => {
    const project = await remote.createProject({ name: 'remote-test', description: 'HTTP project' })
    expect(project.id).toBeTruthy()
    expect(project.name).toBe('remote-test')
    expect(project.createdAt).toBeInstanceOf(Date)

    // Directly confirm it's in LocalStore
    const local = await localStore.getProject(project.id)
    expect(local?.name).toBe('remote-test')
  })

  it('creates a branch and retrieves by git name', async () => {
    const project = await remote.createProject({ name: 'branch-proj' })
    const branch = await remote.createBranch({
      projectId: project.id,
      name: 'main',
      gitBranch: 'main',
    })
    expect(branch.id).toBeTruthy()
    expect(branch.gitBranch).toBe('main')
    expect(branch.createdAt).toBeInstanceOf(Date)

    const byGit = await remote.getBranchByGitName(project.id, 'main')
    expect(byGit?.id).toBe(branch.id)

    const notFound = await remote.getBranchByGitName(project.id, 'nonexistent')
    expect(notFound).toBeNull()
  })

  it('creates a commit and retrieves it', async () => {
    const project = await remote.createProject({ name: 'commit-proj' })
    const branch = await remote.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })

    await remote.upsertAgent({
      id: 'agent-remote',
      projectId: project.id,
      role: 'dev',
      tool: 'test',
      workflowType: 'interactive',
    })

    const commit = await remote.createCommit({
      branchId: branch.id,
      agentId: 'agent-remote',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'Remote commit',
      content: 'Content via HTTP',
      summary: 'Summary',
      commitType: 'manual',
    })
    expect(commit.id).toBeTruthy()
    expect(commit.message).toBe('Remote commit')
    expect(commit.createdAt).toBeInstanceOf(Date)

    const fetched = await remote.getCommit(commit.id)
    expect(fetched?.message).toBe('Remote commit')
  })

  it('getFormattedSnapshot via RemoteStore matches LocalStore output', async () => {
    const project = await remote.createProject({ name: 'snap-proj' })
    const branch = await remote.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })

    await remote.upsertAgent({
      id: 'snap-agent',
      projectId: project.id,
      role: 'dev',
      tool: 'test',
      workflowType: 'interactive',
    })

    await remote.createCommit({
      branchId: branch.id,
      agentId: 'snap-agent',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'First commit',
      content: 'Setting things up',
      summary: 'Project scaffolded',
      commitType: 'manual',
    })

    const remoteSnapshot = await remote.getFormattedSnapshot(project.id, branch.id, 'text')
    const localSnapshot = await localStore.getFormattedSnapshot(project.id, branch.id, 'text')

    // Both should contain the expected sections
    expect(remoteSnapshot).toContain('=== PROJECT STATE ===')
    expect(remoteSnapshot).toContain('Project scaffolded')

    // RemoteStore and LocalStore return the same formatted text
    expect(remoteSnapshot).toBe(localSnapshot)
  })

  it('open threads round-trip via RemoteStore', async () => {
    const project = await remote.createProject({ name: 'thread-proj' })
    const branch = await remote.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })

    await remote.upsertAgent({
      id: 'thread-agent',
      projectId: project.id,
      role: 'dev',
      tool: 'test',
      workflowType: 'interactive',
    })

    await remote.createCommit({
      branchId: branch.id,
      agentId: 'thread-agent',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'Open a thread',
      content: 'Some work',
      summary: 'Work in progress',
      commitType: 'manual',
      threads: { open: ['Which auth approach to use?'] },
    })

    const threads = await remote.listOpenThreads(project.id)
    expect(threads).toHaveLength(1)
    expect(threads[0].description).toBe('Which auth approach to use?')
    expect(threads[0].createdAt).toBeInstanceOf(Date)
  })

  it('fullTextSearch returns results via RemoteStore', async () => {
    const project = await remote.createProject({ name: 'search-proj' })
    const branch = await remote.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })

    await remote.upsertAgent({
      id: 'search-agent',
      projectId: project.id,
      role: 'dev',
      tool: 'test',
      workflowType: 'interactive',
    })

    await remote.createCommit({
      branchId: branch.id,
      agentId: 'search-agent',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'Add authentication',
      content: 'Implemented JWT RS256 for authentication',
      summary: 'JWT auth done',
      commitType: 'manual',
    })

    const results = await remote.fullTextSearch('JWT', project.id)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].commit.createdAt).toBeInstanceOf(Date)
    expect(results[0].matchType).toBe('fulltext')
  })

  it('mergeBranch carries threads via RemoteStore', async () => {
    const project = await remote.createProject({ name: 'merge-proj' })
    const main = await remote.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const feat = await remote.createBranch({
      projectId: project.id,
      name: 'feat',
      gitBranch: 'feat',
      parentBranchId: main.id,
    })

    await remote.upsertAgent({
      id: 'merge-agent',
      projectId: project.id,
      role: 'dev',
      tool: 'test',
      workflowType: 'interactive',
    })

    await remote.createCommit({
      branchId: main.id,
      agentId: 'merge-agent',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'main init',
      content: 'c',
      summary: 's',
      commitType: 'branch-init',
    })

    await remote.createCommit({
      branchId: feat.id,
      agentId: 'merge-agent',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'feat work',
      content: 'c',
      summary: 's',
      commitType: 'manual',
      threads: { open: ['Thread from feat'] },
    })

    const mergeCommit = await remote.mergeBranch(feat.id, main.id, 'Merged feat into main')
    expect(mergeCommit.commitType).toBe('merge')
    expect(mergeCommit.createdAt).toBeInstanceOf(Date)

    // Source branch is merged
    const updatedFeat = await remote.getBranch(feat.id)
    expect(updatedFeat?.status).toBe('merged')

    // Thread carried to main branch
    const mainThreads = await remote.listOpenThreadsByBranch(main.id)
    expect(mainThreads).toHaveLength(1)
    expect(mainThreads[0].description).toBe('Thread from feat')
  })

  it('syncThread is idempotent and round-trips via RemoteStore', async () => {
    const project = await remote.createProject({ name: 'sync-thread-proj' })
    const branch = await remote.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })

    await remote.upsertAgent({
      id: 'sync-agent',
      projectId: project.id,
      role: 'dev',
      tool: 'test',
      workflowType: 'interactive',
    })

    // Create a commit so we have a valid openedInCommit reference
    const commit = await remote.createCommit({
      branchId: branch.id,
      agentId: 'sync-agent',
      agentRole: 'dev',
      tool: 'test',
      workflowType: 'interactive',
      message: 'Seed commit',
      content: 'c',
      summary: 's',
      commitType: 'manual',
    })

    // Construct a Thread as if it came from another store (e.g. during push/pull)
    const thread = await remote.syncThread({
      id: 'sync-thread-id-1',
      projectId: project.id,
      branchId: branch.id,
      description: 'Synced open question',
      status: 'open',
      openedInCommit: commit.id,
      createdAt: new Date(),
    })
    expect(thread.id).toBe('sync-thread-id-1')
    expect(thread.description).toBe('Synced open question')

    // Idempotent: calling again should not throw
    await expect(remote.syncThread(thread)).resolves.toBeDefined()

    // Thread visible via listOpenThreads
    const open = await remote.listOpenThreads(project.id)
    expect(open.some(t => t.id === 'sync-thread-id-1')).toBe(true)
  })
})
