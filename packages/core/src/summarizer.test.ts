// Week 2 summarizer tests.
// All API calls are mocked — no network required.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { RollingSummarizer } from './summarizer.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClient(responseText: string): Anthropic {
  const client = new Anthropic({ apiKey: 'test-key' })
  vi.spyOn(client.messages, 'create').mockResolvedValue({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: responseText }],
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as Awaited<ReturnType<typeof client.messages.create>>)
  return client
}

function makeFailingClient(): Anthropic {
  const client = new Anthropic({ apiKey: 'test-key' })
  vi.spyOn(client.messages, 'create').mockRejectedValue(
    new Error('Simulated API failure'),
  )
  return client
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RollingSummarizer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns Claude summary when API succeeds', async () => {
    const claudeReply = 'Concise summary from Claude Haiku.'
    const summarizer = new RollingSummarizer({ client: makeClient(claudeReply) })

    const result = await summarizer.summarize('some content', '', 'branch')

    expect(result).toBe(claudeReply)
  })

  it('passes previous summary and new content to Claude', async () => {
    const client = makeClient('merged summary')
    const summarizer = new RollingSummarizer({ client })

    await summarizer.summarize('new work', 'old summary', 'branch')

    const callArg = (client.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Anthropic.MessageCreateParamsNonStreaming
    const userContent = callArg.messages[0].content as string
    expect(userContent).toContain('old summary')
    expect(userContent).toContain('new work')
  })

  it('falls back to string truncation when API fails', async () => {
    const summarizer = new RollingSummarizer({ client: makeFailingClient() })

    const result = await summarizer.summarize('beta', 'alpha', 'branch')

    // Fallback: concatenate and keep; both fit in 2000 chars
    expect(result).toContain('alpha')
    expect(result).toContain('beta')
  })

  it('never throws when API fails', async () => {
    const summarizer = new RollingSummarizer({ client: makeFailingClient() })

    await expect(
      summarizer.summarize('content', '', 'branch'),
    ).resolves.toBeDefined()
  })

  it('falls back to string truncation when no client is injected and ANTHROPIC_API_KEY is absent', async () => {
    const savedKey = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']

    try {
      const summarizer = new RollingSummarizer()
      const result = await summarizer.summarize('beta content', 'alpha content', 'branch')
      expect(result).toContain('alpha content')
      expect(result).toContain('beta content')
    } finally {
      if (savedKey !== undefined) process.env['ANTHROPIC_API_KEY'] = savedKey
    }
  })

  it('truncates from the start (keeps newest) when fallback overflows budget', async () => {
    const savedKey = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']

    try {
      const summarizer = new RollingSummarizer({ maxBranchChars: 20 })
      const result = await summarizer.summarize('NEWEST', 'A'.repeat(30), 'branch')
      // Budget is 20 chars; tail of the combined string should end with NEWEST
      expect(result).toHaveLength(20)
      expect(result.endsWith('NEWEST')).toBe(true)
    } finally {
      if (savedKey !== undefined) process.env['ANTHROPIC_API_KEY'] = savedKey
    }
  })

  it('respects maxChars for Claude response (truncates to budget)', async () => {
    const longReply = 'X'.repeat(5000)
    const summarizer = new RollingSummarizer({
      client: makeClient(longReply),
      maxBranchChars: 100,
    })

    const result = await summarizer.summarize('content', '', 'branch')

    expect(result).toHaveLength(100)
  })
})
