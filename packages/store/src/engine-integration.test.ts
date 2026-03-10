// Week 1 validation: ContextEngine + LocalStore end-to-end.
//
// Scenario: create project → 2 commits (one with open thread) →
//   context('global') → snapshot shows thread + both commits.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ContextEngine } from '@contexthub/core'
import { LocalStore } from './local/index.js'

describe('ContextEngine + LocalStore integration', () => {
  let store: LocalStore
  let engine: ContextEngine

  beforeEach(() => {
    store  = new LocalStore(':memory:')
    engine = new ContextEngine(store, 'agent-1', 'dev', 'claude-code', 'interactive')
  })

  afterEach(() => {
    store.close()
  })

  it('Week 1 validation: project → 2 commits → context("global") shows thread + both commits', async () => {
    // Setup: project + branch
    const project = await store.createProject({ name: 'contexthub', description: 'Persistent memory layer' })
    const branch  = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })

    await engine.init(project.id, branch.id)

    // Commit 1 — opens a thread
    const c1 = await engine.commit({
      message: 'Set up monorepo structure',
      content: 'Created pnpm workspaces, tsconfig.base.json, core and store packages.',
      threads: { open: ['Database migration strategy not decided'] },
    })
    expect(c1.id).toBeTruthy()
    expect(c1.summary).toBeTruthy()
    expect(c1.agentRole).toBe('dev')

    // Commit 2 — no thread changes; summary should roll forward
    const c2 = await engine.commit({
      message: 'Add LocalStore implementation',
      content: 'Implemented LocalStore with better-sqlite3, schema, migrations, queries.',
    })
    expect(c2.id).toBeTruthy()
    // Rolling summary must include the new content
    expect(c2.summary).toContain('LocalStore')

    // context('global') → SessionSnapshot
    const snapshot = await engine.context('global')

    expect(snapshot.branchName).toBe('main')
    expect(snapshot.recentCommits).toHaveLength(2)
    expect(snapshot.recentCommits[0].message).toBe('Add LocalStore implementation')
    expect(snapshot.recentCommits[1].message).toBe('Set up monorepo structure')

    // Open thread from commit 1 must survive commit 2
    expect(snapshot.openThreads).toHaveLength(1)
    expect(snapshot.openThreads[0].description).toBe('Database migration strategy not decided')
  })

  it('summarizer rolls content into previous summary', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch  = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await engine.init(project.id, branch.id)

    const c1 = await engine.commit({ message: 'first', content: 'alpha content' })
    const c2 = await engine.commit({ message: 'second', content: 'beta content' })

    // c2 summary must contain both pieces (budget large enough for test data)
    expect(c2.summary).toContain('alpha content')
    expect(c2.summary).toContain('beta content')
    // c1 summary should be just the first content
    expect(c1.summary).toBe('alpha content')
  })

  it('context("branch") returns the same snapshot as context("global")', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch  = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await engine.init(project.id, branch.id)
    await engine.commit({ message: 'm', content: 'c' })

    const global = await engine.context('global')
    const branchCtx = await engine.context('branch')
    expect(branchCtx.branchName).toBe(global.branchName)
    expect(branchCtx.recentCommits).toHaveLength(global.recentCommits.length)
  })

  it('throws if context() called before init()', async () => {
    const uninitEngine = new ContextEngine(store, 'a', 'solo', 'cli', 'interactive')
    await expect(uninitEngine.context('global')).rejects.toThrow('not initialized')
  })
})
