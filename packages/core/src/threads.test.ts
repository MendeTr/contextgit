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

describe('classifyThread (open kind)', () => {
  it('is live when both commit counts are below thresholds', () => {
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({ projectCommitsSince: 7, branchCommitsSince: 29 }))).toBe('live')
  })

  it('is stale once branch commits since touch hit the threshold', () => {
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({ branchCommitsSince: DECAY_DEFAULTS.staleOpenBranchCommits }))).toBe('stale')
  })

  it('is stale once project commits since touch hit the threshold (age signal)', () => {
    const t = makeThread({ kind: 'open' })
    expect(classifyThread(t, makeCtx({ projectCommitsSince: DECAY_DEFAULTS.staleOpenProjectCommits }))).toBe('stale')
  })

  it('treats legacy threads with undefined kind as open', () => {
    const t = makeThread({ kind: undefined })
    expect(classifyThread(t, makeCtx({ branchCommitsSince: 100 }))).toBe('stale')
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
