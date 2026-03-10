// auto-snapshot.ts — AutoSnapshotManager
//
// Tracks tool calls made to the MCP server and fires an automatic context_commit
// after every N=10 non-commit calls. This ensures context is preserved even when
// the agent forgets to call context_commit manually.
//
// Context tool semantics:
//   context_commit  → resets the counter (manual commit = checkpoint reached)
//   context_get     → counted (each session-start snapshot counts toward the interval)
//   context_search  → counted
//   any other tool  → counted (future tools)

import type { ContextEngine } from '@contexthub/core'

export interface AutoSnapshotOptions {
  /** Number of non-commit tool calls before an auto-commit fires. Default: 10. */
  interval?: number
}

export class AutoSnapshotManager {
  private count = 0
  private readonly interval: number
  private readonly engine: ContextEngine

  constructor(engine: ContextEngine, options: AutoSnapshotOptions = {}) {
    this.engine = engine
    this.interval = options.interval ?? 10
  }

  /**
   * Record a tool call by name.
   *
   * - `context_commit` resets the counter (manual commit; no auto-commit fired).
   * - All other tool names increment the counter.
   * - When the counter reaches `interval`, an auto-commit is fired and the
   *   counter resets to 0.
   *
   * Auto-commit failures are swallowed — the tool call is never blocked.
   *
   * @returns The new commit ID if an auto-commit was fired, otherwise undefined.
   */
  async onToolCall(toolName: string): Promise<string | undefined> {
    if (toolName === 'context_commit') {
      this.count = 0
      return undefined
    }

    this.count++

    if (this.count >= this.interval) {
      this.count = 0
      return this.fireAutoCommit()
    }

    return undefined
  }

  /** Current tool-call count since the last commit (manual or auto). */
  get toolCallCount(): number {
    return this.count
  }

  /** Manually reset the counter (e.g. after an out-of-band commit). */
  reset(): void {
    this.count = 0
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async fireAutoCommit(): Promise<string | undefined> {
    try {
      const commit = await this.engine.commit({
        message: `Auto-snapshot after ${this.interval} tool calls`,
        content: `Automatic context checkpoint triggered after ${this.interval} tool calls without a manual context_commit.`,
        commitType: 'auto',
      })
      return commit.id
    } catch {
      // Never block a tool call due to auto-snapshot failure.
      return undefined
    }
  }
}
