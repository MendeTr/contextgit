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
import { ContextEngine, EmbeddingService, SnapshotFormatter, ClaudeMdGenerator } from '@contextgit/core'
import { LocalStore, RemoteStore, SupabaseStore, resolveDbPath } from '@contextgit/store'
import { loadConfig } from './config.js'
import { captureGitFacts, captureGitMetadata } from './git-sync.js'
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
  claimsStore: ContextStore  // Supabase when configured, LocalStore otherwise
  projectId: string
  branchId: string
  config: ContextGitConfig
  agentId: string
}

async function bootstrap(): Promise<ServerContext> {
  const config = loadConfig()
  const { projectId, configDir } = config

  const store: ContextStore =
    config.store && config.store !== 'local'
      ? new RemoteStore(config.store)
      : new LocalStore(projectId, resolveDbPath(projectId, configDir))

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

  let claimsStore: ContextStore = store  // default: same as primary store

  if (config.supabaseUrl) {
    // Env var is preferred; fall back to config file for VS Code extension
    // env injection bug (https://github.com/anthropics/claude-code/issues/28090)
    const key = process.env['SUPABASE_SERVICE_KEY'] ?? config.supabaseServiceKey
    if (key) {
      claimsStore = new SupabaseStore(config.supabaseUrl, key)
    }
  }

  return { engine, store, claimsStore, projectId, branchId, config, agentId }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export async function createServer(): Promise<McpServer> {
  const ctx = await bootstrap()
  const autoSnapshot = new AutoSnapshotManager(ctx.engine, {
    interval: ctx.config.snapshotInterval ?? 10,
  })
  const claudeMdGen = new ClaudeMdGenerator()

  const INITIATION_RITUAL = `
---
## ContextGit: Fresh Setup Detected

No project context found. This is a fresh ContextGit setup. Run the context initiation ritual before doing any other work:

1. Ask the user for specs, PRDs, architecture docs, or design documents.
   These are the highest-value context. Check /docs, /documentation, /specs,
   and root-level markdown files. Ask the user directly — they may have
   documents outside the repo.

2. Scan the project structure automatically (no user input needed):
   README, package.json / Cargo.toml / pyproject.toml / go.mod, folder
   structure (2 levels deep), config files (.env.example, tsconfig.json,
   docker-compose.yml, CI configs), monorepo workspace config.

3. Analyze codebase patterns: entry points, naming conventions, architecture
   patterns in practice, test structure, error handling patterns.

4. Read recent git history: last 20-50 commit messages, active branches,
   most frequently changed files.

5. Synthesize everything into a structured project summary. Present it to
   the user for review. Ask: "What did I get wrong? What's missing?"

6. After the user validates, write a project_memory_save with the reviewed
   summary. Structure it as:
   - Project: name, purpose, current status
   - Architecture: tech stack, key patterns, module structure
   - Decisions: major technical decisions and their rationale
   - Conventions: naming, code style, testing approach
   - Current state: what's working, what's in progress, what's planned
   - Open threads: unresolved questions, known issues, pending decisions

   This is the foundation all future context builds on — make it thorough.

7. A CLAUDE.md file will be auto-generated in the project root after you
   call project_memory_save. It gives context to any tool that reads CLAUDE.md.

Do steps 1-4 before showing the summary. Do not skip the human review in step 5.
---`

  const server = new McpServer({
    name: 'contextgit',
    version: '0.0.1',
  })

  // ── project_memory_load (was: context_get) ──────────────────────────────────

  const handleProjectMemoryLoad = async ({
    format,
    agent_role,
    since,
    commit_window,
  }: {
    scope?: 'global' | 'branch'
    format?: 'agents-md' | 'json' | 'text'
    agent_role?: 'orchestrator' | 'dev' | 'test' | 'review' | 'background' | 'ci' | 'solo'
    since?: number
    commit_window?: number
  }) => {
    await autoSnapshot.onToolCall('context_get')
    try {
      if (since !== undefined) {
        const delta = await ctx.store.getContextDelta(ctx.projectId, ctx.branchId, since)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(delta, null, 2) }],
        }
      }
      const snapshotOptions: { agentRole?: typeof agent_role; commitWindow?: number } = {}
      if (agent_role) snapshotOptions.agentRole = agent_role
      if (commit_window != null) snapshotOptions.commitWindow = commit_window
      const snapshot = await ctx.store.getSessionSnapshot(
        ctx.projectId,
        ctx.branchId,
        Object.keys(snapshotOptions).length ? snapshotOptions : undefined,
      )

      // If claimsStore is different (Supabase configured), replace claims with live data
      if (ctx.claimsStore !== ctx.store) {
        snapshot.activeClaims = await ctx.claimsStore.listActiveClaims(ctx.projectId)
      }

      // Populate volatile git facts live at load time (02 DELTA spec line 89-93).
      // A fact git can answer is never cached in ContextGit; caching is how it goes stale.
      const gitFacts = await captureGitFacts(process.cwd())
      if (gitFacts) {
        snapshot.headSha = gitFacts.sha
        snapshot.commitCount = gitFacts.commitCount
        // branchName too — but only override if git's value disagrees, since the store may
        // know a logical "name" distinct from the raw git branch.
        if (!snapshot.branchName) snapshot.branchName = gitFacts.branch
      }

      const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')
      const output = snapshot.isInitiated ? text : text + INITIATION_RITUAL
      return {
        content: [{ type: 'text' as const, text: output }],
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
    commit_window: z.number().int().positive().optional().describe(
      'How many recent commits to include in the snapshot. Defaults to 5. Use project_memory_retrieve with tier="commits" to scroll past the window.',
    ),
  }

  server.tool(
    'project_memory_load',
    `Load persistent project memory and context.

Call this ONCE at the start of every session — before reading files, before asking questions, before doing any work. This tool returns the project's current state including: what was built, what was decided, active tasks, claimed work, recent decisions, and open questions.

Do not call again unless you need to check for changes made by other agents. After the first load, the context is in your conversation window — reloading wastes tokens and adds latency.

Skipping this call means you will duplicate work that was already done, re-explore approaches that already failed, and contradict decisions that were already made.`,
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

      // Generate/update CLAUDE.md in the project root
      let claudeMdNote = ''
      try {
        const snapshot = await ctx.store.getSessionSnapshot(ctx.projectId, ctx.branchId)
        const formatter = new SnapshotFormatter()
        const snapshotContent = formatter.format(snapshot, 'agents-md')
        const result = await claudeMdGen.write(process.cwd(), {
          projectName: ctx.config.project,
          content: snapshotContent,
          timestamp: commit.createdAt,
        })
        claudeMdNote = result.warning
          ? `\n\nWarning: ${result.warning}`
          : `\nCLAUDE.md updated (${result.file}).`
      } catch {
        // Non-fatal — CLAUDE.md generation failure does not fail the commit
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Commit recorded.\nID: ${commit.id}\nMessage: ${commit.message}${claudeMdNote}`,
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
    `Save project memory after completing significant work.

Call this when you make a git commit or complete significant work (finished a feature, made a key decision, resolved a problem). Pair context saves with git commits. Do not call after every user message or minor interaction.

The correct rhythm: load once at session start → work → save when you git commit → work → save when you git commit again.

If you skip this call at session end, the next session starts blind. Your work will be invisible to future agents.

FIRST COMMIT (context initiation): If this is the first context commit for the project, structure the content as a comprehensive project summary with these sections:
- Project: name, purpose, current status
- Architecture: tech stack, key patterns, module structure
- Decisions: major technical decisions and their rationale
- Conventions: naming, code style, testing approach
- Current state: what's working, what's in progress, what's planned
- Open threads: unresolved questions, known issues, pending decisions

A CLAUDE.md file will be auto-generated in the project root from the full session snapshot after this call.`,
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
      const claim = await ctx.claimsStore.claimTask(ctx.projectId, ctx.branchId, {
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
      await ctx.claimsStore.unclaimTask(claim_id)
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

  // ── project_memory_threads — review decayed threads (02 DELTA Step 3) ──────

  const handleProjectMemoryThreads = async ({ filter }: { filter?: 'all' | 'stale' | 'expired-watch' | 'live' }) => {
    try {
      const threads = await ctx.store.listOpenThreads(ctx.projectId)
      const selected = threads.filter((t) => {
        if (filter === 'stale') return t.stale === true
        if (filter === 'expired-watch') return t.expired === true
        if (filter === 'live') return !t.stale && !t.expired
        return true // 'all' or undefined
      })

      if (selected.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No threads match filter '${filter ?? 'all'}'.` }],
        }
      }

      const lines = selected.map((t) => {
        const flag = t.stale ? '[STALE]' : t.expired ? '[EXPIRED-WATCH]' : '[LIVE]'
        const kind = t.kind ?? 'open'
        const opened = t.createdAt.toISOString().slice(0, 10)
        const touched = t.lastTouchedCommit ? ` last_touched=${t.lastTouchedCommit.slice(0, 8)}` : ''
        return `- ${flag} (${kind}) ${t.description}  (opened ${opened}${touched})`
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: `${selected.length} thread(s) matching filter '${filter ?? 'all'}':\n${lines.join('\n')}`,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error listing threads: ${message}` }],
        isError: true,
      }
    }
  }

  const projectMemoryThreadsSchema = {
    filter: z
      .enum(['all', 'stale', 'expired-watch', 'live'])
      .default('all')
      .describe(
        "Filter the result. 'stale' = open threads past decay threshold; 'expired-watch' = watch notes past TTL; 'live' = neither (what the default load returns); 'all' = everything with decay flags annotated.",
      ),
  }

  // ── project_memory_trace — append a fine-tier note (02 DELTA Step 5) ──────

  const handleProjectMemoryTrace = async ({
    note,
    git_commit_sha,
  }: {
    note: string
    git_commit_sha?: string
  }) => {
    try {
      if (!ctx.store.appendTraceEntry) {
        return {
          content: [{ type: 'text' as const, text: `Trace tier is not supported by the current store backend.` }],
          isError: true,
        }
      }
      const entry = await ctx.store.appendTraceEntry({
        projectId: ctx.projectId,
        branchId: ctx.branchId,
        note,
        gitCommitSha: git_commit_sha,
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: `Trace entry recorded.\nID: ${entry.id}\n(Pull-only — call project_memory_retrieve with tier='trace' to review.)`,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error recording trace entry: ${message}` }],
        isError: true,
      }
    }
  }

  const projectMemoryTraceSchema = {
    note: z.string().min(1).describe(
      'A step-level reasoning note: a decision considered and rejected, a dead end, a "tried X, abandoned because Y". This is cold storage with an index — never auto-loaded, only retrieved on demand.',
    ),
    git_commit_sha: z.string().optional().describe(
      'Optional git commit SHA to associate the note with. Omit if the note stands alone.',
    ),
  }

  server.tool(
    'project_memory_trace',
    `Record a step-level trace note in the fine tier — decisions considered and rejected, dead ends, "tried X, abandoned because Y".

This is the ContextGit analog of GCC's log.md. The trace tier is NEVER auto-loaded — it's pull-only, retrieved via project_memory_retrieve with tier='trace'. Use this when a decision matters below milestone granularity but doesn't belong in a commit message.`,
    projectMemoryTraceSchema,
    handleProjectMemoryTrace,
  )

  // ── project_memory_retrieve — windowed scroll-back (02 DELTA Step 4) ──────

  const handleProjectMemoryRetrieve = async ({
    tier,
    window,
    offset,
  }: {
    tier: 'commits' | 'trace'
    window?: number
    offset?: number
  }) => {
    const limit = window ?? 10
    const off = offset ?? 0
    try {
      if (tier === 'commits') {
        const commits = await ctx.store.listCommits(ctx.branchId, { limit, offset: off })
        if (commits.length === 0) {
          return { content: [{ type: 'text' as const, text: `No commits at offset ${off}.` }] }
        }
        const lines = commits.map(
          (c) =>
            `- [${c.createdAt.toISOString()}] ${c.gitCommitSha ? c.gitCommitSha.slice(0, 8) + ' ' : ''}"${c.message}" by ${c.agentRole} via ${c.tool}`,
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `${commits.length} commit(s) at offset ${off} (window ${limit}):\n${lines.join('\n')}`,
            },
          ],
        }
      }

      // tier === 'trace'
      if (!ctx.store.listTraceEntries) {
        return {
          content: [{ type: 'text' as const, text: `Trace tier is not supported by the current store backend.` }],
          isError: true,
        }
      }
      const entries = await ctx.store.listTraceEntries(ctx.projectId, { limit, offset: off })
      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: `No trace entries at offset ${off}.` }] }
      }
      const lines = entries.map(
        (e) =>
          `- [${e.createdAt.toISOString()}] ${e.gitCommitSha ? e.gitCommitSha.slice(0, 8) + ' ' : ''}${e.note}`,
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: `${entries.length} trace entry/ies at offset ${off} (window ${limit}):\n${lines.join('\n')}`,
          },
        ],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error retrieving ${tier}: ${message}` }],
        isError: true,
      }
    }
  }

  const projectMemoryRetrieveSchema = {
    tier: z
      .enum(['commits', 'trace'])
      .describe(
        "'commits' scrolls back through branch commits beyond project_memory_load's window. 'trace' returns fine-tier step-level notes — NEVER auto-loaded; pull-only.",
      ),
    window: z.number().int().positive().default(10).describe('Page size. Default 10.'),
    offset: z.number().int().nonnegative().default(0).describe('Skip this many entries. Default 0 (most recent).'),
  }

  server.tool(
    'project_memory_retrieve',
    `Windowed scroll-back for commits and trace entries. Use when project_memory_load's recent-commits window isn't enough, or to read the trace tier (which is never included in the default load).

The trace tier holds step-level reasoning notes — dead ends, "tried X, abandoned because Y". Retrieving it explicitly is the whole point: it's cold storage with an index, never noise in the default context.`,
    projectMemoryRetrieveSchema,
    handleProjectMemoryRetrieve,
  )

  server.tool(
    'project_memory_threads',
    `Review open threads with their decay status. Use to inspect the stale and expired-watch threads that the default project_memory_load filters out.

When project_memory_load returns a "(+N stale, +M expired-watch ...)" hint, this is the tool that shows them. Stale open threads can be triaged (close them, or touch them by saving with the same subject). Expired watch notes are auto-dropped — they only show up here for awareness.`,
    projectMemoryThreadsSchema,
    handleProjectMemoryThreads,
  )

  return server
}
