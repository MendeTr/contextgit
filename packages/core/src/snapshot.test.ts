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

  // 02 DELTA gate 1: the legacy stored-prose summary is no longer emitted.
  // projectSummary is reconstructable from the head commit summary and was going
  // stale at load time; per the spec ("Architecture prose is dropped, not
  // maintained"), the load now carries only the live ## Git facts + curated
  // threads + recent activity, never a stored prose block.
  it('agents-md does not emit the legacy ## Project State block', () => {
    const snapshot = makeSnapshot({ projectSummary: 'free-form prose blob' })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).not.toContain('## Project State')
    expect(out).not.toContain('free-form prose blob')
    expect(out).not.toContain('(no summary yet)')
  })

  it('text format does not emit the legacy === PROJECT STATE === block', () => {
    const snapshot = makeSnapshot({ projectSummary: 'free-form prose blob' })
    const out = formatter.format(snapshot, 'text')
    expect(out).not.toContain('=== PROJECT STATE ===')
    expect(out).not.toContain('free-form prose blob')
    expect(out).not.toContain('(no summary yet)')
  })

  // Defensive: when the head commit's summary itself contains markdown headings,
  // the previous formatter would dump them under ## Project State and produce
  // duplicate sections (notably a second ## Git). Verify exactly one ## Git
  // heading regardless of what projectSummary carries.
  it('agents-md emits exactly one ## Git heading even when projectSummary contains "## Git"', () => {
    const snapshot = makeSnapshot({
      projectSummary: '## Git\nBranch: stale-from-storage | HEAD: deadbeef',
      headSha: '1234567890abcdef',
      commitCount: 42,
    })
    const out = formatter.format(snapshot, 'agents-md')
    const gitHeadingCount = (out.match(/^## Git$/gm) ?? []).length
    expect(gitHeadingCount).toBe(1)
    expect(out).not.toContain('stale-from-storage')
    expect(out).not.toContain('deadbeef')
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

  it('agents-md appends a decay count line when stale or expired counts are non-zero', () => {
    const snapshot = makeSnapshot({ staleThreadCount: 12, expiredWatchCount: 7 })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('+12 stale')
    expect(out).toContain('+7 expired-watch')
    expect(out).toContain('call project_memory_threads to view')
  })

  it('agents-md omits the decay count line when counts are zero or missing', () => {
    const snapshot = makeSnapshot()
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).not.toContain('project_memory_threads')
    expect(out).not.toContain('stale')
    expect(out).not.toContain('expired-watch')
  })

  it('agents-md count line includes only the non-zero count when one side is empty', () => {
    const snapshot = makeSnapshot({ staleThreadCount: 4, expiredWatchCount: 0 })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('+4 stale')
    expect(out).not.toContain('expired-watch')
  })

  it('text format also shows the decay count line', () => {
    const snapshot = makeSnapshot({ staleThreadCount: 3, expiredWatchCount: 0 })
    const out = formatter.format(snapshot, 'text')
    expect(out).toContain('+3 stale')
  })

  it('agents-md prefixes each open thread with a 6-char [handle]', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 'abcdef1234567890',
          projectId: 'p', branchId: 'b',
          description: 'thread one',
          status: 'open',
          openedInCommit: 'c1',
          createdAt: new Date(),
        },
      ],
    })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('[abcdef]')
    // Confirm handle is exactly 6 chars and equals id.slice(0,6)
    const handleMatch = out.match(/\[([a-zA-Z0-9_-]+)\] \[FREE\] thread one/)
    expect(handleMatch?.[1]).toBe('abcdef')
  })

  it('text format prefixes each open thread with a 6-char [handle]', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 'xyz789abcdef0000',
          projectId: 'p', branchId: 'b',
          description: 'thread two',
          status: 'open',
          openedInCommit: 'c1',
          createdAt: new Date(),
        },
      ],
    })
    const out = formatter.format(snapshot, 'text')
    expect(out).toContain('[xyz789]')
  })

  it('agents-md renders the Git section with live branch/HEAD/commit count when set', () => {
    const snapshot = makeSnapshot({
      branchName: 'feature/x',
      headSha: '1234567890abcdef',
      commitCount: 42,
    })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('## Git')
    expect(out).toContain('Branch: feature/x')
    expect(out).toContain('HEAD: 12345678')
    expect(out).toContain('42 commits')
  })

  it('omits the Git section when headSha and commitCount are not set', () => {
    const snapshot = makeSnapshot() // branchName defaults to 'main' but no headSha/commitCount
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).not.toContain('## Git')
  })

  it('text format also renders the GIT section', () => {
    const snapshot = makeSnapshot({ headSha: 'abc12345abcdef', commitCount: 7 })
    const out = formatter.format(snapshot, 'text')
    expect(out).toContain('=== GIT ===')
    expect(out).toContain('HEAD: abc12345')
    expect(out).toContain('7 commits')
  })
})
