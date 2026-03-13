// server.ts — ContextGit MCP Server
//
// Exposes three tools to Claude and other MCP clients:
//   context_get    — return a formatted project snapshot
//   context_commit — persist a context commit
//   context_search — full-text search over past commits
//
// Transport: stdio (launched by the MCP host, e.g. Claude Desktop / Claude Code)
//
// Initialization (per server process):
//   1. Load .contextgit/config.json (search from CWD upward)
//   2. Open LocalStore for projectId
//   3. Detect current git branch via simple-git
//   4. Resolve (or create) the context branch for that git branch
//   5. Build ContextEngine, call engine.init()

import os from 'os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { simpleGit } from 'simple-git'
import { ContextEngine, EmbeddingService, SnapshotFormatter } from '@contextgit/core'
import { LocalStore, RemoteStore } from '@contextgit/store'
import { loadConfig } from './config.js'
import { captureGitMetadata } from './git-sync.js'
import { AutoSnapshotManager } from './auto-snapshot.js'
import type { ContextStore } from '@contextgit/store'
import type { ContextGitConfig } from '@contextgit/core'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function detectGitBranch(): Promise<string> {
  try {
    const git = simpleGit(process.cwd())
    const result = await git.revparse(['--abbrev-ref', 'HEAD'])
    return result.trim()
  } catch {
    return 'main'
  }
}

/**
 * Resolve the ContextGit branch that tracks `gitBranch`.
 * Creates one if it doesn't exist yet.
 */
async function resolveContextBranch(
  store: ContextStore,
  projectId: string,
  gitBranch: string,
): Promise<string> {
  const existing = await store.getBranchByGitName(projectId, gitBranch)
  if (existing) return existing.id

  const created = await store.createBranch({
    projectId,
    name: `Context: ${gitBranch}`,
    gitBranch,
  })
  return created.id
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────

interface ServerContext {
  engine: ContextEngine
  store: ContextStore
  projectId: string
  branchId: string
  config: ContextGitConfig
  agentId: string
}

async function bootstrap(): Promise<ServerContext> {
  const config = loadConfig()
  const { projectId } = config

  const store: ContextStore =
    config.store && config.store !== 'local'
      ? new RemoteStore(config.store)
      : new LocalStore(projectId)

  // Ensure the project row exists before creating branches (FK constraint)
  const existing = await store.getProject(projectId)
  if (!existing) {
    await store.createProject({ id: projectId, name: config.project })
  }

  const gitBranch = await detectGitBranch()
  const branchId = await resolveContextBranch(store, projectId, gitBranch)

  const hostname = os.hostname()
  const agentId = process.env['CONTEXTGIT_AGENT_ID'] ?? `${hostname}-mcp-claude-code-interactive`

  const engine = new ContextEngine(
    store,
    agentId,
    config.agentRole ?? 'solo',
    'claude-code',
    config.workflowType ?? 'interactive',
    { embeddingService: new EmbeddingService() },
  )
  await engine.init(projectId, branchId)

  return { engine, store, projectId, branchId, config, agentId }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export async function createServer(): Promise<McpServer> {
  const ctx = await bootstrap()
  const autoSnapshot = new AutoSnapshotManager(ctx.engine, {
    interval: ctx.config.snapshotInterval ?? 10,
  })

  const server = new McpServer({
    name: 'contextgit',
    version: '0.0.1',
  })

  // ── context_get ─────────────────────────────────────────────────────────────
  server.tool(
    'context_get',
    'Retrieve the current project snapshot. Call this at every session start to load project state.',
    {
      scope: z.enum(['global', 'branch']).default('global').describe(
        "'global' returns the full project summary + branch state. 'branch' scopes to the current branch.",
      ),
      format: z.enum(['agents-md', 'json', 'text']).default('agents-md').describe(
        'Output format. agents-md is optimized for agent consumption.',
      ),
      agent_role: z.enum(['orchestrator','dev','test','review','background','ci','solo']).optional().describe(
        'Filter recentCommits to this agent role only. Omit to return commits from all roles.',
      ),
      since: z.number().optional().describe(
        'Unix timestamp ms. When provided, returns only commits and thread changes after this time. Use for orchestrator polling loops.',
      ),
    },
    async ({ format, agent_role, since }) => {
      await autoSnapshot.onToolCall('context_get')
      try {
        if (since !== undefined) {
          const delta = await ctx.store.getContextDelta(ctx.projectId, ctx.branchId, since)
          return {
            content: [{ type: 'text', text: JSON.stringify(delta, null, 2) }],
          }
        }
        const snapshot = await ctx.store.getSessionSnapshot(
          ctx.projectId,
          ctx.branchId,
          agent_role ? { agentRole: agent_role } : undefined,
        )
        const text = new SnapshotFormatter().format(snapshot, format)
        return {
          content: [{ type: 'text', text }],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Error retrieving snapshot: ${message}` }],
          isError: true,
        }
      }
    },
  )

  // ── context_commit ───────────────────────────────────────────────────────────
  server.tool(
    'context_commit',
    'Persist a context commit recording significant work. Call this after completing meaningful tasks or milestones.',
    {
      message: z.string().min(1).describe('Short summary of what was accomplished (1–2 sentences).'),
      content: z.string().min(1).describe('Detailed description of the work done, decisions made, and current state.'),
      open_threads: z.array(z.string()).optional().describe(
        'New open questions or blockers to track (each max 200 chars).',
      ),
      close_thread_ids: z.array(z.string()).optional().describe(
        'IDs of threads to close.',
      ),
    },
    async ({ message, content, open_threads, close_thread_ids }) => {
      await autoSnapshot.onToolCall('context_commit')
      try {
        const threads: { open?: string[]; close?: Array<{ id: string; note: string }> } = {}
        if (open_threads?.length) threads.open = open_threads
        if (close_thread_ids?.length) {
          threads.close = close_thread_ids.map(id => ({ id, note: 'Closed via context_commit' }))
        }

        const git = await captureGitMetadata(process.cwd())
        const commit = await ctx.engine.commit({
          message,
          content,
          gitCommitSha: git?.sha,
          ...(Object.keys(threads).length > 0 ? { threads } : {}),
        })

        return {
          content: [
            {
              type: 'text',
              text: `Commit recorded.\nID: ${commit.id}\nMessage: ${commit.message}`,
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Error recording commit: ${message}` }],
          isError: true,
        }
      }
    },
  )

  // ── context_search ───────────────────────────────────────────────────────────
  server.tool(
    'context_search',
    'Search past context commits. Uses semantic + full-text search and merges results.',
    {
      query: z.string().min(1).describe('Search query — natural language or keywords.'),
      limit: z.number().int().min(1).max(20).default(5).describe('Maximum results to return.'),
    },
    async ({ query, limit }) => {
      await autoSnapshot.onToolCall('context_search')
      try {
        // Run semantic and full-text in parallel; merge by commit ID, dedup.
        const [semantic, fts] = await Promise.all([
          ctx.engine.semanticSearch(query, ctx.projectId, limit),
          ctx.store.fullTextSearch(query, ctx.projectId),
        ])
        const seen = new Set<string>()
        const merged = [...semantic, ...fts].filter(r => {
          if (seen.has(r.commit.id)) return false
          seen.add(r.commit.id)
          return true
        })
        const trimmed = merged.slice(0, limit)

        if (trimmed.length === 0) {
          return {
            content: [{ type: 'text', text: 'No results found.' }],
          }
        }

        const formatted = trimmed
          .map(
            (r, i) =>
              `[${i + 1}] ${r.commit.message}\n` +
              `    ID: ${r.commit.id}  Score: ${r.score.toFixed(3)}\n` +
              `    ${r.commit.content.slice(0, 200)}${r.commit.content.length > 200 ? '…' : ''}`,
          )
          .join('\n\n')

        return {
          content: [{ type: 'text', text: formatted }],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Error searching commits: ${message}` }],
          isError: true,
        }
      }
    },
  )

  // ── context_branch ───────────────────────────────────────────────────────────
  server.tool(
    'context_branch',
    'Create a new context branch tracking a git branch. Call this when starting work on a new git branch.',
    {
      git_branch: z.string().min(1).describe('The git branch name to track.'),
      name: z.string().optional().describe('Optional display name for the context branch.'),
    },
    async ({ git_branch, name }) => {
      await autoSnapshot.onToolCall('context_branch')
      try {
        const branch = await ctx.engine.branch(git_branch, name)
        return {
          content: [
            {
              type: 'text',
              text: `Branch created.\nID:   ${branch.id}\nName: ${branch.name}`,
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Error creating branch: ${message}` }],
          isError: true,
        }
      }
    },
  )

  // ── context_claim ────────────────────────────────────────────────────────────
  server.tool(
    'context_claim',
    'Claim a task to prevent other agents from picking it up simultaneously. Call this before starting any significant task.',
    {
      task: z.string().min(1).describe('Short description of the task being claimed (e.g. "build auth module").'),
      ttl_hours: z.number().positive().default(2).describe('Time-to-live in hours before the claim auto-expires. Default: 2.'),
      status: z.enum(['proposed', 'active']).default('proposed').describe("'proposed' for plan-mode claims; 'active' once approved and work begins."),
      for_agent_id: z.string().optional().describe('Claim on behalf of this agent ID (pre-claiming by orchestrator).'),
      thread_id: z.string().optional().describe('Direct thread ID link for this claim.'),
    },
    async ({ task, ttl_hours, status, for_agent_id, thread_id }) => {
      await autoSnapshot.onToolCall('context_claim')
      try {
        const claim = await ctx.store.claimTask(ctx.projectId, ctx.branchId, {
          task,
          agentId: for_agent_id ?? ctx.agentId,
          role: ctx.config.agentRole ?? 'solo',
          status,
          ttl: Math.round(ttl_hours * 3_600_000),
          threadId: thread_id,
        })
        return {
          content: [
            {
              type: 'text',
              text: `Claim recorded.\nID:     ${claim.id}\nTask:   ${claim.task}\nStatus: ${claim.status}\nTTL:    ${ttl_hours}h`,
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Error creating claim: ${message}` }],
          isError: true,
        }
      }
    },
  )

  // ── context_unclaim ──────────────────────────────────────────────────────────
  server.tool(
    'context_unclaim',
    'Release a previously claimed task. Use when abandoning a task without committing.',
    {
      claim_id: z.string().min(1).describe('ID of the claim to release.'),
    },
    async ({ claim_id }) => {
      await autoSnapshot.onToolCall('context_unclaim')
      try {
        await ctx.store.unclaimTask(claim_id)
        return {
          content: [{ type: 'text', text: `Claim released.\nID: ${claim_id}` }],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Error releasing claim: ${message}` }],
          isError: true,
        }
      }
    },
  )

  // ── context_merge ────────────────────────────────────────────────────────────
  server.tool(
    'context_merge',
    'Merge a source context branch into the current branch. Call this after merging a git branch.',
    {
      source_branch_id: z.string().min(1).describe('ID of the context branch to merge in.'),
    },
    async ({ source_branch_id }) => {
      await autoSnapshot.onToolCall('context_merge')
      try {
        const commit = await ctx.engine.merge(source_branch_id)
        return {
          content: [
            {
              type: 'text',
              text: `Merge commit recorded.\nID: ${commit.id}`,
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `Error merging branch: ${message}` }],
          isError: true,
        }
      }
    },
  )

  return server
}
