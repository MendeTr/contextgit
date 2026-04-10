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
    isInitiated: true,
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

  it('includes ## Active Claims section in agents-md when claims exist', () => {
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
    expect(out).toContain('## Active Claims')
  })

  it('includes ACTIVE CLAIMS section in text format when claims exist', () => {
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
    expect(out).toContain('=== ACTIVE CLAIMS ===')
  })

  it('agents-md does not contain ## Current Branch section', () => {
    const snapshot = makeSnapshot({ branchSummary: 'branch summary' })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).not.toContain('## Current Branch')
  })

  it('agents-md contains ## Project State before ## Open Threads', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 't1',
          projectId: 'p',
          branchId: 'b',
          description: 'thread one',
          status: 'open',
          openedInCommit: 'c1',
          createdAt: new Date(),
        },
      ],
    })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out.indexOf('## Project State')).toBeLessThan(out.indexOf('## Open Threads'))
  })

  it('agents-md deduplicates open threads by id', () => {
    const thread = {
      id: 'dup-1',
      projectId: 'p',
      branchId: 'b',
      description: 'duplicated thread',
      status: 'open' as const,
      openedInCommit: 'c1',
      createdAt: new Date(),
    }
    const snapshot = makeSnapshot({ openThreads: [thread, thread] })
    const out = formatter.format(snapshot, 'agents-md')
    const count = (out.match(/duplicated thread/g) ?? []).length
    expect(count).toBe(1)
  })
})
