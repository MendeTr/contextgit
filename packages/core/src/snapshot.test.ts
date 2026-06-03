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

  // ─── 04 DELTA: ## Plan section ───────────────────────────────────────────

  it('agents-md renders ## Plan between ## Git and ## Open Threads when planTree is present', () => {
    const snapshot = makeSnapshot({
      headSha: 'a1b2c3d4',
      commitCount: 10,
      planTree: [
        {
          id: 'plan-1234567890', projectId: 'p', level: 'plan', title: 'Webapp foundation',
          status: 'pending', position: 0, createdAt: new Date(),
          progress: { done: 1, total: 3 },
          children: [
            {
              id: 'step-1234567890', projectId: 'p', parentId: 'plan-1234567890', level: 'step',
              title: 'Slice 1', status: 'done', position: 0, createdAt: new Date(),
              progress: { done: 1, total: 1 },
              children: [
                { id: 'task-AA12345678', projectId: 'p', parentId: 'step-1234567890', level: 'task',
                  title: 'StatusDot', status: 'done', position: 0, createdAt: new Date() },
              ],
            },
            {
              id: 'step-2234567890', projectId: 'p', parentId: 'plan-1234567890', level: 'step',
              title: 'Slice 2', status: 'pending', position: 1, createdAt: new Date(),
              progress: { done: 0, total: 2 },
              children: [
                { id: 'task-BB12345678', projectId: 'p', parentId: 'step-2234567890', level: 'task',
                  title: 'ProgressBar', status: 'pending', position: 0, createdAt: new Date() },
                { id: 'task-CC12345678', projectId: 'p', parentId: 'step-2234567890', level: 'task',
                  title: 'AISuggestionCard', status: 'pending', position: 1, createdAt: new Date() },
              ],
            },
          ],
        },
      ],
    })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('## Plan')
    expect(out).toContain('Webapp foundation')
    expect(out).toContain('[1/3 done]')
    expect(out).toContain('✓ StatusDot')
    expect(out).toContain('→ ProgressBar')
    expect(out).toContain('← next')
    expect(out).toContain('○ AISuggestionCard')
    expect(out.indexOf('## Plan')).toBeLessThan(out.indexOf('## Open Threads'))
    expect(out.indexOf('## Git')).toBeLessThan(out.indexOf('## Plan'))
  })

  it('agents-md omits ## Plan when planTree is empty or undefined', () => {
    expect(formatter.format(makeSnapshot({ planTree: [] }), 'agents-md')).not.toContain('## Plan')
    expect(formatter.format(makeSnapshot(), 'agents-md')).not.toContain('## Plan')
  })

  it('text format also renders === PLAN === when planTree is non-empty', () => {
    const snapshot = makeSnapshot({
      planTree: [{
        id: 'planXYZ-rest', projectId: 'p', level: 'plan', title: 'Test plan',
        status: 'pending', position: 0, createdAt: new Date(),
        progress: { done: 0, total: 0 },
      }],
    })
    const out = formatter.format(snapshot, 'text')
    expect(out).toContain('=== PLAN ===')
    expect(out).toContain('Test plan')
  })

  it('agents-md: a done container renders ✓ and the ← next walk skips its subtree (0.2.2)', () => {
    // 0.2.2 honor-container-status: a step the user marked status='done' renders ✓
    // even with pending children, and the "find first pending task" walk must skip
    // the done subtree so a finished step never flags a spurious ← next.
    const snapshot = makeSnapshot({
      planTree: [
        {
          id: 'plan-root12345', projectId: 'p', level: 'plan', title: 'Phase 1',
          status: 'pending', position: 0, createdAt: new Date(),
          progress: { done: 1, total: 2 },
          children: [
            {
              // Done step with a still-pending child — must render ✓, child no ← next.
              id: 'step-done12345', projectId: 'p', parentId: 'plan-root12345', level: 'step',
              title: 'Shipped step', status: 'done', position: 0, createdAt: new Date(),
              progress: { done: 0, total: 1 },
              children: [
                { id: 'task-skip12345', projectId: 'p', parentId: 'step-done12345', level: 'task',
                  title: 'Deferred subtask', status: 'pending', position: 0, createdAt: new Date() },
              ],
            },
            {
              id: 'step-open12345', projectId: 'p', parentId: 'plan-root12345', level: 'step',
              title: 'Open step', status: 'pending', position: 1, createdAt: new Date(),
              progress: { done: 0, total: 1 },
              children: [
                { id: 'task-next12345', projectId: 'p', parentId: 'step-open12345', level: 'task',
                  title: 'Real next task', status: 'pending', position: 0, createdAt: new Date() },
              ],
            },
          ],
        },
      ],
    })
    const out = formatter.format(snapshot, 'agents-md')
    // The done step renders ✓ despite its pending child.
    expect(out).toContain('✓ Shipped step')
    // ← next lands on the real next task in the open step, not the deferred subtask.
    expect(out).toContain('→ Real next task')
    expect(out).toMatch(/Real next task.*← next/)
    expect(out).not.toMatch(/Deferred subtask.*← next/)
    // The deferred subtask under a done container is not flagged → next.
    expect(out).not.toContain('→ Deferred subtask')
  })
})
