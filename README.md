# ContextGit

Persistent memory for AI coding agents. Like git, but for context.

## The problem

Every time you start a new session with an AI coding agent, it starts from zero. It doesn't know what was built yesterday, what decisions were made, what approaches failed, or what's left to do. You spend the first 10 minutes of every session re-explaining your project.

ContextGit gives your agents a persistent memory layer that survives across sessions. When a new session starts, the agent loads the project snapshot and picks up exactly where the last session left off.

## How it works

ContextGit stores structured context commits alongside your git history. Each commit captures what was done, what was decided, and what questions remain open. The MCP server exposes this to Claude Code (or any MCP-compatible client) as tools the agent calls automatically.

```
Session 1: Agent builds auth module → saves context commit
Session 2: Agent loads snapshot → knows auth is done → starts on the next task
```

## Install

```bash
npm install -g contextgit
```

## Quick start

```bash
# 1. Initialize in your project
cd your-project
contextgit init

# 2. Add the MCP server to Claude Code
#    In ~/.claude.json, add to mcpServers:
#    "contextgit": {
#      "command": "node",
#      "args": ["<path-to>/contextgit/packages/mcp/dist/index.js"]
#    }

# 3. Start a Claude Code session — the agent will call project_memory_load
#    automatically and see your project's full context
```

## MCP tools

These tools are exposed to the agent via MCP. The agent calls them as part of its normal workflow.

| Tool | What it does |
|------|-------------|
| `project_memory_load` | Load the full project snapshot — what was built, what's decided, open threads, active claims. Call at session start. |
| `project_memory_save` | Save a context commit — what you did, decisions made, open questions. Call before ending a session. |
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

## What the agent sees

When an agent calls `project_memory_load`, it gets a snapshot like this:

```
## Project State
Auth module complete. API routes tested. Database schema finalized.

## Current Branch: Context: main
Implementing payment integration. Stripe SDK configured.

## Recent Activity
- [2026-03-20T08:33:44Z] "Payment webhook handler done" by solo via claude-code
- [2026-03-20T07:15:22Z] "Stripe SDK integration" by solo via claude-code
- [2026-03-19T16:42:11Z] "Auth module complete" by solo via claude-code

## Open Threads
- [FREE] Need to add rate limiting to payment endpoints
- [CLAIMED by studio-mcp-agent] Build invoice PDF generation
- [FREE] Decide on webhook retry strategy

## Active Claims
- "Build invoice PDF generation" claimed by studio-mcp-agent (2h TTL)
```

The agent reads this and knows exactly where the project stands without you saying a word.

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
