import { describe, it, expect } from 'vitest'
import { classifyThread, DECAY_DEFAULTS, normalizeThreadSubject, parseThreadOpenInput } from './threads.js'
import type { Thread, ThreadDecayContext } from './index.js'

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    branchId: 'b1',
    description: 'sub',
    status: 'open',
    kind: 'open',
    openedInCommit: 'c1',
    createdAt: new Date(0),
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ThreadDecayContext> = {}): ThreadDecayContext {
  return {
    touchTs: 0,
    projectCommitsSince: 0,
    branchCommitsSince: 0,
    now: 0,
    ...overrides,
  }
}

describe('normalizeThreadSubject', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeThreadSubject('  hello  ')).toBe('hello')
  })

  it('lowercases', () => {
    expect(normalizeThreadSubject('Foo BAR Baz')).toBe('foo bar baz')
  })

  it('collapses internal whitespace runs', () => {
    expect(normalizeThreadSubject('foo   bar\tbaz\n qux')).toBe('foo bar baz qux')
  })

  it('returns equal forms for casing + spacing variants', () => {
    const a = normalizeThreadSubject('  Write Plan B Extension')
    const b = normalizeThreadSubject('write plan b extension')
    const c = normalizeThreadSubject('Write  Plan  B  Extension ')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('treats distinct subjects as distinct', () => {
    expect(normalizeThreadSubject('foo')).not.toBe(normalizeThreadSubject('bar'))
  })
})

describe('parseThreadOpenInput', () => {
  it('coerces a plain string to {subject, kind: "open"}', () => {
    expect(parseThreadOpenInput('hello')).toEqual({ subject: 'hello', kind: 'open' })
  })

  it('passes through an object with kind set', () => {
    expect(parseThreadOpenInput({ subject: 'note', kind: 'watch' })).toEqual({ subject: 'note', kind: 'watch' })
  })

  it('defaults kind to "open" when an object omits it', () => {
    expect(parseThreadOpenInput({ subject: 'note' })).toEqual({ subject: 'note', kind: 'open' })
  })
})

describe('classifyThread (open kind) — AND-rule: stale requires BOTH age AND distance', () => {
  const oldEnough = DECAY_DEFAULTS.staleOpenAgeMs + 1 // > age threshold = age-stale
  const youngEnough = DECAY_DEFAULTS.staleOpenAgeMs - 1 // < age threshold = age-fresh

  it('is live when both commit counts are below thresholds (regardless of age)', () => {
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({
      projectCommitsSince: 7,
      branchCommitsSince: 29,
      touchTs: 0,
      now: oldEnough,
    }))).toBe('live')
  })

  it('is live when distance is past threshold but recency is fresh — the JiraExtension long-branch case', () => {
    // 100 branch commits since touch, but touch was 1 hour ago → recency keeps it alive.
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({
      branchCommitsSince: 100,
      projectCommitsSince: 100,
      touchTs: 0,
      now: 60 * 60 * 1000, // 1h since touch
    }))).toBe('live')
  })

  it('is live when age is past threshold but distance is below — inactive project, untouched thread', () => {
    // 30 days untouched, but 0 commits-since-touch on either dimension → distance signal absent.
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({
      projectCommitsSince: 0,
      branchCommitsSince: 0,
      touchTs: 0,
      now: oldEnough,
    }))).toBe('live')
  })

  it('is stale when BOTH age AND branch-distance are past thresholds', () => {
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({
      branchCommitsSince: DECAY_DEFAULTS.staleOpenBranchCommits,
      touchTs: 0,
      now: oldEnough,
    }))).toBe('stale')
  })

  it('is stale when BOTH age AND project-distance are past thresholds', () => {
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({
      projectCommitsSince: DECAY_DEFAULTS.staleOpenProjectCommits,
      touchTs: 0,
      now: oldEnough,
    }))).toBe('stale')
  })

  it('is live when age is just under the threshold even with strong distance signal', () => {
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({
      branchCommitsSince: DECAY_DEFAULTS.staleOpenBranchCommits + 50,
      touchTs: 0,
      now: youngEnough,
    }))).toBe('live')
  })

  it('treats legacy threads with undefined kind as open (AND-rule still applies)', () => {
    const t = makeThread({ kind: undefined })
    // distance only → live; both signals needed
    expect(classifyThread(t, makeCtx({ branchCommitsSince: 100, touchTs: 0, now: 0 }))).toBe('live')
    // age + distance → stale
    expect(classifyThread(t, makeCtx({ branchCommitsSince: 100, touchTs: 0, now: oldEnough }))).toBe('stale')
  })
})

describe('classifyThread (watch kind)', () => {
  it('is live when neither commit count nor time exceeds the TTL', () => {
    const t = makeThread({ kind: 'watch' })
    expect(classifyThread(t, makeCtx({ branchCommitsSince: 14, now: 0, touchTs: 0 }))).toBe('live')
  })

  it('expires once branch commits since touch hit the watch threshold', () => {
    const t = makeThread({ kind: 'watch' })
    expect(classifyThread(t, makeCtx({ branchCommitsSince: DECAY_DEFAULTS.expiredWatchBranchCommits }))).toBe('expired')
  })

  it('expires once time since touch exceeds the watch TTL', () => {
    const t = makeThread({ kind: 'watch' })
    const ctx = makeCtx({ touchTs: 0, now: DECAY_DEFAULTS.expiredWatchTimeMs })
    expect(classifyThread(t, ctx)).toBe('expired')
  })

  it('does NOT use the stale-open thresholds for watch', () => {
    const t = makeThread({ kind: 'watch' })
    // 30 branch commits would stale an open thread, but watch threshold is 15 — already expired
    // so test the other direction: 14 branch commits + 0 time = still live for watch.
    expect(classifyThread(t, makeCtx({ branchCommitsSince: 14 }))).toBe('live')
  })
})
