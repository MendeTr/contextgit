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

Git records what changed at each commit. It does not record *why* — the decision behind the change, the approach you rejected, the question the change left open. That intent lives only in the head of whoever made the commit, and it evaporates when the session ends.

ContextGit stores that missing layer. Every context save is **bound to a git commit**. The commit is a snapshot of the code; the save bound to it is a snapshot of the intent. Together they let anyone — a teammate, or you in three weeks — pull the repo at any commit and reconstruct *both*: what the code was, and what the thinking was.

```
Session 1: Agent builds auth module, commits → saves intent bound to that commit
Session 2: Agent loads the snapshot → knows auth is done, knows why it was
           built that way → starts on the next task
```

The save's job is not to repeat the diff (git already has that). It carries what the diff cannot show: decisions, abandoned approaches, open questions, and the next concrete task.

## What the agent sees

When an agent calls `project_memory_load`, it gets a snapshot like this:

```
## Git
Branch: feature/payments | HEAD: a1b2c3d4 | 47 commits

## Plan
[a1b2c3] ▸ Phase 1 — Payments  [1/3 done]
  [d4e5f6] ✓ Stripe SDK integration
  [g7h8i9] → Webhook handler          ← next
  [j1k2l3] ○ Invoice PDF generation

## Open Threads
- [m4n5o6] [FREE] Need to add rate limiting to payment endpoints  (opened 5/21/2026, interactive)
- [p7q8r9] [FREE] Decide on webhook retry strategy  (opened 5/19/2026, interactive)
(+3 stale, +1 expired-watch — call project_memory_threads to view)

## Recent Activity
- [2026-05-22T08:33:44Z] "Payment webhook handler done" by solo via claude-code (interactive)
- [2026-05-22T07:15:22Z] "Stripe SDK integration" by solo via claude-code (interactive)
- [2026-05-21T16:42:11Z] "Auth module complete" by solo via claude-code (interactive)

## Active Claims
(none)
```

The agent reads this and knows exactly where the project stands without you saying a word.

The `## Git` line is read live from git on every load — branch, HEAD, and commit count are never cached. The `## Plan` section is the project's task hierarchy (plan → step → task); the first unfinished task is marked `← next`. The count hint under `## Open Threads` surfaces decayed entries filtered from the default load (stale open threads + expired watch notes) so the agent can drill in with `project_memory_threads` if needed.

Each line carries a short 6-character handle (`[a1b2c3]`) — used to close a thread or check off a task in one step, by handle or by subject.

## Two structures: threads and plans

ContextGit tracks two different things, and keeps them separate because they have opposite lifecycles:

- **Threads** are unresolved questions and things to watch — "decide on the retry strategy", "watch for the rate-limit edge case". A thread is resolved by being *answered*, and it **decays**: an open thread untouched for long enough is archived (recoverably), and a `watch` note expires on a short TTL. This keeps the load free of a graveyard of dead questions.
- **Plans** are intended work — a plan → step → task hierarchy you check off as you go. A plan node is resolved by being *done*. Planning **never decays**: a planned task does not become irrelevant because time passed; it is either pending or complete.

Threads keep the question list honest; plans keep the work list durable.

## MCP tools

These tools are exposed to the agent via MCP. The agent calls them as part of its normal workflow.

| Tool | What it does |
|------|-------------|
| `project_memory_load` | Load the full project snapshot — the plan, live open threads, recent activity, active claims, plus live git facts (HEAD, commit count). Call at session start. Optional `commit_window` (default 5) controls how many recent commits to include. |
| `project_memory_save` | Save a context commit, bound to the current git commit — decisions made, approaches abandoned, open questions. Call once per commit; the body carries intent, not a paraphrase of the diff. Can open threads, close threads (`closes_threads`), and check off tasks (`completes_tasks`) in the same call. Threads open as `'open'` (committed) or `'watch'` (a TTL-expiring reminder). |
| `project_memory_plan` | Create or update the plan hierarchy — lay out a whole plan → step → task tree, or update one node's status (`pending` / `in_progress` / `done`). |
| `project_memory_plans` | Read the plan tree. `--completed` shows finished plans; `--plan <handle>` drills into one. |
| `project_memory_threads` | List threads with `filter='stale' \| 'expired-watch' \| 'live' \| 'all' \| 'archived'`. Close a thread with `close=<handle>` or `close_subject=…`; restore an archived thread with `restore=<handle>`; bulk-restore everything archived as `stale-age` or `stale-distance` with `restore_all_stale=true` (recovery primitive for the decay calibration). |
| `project_memory_retrieve` | Windowed scroll-back. `tier='commits' \| 'trace'`, `window` (default 10), `offset` (default 0). The way to read past the load's recent-commits window or to read the trace tier. |
| `project_memory_trace` | Record a step-level reasoning note in the fine tier — decisions considered and rejected, dead ends. Pull-only: NEVER appears in `project_memory_load` output. |
| `context_search` | Semantic + full-text search over past context commits. |
| `project_task_claim` | Claim a task so other agents skip it. Claims auto-expire after 2 hours. |
| `project_task_unclaim` | Release a claimed task. |
| `project_memory_branch` | Create a context branch for experimental work. |
| `project_memory_merge` | Merge a context branch back into the parent. |

## CLI commands

Most day-to-day work happens through the MCP tools; the CLI is for setup, diagnostics, and operations the MCP server doesn't surface.

**Setup + diagnostics**

```bash
contextgit init              # Initialize ContextGit in this project (registers MCP, updates CLAUDE.md)
contextgit init --hooks      # Same, plus install git hooks to auto-capture context on every git commit
contextgit doctor            # Check ContextGit setup and diagnose issues
```

**Context operations**

```bash
contextgit commit "message"  # Record a context commit
contextgit context           # Print the current project context snapshot
contextgit log               # List context commits for the current branch
contextgit status            # Show current ContextGit status
contextgit search "query"    # Full-text search across context commits
```

**Branches + multi-agent claims**

```bash
contextgit branch <name>     # Create a new context branch
contextgit merge <id>        # Merge a context branch into the current branch
contextgit claim "task"      # Claim a task so other agents skip it (auto-expires after 2h)
contextgit unclaim <id>      # Release a previously claimed task
```

**Remote sync (Supabase or self-hosted API)**

```bash
contextgit set-remote        # Configure remote push/pull target
contextgit remote-show       # Show remote configuration and connection status
contextgit push              # Push local context commits to the remote
contextgit pull              # Pull context commits from the remote
```

**Self-hosted API server**

```bash
contextgit serve             # Start the ContextGit REST API server
contextgit keygen            # Generate an API key for securing the server
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

Early-stage but solid for solo developers using Claude Code across one or more machines. As of 0.2.0 the memory layer is structured into three tiers — a live roadmap, commit-bound context saves, and a pull-only reasoning trace — with a plan hierarchy, automatic thread decay, and windowed retrieval. See [CHANGELOG.md](./CHANGELOG.md) for the full 0.2.0 changes.

## Known limitations

- No automatic context merge when git branches are merged (manual `project_memory_merge` required)
- No integration with external boards (Linear, Jira, GitHub Issues)
- Semantic search requires the embedding model to download on first use (~23MB)

## License

MIT
