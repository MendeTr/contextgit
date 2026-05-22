// ThreadManager — read-side helper for the open-thread immune-to-compression guarantee.
//
// Key invariant: open threads are stored in the `threads` table and NEVER
// passed to the summarizer.  This file enforces that boundary by providing
// the only sanctioned way to query open threads.
//
// Write-side (opening / closing threads) happens via CommitInput.threads
// inside store.createCommit(), which is the right transactional boundary.

import type { Thread, ThreadKind, ThreadOpenInput } from './types.js'

/**
 * Canonical form of a thread subject for dedupe-on-save (02 DELTA, spec §A).
 * Trim, lowercase, collapse internal whitespace. Two subjects are duplicates
 * iff their normalized forms are equal.
 */
export function normalizeThreadSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Coerce a `ThreadOpenInput` (string sugar OR object) into `{ subject, kind }`.
 * Plain string → `{ subject, kind: 'open' }`. Object missing `kind` → `'open'`.
 * Keeps the public API additive: old `string[]` callers keep working unchanged.
 */
export function parseThreadOpenInput(input: ThreadOpenInput): { subject: string; kind: ThreadKind } {
  if (typeof input === 'string') return { subject: input, kind: 'open' }
  return { subject: input.subject, kind: input.kind ?? 'open' }
}

// ─── Decay derivation (02 DELTA Step 3) ──────────────────────────────────────

/**
 * Thresholds for thread decay. The two open-thread signals fire independently —
 * a thread is stale if EITHER triggers. Watch expiry fires on first signal.
 *
 * "Sessions" in the spec are modeled here as:
 *   - branch commits since touch (per-branch activity)
 *   - project commits since touch (project-wide activity, the coarse session proxy)
 *   - calendar time since touch (the absolute-time fallback for inactive projects)
 */
export const DECAY_DEFAULTS = {
  staleOpenProjectCommits: 8,   // spec: 8 sessions, mapped to project-wide commits since touch
  staleOpenBranchCommits: 30,   // spec: 30 commits behind HEAD on the current branch
  expiredWatchBranchCommits: 15,// spec: 15 commits, whichever first
  expiredWatchTimeMs: 3 * 24 * 60 * 60 * 1000, // spec: 3 sessions, mapped to 3 days
} as const

export type DecayThresholds = typeof DECAY_DEFAULTS

export interface ThreadDecayContext {
  /** Unix ms timestamp of the thread's last touch (touched commit's created_at, fallback to thread.createdAt). */
  touchTs: number
  /** Count of commits on the project created strictly after touchTs. */
  projectCommitsSince: number
  /** Count of commits on the thread's branch created strictly after touchTs. */
  branchCommitsSince: number
  /** "Now" in Unix ms — injectable for deterministic tests. */
  now: number
}

export type ThreadDecayFlag = 'live' | 'stale' | 'expired'

/**
 * Classify a thread as live, stale (open thread past its decay threshold),
 * or expired (watch note past its TTL). Pure — no DB, no clock side-effect.
 */
export function classifyThread(
  thread: Thread,
  ctx: ThreadDecayContext,
  thresholds: DecayThresholds = DECAY_DEFAULTS,
): ThreadDecayFlag {
  const msSince = ctx.now - ctx.touchTs

  if (thread.kind === 'watch') {
    if (ctx.branchCommitsSince >= thresholds.expiredWatchBranchCommits) return 'expired'
    if (msSince >= thresholds.expiredWatchTimeMs) return 'expired'
    return 'live'
  }

  // 'open' or undefined (legacy) — treat as open
  if (ctx.branchCommitsSince >= thresholds.staleOpenBranchCommits) return 'stale'
  if (ctx.projectCommitsSince >= thresholds.staleOpenProjectCommits) return 'stale'
  return 'live'
}

export interface ThreadReader {
  listOpenThreads(projectId: string): Promise<Thread[]>
  listOpenThreadsByBranch(branchId: string): Promise<Thread[]>
}

export class ThreadManager {
  constructor(private readonly store: ThreadReader) {}

  /** All open threads for a project, across all branches. */
  openForProject(projectId: string): Promise<Thread[]> {
    return this.store.listOpenThreads(projectId)
  }

  /** Open threads scoped to a single branch. */
  openForBranch(branchId: string): Promise<Thread[]> {
    return this.store.listOpenThreadsByBranch(branchId)
  }
}
