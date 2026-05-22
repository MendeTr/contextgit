// ThreadManager — read-side helper for the open-thread immune-to-compression guarantee.
//
// Key invariant: open threads are stored in the `threads` table and NEVER
// passed to the summarizer.  This file enforces that boundary by providing
// the only sanctioned way to query open threads.
//
// Write-side (opening / closing threads) happens via CommitInput.threads
// inside store.createCommit(), which is the right transactional boundary.

import type { Thread } from './types.js'

/**
 * Canonical form of a thread subject for dedupe-on-save (02 DELTA, spec §A).
 * Trim, lowercase, collapse internal whitespace. Two subjects are duplicates
 * iff their normalized forms are equal.
 */
export function normalizeThreadSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, ' ')
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
