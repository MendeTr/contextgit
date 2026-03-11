# ContextGit — Phase 2 Implementation Plan

## Context

Phase 1 is complete: core engine, LocalStore (SQLite + sqlite-vec), RemoteStore (HTTP client), MCP server (3 tools), CLI (3 commands), and REST API are built and dogfooded on the ContextGit repo itself and on an external project (Loqally). All three Phase 1 gates passed.

Phase 2 (Weeks 5–8) makes ContextGit team-ready. It fills every Phase 1 gap and ships push/pull, auth, multi-agent scoped snapshots, git hooks, and CI integration.

**What Phase 1 left incomplete:**
- `gitCommitSha` / `gitBranch` fields exist in the DB schema and types but are never populated — agents write them manually
- `context_branch` and `context_merge` MCP tools were planned but never built (engine is done)
- CLI is missing: `branch`, `merge`, `search`, `status`, `push`, `pull`, `keygen`, `doctor`
- REST API `/v1/store` routes are NOT mounted in production `createApp()` — only in integration tests — so `RemoteStore` gets 404 in any real deployment
- No authentication on the REST API
- No git hook installer

---

## Monorepo Changes for Phase 2

No new packages. All work happens in existing packages:

```
packages/
├── core/src/
│   ├── types.ts          ← add remote?, ciRunId?, pipelineName?, gitCommitSha?, gitBranch? to config/input types
│   └── engine.ts         ← pass new EngineCommitInput fields through to store
├── store/src/
│   ├── interface.ts      ← add options? param to getSessionSnapshot
│   ├── local/
│   │   ├── queries.ts    ← add selectRecentCommitsByRole prepared statement
│   │   └── index.ts      ← role filter in getSessionSnapshot
│   └── remote/index.ts   ← add apiKey constructor param, Authorization header
├── mcp/src/
│   ├── git-sync.ts       ← CREATE: captureGitMetadata(), installGitHooks()
│   └── server.ts         ← fix double loadConfig(), add context_branch + context_merge tools
├── cli/src/commands/
│   ├── init.ts           ← add --hooks, --remote, --role flags
│   ├── commit.ts         ← add --ci-run-id, --pipeline flags + captureGitMetadata
│   ├── branch.ts         ← CREATE
│   ├── merge.ts          ← CREATE
│   ├── search.ts         ← CREATE
│   ├── status.ts         ← CREATE
│   ├── push.ts           ← CREATE
│   ├── pull.ts           ← CREATE
│   ├── keygen.ts         ← CREATE
│   └── doctor.ts         ← CREATE
└── api/src/
    ├── server.ts          ← mount /v1/store routes; add auth middleware
    └── middleware/
        └── auth.ts        ← CREATE: Bearer token auth

.github/workflows/
└── contextgit-ci.yml     ← CREATE: CI integration template
```

---

## Week 5 — Git Integration + MCP Completeness

**Goal:** Every context commit is automatically enriched with git metadata. MCP covers the full engine surface.

### 5.1 — `packages/mcp/src/git-sync.ts` (new file)

Two exports:

**`captureGitMetadata(cwd: string): Promise<{ sha: string; branch: string } | null>`**
- Calls `simpleGit(cwd).revparse(['HEAD'])` and `simpleGit(cwd).revparse(['--abbrev-ref', 'HEAD'])`
- Returns `null` on any error — git capture must never block a commit
- Used by both MCP `context_commit` handler and CLI `commit` command

**`installGitHooks(projectRoot: string): Promise<void>`**
- Writes hook scripts to `.git/hooks/` for `post-commit`, `post-checkout`, `post-merge`
- Idempotent: check for a `# contextgit` sentinel comment before appending
- Hook failures are completely silent — write errors to `~/.contextgit/hooks.log`, never stderr
- `post-commit` script: `contextgit commit -m "git: $(git log -1 --pretty=%s)" --git-capture`
- `post-checkout` script: `contextgit context --quiet` (confirm branch context loaded)
- `post-merge` script: `contextgit commit -m "Merged into $(git rev-parse --abbrev-ref HEAD)"`

### 5.2 — SQLite concurrency mitigation in `LocalStore`

`packages/store/src/local/index.ts` — alongside the existing WAL mode pragma, add:
```typescript
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000') // Silently retry on concurrent write contention (1-in-1000 case)
```

This is a single-line addition with no interface changes. It ensures that concurrent writes (e.g., a git hook firing while a CLI command is running) queue and retry for up to 5 seconds rather than immediately throwing `SQLITE_BUSY`.

### 5.3 — Native git metadata on every commit

`packages/core/src/engine.ts`:
- Add `gitCommitSha?: string` and `gitBranch?: string` to `EngineCommitInput`
- Pass through to `EngineCommitStoreInput` → `CommitInput`

`packages/mcp/src/server.ts` (in `context_commit` handler):
```typescript
const git = await captureGitMetadata(process.cwd())
await engine.commit({ ..., gitCommitSha: git?.sha, gitBranch: git?.branch })
```

`packages/cli/src/commands/commit.ts`:
- Same `captureGitMetadata()` call; import from `../../mcp/src/git-sync` or duplicate the 5-line helper inline

### 5.4 — Fix MCP server tech debt

`packages/mcp/src/server.ts`:
- **Double `loadConfig()` bug:** Called at bootstrap (~line 69) and again for `snapshotInterval` (~line 100). Fix: extend `ServerContext` to carry `config: ContextGitConfig`. `bootstrap()` returns it; remove the second `loadConfig()` call.
- **Deprecated 4-arg `server.tool()`:** If no clean fix in MCP SDK `^1.0.0`, add `// TODO: MCP SDK deprecated 4-arg form; no non-deprecated alternative available as of SDK ^1.0.0` inline comment.

### 5.5 — `context_branch` and `context_merge` MCP tools

`packages/mcp/src/server.ts` — add two new `server.tool()` calls:

**`context_branch`:**
- Input: `{ git_branch: string, name?: string }`
- Calls `engine.branch(gitBranch, name)` — engine method is already implemented
- Returns: `{ branchId, branchName }`
- Call `autoSnapshot.onToolCall('context_branch')` first

**`context_merge`:**
- Input: `{ source_branch_id: string }`
- Calls `engine.merge(sourceBranchId)`
- Returns: `{ commitId }`
- Call `autoSnapshot.onToolCall('context_merge')` first

### 5.6 — `contextgit init --hooks`

`packages/cli/src/commands/init.ts`:
- Add `--hooks` boolean flag
- When set, call `installGitHooks(process.cwd())` after project creation
- Without the flag, print: `Tip: run "contextgit init --hooks" to auto-capture context on every git commit`

**Week 5 Validation Gate:**
```bash
# In a test git repo with contextgit init --hooks:
echo "test" > file.txt && git add . && git commit -m "test"
# Verify: contextgit context shows a new commit with gitCommitSha populated
```

---

## Week 6 — CLI Completeness + Push/Pull

**Goal:** Complete CLI surface. Enable the core team-sharing workflow.

### 6.1 — Fix production API (critical bug)

`packages/api/src/server.ts` — in `createApp()`, after store is initialized:
```typescript
app.use('/v1/store', createStoreRouter(store))
```

Without this, `RemoteStore` gets 404 on every call in production. This is the single most important fix for team use.

### 6.2 — Add `remote?` to config

`packages/core/src/types.ts`:
```typescript
interface ContextGitConfig {
  // ... existing fields ...
  remote?: string  // URL for push/pull target (separate from store backend)
}
```

- `config.store = 'local'` — use local SQLite for reads/writes (default)
- `config.remote = 'http://...'` — remote API server for push/pull operations

`packages/cli/src/commands/init.ts` — add `--remote <url>` flag, write to config if provided.

### 6.3 — `contextgit branch` and `contextgit merge`

`packages/cli/src/commands/branch.ts`:
```
contextgit branch <git-branch-name> [--name <display-name>]
```
- Bootstrap engine, call `engine.branch(gitBranch, name)`, print new branch ID

`packages/cli/src/commands/merge.ts`:
```
contextgit merge <source-branch-id>
```
- Bootstrap engine, call `engine.merge(sourceBranchId)`, print merge commit ID

### 6.4 — `contextgit search`

`packages/cli/src/commands/search.ts`:
```
contextgit search <query> [--limit 5] [--format table|json]
```
- Run `store.fullTextSearch(query, projectId)` and `engine.semanticSearch(query, projectId, limit)` in parallel
- Merge results (deduplicate by commit ID, rank by score)
- Default output: a terminal table (respect `process.stdout.columns`)
- `--format json` for programmatic use

### 6.5 — `contextgit status`

`packages/cli/src/commands/status.ts`:
```
contextgit status
```
Output:
```
Project:    my-project (proj_abc123)
Branch:     feature/auth (ctx_branch_xyz)
HEAD:       "Fixed the login bug" (2 hours ago)
Threads:    3 open
Store:      local (~/.contextgit/projects/proj_abc123.db)
Remote:     http://contextgit.company.com (configured)
```

### 6.6 — `contextgit push` and `contextgit pull`

**Architecture:** Push/pull lives entirely in the CLI layer. Both `LocalStore` and `RemoteStore` implement `ContextStore`, so:
- Push = `listCommits(localStore)` → diff by ID vs `listCommits(remoteStore)` → `createCommit(remoteStore)` for missing ones
- Pull = reverse

**Conflict resolution:** Skip if commit ID already exists on target (append-only ledger; commits are immutable once written, so duplicate IDs = already synced).

`packages/cli/src/commands/push.ts`:
```
contextgit push [--branch <id>]
```
1. Load `LocalStore(projectId)` and `RemoteStore(config.remote)` from config
2. List local commits on current branch (all pages via pagination)
3. List remote commits on same branch
4. `createCommit(remote, c)` for each commit not on remote
5. `indexEmbedding(remote, commitId, vector)` for each pushed commit
6. Print: `Pushed N commits to <remote-url>`

`packages/cli/src/commands/pull.ts`:
```
contextgit pull [--branch <id>]
```
- Fetch all remote commits not present locally
- Wrap ALL inserts in a single `better-sqlite3` transaction: `db.transaction(() => { ... })()`. All commits land atomically or none do — if the process dies mid-pull, the local store stays clean.
- Re-index embeddings locally after the transaction commits (fire-and-forget)
- Update `headCommitId` on local branch after pull

**Week 6 Validation Gate:**
```bash
# dir1: contextgit commit -m "hello from dir1"
# dir1: contextgit push
# dir2: contextgit pull
# dir2: contextgit context  → shows dir1 commit
```

---

## Week 7 — Auth + Multi-Agent

**Goal:** Make the REST API safe for shared use. Enable agent-role-filtered snapshots.

### 7.1 — API key authentication

**New DB:** `~/.contextgit/server.db` (separate from project DBs). One table:
```sql
CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,  -- SHA-256(raw_key)
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);
```

`packages/api/src/middleware/auth.ts`:
- Read `Authorization: Bearer <token>` header
- Hash the token with `crypto.createHash('sha256')`
- Look up `key_hash` in `api_keys` table
- 401 if missing or no match
- Update `last_used` on success
- Auth is only enforced when `CONTEXTGIT_AUTH=1` env var is set — local-only mode stays public

`packages/api/src/server.ts`:
```typescript
if (process.env.CONTEXTGIT_AUTH) {
  app.use(authMiddleware(serverDb))
}
app.use('/v1', router)
app.use('/v1/store', createStoreRouter(store))
```

`packages/store/src/remote/index.ts`:
```typescript
constructor(baseUrl: string, private apiKey?: string) { ... }
// In req():
if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`
```

`packages/cli/src/commands/keygen.ts`:
```
contextgit keygen [--name <label>]
```
- Generate 32-byte random key, base64url encode
- Store SHA-256 hash in `~/.contextgit/server.db`
- Print key once (never stored in plaintext): `cgk_<base64url>`
- Key goes in `config.apiKey` for CLI/MCP use

**Week 7 Gate (auth):**
```bash
CONTEXTGIT_AUTH=1 node packages/api/dist/server.js &
curl http://localhost:3141/v1/snapshot          # → 401
curl -H "Authorization: Bearer cgk_..." http://localhost:3141/v1/snapshot  # → 200
```

### 7.2 — Multi-agent scoped snapshots

`packages/store/src/interface.ts`:
```typescript
getSessionSnapshot(
  projectId: string,
  branchId: string,
  options?: { agentRole?: AgentRole }
): Promise<SessionSnapshot>
```
(Backward-compatible — `options` is optional.)

`packages/store/src/local/queries.ts`:
```typescript
selectRecentCommitsByRole: db.prepare(`
  SELECT * FROM commits
  WHERE branch_id = ? AND agent_role = ?
  ORDER BY created_at DESC LIMIT 3
`)
```

`packages/store/src/local/index.ts`:
- When `options?.agentRole` is set, use `selectRecentCommitsByRole` instead of the default `selectRecentCommits`
- `openThreads` are never role-filtered (threads cross agent boundaries by design)

`packages/mcp/src/server.ts` — `context_get` tool gains new parameter:
```typescript
agent_role: z.enum(['orchestrator','dev','test','review','background','ci','solo']).optional()
```

`packages/cli/src/commands/init.ts` — add `--role` flag:
```
contextgit init [--role orchestrator|dev|test|review|ci|solo]
```
Writes `agentRole` to `.contextgit/config.json`.

**Week 7 Gate (multi-agent):**
```bash
# Agent 1 (--role dev):  contextgit commit -m "implement login"
# Agent 2 (--role test): contextgit commit -m "test login"
# context_get agent_role=dev → recentCommits shows only dev commits
# context_get             → recentCommits shows all commits
```

---

## Week 8 — CI Integration + Polish

**Goal:** Ship a working CI story. Add diagnostics. Integration tests. Cut the Phase 2 release.

### 8.1 — CI metadata on commits

`packages/core/src/engine.ts`:
- Add `ciRunId?: string` and `pipelineName?: string` to `EngineCommitInput`
- Pass through to `CommitInput` (fields already exist in DB schema and `CommitInput` type)

`packages/cli/src/commands/commit.ts`:
- Add `--ci-run-id <id>` and `--pipeline <name>` flags

### 8.2 — GitHub Actions templates

`.github/workflows/contextgit-ci.yml` — template for users to copy into their repos:
```yaml
name: ContextGit CI

on: [push, pull_request]

jobs:
  capture-context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx contextgit commit
          -m "CI run ${{ github.run_number }}: ${{ github.event.head_commit.message }}"
          --role ci
          --ci-run-id ${{ github.run_id }}
          --pipeline ${{ github.workflow }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          CONTEXTGIT_REMOTE: ${{ secrets.CONTEXTGIT_REMOTE_URL }}
          CONTEXTGIT_API_KEY: ${{ secrets.CONTEXTGIT_API_KEY }}
```

### 8.3 — `contextgit doctor`

`packages/cli/src/commands/doctor.ts`:
```
contextgit doctor
```
Checks and reports:
- [ ] Config file present and valid JSON
- [ ] DB reachable (local: file exists; remote: GET /v1/snapshot returns ≤ 401)
- [ ] Git hooks installed (check `.git/hooks/post-commit` for sentinel comment)
- [ ] API key configured (if `config.remote` is set)
- [ ] Embedding model downloaded (check `~/.cache/huggingface` or equiv)
- [ ] MCP server registered in `~/.claude.json` (check for `contextgit` entry)
- [ ] SQLite `busy_timeout` pragma set (open DB, run `PRAGMA busy_timeout`, verify result > 0)

### 8.4 — Integration test suite

New test files:

`packages/cli/src/push-pull.test.ts`:
- Two `LocalStore(':memory:')` instances bridged by an in-process Express server
- Commit to store A → push to server → pull to store B → assert both stores have same commits
- Embedding round-trip: index in A, pull to B, semantic search in B returns result

`packages/api/src/auth.test.ts`:
- Supertest against `createApp()` with `CONTEXTGIT_AUTH=1`
- 401 on missing Authorization header
- 401 on wrong key
- 200 on valid key
- `last_used` updates on successful auth

`packages/store/src/role-filter.test.ts`:
- Two agents write commits with different roles
- `getSessionSnapshot(projectId, branchId, { agentRole: 'dev' })` returns only dev commits in `recentCommits`
- `openThreads` remain unfiltered regardless of role

### Phase 2 Validation Gates

| Gate | What to verify |
|------|----------------|
| **1 — Git hooks** | `git commit` in a `--hooks` repo → context commit auto-written with `gitCommitSha` populated |
| **2 — Push/pull** | Commit in dir1, push, pull in dir2, `contextgit context` in dir2 shows dir1's commit |
| **3 — Auth** | API with `CONTEXTGIT_AUTH=1`: no unauthenticated request succeeds |
| **4 — CI** | GH Actions workflow writes `agentRole: ci` commit; `contextgit search "CI run"` finds it |
| **5 — Multi-agent** | `context_get agent_role=dev` returns only dev-role `recentCommits` |

---

## Architecture Notes

### Dependency graph is unchanged

No new packages. The strict dep graph from Phase 1 is preserved:
```
core → @anthropic-ai/sdk, @xenova/transformers, nanoid
store → core (types only), better-sqlite3, sqlite-vec
mcp → core, store, @modelcontextprotocol/sdk, simple-git
cli → core, store, @oclif/core
api → core, store, express
```

`captureGitMetadata()` lives in `packages/mcp/src/git-sync.ts` (MCP already has `simple-git`). The CLI duplicates a minimal 5-line version in its bootstrap. Core stays pure business logic with no I/O deps.

### Config schema evolution

All three bootstrap files (`cli/src/bootstrap.ts`, `mcp/src/server.ts`, `api/src/bootstrap.ts`) have their own copy of the config loader. This is intentional to preserve the dep graph. When `ContextGitConfig` gains `remote?` and the `apiKey` field is wired, update all three copies in parallel.

### Push/pull append-only guarantee

Commits are immutable once written. "Conflicts" at the data level don't exist: if two agents wrote commits simultaneously, both are valid and both should exist in both stores after sync. The rolling summarizer naturally resolves semantic conflicts in subsequent summaries. No CRDT or OT needed.

### Auth is opt-in

Local-only workflows (solo developer, single machine) stay zero-config. Auth is enabled only when the `CONTEXTGIT_AUTH=1` env var is set on the API server. This preserves the Phase 1 DX for solo use while adding security for team deployments.

### Remote Hosting

Phase 2 validation uses localhost for the REST API server (`packages/api`). Deploying to a shared host (Railway, fly.io, etc.) is deferred to Phase 3 when the product goes public. For now, teams run the API server themselves on a machine they control.

---

## What to Defer to Phase 3

| Feature | Why deferred |
|---------|-------------|
| **PostgreSQL + pgvector** | SQLite + WAL handles ~10 concurrent writers; build Postgres only when hitting real limits. Estimated 2–3 weeks of work. |
| **Conflict resolution beyond last-write-wins** | Append-only ledger means no data conflicts; semantic conflicts resolved by summarizer |
| **OpenAI embedding alternative** | `embeddingModel: 'openai'` is in the type but wiring it is a separate feature; Xenova local model works |
| **Web UI dashboard** | REST API + formatted snapshot already expose the data |
| **Multi-project API server mode** | Single-project-per-process is fine for Phase 2; multi-project routing is Phase 3 |
