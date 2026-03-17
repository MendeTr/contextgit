// server.ts — ContextGit MCP Server
//
// Exposes tools to Claude and other MCP clients:
//   project_memory_load   — return a formatted project snapshot
//   project_memory_save   — persist a context commit
//   context_search        — full-text search over past commits
//   project_memory_branch — create a context branch
//   project_task_claim    — claim a task
//   project_task_unclaim  — release a claimed task
//   project_memory_merge  — merge a context branch
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

  // ── project_memory_load (was: context_get) ──────────────────────────────────

  const handleProjectMemoryLoad = async ({
    format,
    agent_role,
    since,
  }: {
    scope?: 'global' | 'branch'
    format?: 'agents-md' | 'json' | 'text'
    agent_role?: 'orchestrator' | 'dev' | 'test' | 'review' | 'background' | 'ci' | 'solo'
    since?: number
  }) => {
    await autoSnapshot.onToolCall('context_get')
    try {
      if (since !== undefined) {
        const delta = await ctx.store.getContextDelta(ctx.projectId, ctx.branchId, since)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(delta, null, 2) }],
        }
      }
      const snapshot = await ctx.store.getSessionSnapshot(
        ctx.projectId,
        ctx.branchId,
        agent_role ? { agentRole: agent_role } : undefined,
      )
      const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')
      return {
        content: [{ type: 'text' as const, text }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error retrieving snapshot: ${message}` }],
        isError: true,
      }
    }
  }

  const projectMemoryLoadSchema = {
    scope: z.enum(['global', 'branch']).default('global').describe(
      "'global' returns the full project summary + branch state. 'branch' scopes to the current branch.",
    ),
    format: z.enum(['agents-md', 'json', 'text']).default('agents-md').describe(
      'Output format. agents-md is optimized for agent consumption.',
    ),
    agent_role: z.enum(['orchestrator', 'dev', 'test', 'review', 'background', 'ci', 'solo']).optional().describe(
      'Filter recentCommits to this agent role only. Omit to return commits from all roles.',
    ),
    since: z.number().optional().describe(
      'Unix timestamp ms. When provided, returns only commits and thread changes after this time. Use for orchestrator polling loops.',
    ),
  }

  server.tool(
    'project_memory_load',
    `Load persistent project memory and context.

IMPORTANT: Call this tool at the START of every session — before reading files, before asking questions, before doing any work. This tool returns the project's current state including: what was built, what was decided, active tasks, claimed work, recent decisions, and open questions.

Skipping this call means you will duplicate work that was already done, re-explore approaches that already failed, and contradict decisions that were already made.

If you are a subagent working on a specific task, call this tool first to understand the full project context before starting your assigned work.`,
    projectMemoryLoadSchema,
    handleProjectMemoryLoad,
  )

  // Backward-compat alias — remove in 0.0.6
  server.tool(
    'context_get',
    'DEPRECATED: Use project_memory_load instead. Retrieve the current project snapshot.',
    projectMemoryLoadSchema,
    async (params) => {
      console.warn('[contextgit] context_get is deprecated. Use project_memory_load.')
      return handleProjectMemoryLoad(params)
    },
  )

  // ── project_memory_save (was: context_commit) ───────────────────────────────

  const handleProjectMemorySave = async ({
    message,
    content,
    open_threads,
    close_thread_ids,
  }: {
    message: string
    content: string
    open_threads?: string[]
    close_thread_ids?: string[]
  }) => {
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
            type: 'text' as const,
            text: `Commit recorded.\nID: ${commit.id}\nMessage: ${commit.message}`,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error recording commit: ${message}` }],
        isError: true,
      }
    }
  }

  const projectMemorySaveSchema = {
    message: z.string().min(1).describe('Short summary of what was accomplished (1–2 sentences).'),
    content: z.string().min(1).describe('Detailed description of the work done, decisions made, and current state.'),
    open_threads: z.array(z.string()).optional().describe(
      'New open questions or blockers to track (each max 200 chars).',
    ),
    close_thread_ids: z.array(z.string()).optional().describe(
      'IDs of threads to close.',
    ),
  }

  server.tool(
    'project_memory_save',
    `Save project memory after completing work.

IMPORTANT: Call this tool BEFORE ending your session or moving to the next task. This saves what you did, what you decided, and what questions remain — so the next session (or the next agent) can pick up where you left off.

If you skip this call, the next session starts blind. Your work will be invisible to future agents. They will re-do what you already did.

Call after: completing a feature, making an architectural decision, resolving a bug, closing a thread, or finishing any meaningful unit of work. Small decisions compound — save them.`,
    projectMemorySaveSchema,
    handleProjectMemorySave,
  )

  // Backward-compat alias — remove in 0.0.6
  server.tool(
    'context_commit',
    'DEPRECATED: Use project_memory_save instead. Persist a context commit recording significant work.',
    projectMemorySaveSchema,
    async (params) => {
      console.warn('[contextgit] context_commit is deprecated. Use project_memory_save.')
      return handleProjectMemorySave(params)
    },
  )

  // ── context_search (unchanged) ──────────────────────────────────────────────
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

  // ── project_memory_branch (was: context_branch) ─────────────────────────────

  const handleProjectMemoryBranch = async ({
    git_branch,
    name,
  }: {
    git_branch: string
    name?: string
  }) => {
    await autoSnapshot.onToolCall('context_branch')
    try {
      const branch = await ctx.engine.branch(git_branch, name)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Branch created.\nID:   ${branch.id}\nName: ${branch.name}`,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error creating branch: ${message}` }],
        isError: true,
      }
    }
  }

  const projectMemoryBranchSchema = {
    git_branch: z.string().min(1).describe('The git branch name to track.'),
    name: z.string().optional().describe('Optional display name for the context branch.'),
  }

  server.tool(
    'project_memory_branch',
    `Create an isolated context branch before risky or experimental work.

Call before: trying an approach you're not sure will work, refactoring across many files, or exploring an architectural alternative. If the exploration fails, the main context is untouched.

The cost of not branching is re-explaining to the next session why you abandoned an approach you spent an hour on.`,
    projectMemoryBranchSchema,
    handleProjectMemoryBranch,
  )

  // Backward-compat alias — remove in 0.0.6
  server.tool(
    'context_branch',
    'DEPRECATED: Use project_memory_branch instead. Create a new context branch tracking a git branch.',
    projectMemoryBranchSchema,
    async (params) => {
      console.warn('[contextgit] context_branch is deprecated. Use project_memory_branch.')
      return handleProjectMemoryBranch(params)
    },
  )

  // ── project_task_claim (was: context_claim) ─────────────────────────────────

  const handleProjectTaskClaim = async ({
    task,
    ttl_hours,
    status,
    for_agent_id,
    thread_id,
  }: {
    task: string
    ttl_hours?: number
    status?: 'proposed' | 'active'
    for_agent_id?: string
    thread_id?: string
  }) => {
    await autoSnapshot.onToolCall('context_claim')
    try {
      const claim = await ctx.store.claimTask(ctx.projectId, ctx.branchId, {
        task,
        agentId: for_agent_id ?? ctx.agentId,
        role: ctx.config.agentRole ?? 'solo',
        status: status ?? 'proposed',
        ttl: Math.round((ttl_hours ?? 2) * 3_600_000),
        threadId: thread_id,
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: `Claim recorded.\nID:     ${claim.id}\nTask:   ${claim.task}\nStatus: ${claim.status}\nTTL:    ${ttl_hours ?? 2}h`,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error creating claim: ${message}` }],
        isError: true,
      }
    }
  }

  const projectTaskClaimSchema = {
    task: z.string().min(1).describe('Short description of the task being claimed (e.g. "build auth module").'),
    ttl_hours: z.number().positive().default(2).describe('Time-to-live in hours before the claim auto-expires. Default: 2.'),
    status: z.enum(['proposed', 'active']).default('proposed').describe("'proposed' for plan-mode claims; 'active' once approved and work begins."),
    for_agent_id: z.string().optional().describe('Claim on behalf of this agent ID (pre-claiming by orchestrator).'),
    thread_id: z.string().optional().describe('Direct thread ID link for this claim.'),
  }

  server.tool(
    'project_task_claim',
    `Claim a task to prevent other agents from working on it simultaneously.

Call before starting work on any task visible in the project memory. Other agents will see your claim and skip this task. Claims auto-expire after 2 hours.

If you skip claiming, another agent may start the same task, producing duplicate and conflicting work.`,
    projectTaskClaimSchema,
    handleProjectTaskClaim,
  )

  // Backward-compat alias — remove in 0.0.6
  server.tool(
    'context_claim',
    'DEPRECATED: Use project_task_claim instead. Claim a task to prevent other agents from picking it up simultaneously.',
    projectTaskClaimSchema,
    async (params) => {
      console.warn('[contextgit] context_claim is deprecated. Use project_task_claim.')
      return handleProjectTaskClaim(params)
    },
  )

  // ── project_task_unclaim (was: context_unclaim) ──────────────────────────────

  const handleProjectTaskUnclaim = async ({ claim_id }: { claim_id: string }) => {
    await autoSnapshot.onToolCall('context_unclaim')
    try {
      await ctx.store.unclaimTask(claim_id)
      return {
        content: [{ type: 'text' as const, text: `Claim released.\nID: ${claim_id}` }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error releasing claim: ${message}` }],
        isError: true,
      }
    }
  }

  const projectTaskUnclaimSchema = {
    claim_id: z.string().min(1).describe('ID of the claim to release.'),
  }

  server.tool(
    'project_task_unclaim',
    `Release a previously claimed task so other agents can work on it.

Call when: abandoning a task you claimed (won't be completing it), or when re-assigning work. If you claimed a task and won't complete it, release it — otherwise it blocks other agents until the 2-hour TTL expires.`,
    projectTaskUnclaimSchema,
    handleProjectTaskUnclaim,
  )

  // Backward-compat alias — remove in 0.0.6
  server.tool(
    'context_unclaim',
    'DEPRECATED: Use project_task_unclaim instead. Release a previously claimed task.',
    projectTaskUnclaimSchema,
    async (params) => {
      console.warn('[contextgit] context_unclaim is deprecated. Use project_task_unclaim.')
      return handleProjectTaskUnclaim(params)
    },
  )

  // ── project_memory_merge (was: context_merge) ───────────────────────────────

  const handleProjectMemoryMerge = async ({ source_branch_id }: { source_branch_id: string }) => {
    await autoSnapshot.onToolCall('context_merge')
    try {
      const commit = await ctx.engine.merge(source_branch_id)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Merge commit recorded.\nID: ${commit.id}`,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error merging branch: ${message}` }],
        isError: true,
      }
    }
  }

  const projectMemoryMergeSchema = {
    source_branch_id: z.string().min(1).describe('ID of the context branch to merge in.'),
  }

  server.tool(
    'project_memory_merge',
    `Merge a context branch back into the parent branch after successful exploration.

Call after a context branch experiment succeeds and you want to preserve the findings in the main project memory.`,
    projectMemoryMergeSchema,
    handleProjectMemoryMerge,
  )

  // Backward-compat alias — remove in 0.0.6
  server.tool(
    'context_merge',
    'DEPRECATED: Use project_memory_merge instead. Merge a source context branch into the current branch.',
    projectMemoryMergeSchema,
    async (params) => {
      console.warn('[contextgit] context_merge is deprecated. Use project_memory_merge.')
      return handleProjectMemoryMerge(params)
    },
  )

  return server
}
