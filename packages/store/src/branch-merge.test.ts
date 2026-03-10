// Days 12–13 integration test: engine.branch() + engine.merge()
//
// Scenario: main → commit + thread → branch('feature') → 2 commits + thread
//           → merge back to main → snapshot shows merged state + all threads.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ContextEngine } from '@contexthub/core'
import { LocalStore } from './local/index.js'

describe('engine.branch() + engine.merge()', () => {
  let store: LocalStore
  let mainEngine: ContextEngine
  let featureEngine: ContextEngine

  beforeEach(() => {
    store         = new LocalStore(':memory:')
    mainEngine    = new ContextEngine(store, 'agent-main', 'orchestrator', 'claude-code', 'interactive')
    featureEngine = new ContextEngine(store, 'agent-feat', 'dev',          'claude-code', 'interactive')
  })

  afterEach(() => {
    store.close()
  })

  it('branch → 2 commits → merge → snapshot shows merged state and all threads', async () => {
    // 1. Setup: project + main branch
    const project    = await store.createProject({ name: 'contexthub' })
    const mainBranch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await mainEngine.init(project.id, mainBranch.id)

    // 2. Commit on main with an open thread
    await mainEngine.commit({
      message: 'Initial main commit',
      content: 'Set up project foundation.',
      threads: { open: ['Choose DB migration strategy'] },
    })

    // 3. Branch off main
    const featureBranch = await mainEngine.branch('feature/auth', 'auth feature')

    expect(featureBranch.gitBranch).toBe('feature/auth')
    expect(featureBranch.name).toBe('auth feature')
    expect(featureBranch.parentBranchId).toBe(mainBranch.id)
    expect(featureBranch.status).toBe('active')

    // feature branch should have a branch-init commit with main's summary
    const featureCommits = await store.listCommits(featureBranch.id, { limit: 10, offset: 0 })
    expect(featureCommits).toHaveLength(1)
    expect(featureCommits[0].commitType).toBe('branch-init')
    expect(featureCommits[0].summary).toBeTruthy() // carried parent summary

    // 4. Two commits on feature branch (one with its own thread)
    await featureEngine.init(project.id, featureBranch.id)

    await featureEngine.commit({
      message: 'Add auth middleware',
      content: 'Implemented JWT middleware and route guards.',
      threads: { open: ['Token expiry policy TBD'] },
    })

    const lastFeatureCommit = await featureEngine.commit({
      message: 'Add login endpoint',
      content: 'POST /auth/login with bcrypt password verification.',
    })
    expect(lastFeatureCommit.summary).toContain('bcrypt')

    // 5. Merge feature → main
    const mergeCommit = await mainEngine.merge(featureBranch.id)

    expect(mergeCommit.commitType).toBe('merge')
    expect(mergeCommit.branchId).toBe(mainBranch.id)
    expect(mergeCommit.mergeSourceBranchId).toBe(featureBranch.id)

    // 6. Source branch should be marked merged
    const mergedBranch = await store.getBranch(featureBranch.id)
    expect(mergedBranch?.status).toBe('merged')
    expect(mergedBranch?.mergedAt).toBeTruthy()

    // 7. Snapshot on main should show merged state
    const snapshot = await mainEngine.context('global')

    expect(snapshot.branchName).toBe('main')
    // recent commits: merge commit is the newest
    expect(snapshot.recentCommits[0].commitType).toBe('merge')
    // open threads: both the main thread and the feature thread carried forward
    const threadDescriptions = snapshot.openThreads.map(t => t.description)
    expect(threadDescriptions).toContain('Choose DB migration strategy')
    expect(threadDescriptions).toContain('Token expiry policy TBD')
  })

  it('branch-init commit carries parent HEAD summary into new branch', async () => {
    const project    = await store.createProject({ name: 'p' })
    const mainBranch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await mainEngine.init(project.id, mainBranch.id)

    await mainEngine.commit({ message: 'setup', content: 'foundation work done' })

    const feat = await mainEngine.branch('feature/x')

    // branch-init summary should match main's HEAD summary
    const mainHead = await store.getBranch(mainBranch.id)
    const mainHeadCommit = mainHead?.headCommitId
      ? await store.getCommit(mainHead.headCommitId)
      : null

    const featCommits = await store.listCommits(feat.id, { limit: 1, offset: 0 })
    expect(featCommits[0].summary).toBe(mainHeadCommit?.summary)
  })

  it('merge summary incorporates source branch content', async () => {
    const project    = await store.createProject({ name: 'p' })
    const mainBranch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await mainEngine.init(project.id, mainBranch.id)

    await mainEngine.commit({ message: 'base', content: 'base content' })

    const feat = await mainEngine.branch('feature/y')
    await featureEngine.init(project.id, feat.id)
    await featureEngine.commit({ message: 'feature work', content: 'feature specific content' })

    const mergeCommit = await mainEngine.merge(feat.id)

    // merge commit summary should reference feature content
    expect(mergeCommit.summary).toBeTruthy()
    expect(mergeCommit.content).toContain('feature specific content')
  })
})
