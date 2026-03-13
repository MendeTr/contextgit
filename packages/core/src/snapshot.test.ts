import { describe, it, expect } from 'vitest'
import { SnapshotFormatter } from './snapshot.js'
import type { SessionSnapshot } from './types.js'

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    projectSummary: 'project summary',
    branchName: 'main',
    branchSummary: 'branch summary',
    recentCommits: [],
    openThreads: [],
    activeClaims: [],
    ...overrides,
  }
}

describe('SnapshotFormatter inline claim status', () => {
  const formatter = new SnapshotFormatter()

  it('shows [FREE] when thread has no matching claim', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 'thread-1',
          projectId: 'proj',
          branchId: 'branch',
          description: 'build auth module',
          status: 'open',
          openedInCommit: 'commit-1',
          createdAt: new Date(),
        },
      ],
      activeClaims: [],
    })

    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('[FREE] build auth module')
  })

  it('shows [CLAIMED by agentId] when thread has matching claim via threadId', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 'thread-1',
          projectId: 'proj',
          branchId: 'branch',
          description: 'build auth module',
          status: 'open',
          openedInCommit: 'commit-1',
          createdAt: new Date(),
        },
      ],
      activeClaims: [
        {
          id: 'claim-1',
          projectId: 'proj',
          branchId: 'branch',
          task: 'build auth module',
          agentId: 'agent-dev-1',
          role: 'dev',
          claimedAt: new Date(),
          status: 'active',
          ttl: 7_200_000,
          threadId: 'thread-1',
        },
      ],
    })

    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('[CLAIMED by agent-dev-1]')
    expect(out).not.toContain('[FREE]')
  })

  it('shows [CLAIMED by agentId] via substring match when threadId not set', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 'thread-2',
          projectId: 'proj',
          branchId: 'branch',
          description: 'write integration tests for login',
          status: 'open',
          openedInCommit: 'commit-1',
          createdAt: new Date(),
        },
      ],
      activeClaims: [
        {
          id: 'claim-2',
          projectId: 'proj',
          branchId: 'branch',
          task: 'write integration tests for login',
          agentId: 'agent-test-1',
          role: 'test',
          claimedAt: new Date(),
          status: 'active',
          ttl: 7_200_000,
        },
      ],
    })

    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('[CLAIMED by agent-test-1]')
  })

  it('does not include ## Active Claims section in agents-md', () => {
    const snapshot = makeSnapshot({
      activeClaims: [
        {
          id: 'claim-1',
          projectId: 'proj',
          branchId: 'branch',
          task: 'some task',
          agentId: 'agent-1',
          role: 'dev',
          claimedAt: new Date(),
          status: 'active',
          ttl: 7_200_000,
        },
      ],
    })

    const out = formatter.format(snapshot, 'agents-md')
    expect(out).not.toContain('## Active Claims')
  })

  it('does not include ACTIVE CLAIMS section in text format', () => {
    const snapshot = makeSnapshot({
      activeClaims: [
        {
          id: 'claim-1',
          projectId: 'proj',
          branchId: 'branch',
          task: 'some task',
          agentId: 'agent-1',
          role: 'dev',
          claimedAt: new Date(),
          status: 'active',
          ttl: 7_200_000,
        },
      ],
    })

    const out = formatter.format(snapshot, 'text')
    expect(out).not.toContain('=== ACTIVE CLAIMS ===')
  })
})
