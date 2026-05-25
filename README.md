# ContextGit

Every time you start a new session with an AI coding agent, it starts from zero. It doesn't know what was built yesterday, what decisions were made, or what's left to do. You spend the first 10 minutes of every session re-explaining your project. ContextGit fixes this — it gives your agents a persistent memory layer that survives across sessions, branches, and machines.

## Install

```bash
npm install -g contextgit
cd your-project
contextgit init
```

> **Restart Claude Code** (or any MCP client) after running `init` for the MCP server to take effect.

That's it. `init` registers the MCP server, updates CLAUDE.md with session instructions, and installs Claude Code hooks. Start a new session — the agent calls `project_memory_load` automatically and picks up exactly where the last session left off.

## How it works

ContextGit stores structured context commits alongside your git history. Each commit captures what was done, what was decided, and what questions remain open.

```
Session 1: Agent builds auth module → saves context commit
Session 2: Agent loads snapshot → knows auth is done → starts on the next task
```

## What the agent sees

When an agent calls `project_memory_load`, it gets a snapshot like this:

```
## Git
Branch: feature/payments | HEAD: a1b2c3d4 | 47 commits

## Open Threads
- [FREE] Need to add rate limiting to payment endpoints  (opened 5/21/2026, interactive)
- [CLAIMED by studio-mcp-agent] Build invoice PDF generation  (opened 5/20/2026, interactive)
- [FREE] Decide on webhook retry strategy  (opened 5/19/2026, interactive)
(+3 stale, +1 expired-watch — call project_memory_threads to view)

## Recent Activity
- [2026-05-22T08:33:44Z] "Payment webhook handler done" by solo via claude-code (interactive)
- [2026-05-22T07:15:22Z] "Stripe SDK integration" by solo via claude-code (interactive)
- [2026-05-21T16:42:11Z] "Auth module complete" by solo via claude-code (interactive)

## Active Claims
- [CLAIMED by studio-mcp-agent] Build invoice PDF generation (claimed 2026-05-22T09:00:00Z)
```

The agent reads this and knows exactly where the project stands without you saying a word.

The `## Git` line is read live from git on every load — branch, HEAD, and commit count are never cached. The count hint under `## Open Threads` surfaces decayed entries that have been filtered from the default load (stale open threads + expired watch notes) so the agent can drill in with `project_memory_threads` if needed.

## MCP tools

These tools are exposed to the agent via MCP. The agent calls them as part of its normal workflow.

| Tool | What it does |
|------|-------------|
| `project_memory_load` | Load the full project snapshot — what was built, what's decided, live open threads, active claims, plus live git facts (HEAD, commit count). Call at session start. Optional `commit_window` (default 5) controls how many recent commits to include. |
| `project_memory_save` | Save a context commit — what you did, decisions made, open questions. Call at session end. Threads can be opened as `'open'` (the default — committed) or `'watch'` (a TTL-expiring reminder). |
| `project_memory_threads` | List threads with `filter='stale' \| 'expired-watch' \| 'live' \| 'all'`. Use to inspect what the default load filtered out — stale open threads and expired watch notes. |
| `project_memory_retrieve` | Windowed scroll-back. `tier='commits' \| 'trace'`, `window` (default 10), `offset` (default 0). The way to read past the load's recent-commits window or to read the trace tier. |
| `project_memory_trace` | Record a step-level reasoning note in the fine tier — decisions considered and rejected, dead ends. Pull-only: NEVER appears in `project_memory_load` output. |
| `context_search` | Semantic + full-text search over past context commits. |
| `project_task_claim` | Claim a task so other agents skip it. Claims auto-expire after 2 hours. |
| `project_task_unclaim` | Release a claimed task. |
| `project_memory_branch` | Create a context branch for experimental work. |
| `project_memory_merge` | Merge a context branch back into the parent. |

## CLI commands

```bash
contextgit init              # Initialize contextgit in current project
contextgit init --hooks      # Initialize with git hooks
contextgit commit "message"  # Write a context commit
contextgit status            # Show current project state
contextgit search "query"    # Search past commits
contextgit claim "task"      # Claim a task
contextgit unclaim <id>      # Release a claim
contextgit branch <name>     # Create a context branch
contextgit merge <id>        # Merge a context branch
contextgit serve             # Start the REST API server
```

## Architecture

Monorepo with strict dependency ordering:

```
packages/
  core/     → Types, snapshot formatter, embedding service, context engine
  store/    → Storage interface, LocalStore (SQLite), RemoteStore, SupabaseStore
  mcp/      → MCP server (stdio transport, launched by Claude Code)
  cli/      → CLI commands (oclif)
  api/      → REST API (Express)
```

**Local storage:** SQLite via better-sqlite3. One DB per project at `~/.contextgit/projects/<id>.db`.

**Remote storage:** Optional Supabase (Postgres + pgvector) for cross-machine sync and team use.

**Embeddings:** Local all-MiniLM-L6-v2 (384 dimensions, no API key needed) for semantic search.

## Configuration

Project config lives at `.contextgit/config.json`:

```json
{
  "project": "my-project",
  "projectId": "unique-id",
  "store": "local",
  "agentRole": "solo",
  "workflowType": "interactive",
  "autoSnapshot": false,
  "snapshotInterval": 10,
  "embeddingModel": "local"
}
```

## Current status

This is an early-stage tool. It works for solo developers using Claude Code across one or more machines. The core memory layer is solid — context commits, branches, threads, search, and snapshots all work.

## Known limitations

- No automatic context merge when git branches are merged (manual `project_memory_merge` required)
- No integration with external boards (Linear, Jira, GitHub Issues)
- Semantic search requires the embedding model to download on first use (~23MB)

## License

MIT
