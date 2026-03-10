// RollingSummarizer — Week 2: Claude Haiku with graceful string-truncation fallback.
// If the API key is absent or the API call fails, falls back to string truncation.
// The interface is stable; callers never know which implementation is running.

import Anthropic from '@anthropic-ai/sdk'

export interface SummarizerOptions {
  /** Max characters for project-level summaries (~2000 tokens). */
  maxProjectChars?: number
  /** Max characters for branch-level summaries (~500 tokens). */
  maxBranchChars?: number
  /**
   * Inject a pre-built Anthropic client (useful for tests).
   * If omitted, one is created from ANTHROPIC_API_KEY.
   * If ANTHROPIC_API_KEY is also absent, falls back to string truncation.
   */
  client?: Anthropic
}

export class RollingSummarizer {
  private readonly maxProjectChars: number
  private readonly maxBranchChars: number
  private readonly client: Anthropic | null

  constructor(options: SummarizerOptions = {}) {
    this.maxProjectChars = options.maxProjectChars ?? 8000
    this.maxBranchChars  = options.maxBranchChars  ?? 2000

    if (options.client !== undefined) {
      this.client = options.client
    } else if (process.env['ANTHROPIC_API_KEY']) {
      this.client = new Anthropic()
    } else {
      this.client = null
    }
  }

  /**
   * Roll `content` into `previousSummary` and return a new summary that fits
   * within the budget for the given scope.
   *
   * Week 2: uses Claude Haiku for intelligent compression.
   * Fallback: dumb truncation (newest content appended, trimmed from the start
   * so the most-recent work is always present).
   *
   * Never throws — summarizer failures are silently swallowed.
   */
  async summarize(
    content: string,
    previousSummary: string,
    budget: 'project' | 'branch',
  ): Promise<string> {
    const max = budget === 'project' ? this.maxProjectChars : this.maxBranchChars

    if (this.client !== null) {
      try {
        return await this._claudeSummarize(content, previousSummary, max)
      } catch {
        // Graceful fallback — never propagate summarizer failure to the caller.
      }
    }

    return this._truncateSummarize(content, previousSummary, max)
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async _claudeSummarize(
    content: string,
    previousSummary: string,
    maxChars: number,
  ): Promise<string> {
    const userContent = previousSummary
      ? `Previous summary:\n${previousSummary}\n\nNew content to integrate:\n${content}`
      : `Content to summarize:\n${content}`

    const response = await this.client!.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system:
        'You are a context summarizer for an AI coding agent. ' +
        'Return only the summary text with no preamble or explanation.',
      messages: [
        {
          role: 'user',
          content:
            userContent +
            `\n\nCreate a concise rolling summary (max ${maxChars} characters) ` +
            'that preserves the most important recent work and decisions. ' +
            'Return only the summary text.',
        },
      ],
    })

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    return text.slice(0, maxChars)
  }

  private _truncateSummarize(
    content: string,
    previousSummary: string,
    max: number,
  ): string {
    const combined = previousSummary ? `${previousSummary}\n\n${content}` : content
    if (combined.length <= max) return combined
    // Keep the tail so recent work is never lost.
    return combined.slice(combined.length - max)
  }
}
