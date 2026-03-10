// RollingSummarizer — Week 1 placeholder: string truncation.
// Week 2 replaces this body with claude-haiku-4-5-20251001 + graceful fallback.
// The interface is stable; callers never know which implementation is running.

export interface SummarizerOptions {
  /** Max characters for project-level summaries (~2000 tokens). */
  maxProjectChars?: number
  /** Max characters for branch-level summaries (~500 tokens). */
  maxBranchChars?: number
}

export class RollingSummarizer {
  private readonly maxProjectChars: number
  private readonly maxBranchChars: number

  constructor(options: SummarizerOptions = {}) {
    this.maxProjectChars = options.maxProjectChars ?? 8000
    this.maxBranchChars  = options.maxBranchChars  ?? 2000
  }

  /**
   * Roll `content` into `previousSummary` and return a new summary that fits
   * within the budget for the given scope.
   *
   * Week 1: dumb truncation (newest content appended, trimmed from the start
   * so the most-recent work is always present).
   */
  summarize(
    content: string,
    previousSummary: string,
    budget: 'project' | 'branch',
  ): string {
    const max = budget === 'project' ? this.maxProjectChars : this.maxBranchChars
    const combined = previousSummary ? `${previousSummary}\n\n${content}` : content
    if (combined.length <= max) return combined
    // Keep the tail so recent work is never lost.
    return combined.slice(combined.length - max)
  }
}
