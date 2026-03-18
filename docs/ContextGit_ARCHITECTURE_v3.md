# ContextGit — Architecture Document

**Version 3.1 | March 2026**
**Status: Internal — Co-founder Review**

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Context Engine](#3-context-engine)
4. [Session Start Contract](#4-session-start-contract)
5. [Workflow Integrations](#5-workflow-integrations)
6. [Multi-Agent Model](#6-multi-agent-model)
7. [Git Branch Synchronisation](#7-git-branch-synchronisation)
8. [Persistence Layer](#8-persistence-layer)
9. [Integration Interfaces](#9-integration-interfaces)
10. [API Layer](#10-api-layer)
11. [Web Platform](#11-web-platform)
12. [Data Model](#12-data-model)
13. [Authentication and Multi-tenancy](#13-authentication-and-multi-tenancy)
14. [Deployment Architecture](#14-deployment-architecture)
15. [Phase Build Plan](#15-phase-build-plan)
16. [Open Questions](#16-open-questions)

---

## 1. System Overview

ContextGit is the memory layer for AI agent workflows. It provides persistent, structured, shared context to any agent — regardless of how that agent is invoked.

There are four user-facing surfaces:

**MCP Server** — For interactive tools (Claude Code, Cursor, Codex). Runs locally. Auto-detects git branches, installs hooks, handles background snapshotting.

**REST API** — For automated pipelines, CI agents, custom frameworks (LangChain, CrewAI). Full feature parity with the MCP server. No MCP required.

**CLI** — For Ralph-style loops, shell scripts, and automation. `contextgit snapshot` generates AGENTS.md. `contextgit commit` checkpoints from the command line. Composable with any bash workflow.

**Web Platform** — A GitHub-like frontend where developers browse, search, publish, and clone agent context repositories.

All four surfaces share a single Context Engine and dual-mode Persistence Layer.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  HOW AGENTS CONNECT                                                      │
│                                                                          │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────┐  │
│  │  MCP Server     │  │  REST API        │  │  CLI                   │  │
│  │  (interactive   │  │  (pipelines,     │  │  (Ralph loops,         │  │
│  │   tools)        │  │   CI, custom)    │  │   shell scripts, CI)   │  │
│  └────────┬────────┘  └────────┬─────────┘  └───────────┬────────────┘  │
└───────────┼────────────────────┼───────────────────────┼───────────────┘
            │                   │                        │
            └───────────────────┴────────────┬───────────┘
                                             │
┌────────────────────────────────────────────┴───────────────────────────┐
│  CONTEXTHUB CORE                                                        │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Context Engine  (based on GCC / Aline)                          │   │
│  │  COMMIT | BRANCH | MERGE | CONTEXT                               │   │
│  │  Rolling summaries | Open threads | Session contract             │   │
│  │  AGENTS.md generator | Snapshot export                           │   │
│  └──────────────────────────────┬───────────────────────────────────┘   │
│                                 │                                        │
│              ┌──────────────────┴────────────────────┐                  │
│              │         Storage Interface              │                  │
│              └──────────────┬───────────────┬─────────┘                  │
│                             │               │                            │
│              ┌──────────────┴──────┐  ┌─────┴──────────────┐            │
│              │  LocalStore         │  │  RemoteStore        │            │
│              │  SQLite + sqlite-vec│  │  Postgres + pgvector│            │
│              │  Solo dev, offline  │  │  Team, hosted, CI   │            │
│              └─────────────────────┘  └────────────────────┘            │
└─────────────────────────────────────────────────────────────────────────┘
            │
┌───────────┴────────────────────────────────────────────────────────────┐
│  ContextGit Web Platform                                               │
│  Explore repos | Branch viewer | Diff view | Threads | Search          │
│  Clone | Fork | Star | Team dashboards | Live agent activity           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Context Engine

The context engine is a port of GCC/Aline's core logic, decoupled from any storage backend or integration interface. It is the only layer that understands the semantics of agent context.

### 3.1 Commands

**COMMIT(message, content, tags, threads)**

Creates a context checkpoint:
1. Generates a new rolling summary by compressing new content with the previous summary
2. Processes thread updates — marks open threads closed, creates new open threads
3. Stores the commit: id, parent_id, branch_id, agent_id, role, tool, workflow_type, message, content, summary, threads, embedding, commit_type
4. Updates branch HEAD
5. Auto-releases any active claims for this agent on this branch
6. Returns commit id

**BRANCH(name, from_commit_id?)**

Creates an isolated context workspace branching from HEAD. The new branch inherits the parent's rolling summary — the agent arrives already oriented.

**MERGE(branch_id, summary)**

Integrates a branch into its parent:
1. Creates a merge commit with pointers to both parent commits
2. Generates synthesis summary combining both trajectories
3. Carries forward unresolved open threads from the merged branch
4. Updates parent branch HEAD, marks source branch merged

**CONTEXT(scope, options)**

Retrieves history at the requested granularity:

| Scope | Returns | Max tokens |
|-------|---------|-----------|
| `global` | Full session start snapshot | ~600 |
| `branch` | Current branch summary | ~500 |
| `search` | Semantic search across all branches | ~800 |
| `commit` | Specific commit full content | variable |
| `raw` | Paginated raw execution trace | paginated |

**SNAPSHOT(format)**

New command. Generates a formatted export of the session start contract for use outside MCP contexts:

| Format | Output | Use case |
|--------|--------|---------|
| `agents-md` | Markdown AGENTS.md file | Ralph loops, `contextgit snapshot > AGENTS.md` |
| `json` | Structured JSON | CI pipelines, custom integrations |
| `text` | Plain text | Shell scripts, logging |

### 3.2 Rolling Summary Algorithm

Every COMMIT generates a new bounded summary:

```
new_summary = compress(previous_summary + new_content)
max_tokens = 2000 (configurable)
```

**Phase 1 (rule-based):** Structured extraction — most recent decisions weighted highest, older details compressed to single-line entries, contradicted decisions removed.

**Phase 2+ (LLM-based):** Lightweight LLM call with specialised summarisation prompt. Better quality, small latency cost. Configurable.

**Versioned summaries:** Every COMMIT stores both raw content and the generated summary. The summary history is append-only. If quality degrades, summaries can be regenerated from raw commits.

### 3.3 Open Threads

Open threads are a first-class data structure, explicitly tagged on commits:

```typescript
interface Thread {
  id: string
  projectId: string
  branchId: string
  description: string              // max 200 chars, must be scannable
  status: 'open' | 'closed'
  openedInCommit: string
  closedInCommit?: string
  closedNote?: string
  workflowType?: string            // which workflow opened this thread
  updatedAt: number                // updated on status change (for polling)
}
```

On COMMIT:
```typescript
threads: {
  open: ["sliding window vs fixed window not yet decided"],
  close: [{ id: "thread_abc", note: "chose Upstash Redis, see commit" }]
}
```

Open threads are immune to summary compression and always surfaced at session start.

### 3.4 Workflow Attribution

Every commit carries workflow metadata for traceability across the team dashboard:

```typescript
interface CommitWorkflowMeta {
  workflowType: 'interactive' | 'ralph-loop' | 'ci' | 'background' | 'custom'
  tool: string            // 'claude-code' | 'cursor' | 'codex' | 'github-actions' | etc.
  agentRole: AgentRole
  loopIteration?: number  // for Ralph loops
  ciRunId?: string        // for CI pipelines
  pipelineName?: string   // for custom frameworks
}
```

This data powers the team dashboard — you can see not just who committed context but what kind of workflow it came from.

---

## 4. Session Start Contract

Every agent, in every workflow, calls `context_get scope=global` at startup and receives the same compact structured snapshot. Always under 600 tokens. Regardless of project age.

### 4.1 Snapshot Structure

```
=== PROJECT STATE ===
<rolling summary — max 2000 tokens>
Distilled reality of the project: stack, conventions, key decisions,
completed modules. Built from actual development, not the PRD.

=== CURRENT BRANCH: <branch-name> ===
<branch summary — max 500 tokens>
What this line of work has done and where it stands.

=== LAST 3 COMMITS ===
[<timestamp>] "<message>"  by <agent-role> via <tool> (<workflow-type>)
[<timestamp>] "<message>"  by <agent-role> via <tool> (<workflow-type>)
[<timestamp>] "<message>"  by <agent-role> via <tool> (<workflow-type>)

=== OPEN THREADS ===
[CLAIMED by dev-agent-1] <description>   (opened <date>, <branch>)
[FREE] <description>   (opened <date>, <branch>)
[FREE] <description>   (opened <date>, <branch>)

=== ACTIVE CLAIMS ===
<agent-id>: "<task>"  (claimed <time-ago>, TTL 2h)
```

**Total budget: ~400–600 tokens. Flat cost regardless of project age.**

The `[CLAIMED]` / `[FREE]` prefix on open threads is the primary collision-prevention signal. Any agent reading the snapshot immediately sees what is taken and what is available without parsing a separate section.

### 4.2 AGENTS.md Export

For Ralph loops and shell-script workflows, the snapshot can be exported as AGENTS.md:

```bash
contextgit snapshot --format=agents-md > AGENTS.md
```

Generates a Ralph-compatible AGENTS.md with the same information structured for the Ralph prompt pattern:

```markdown
## Project State
Next.js 14, Tailwind, JWT RS256 auth, Stripe webhooks.
Middleware pattern for all auth. API routes under /api/v1.

## Current Branch: feature/rate-limiting
Implementing rate limiting. Redis chosen over in-memory.
Upstash client installed. Middleware skeleton in place.

## Recent Activity
- [2h ago] Upstash client configured (dev, Claude Code)
- [5h ago] Decided against in-memory store (dev, Ralph loop)
- [yesterday] Rate limit middleware skeleton created (dev, Ralph loop)

## Open Threads
- [CLAIMED by dev-agent-1] Sliding window vs fixed window — not yet decided
- [FREE] Test coverage for rate limiter — pending

## Build & Run
<operational notes from AGENTS.md commits>
```

This is the bridge between ContextGit and Ralph. Ralph loops auto-generate AGENTS.md from accumulated context rather than maintaining it manually. It is never stale.

### 4.3 Why the Snapshot Stays Flat at Scale

A project with 300 commits across 20 branches still produces a ~500 token snapshot because:

- Project summary is a compressed distillation, not a log (max 2000 tokens)
- Branch summary covers only the current branch (max 500 tokens)
- Only the last 3 commits are included in full
- Open threads are short single-line descriptions

The other 297 commits exist in the database, searchable on demand:

```
context_get scope=search query="how we handled token refresh"
→ 2–3 most relevant commits, ~800 tokens, loaded only when needed
```

---

## 5. Workflow Integrations

ContextGit is workflow-agnostic. The same context engine and storage layer serves every major AI agent pattern through the appropriate integration interface.

### 5.1 Interactive Sessions (MCP)

Claude Code, Cursor, Codex, and any MCP-compatible tool. The MCP server runs locally alongside the developer's tool. Zero workflow change required.

```
Developer opens Claude Code
  → MCP server starts, detects git branch
  → Agent calls context_get scope=global (via system prompt injection)
  → Receives compact snapshot, oriented in ~500 tokens
  → Works normally
  → context_commit called at milestones (agent-initiated or background snapshot)
  → Session closes

Next session
  → Same lean snapshot, updated with last session's commits
  → Agent picks up exactly where the last session left off
```

**Agent cooperation:** Background snapshotting every N tool calls (default 10) as a fallback for agents that don't call `context_commit` reliably. System prompt fragment instructs the agent when to commit. Both are belt-and-suspenders.

### 5.2 Ralph / Autonomous Loop (CLI)

Ralph's `while true` loop already solves the execution problem. ContextGit adds the memory layer without changing the loop mechanics.

```bash
#!/bin/bash
while true; do
  # 1. Generate AGENTS.md from ContextGit snapshot (replaces manual maintenance)
  contextgit snapshot --format=agents-md > AGENTS.md

  # 2. Run Ralph iteration (reads AGENTS.md + IMPLEMENTATION_PLAN.md as always)
  cat PROMPT.md | claude -p --dangerously-skip-permissions \
    --output-format=stream-json \
    --model opus \
    --verbose

  # 3. Checkpoint context after iteration completes
  contextgit commit \
    --message "Loop iteration: $(git log -1 --pretty=%s)" \
    --workflow-type ralph-loop \
    --loop-iteration $ITERATION

  # 4. Push code as normal
  git push origin "$(git branch --show-current)"

  ITERATION=$((ITERATION + 1))
done
```

**What ContextGit adds to Ralph without changing it:**

- `AGENTS.md` is generated from accumulated context — never manually maintained, never stale
- Architectural decisions, failed approaches, and conventions discovered in one loop iteration persist across restarts
- When a second developer runs the same loop on the same project, their `AGENTS.md` reflects everything the first developer's loops discovered
- Web UI provides visibility into what the loop has been doing — branch tree, commit history, open threads — without reading raw git logs

**What stays unchanged:** `IMPLEMENTATION_PLAN.md` is entirely Ralph's domain. ContextGit does not touch it. Clean separation: Ralph owns task tracking, ContextGit owns institutional memory.

### 5.3 CI / GitHub Actions (REST API)

```yaml
# .github/workflows/ai-agent.yml
name: AI Context Agent

on: [pull_request]

jobs:
  agent-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install ContextGit CLI
        run: npm install -g contextgit

      - name: Pull context snapshot
        run: |
          contextgit snapshot \
            --project ${{ vars.CONTEXTHUB_PROJECT_ID }} \
            --store ${{ secrets.CONTEXTHUB_REMOTE_URL }} \
            --format agents-md > AGENTS.md
        env:
          CONTEXTHUB_API_KEY: ${{ secrets.CONTEXTHUB_API_KEY }}

      - name: Run review agent
        run: |
          cat prompts/pr-review.md | claude -p \
            --dangerously-skip-permissions \
            --model sonnet

      - name: Commit agent findings to context
        run: |
          contextgit commit \
            --message "CI review: PR #${{ github.event.number }} findings" \
            --workflow-type ci \
            --ci-run-id ${{ github.run_id }} \
            --store ${{ secrets.CONTEXTHUB_REMOTE_URL }}
        env:
          CONTEXTHUB_API_KEY: ${{ secrets.CONTEXTHUB_API_KEY }}
```

Every CI run builds on what previous runs discovered. A flaky test pattern found in one run is committed to context and surfaced to the next agent that touches the same code area.

### 5.4 Multi-Agent Orchestration (MCP or REST)

Sub-agents call `context_get scope=global` on startup. No manual briefing. Each agent writes its findings directly to the shared store, attributed by role and workflow type.

See Section 6 for full detail.

### 5.5 Custom Agent Frameworks (REST API)

LangChain, CrewAI, custom pipelines — any Python or Node.js orchestration framework calls the REST API directly:

```python
import requests

CONTEXTHUB_URL = "https://app.contextgit.dev"
PROJECT_ID = "uuid"
API_KEY = os.environ["CONTEXTHUB_API_KEY"]
headers = {"Authorization": f"Bearer {API_KEY}"}

# Session start — get compact snapshot
snapshot = requests.get(
    f"{CONTEXTHUB_URL}/v1/projects/{PROJECT_ID}/snapshot",
    headers=headers
).json()

# Inject into agent system prompt
system_context = snapshot["formatted"]["agents_md"]

# ... run pipeline with context ...

# Commit findings
requests.post(
    f"{CONTEXTHUB_URL}/v1/projects/{PROJECT_ID}/commits",
    json={
        "message": "Pipeline run complete",
        "content": pipeline_findings,
        "workflowType": "custom",
        "pipelineName": "langchain-review",
        "threads": {"open": new_open_threads, "close": resolved_threads}
    },
    headers=headers
)
```

### 5.6 Background Agents

Background agents (Cursor background, autonomous overnight runs) connect via MCP. Their commits are attributed `workflow_type: background`. When the developer opens an interactive session the next morning, the snapshot includes everything the background agent discovered overnight — the same compact format, updated.

---

## 6. Multi-Agent Model

### 6.1 Agent Roles

Every agent is registered with a role:

| Role | Description | Typical workflow |
|------|-------------|-----------------|
| `orchestrator` | Coordinates agents, writes synthesis commits | Any |
| `dev` | Implements features | Interactive, Ralph, custom |
| `test` | Writes and runs tests, commits findings | Interactive, CI, Ralph |
| `review` | Reviews PRs and architecture | CI, interactive |
| `background` | Autonomous overnight or async work | Background agents |
| `ci` | CI pipeline agents | GitHub Actions, CI |
| `solo` | Default for single-developer setups | Interactive |

Role is set in MCP config or passed as a CLI flag. Stored on every commit for attribution and filtering.

### 6.2 Write Model

Every agent writes directly to the shared store. Every commit is attributed to its author agent, role, tool, and workflow type. The orchestrator additionally writes synthesis commits.

Append-only commits mean concurrent writes from multiple agents across multiple workflows do not conflict.

### 6.3 Agent ID

Every agent has a stable, predictable ID. The MCP server derives its ID from hostname by default:

```typescript
const agentId = process.env.CONTEXTGIT_AGENT_ID
  ?? `${hostname}-mcp-claude-code-interactive`
```

The `CONTEXTGIT_AGENT_ID` environment variable takes priority. Orchestrators set this variable when spawning sub-agent MCP processes to give each agent a stable, known ID:

| Agent | ID convention |
|-------|---------------|
| Orchestrator | `{hostname}-orchestrator` |
| Dev agent 1 | `{hostname}-dev-1` |
| Dev agent 2 | `{hostname}-dev-2` |
| Test agent 1 | `{hostname}-test-1` |

### 6.4 Coordination: Claims

Claims are the collision-prevention primitive. Before starting any task, an agent claims it. The claim is visible to all other agents in the snapshot.

```sql
CREATE TABLE claims (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  branch_id    TEXT NOT NULL REFERENCES branches(id),
  task         TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  role         TEXT NOT NULL,
  claimed_at   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'proposed',
  ttl          INTEGER NOT NULL,     -- milliseconds, default 7200000 (2h)
  released_at  INTEGER,
  thread_id    TEXT REFERENCES threads(id)  -- optional direct thread linkage
)
```

**Claim lifecycle:** `proposed → active → released`

- Claim is created with status `proposed`
- Agent starts work → status becomes `active`
- Agent calls `context_commit` → claim auto-releases (branch-scoped)
- Agent calls `contextgit unclaim <id>` → immediate manual release
- TTL expires (2h) → claim treated as released in all queries (filtered in SQL)

**Auto-release on commit** prevents orphaned claims. If an agent crashes without committing, the 2h TTL ensures the task becomes available again without manual intervention.

### 6.5 Coordination: Pre-claiming by Orchestrator

The orchestrator can claim tasks on behalf of agents before spawning them. This eliminates the race window between agent start and first `context_get`:

```typescript
// context_claim MCP tool — for_agent_id param
for_agent_id: z.string().optional().describe(
  'If set, creates the claim on behalf of this agent ID instead of the calling agent. '
  + 'Used by orchestrators to pre-assign work before spawning sub-agents.'
)
```

When `for_agent_id` is set, `claim.agentId` is set to the target agent ID, not the orchestrator's ID.

### 6.6 Coordination: Orchestrator Polling

The orchestrator polls for changes without re-reading the full snapshot using the `since` parameter on `context_get`:

```typescript
// context_get MCP tool — since param
since: z.number().optional().describe(
  'Unix timestamp ms. When provided, returns only commits and thread changes '
  + 'after this time. Omits projectSummary and branchSummary. '
  + 'Use this for orchestrator polling loops.'
)
```

**When `since` is provided, response shape:**

```typescript
{
  newCommits: Commit[]        // commits created after `since` on this branch
  openedThreads: Thread[]     // threads opened after `since`
  closedThreads: Thread[]     // threads closed after `since`
  activeClaims: Claim[]       // always full list
  checkedAt: number           // timestamp to use as next `since` value
}
```

The orchestrator passes `checkedAt` as the next `since` value, creating an efficient polling loop with no duplicate reads.

### 6.7 Multi-Agent Coordination Workflow (Model A)

ContextGit is the **memory and coordination layer**. The orchestration framework (Claude Code subagents, claude-flow, etc.) is the **task router**. They do not overlap.

```
Orchestrator starts
  → context_get: sees open threads [A, B, C] — all [FREE]
  → pre-claims thread A for dev-agent-1  (for_agent_id="{hostname}-dev-1")
  → pre-claims thread B for dev-agent-2  (for_agent_id="{hostname}-dev-2")
  → pre-claims thread C for dev-agent-3  (for_agent_id="{hostname}-dev-3")
  → spawns dev-agent-1 with CONTEXTGIT_AGENT_ID="{hostname}-dev-1"
  → spawns dev-agent-2 with CONTEXTGIT_AGENT_ID="{hostname}-dev-2"
  → spawns dev-agent-3 with CONTEXTGIT_AGENT_ID="{hostname}-dev-3"
  → begins polling: context_get(since=now) every 30s

Dev agent 1 starts
  → context_get: sees [CLAIMED by {hostname}-dev-1] thread A — starts work
  → context_commit: claim auto-releases

Orchestrator polling detects new commit from dev-agent-1
  → spawns test-agent-1 ("test the work in commit XYZ, thread A")
  → test-agent-1 context_get → sees dev commit → tests → context_commit findings

Orchestrator detects test pass → closes thread A
```

No agent is manually briefed. No context is duplicated. The orchestrator reacts to commits, not to a fixed schedule.

### 6.8 Multi-Agent + Multi-Workflow Example

```
feature/payments — 3 agents, 2 workflow types

Ralph loop (overnight):
  contextgit snapshot > AGENTS.md
  → loop runs, dev agent implements Stripe integration
  → contextgit commit role=dev workflow=ralph-loop
    "Stripe webhook endpoint created at /api/webhooks/stripe"

CI pipeline (triggered by push):
  → test agent: context snapshot pulled, aware of dev agent's commit
  → runs tests, finds edge case
  → contextgit commit role=ci workflow=ci ci-run-id=abc123
    "24 tests passing. Duplicate webhook on network retry."
    threads.open: ["network retry duplicate webhook — needs idempotency fix"]

Developer opens interactive session (morning):
  → context_get scope=global
  → snapshot shows: Stripe implemented (Ralph loop), test edge case found (CI)
  → open thread: [FREE] duplicate webhook issue
  → developer's Claude Code agent claims thread, picks it up immediately
  → context_commit role=dev workflow=interactive
    "Idempotency key includes retry count. Duplicate issue resolved."
    threads.close: ["network retry duplicate webhook — needs idempotency fix"]
```

No agent is manually briefed. No context is lost between workflow switches. The institutional memory accumulates across all of them.

---

## 7. Git Branch Synchronisation

Context branches mirror git branches automatically. No manual management required.

### 7.1 Branch Detection

The MCP server and CLI both read the current git branch:

```typescript
import simpleGit from 'simple-git'

const git = simpleGit(process.cwd())
const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
// → "feature/payments"
// Auto-scope all commits to the matching context branch
// Create the context branch if it doesn't exist yet
```

### 7.2 Git Hooks

`contextgit init` offers to install three git hooks:

**post-checkout** — fires when developer switches branches, updates active context branch.

**post-merge** — fires when git merge completes, triggers context MERGE to match.

**post-commit** (optional) — fires on every git commit, creates lightweight auto context commit tagged to the git SHA.

### 7.3 Branch Lifecycle

```
git checkout -b feature/payments
  → context branch created: feature/payments
  → inherits main branch summary as starting point

[development across multiple sessions, workflows, agents]

git merge feature/payments (or PR merged)
  → post-merge hook fires
  → context branch merges into main
  → synthesis summary generated
  → unresolved open threads carried forward
  → context branch status → merged

git branch -d feature/payments
  → context branch remains (history is permanent)
  → accessible via web UI and search forever
```

---

## 8. Persistence Layer

### 8.1 Storage Interface

```typescript
interface ContextStore {
  // Commits
  createCommit(commit: CommitInput): Promise<Commit>
  getCommit(id: string): Promise<Commit | null>
  listCommits(branchId: string, pagination: Pagination): Promise<Commit[]>
  getSessionSnapshot(projectId: string, branchId: string, options?: { agentRole?: AgentRole }): Promise<SessionSnapshot>
  getFormattedSnapshot(projectId: string, branchId: string, format: SnapshotFormat): Promise<string>

  // Branches
  createBranch(branch: BranchInput): Promise<Branch>
  getBranch(id: string): Promise<Branch | null>
  getBranchByGitName(projectId: string, gitBranch: string): Promise<Branch | null>
  listBranches(projectId: string): Promise<Branch[]>
  updateBranchHead(branchId: string, commitId: string): Promise<void>
  mergeBranch(sourceBranchId: string, targetBranchId: string, summary: string): Promise<Commit>

  // Open threads
  listOpenThreads(projectId: string): Promise<Thread[]>
  listOpenThreadsByBranch(branchId: string): Promise<Thread[]>

  // Claims
  claimTask(projectId: string, branchId: string, input: ClaimInput): Promise<Claim>
  unclaimTask(claimId: string): Promise<void>
  listActiveClaims(projectId: string): Promise<Claim[]>

  // Polling
  listCommitsSince(branchId: string, since: number): Promise<Commit[]>
  listThreadChangesSince(projectId: string, since: number): Promise<Thread[]>

  // Search
  semanticSearch(query: string, projectId: string, limit: number): Promise<SearchResult[]>
  fullTextSearch(query: string, projectId: string): Promise<SearchResult[]>

  // Agents and projects
  upsertAgent(agent: AgentInput): Promise<Agent>
  listAgents(projectId: string): Promise<Agent[]>
  getProject(id: string): Promise<Project | null>
  createProject(project: ProjectInput): Promise<Project>
}
```

### 8.2 LocalStore (SQLite + sqlite-vec)

Used when `store: local`. Ships inside the npx binary. Zero external dependencies.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  github_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  git_branch TEXT NOT NULL,
  github_pr_url TEXT,
  parent_branch_id TEXT REFERENCES branches(id),
  head_commit_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  merged_at INTEGER
);

CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  parent_id TEXT REFERENCES commits(id),
  merge_source_branch_id TEXT REFERENCES branches(id),
  agent_id TEXT NOT NULL,
  agent_role TEXT NOT NULL DEFAULT 'solo',
  tool TEXT NOT NULL,
  workflow_type TEXT NOT NULL DEFAULT 'interactive',
  loop_iteration INTEGER,
  ci_run_id TEXT,
  pipeline_name TEXT,
  message TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  commit_type TEXT NOT NULL DEFAULT 'manual',
  git_commit_sha TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  workflow_type TEXT,
  opened_in_commit TEXT NOT NULL REFERENCES commits(id),
  closed_in_commit TEXT REFERENCES commits(id),
  closed_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER   -- updated on status change; used for since-based polling
);

CREATE TABLE claims (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  branch_id    TEXT NOT NULL REFERENCES branches(id),
  task         TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  role         TEXT NOT NULL,
  claimed_at   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'proposed',
  ttl          INTEGER NOT NULL,
  released_at  INTEGER,
  thread_id    TEXT REFERENCES threads(id)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL DEFAULT 'solo',
  tool TEXT NOT NULL,
  workflow_type TEXT NOT NULL DEFAULT 'interactive',
  display_name TEXT,
  total_commits INTEGER DEFAULT 0,
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE commit_embeddings USING vec0(
  commit_id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);

CREATE INDEX idx_commits_branch ON commits(branch_id, created_at DESC);
CREATE INDEX idx_commits_workflow ON commits(project_id, workflow_type, created_at DESC);
CREATE INDEX idx_threads_project_status ON threads(project_id, status);
CREATE INDEX idx_branches_git ON branches(project_id, git_branch);
CREATE INDEX idx_claims_project_status ON claims(project_id, status, released_at);
```

### 8.3 SupabaseStore (Postgres + pgvector)

`SupabaseStore` implements `ContextStore` directly via `@supabase/supabase-js`. It is a push/pull sync target — LocalStore remains the live primary store. Push/pull syncs LocalStore ↔ SupabaseStore.

Schema: `packages/store/src/supabase/schema.sql`. Applied once via the Supabase SQL editor.

**Key schema decisions:**

| Decision | Rationale |
|----------|-----------|
| TEXT primary keys (nanoid) | ID parity with LocalStore — no translation on push/pull |
| TIMESTAMPTZ | Postgres best practice; `Date` objects at interface boundary |
| HNSW embedding index | Works with incremental inserts; IVFFlat requires training data |
| `project_id` on `commits` | Denormalized for query efficiency; not mapped to `Commit` domain type |
| `fts` generated tsvector column | Full-text search via GIN index; kept in sync automatically |
| No orgs/users/RLS | Phase 3 Step 3 — service role key used until auth ships |

**Core tables:** `projects`, `branches`, `commits`, `threads`, `claims`, `agents`

**RPC functions:**
- `match_commits(query_embedding, project_id, match_count)` — semantic search via pgvector cosine similarity
- `list_active_claims(p_project_id)` — active claims with TTL filter in SQL

**Configuration:**
- `config.supabaseUrl` — written by `contextgit set-remote supabase <url>`
- `SUPABASE_SERVICE_KEY` env var — service role key, never written to disk

**Push/pull priority:** `--remote` flag (HTTP) > `config.supabaseUrl` (Supabase) > `config.remote` (HTTP)

### 8.4 getSessionSnapshot Implementation

```typescript
async getSessionSnapshot(
  projectId: string,
  branchId: string,
  options?: { agentRole?: AgentRole }
): Promise<SessionSnapshot> {
  const headCommit = await this.getHeadCommit(branchId)
  const branch = await this.getBranch(branchId)

  const projectSummary = branch.parentBranchId
    ? await this.getHeadCommitSummary(branch.parentBranchId)
    : headCommit.summary

  // Role-filtered or default commit list
  const recentCommits = options?.agentRole
    ? await this.listCommitsByRole(branchId, options.agentRole, 3)
    : await this.listCommits(branchId, { limit: 3 })

  const openThreads = await this.listOpenThreads(projectId)
  const activeClaims = await this.listActiveClaims(projectId)

  // Inline claim status on threads
  const threadsWithClaimStatus = openThreads.map(t => ({
    ...t,
    claimStatus: resolveClaimStatus(t, activeClaims)
  }))

  return {
    projectSummary,
    branchName: branch.name,
    branchSummary: headCommit.summary,
    recentCommits,
    openThreads: threadsWithClaimStatus,
    activeClaims,
  }
}
```

---

## 9. Integration Interfaces

### 9.1 MCP Server

**Installation:**

```bash
npx contextgit init
```

Generates `.contextgit/config.json`:

```json
{
  "project": "my-project",
  "store": "local",
  "agentRole": "solo",
  "workflowType": "interactive",
  "autoSnapshot": true,
  "snapshotInterval": 10,
  "installGitHooks": true,
  "embeddingModel": "local"
}
```

**MCP Tools exposed to agent** *(current — Delta 3, v0.0.10+)*:

- `project_memory_load` — session start snapshot. Optional `agent_role` filter. Optional `since` timestamp for orchestrator polling.
- `project_memory_save` — checkpoint with message, content, threads. Auto-releases active claims on commit.
- `project_memory_branch` — create a context branch before risky/experimental work
- `project_memory_merge` — merge a context branch back into parent
- `project_task_claim` — claim a task before starting. Optional `for_agent_id` for orchestrator pre-claiming. Optional `thread_id` for direct thread linkage.
- `project_task_unclaim` — release a claim manually
- `context_search` — semantic + full-text search over past commits (name unchanged)

> **⚠️ SUPERSEDED (v0.0.9 and earlier):** Old tool names below are still registered as backward-compat aliases (emit deprecation warning). Will be removed in v0.0.6.
>
> - ~~`context_get`~~ → use `project_memory_load`
> - ~~`context_commit`~~ → use `project_memory_save`
> - ~~`context_branch`~~ → use `project_memory_branch`
> - ~~`context_merge`~~ → use `project_memory_merge`
> - ~~`context_claim`~~ → use `project_task_claim`
> - ~~`context_unclaim`~~ → use `project_task_unclaim`

**Background snapshotting:** MCP server counts tool calls and auto-commits every N calls (default 10). Tagged `commit_type: auto`, displayed differently in the web UI, can be promoted to manual.

**Session enforcement — three-layer model** *(Delta 3, replaces single system prompt fragment)*:

| Layer | Mechanism | Reaches |
|---|---|---|
| 1 (universal) | MCP tool descriptions — self-enforcing, IMPORTANT-prefixed | All agents including subagents |
| 2 (interactive) | `CLAUDE.md` fragment written by `contextgit init` | Interactive sessions, project-aware agents |
| 3 (interactive) | Project skills in `.claude/skills/` written by `contextgit init` | Interactive Claude Code sessions |

`contextgit init` writes:
- `CLAUDE.md` fragment (idempotent via `<!-- contextgit:start -->` sentinel)
- `.claude/skills/context-commit/SKILL.md` — guides `project_memory_save` discipline
- `.claude/skills/context-branch/SKILL.md` — guides `project_memory_branch` discipline

> **⚠️ SUPERSEDED (v0.0.9 and earlier):** Single system prompt fragment approach below. Replaced by three-layer model above. Still written to `.contextgit/system-prompt.md` for reference.
>
> ```
> You have access to a persistent context system. Use it consistently.
>
> ALWAYS at session start: call context_get scope="global". This returns a compact
> snapshot (~500 tokens) of project state, branch, recent commits, and open threads.
> Read it before doing anything else.
>
> BEFORE starting any task: call context_claim to claim it. This prevents other agents
> from starting the same work simultaneously. Claims auto-release on context_commit.
>
> DURING work, call context_commit when you: complete a feature or fix, make an
> architectural decision, discover a failed approach, open or close a thread.
>
> WHEN exploring uncertain approaches: context_branch first. Abandon or merge.
>
> FOR specific past decisions: context_get scope=search. Do not load raw history.
>
> The snapshot is NOT the PRD. It is distilled reality. Treat it as ground truth.
> ```

### 9.2 CLI

```bash
# Installation (alongside MCP server, same package)
npm install -g contextgit
# or without global install
npx contextgit <command>

# Core commands
contextgit init                          # init project, generate config, install hooks
contextgit snapshot                      # print snapshot to stdout (text format)
contextgit snapshot --format agents-md   # print AGENTS.md formatted snapshot
contextgit snapshot --format json        # print JSON snapshot
contextgit commit -m "..."              # create a context commit
contextgit commit -m "..." \
  --workflow-type ralph-loop \
  --loop-iteration 42                    # commit with workflow metadata
contextgit claim "<task>"               # claim a task before starting
contextgit unclaim <claim-id>           # release a claim manually
contextgit search "query"               # semantic search, prints results
contextgit branch create <n>            # create context branch
contextgit branch merge <n>             # merge context branch
contextgit push                          # push local context to remote store
contextgit pull                          # pull remote context to local store
contextgit status                        # show current branch, head commit, open threads
contextgit doctor                        # check config, DB, hooks, API key, MCP registration

# Remote store flags (override config)
contextgit snapshot --store <url> --api-key <key>
contextgit commit --store <url> --api-key <key>
```

### 9.3 REST API

Full feature parity with the MCP server. Used by CI pipelines, custom frameworks, and any non-MCP agent.

See Section 10 for endpoint reference.

---

## 10. API Layer

### 10.1 REST Endpoints

**Context operations (MCP server, CLI, pipelines)**
```
POST   /v1/projects/:id/commits
GET    /v1/projects/:id/commits/:commitId
GET    /v1/projects/:id/snapshot                    ← session start contract (JSON)
GET    /v1/projects/:id/snapshot?format=agents-md   ← AGENTS.md format
GET    /v1/projects/:id/snapshot?since=<timestamp>  ← orchestrator polling (delta only)
POST   /v1/projects/:id/branches
PATCH  /v1/projects/:id/branches/:branchId
POST   /v1/projects/:id/branches/:branchId/merge
POST   /v1/projects/:id/search
GET    /v1/projects/:id/threads?status=open
GET    /v1/projects/:id/agents
POST   /v1/projects/:id/claims
DELETE /v1/projects/:id/claims/:claimId
GET    /v1/projects/:id/claims?status=active
```

**Platform operations (web frontend)**
```
GET    /v1/projects                           ← explore public repos
GET    /v1/projects/:org/:slug                ← project home
POST   /v1/projects/:org/:slug/star
POST   /v1/projects/:org/:slug/fork
GET    /v1/projects/:org/:slug/clone-bundle   ← download context bundle
GET    /v1/projects/:org/:slug/commits        ← paginated history
GET    /v1/projects/:org/:slug/branches       ← branch tree
```

### 10.2 WebSocket Events

```typescript
WS /v1/projects/:id/live

// Server emits — now includes workflow_type for dashboard filtering
{ type: "agent_commit",  agentId, role, workflowType, commitId, message, branchName, timestamp }
{ type: "agent_branch",  agentId, role, workflowType, branchId, name, timestamp }
{ type: "agent_merge",   agentId, role, workflowType, branchId, timestamp }
{ type: "thread_opened", threadId, description, workflowType, branchName, agentId, timestamp }
{ type: "thread_closed", threadId, note, workflowType, agentId, timestamp }
{ type: "agent_active",  agentId, role, tool, workflowType, branchName, timestamp }
{ type: "loop_iteration", loopIteration, agentId, branchName, timestamp }  // Ralph loops
{ type: "ci_run",        ciRunId, pipelineName, status, branchName, timestamp }  // CI
{ type: "claim_created", claimId, agentId, task, threadId, timestamp }
{ type: "claim_released", claimId, agentId, timestamp }
```

### 10.3 Clone Bundle

```
GET /v1/projects/:org/:slug/clone-bundle

Response: application/zip
  context-bundle.zip
  ├── manifest.json       ← schema version, project metadata, branch list
  ├── branches.json       ← full branch tree with metadata
  ├── commits.ndjson      ← all commits with workflow attribution
  ├── threads.json        ← all threads (open and closed)
  └── embeddings.bin      ← pre-computed embeddings (optional)
```

---

## 11. Web Platform

### 11.1 Routes

```
/                               ← Explore: public repos, trending, search
/explore                        ← Browse all public repos
/:org/:project                  ← Project home
/:org/:project/commits          ← Commit history with diff view
/:org/:project/branches         ← Branch tree (D3.js)
/:org/:project/threads          ← Open and closed threads
/:org/:project/search           ← Semantic + full-text search
/:org/:project/agents           ← Agent registry and attribution
/:org/:project/workflows        ← Workflow activity breakdown
/dashboard                      ← Team live dashboard
/dashboard/:project             ← Project-level live view with workflow filter
```

### 11.2 Key Components

**Explore page** — Public context repos, stars, recent activity, tag search. The network-effect surface.

**Project home** — Description, linked GitHub repo, star count, clone command. Workflow activity summary showing which workflow types are most active on this project.

**Branch tree** — D3.js visualisation. Nodes coloured by agent role. Shape indicates workflow type (circle=interactive, diamond=ralph-loop, square=ci). Hovering shows commit message, author, and workflow. Clicking opens diff view.

**Commit diff view** — Previous vs new summary, full content, thread operations, full attribution: agent, role, tool, workflow type, loop iteration or CI run ID if applicable.

**Threads panel** — Open and closed threads across all workflows. Filterable by branch, workflow type, agent, date. Closed threads show resolution note and linked commit. Open threads show `[CLAIMED by X]` or `[FREE]` status.

**Workflow breakdown page (`/workflows`)** — New in v3. Shows contribution breakdown by workflow type: how many commits came from interactive sessions vs Ralph loops vs CI vs background agents. Timeline of activity. Helps teams understand how their agents are actually being used.

**Team dashboard (live)** — Real-time activity across all workflows via WebSocket. Filter by workflow type: see only Ralph loop commits, or only CI commits, or everything. The "war room" view for teams running parallel workflows.

**Semantic search** — Full-text and vector similarity. Filterable by branch, agent role, workflow type, date, tags, thread status.

### 11.3 Frontend Stack

```
React 18 + TypeScript
React Router v6
Tailwind CSS
D3.js                ← branch tree, knowledge map, workflow timeline
TanStack Query       ← data fetching and caching
Zustand              ← client state
WebSocket (native)   ← live dashboard
```

---

## 12. Data Model

### 12.1 Core Entities and Relationships

```
Organization  1──* User
Organization  1──* Project
Project       1──* Branch
Project       1──* Thread
Project       1──* Agent
Project       1──* Claim
Branch        1──* Commit
Branch        0──1 Branch    (parent)
Branch        0──1 GitPR     (linked PR URL)
Commit        0──1 Commit    (parent)
Commit        0──1 Branch    (merge source)
Commit        1──* Thread    (opened or closed in this commit)
Commit        *──1 WorkflowMeta  (type, loop iteration, CI run ID)
Claim         *──1 Thread    (optional direct linkage via thread_id)
Agent         *──1 User
Agent         *──1 Role
Agent         *──1 WorkflowType
Agent         1──* Commit
Agent         1──* Claim
```

### 12.2 Key Field Constraints

- Rolling summaries: max 2000 tokens (enforced before write)
- Branch summaries: max 500 tokens
- Thread descriptions: max 200 characters
- Commit content: unbounded
- Embeddings: 384 dimensions (all-MiniLM-L6-v2, configurable)
- Workflow type: enum `interactive | ralph-loop | ci | background | custom`
- Claim TTL: default 7200000ms (2 hours); TTL filter applied in SQL

---

## 13. Authentication and Multi-tenancy

**Phase 1 (local):** No auth. LocalStore at `~/.contextgit/`.

**Phase 2 (remote):** Email + password via Supabase Auth. GitHub OAuth. API keys for programmatic access (MCP server, CLI, REST). API keys scoped by role — read-only keys for CI agents, read-write for dev agents.

**Phase 3 (team tier):** SSO via SAML/OIDC. Per-workflow API keys — CI pipelines get a CI-scoped key, Ralph loops get a dev-scoped key. Audit log captures every commit with full workflow attribution.

**Multi-tenancy:** Row-level security in Postgres. Every query scoped to authenticated org. Public project reads bypass RLS. Writes always require authentication.

---

## 14. Deployment Architecture

### 14.1 Phase 1 — Local Only

```
Developer machine:
  npx contextgit  (MCP server + CLI, ~50MB with SQLite bundled)
  └── ~/.contextgit/projects/<project-id>.db
```

No cloud. No accounts. Single npm package.

### 14.2 Phase 2 and 3 — Hosted

```
Supabase (managed Postgres):
  - Core database with workflow attribution columns
  - pgvector (semantic search)
  - Auth (email, GitHub OAuth, SSO)
  - Realtime (WebSocket for live dashboard)
  - Row-level security (multi-tenancy)

Vercel (web platform):
  - Next.js frontend
  - API routes
  - CDN for static assets
  - Edge functions for clone bundle generation

Enterprise (self-hosted):
  Docker Compose:
    - Node.js API server
    - Postgres + pgvector
    - React frontend (nginx)
    - Optional: local embedding model server
```

### 14.3 Cost Profile (Bootstrapped)

Supabase free tier covers all development and early beta. Upgrade to Supabase Pro ($25/month) when team tier customers onboard. Vercel free tier covers the web platform until significant traffic.

**Total infrastructure cost until first paying customer: $0.**

---

## 15. Phase Build Plan

### Phase 1 — Weeks 1–4: Core Engine + All Three Interfaces

| Week | Deliverable |
|------|-------------|
| 1 | Fork GCC/Aline. Storage interface + LocalStore. COMMIT and CONTEXT working. Workflow attribution columns in schema from day one. |
| 2 | BRANCH and MERGE. Rolling summary (rule-based). Open threads. SNAPSHOT command with agents-md format. |
| 3 | MCP server. CLI. Git branch detection + hook installer. Background snapshotting. |
| 4 | REST API (core endpoints). Vector embeddings. Package as npx binary. Validate on real project across two workflows: interactive + Ralph loop. |

**Phase 1 gate (all three must pass):**
- Does `context_get scope=global` return a snapshot that orients an agent without reading any other documentation?
- Does `contextgit snapshot --format agents-md` generate a useful AGENTS.md in a real Ralph loop?
- Does the REST API snapshot endpoint work correctly for a simulated CI pipeline call?

### Phase 2 — Weeks 5–8: Team, Multi-Agent, CI (shipped)

| Period | Deliverable |
|--------|-------------|
| Weeks 5–6 | CLI completeness: branch, merge, search, status, push, pull, keygen, doctor, claim, unclaim. Production API fix (`/v1/store` mounted). Git hooks (`git-sync.ts`). |
| Week 7 | Delta 1 — Coordination primitives: claims table, `project_task_claim`/`project_task_unclaim` MCP tools, active claims in snapshot. |
| Weeks 7–8 | Delta 2 — Multi-agent protocol: `getContextDelta`, `since` on `project_memory_load`, `for_agent_id` pre-claiming, inline `[CLAIMED]`/`[FREE]` formatter. |
| Week 8 | Delta 3 — Session contract enforcement: MCP tools renamed `project_memory_*`, CLAUDE.md fragment + skills written by `init`. |

**Phase 2 gate (all passed):** Three workflow types contributing to the same project context store. Orchestrator can pre-claim, poll, and spawn agents without collision.

### Phase 3 — Team + Web Platform

| Step | Deliverable |
|------|-------------|
| 1 | SupabaseStore: core tables, `SupabaseStore` implementing `ContextStore`, push/pull against Supabase, `set-remote supabase` command. |
| 2 | Web platform: React app, branch tree (D3.js), commit diff view, threads panel, search UI. Read-only, service-key-backed. |
| 3 | Auth + multi-tenancy: Supabase Auth, GitHub OAuth, API keys, RLS. Required before publishing opens. |
| 4 | Public repos: publish, clone, fork, star. Auth gates publishing; reading stays open. |
| 5 | Live team dashboard: WebSocket, workflow filter. |

---

## 16. Open Questions

**Rolling summary quality in Phase 1** — Rule-based compression may produce poor summaries on complex projects. Is it good enough to validate the concept in week 4, or do we need an LLM call from the start? If the Phase 1 gate fails because of summary quality, this is the first fix.

**Embedding model** — Local all-MiniLM-L6-v2 (384 dim, no API key, ~23MB) vs OpenAI text-embedding-3-small (better quality, requires key). Start local, make it configurable.

**Ralph loop commit noise** — Each loop iteration creates one context commit. A 200-iteration run creates 200 commits. Should Ralph-loop commits have a different retention/display policy than interactive commits? Recommendation: show by default but allow filtering by workflow type in the UI.

**CI commit granularity** — A CI pipeline that runs 50 times a day would create 50 context commits per day. Most of these may be low signal. Should CI commits be filtered unless they open a new thread or match a significance threshold? Recommendation: CI commits visible but deprioritised in the snapshot's "last 3 commits" display — only surfaced if they opened an open thread.

**Auto-commit noise (interactive sessions)** — At 10 tool calls per auto-snapshot, an active session generates 20-30 auto commits per hour. Should auto commits be hidden by default in the UI?

**Thread granularity** — Per-project threads are simpler and always visible. Per-branch threads are more organised but risk siloing unresolved questions. Recommendation: per-project with branch attribution.

**Public platform timing** — Invite-only for first 30 days to ensure quality of early public repos. Open after.

**Claim string matching vs thread_id linkage** — The inline `[CLAIMED]` formatter should prefer `thread_id` direct linkage over case-insensitive string matching. String matching is a fallback for legacy claims only. Orchestrators should always pass `thread_id` when pre-claiming to ensure reliable linkage.

---

*Update this document as architectural decisions are made and validated. Every open question above should be resolved before the relevant phase begins.*
