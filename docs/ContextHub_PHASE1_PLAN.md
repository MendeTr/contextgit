# ContextHub — Phase 1 Implementation Plan

## Context
ContextHub is a persistent memory layer for AI agent workflows, solving the "amnesia problem" where agents lose context across sessions. The repo is greenfield (only `Docs/` exists). We're planning Phase 1 (Weeks 1–4): the core engine, LocalStore, MCP server, CLI, and REST API.

**Key decisions:**
- Build from scratch (GCC/Aline = inspiration for COMMIT/BRANCH/MERGE/CONTEXT/SNAPSHOT concepts only)
- MCP server is the priority integration (dogfood during development)
- LLM-based rolling summaries from day 1 (`claude-haiku-4-5-20251001`)
- LocalStore only (SQLite + sqlite-vec) — no RemoteStore in Phase 1

---

## Monorepo Structure

```
contexthub/
├── package.json              ← pnpm workspaces root
├── tsconfig.base.json
├── .contexthub/config.json   ← bootstrapped on itself during dev
├── packages/
│   ├── core/                 ← Context Engine (pure business logic, no I/O)
│   │   └── src/
│   │       ├── types.ts      ← ALL shared interfaces (define first, everything derives from this)
│   │       ├── engine.ts     ← ContextEngine: COMMIT, BRANCH, MERGE, CONTEXT, SNAPSHOT
│   │       ├── summarizer.ts ← RollingSummarizer: Claude Haiku + graceful fallback
│   │       ├── snapshot.ts   ← SnapshotFormatter: agents-md / json / text
│   │       ├── threads.ts    ← ThreadManager: immune-to-compression guarantee
│   │       └── embeddings.ts ← EmbeddingService: @xenova/transformers all-MiniLM-L6-v2
│   ├── store/                ← Storage abstraction + LocalStore
│   │   └── src/
│   │       ├── interface.ts  ← ContextStore interface (the contract)
│   │       └── local/
│   │           ├── index.ts  ← LocalStore: better-sqlite3 + sqlite-vec
│   │           ├── schema.ts ← DDL + indexes
│   │           ├── migrations.ts
│   │           └── queries.ts
│   ├── mcp/                  ← MCP Server
│   │   └── src/
│   │       ├── server.ts
│   │       ├── tools/        ← context_get, context_commit, context_branch, context_merge
│   │       ├── git-sync.ts   ← branch detection + hook installer
│   │       └── auto-snapshot.ts ← tool-call counter, fires at N=10
│   ├── cli/                  ← oclif CLI
│   │   └── src/commands/     ← init, snapshot, commit, branch, search, status
│   └── api/                  ← Express REST API
│       └── src/routes/       ← commits, snapshot, branches, search, threads
└── scripts/
    ├── build.sh
    └── validate-e2e.sh
```

**Dependency graph (strict, no circular deps):**
- `core` → `@anthropic-ai/sdk`, `@xenova/transformers`, `nanoid`
- `store` → `core` (types only), `better-sqlite3`, `sqlite-vec`
- `mcp` → `core`, `store`, `@modelcontextprotocol/sdk`, `simple-git`
- `cli` → `core`, `store`, `@oclif/core`
- `api` → `core`, `store`, `express`

---

## Core Types (define in `packages/core/src/types.ts` before any implementation)

```typescript
type AgentRole = 'orchestrator' | 'dev' | 'test' | 'review' | 'background' | 'ci' | 'solo'
type WorkflowType = 'interactive' | 'ralph-loop' | 'ci' | 'background' | 'custom'
type CommitType = 'manual' | 'auto' | 'merge' | 'branch-init'
type BranchStatus = 'active' | 'merged' | 'abandoned'
type SnapshotFormat = 'agents-md' | 'json' | 'text'
type ContextScope = 'global' | 'branch' | 'search' | 'commit' | 'raw'

// Key entities: Project, Branch, Commit, Thread, Agent
// Commit carries full workflow attribution: agentRole, tool, workflowType, loopIteration, ciRunId
// SessionSnapshot: projectSummary + branchSummary + recentCommits[3] + openThreads[]
```

---

## Week-by-Week Plan

### Week 1 — Foundation (Days 1–7)
**Goal:** Monorepo scaffolded, COMMIT + CONTEXT returning real data from SQLite.

1. **Days 1–2:** Scaffold monorepo (pnpm workspaces). Write `types.ts` in full. Write `store/interface.ts` in full. Set up Vitest.
2. **Days 3–4:** `LocalStore` — DDL (`schema.ts`), migration runner, `better-sqlite3` implementation. Use sync API wrapped in `Promise.resolve()` at the interface boundary (fine for LocalStore; `ContextStore` interface already returns Promises so Phase 2 `RemoteStore` swap is clean — keep that discipline). IDs via `nanoid()`. DB path: `~/.contexthub/projects/<projectId>.db`.
3. **Days 5–7:** `ContextEngine.commit()` (with placeholder string truncation for summary), `ContextEngine.context('global')`, `SnapshotFormatter` (all 3 formats), `ThreadManager`.

**Week 1 validation:** Create project → 2 commits (one with open thread) → `context('global')` → snapshot output shows thread + both commits.

---

### Week 2 — Rolling Summaries, BRANCH, MERGE, SNAPSHOT (Days 8–14)
**Goal:** Full context engine with LLM summaries and branch operations.

1. **Days 8–9:** `RollingSummarizer` using `claude-haiku-4-5-20251001`. Budget: 2000 tokens (project), 500 tokens (branch). Graceful degradation: if API fails, fall back to string truncation. Never fail a COMMIT due to summarizer. Replace Week 1 placeholder.
2. **Days 10–11:** `engine.branch()` — creates branch, inherits parent summary via a `branch-init` commit. `engine.merge()` — synthesizes both summaries, carries forward open threads from source branch, sets source branch `status: 'merged'`.
3. **Days 12–13:** `engine.snapshot()` as first-class method. Harden ThreadManager with test: 20 commits through summarizer, open thread still present.
4. **Day 14:** Integration test — branch + merge + snapshot. Verify AGENTS.md output is immediately useful cold (no other file needed to understand project state).

**Critical architecture decisions:**
- Open threads stored in `threads` table, never passed to summarizer — guaranteed immune to compression
- Project summary = head commit summary of `main` branch; branch summary = head commit summary of current branch
- Summary history is implicit in the commit chain (every commit stores its summary snapshot)

---

### Week 3 — MCP Server, CLI, Git Hooks (Days 15–21)
**Goal:** All integration surfaces connected. Begin dogfooding on the ContextHub repo itself.

1. **Days 15–16:** MCP Server — 4 tools: `context_get`, `context_commit`, `context_branch`, `context_merge`. Loads `.contexthub/config.json`, detects current git branch via `simple-git`, auto-resolves context branch.
2. **Day 17:** `GitSync` — `detectCurrentBranch()`, `ensureContextBranchExists()`, `installGitHooks()`. Hooks: `post-checkout` → `contexthub branch switch`, `post-merge` → `contexthub merge --auto`. Non-destructive: append to existing hooks.
3. **Days 18–19:** oclif CLI — `init`, `snapshot`, `commit`, `branch create/merge`, `search`, `status`. Single `bin/run.js` entry point: detects CLI command vs MCP stdio mode.

   **`contexthub init` must also output a system prompt fragment** — the instruction that tells the agent to call `context_get scope=global` at every session start and `context_commit` at milestones. Without this, Gate 1 fails because the agent won't call the tools reliably. Print it to stdout and write it to `.contexthub/system-prompt.md` for inclusion in MCP config. Minimal viable fragment:
   ```
   You have access to ContextHub memory tools. At the start of every session, call
   context_get with scope=global to load project state. After completing significant
   work, call context_commit with a message describing what was done and any open
   threads. Use context_branch before exploring risky changes.
   ```
4. **Days 20–21:** `AutoSnapshotManager` — fires auto-commit every N=10 non-context tool calls. **Start dogfooding:** run `contexthub init` on this repo, configure Claude Code MCP.

**Week 3 validation:**
- `npx contexthub init` → config + DB created, hooks installed
- `context_get scope=global` works inside Claude Code
- Git branch switch fires hook, active context branch updates

---

### Week 4 — REST API, Embeddings, Packaging, Validation (Days 22–28)
**Goal:** REST API live, semantic search working, npx binary packaged, all three Phase 1 gates passed.

1. **Days 22–23:** Express REST API — routes: `POST /v1/projects/:id/commits`, `GET /v1/projects/:id/snapshot`, `POST /v1/projects/:id/branches`, `POST /v1/projects/:id/branches/:id/merge`, `POST /v1/projects/:id/search`, `GET /v1/projects/:id/threads`. Thin wrappers over `ContextEngine`. Supertest integration tests.
2. **Days 24–25:** `EmbeddingService` — `@xenova/transformers` `Xenova/all-MiniLM-L6-v2`, 384 dims, singleton with lazy init (pre-warm on MCP startup). Wire into `engine.commit()`. `semanticSearch` via sqlite-vec KNN query. FTS5 full-text search via migration v2.
3. **Day 26:** npx packaging — `contexthub` package.json `bin` entry, `scripts/build.sh`, test `npx contexthub init` in a clean temp dir.
4. **Days 27–28:** Run all three end-to-end validation gates (see below).

**Version constraints:**
- `@xenova/transformers`: pin to `^2.17.0` (v3 has breaking API changes)
- `better-sqlite3` + `sqlite-vec`: verify Node.js ABI compatibility on Day 3 before writing SQL

---

## Phase 1 Validation Gates

**Gate 1 — Interactive Session (MCP) [most important gate]:**
- A cold agent reads the snapshot and immediately knows where to pick up — no other file needed
- `context_get scope=global` called automatically at session start via injected system prompt fragment
- Open threads persist across git branch switches

**Gate 2 — Ralph Loop (CLI):**
```bash
# 3 iterations: snapshot → AGENTS.md → commit --workflow-type ralph-loop
# Verify all 4 sections present in AGENTS.md each iteration
```

**Gate 3 — REST API (Simulated CI):**
```bash
# GET /v1/projects/:id/snapshot?format=agents-md → returns PROJECT STATE section
# POST /v1/projects/:id/commits with workflowType: ci → returns commitId
```

**Additional checks:**
- Snapshot stays under 600 tokens for a project with 20+ commits
- Semantic search returns relevant commit for natural language query
- Summarizer fallback path tested explicitly (mock API failure)

---

## Config Strategy

- `.contexthub/config.json` — project-local, committed to repo (shared across team)
- `~/.contexthub/projects/<projectId>.db` — machine-local, not committed
- `ANTHROPIC_API_KEY` from env or config

## Agent Identity (Phase 1)
Agent ID = `<hostname>-<agentRole>-<tool>` (deterministic, no auth needed until Phase 2)
