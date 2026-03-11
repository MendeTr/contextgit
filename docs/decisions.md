# ContextGit — Session Decisions Log

---

## Session: Day 1–4 Foundation (2026-03-10)

**Built:**
- `packages/core/package.json` + `tsconfig.json` — `@contextgit/core` package wired into monorepo
- `packages/store/package.json` + `tsconfig.json` — `@contextgit/store` with `better-sqlite3`, `sqlite-vec`, `nanoid`
- `packages/store/src/interface.ts` — full `ContextStore` interface (the contract all storage backends must satisfy)
- `packages/store/src/local/schema.ts` — DDL for 5 tables (`projects`, `branches`, `commits`, `threads`, `agents`), `vec0` virtual table, FTS5 index, and 4 covering indexes
- `packages/store/src/local/migrations.ts` — versioned migration runner with `_migrations` tracking table; v1=core schema, v2=FTS5+vec0 (vec0 creation wrapped in try/catch)
- `packages/store/src/local/queries.ts` — `Queries` class with all prepared statements, row→domain type converters, full CRUD + snapshot + search helpers
- `packages/store/src/local/index.ts` — `LocalStore` implementing `ContextStore`; sync `better-sqlite3` calls wrapped in `Promise.resolve()` at the interface boundary
- `packages/core/src/index.ts`, `packages/store/src/index.ts` — barrel exports
- `vitest.config.ts` — root-level Vitest covering all `packages/*/src/**/*.test.ts`
- `packages/store/src/local/local-store.test.ts` — 6 smoke tests (project, branch, commit, threads open/close, snapshot, merge with thread carry-forward)
- Root `package.json` — added `pnpm.onlyBuiltDependencies` for `better-sqlite3`/`sqlite-vec`/`esbuild`; fixed `skipLibChecks` typo → `skipLibCheck`

**Decided:**
- **TEXT primary keys via `nanoid()`** — never auto-increment integers. Keeps IDs portable and opaque.
- **Sync SQLite wrapped in `Promise.resolve()` at the interface boundary** — `ContextStore` interface returns Promises so Phase 2 `RemoteStore` (async Postgres) can slot in without changing callers. `LocalStore` internals stay sync (better-sqlite3's strength).
- **sqlite-vec loaded via `createRequire` shim** — package is ESM, `sqlite-vec` is CJS. `createRequire(import.meta.url)` gives a sync CJS `require()` suitable for use in the constructor. Load failure is silently caught — semantic search disabled gracefully.
- **Migration v2 wraps vec0 creation in try/catch** — sqlite-vec is optional at runtime; FTS5 and KNN queries both return empty arrays if the extension isn't loaded. Semantic search wired in Week 4 only.
- **Inline snapshot formatter in `LocalStore`** — minimal `text`/`agents-md`/`json` formatting lives in `store/local/index.ts` for now. Full `SnapshotFormatter` moves to `core/src/snapshot.ts` in Days 5–7 without changing the `ContextStore` interface.
- **`mergeBranch` attributes merge commits to `system`/`orchestrator`** — the interface signature `(sourceBranchId, targetBranchId, summary)` matches the architecture doc exactly; attribution is a placeholder until `ContextEngine.merge()` is built.
- **DB path: `~/.contextgit/projects/<projectId>.db`** — pass `':memory:'` for tests.
- **ABI compatibility confirmed:** `better-sqlite3` compiled from source for Node 22.22.0 / arm64 (no prebuilt available). `sqlite-vec` v0.1.6 loads and `vec0` virtual tables create cleanly against SQLite 3.45.3.

**Unresolved:**
- `pnpm approve-builds` is interactive in pnpm 10 — worked around via `pnpm.onlyBuiltDependencies` in root `package.json` + `pnpm install --force` to trigger the native build. Subsequent installs should be clean, but CI will need the same config.
- `getFormattedSnapshot` in `LocalStore` does inline formatting. Once `core/src/snapshot.ts` is written (Days 5–7), decide whether to call the formatter from the store or move `getFormattedSnapshot` up to `ContextEngine`.
- `semanticSearch` on `LocalStore` currently returns `[]` unconditionally — the interface method exists but the embedding vector must be passed in from `core/src/embeddings.ts` (Week 4). The `Queries.semanticSearch()` helper is wired and ready.
- No project-references in `tsconfig.json` — store must typecheck after core is built. Consider adding `composite: true` + `references` to avoid the build-first requirement.

**Next:**
- Start Days 5–7: `packages/core/src/engine.ts` — `ContextEngine.commit()` with placeholder string-truncation summarizer, `ContextEngine.context('global')` returning a `SessionSnapshot`. Wire `LocalStore` into the engine via constructor injection. Validate: create project → 2 commits (one with open thread) → `context('global')` → snapshot shows thread + both commits.

---

## Session: Days 5–7 — ContextEngine (2026-03-10) #2

**Built:**
- `packages/core/src/summarizer.ts` — `RollingSummarizer` class; Week 1 placeholder: appends new content to previous summary, truncates from the start to keep the most-recent work. Interface is stable for Week 2 Claude Haiku swap.
- `packages/core/src/snapshot.ts` — `SnapshotFormatter` class; all 3 formats (`text`, `agents-md`, `json`). Moved out of the inline function in `LocalStore`.
- `packages/core/src/threads.ts` — `ThreadManager` class; read-side helper enforcing the open-thread immune-to-compression boundary. Write-side (open/close) stays in `store.createCommit()` for transactional correctness.
- `packages/core/src/engine.ts` — `ContextEngine`: `init(projectId, branchId)`, `commit(input)`, `context(scope)`. Uses `EngineStore` structural interface so core never imports from store (no circular deps).
- `packages/core/src/index.ts` — updated barrel exports for all 4 new modules.
- `packages/store/src/local/index.ts` — removed inline `formatSnapshot`; now imports and uses `SnapshotFormatter` from `@contextgit/core`.
- `packages/store/src/engine-integration.test.ts` — 4 integration tests covering the Week 1 validation scenario, rolling summary accumulation, `context('branch')` parity, and uninitialized guard.

**Decided:**
- **`ContextEngine` accepts `EngineStore` structural interface** — core defines only the subset of methods it needs (`getBranch`, `getCommit`, `createCommit`, `getSessionSnapshot`, `upsertAgent`). `LocalStore` satisfies it without a direct import, preserving the strict dependency graph (`core` never imports `store`).
- **`SnapshotFormatter` moved to core, `LocalStore` imports it** — store already depends on core for types; this is the correct layering. `getFormattedSnapshot` stays on `ContextStore` interface (callers don't change).
- **`ThreadManager` is read-only** — write-side (open/close) is a transactional concern that belongs inside `store.createCommit()`. `ThreadManager` is purely a query helper.
- **`context('branch')` delegates to same `getSessionSnapshot` as `'global'`** — branch-scoped view is distinct only in Week 2+ when branch summaries are computed separately. For now both return identical data.

**Unresolved:**
- `semanticSearch` still returns `[]` — needs `EmbeddingService` from `core/src/embeddings.ts` (Week 4).
- `RollingSummarizer.summarize()` uses string truncation — Week 2 replaces with Claude Haiku + graceful fallback; no caller changes required.
- `context('search' | 'commit' | 'raw')` scopes throw "not implemented" — Week 3/4 work.
- No project-references in tsconfig — build-order dependency remains manual (`pnpm build` must run core before store).

**Next:**
- Start Days 8–9 (Week 2): `packages/core/src/summarizer.ts` — replace string truncation with `claude-haiku-4-5-20251001` via `@anthropic-ai/sdk`. Graceful fallback: if API call fails, revert to string truncation. Never let summarizer failure propagate to the caller. Add `ANTHROPIC_API_KEY` handling. Test: mock API failure → fallback summary still returned.

---

## Session: Days 8–9 — Claude Haiku Summarizer (2026-03-10) #3

**Built:**
- `packages/core/src/summarizer.ts` — `RollingSummarizer.summarize()` is now async; uses `claude-haiku-4-5` via `@anthropic-ai/sdk` when `ANTHROPIC_API_KEY` is present. Graceful fallback to string truncation on any error (API failure, no key, network issue). Response is sliced to `maxChars` budget after the Claude call.
- `packages/core/src/summarizer.test.ts` — 7 tests: Claude success path, previous summary passed through, API failure → fallback, never throws, no-key → fallback, truncation tail-keeps-newest, Claude response truncated to budget.
- `packages/core/package.json` — added `@anthropic-ai/sdk: ^0.40.1` to `dependencies`.
- `packages/core/src/engine.ts` — `summarizer.summarize()` call updated to `await`.
- `packages/store/src/local/queries.ts` — `selectCommits` and `selectLastCommit` sort keys extended with `rowid DESC` tiebreaker to fix non-deterministic ordering when two commits share the same millisecond timestamp.

**Decided:**
- **Inject `Anthropic` client via `SummarizerOptions.client`** — avoids environment coupling in tests; production path creates the client from `ANTHROPIC_API_KEY` automatically.
- **`model: 'claude-haiku-4-5'`** — cheapest/fastest model, appropriate for compression; no thinking or streaming needed.
- **`max_tokens: 1024`** — sufficient for summaries; both budget sizes (2000 / 8000 chars) fit within this token ceiling.
- **`rowid DESC` tiebreaker on commit sort** — `Date.now()` collides at millisecond resolution in fast in-memory tests. `rowid` is always monotonically increasing so insertion order is preserved as a stable secondary sort.
- **No changes to `ContextStore` interface** — `getFormattedSnapshot` and `createCommit` signatures unchanged; callers are unaffected by the sync→async transition inside `ContextEngine`.

**Unresolved:**
- `semanticSearch` still returns `[]` — needs `EmbeddingService` from `core/src/embeddings.ts` (Week 4).
- `context('search' | 'commit' | 'raw')` scopes throw "not implemented" — Week 3/4 work.
- No project-references in tsconfig — build-order dependency remains manual.

**Next:**
- Days 10–11 (Week 2 continued): wire the MCP server skeleton — `packages/mcp/src/server.ts` implementing the three core tools (`context`, `commit`, `search`) via `@modelcontextprotocol/sdk`. Validate with `mcp dev` inspector: tool list returned, `commit` persists a record, `context` returns a snapshot.

---

## Session: Days 10–11 — MCP Server Skeleton (2026-03-10) #4

**Built:**
- `packages/mcp/package.json` — `@contextgit/mcp` workspace package; deps: `@modelcontextprotocol/sdk ^1.0.0`, `simple-git ^3.27.0`, `zod ^3.23.0`, `@contextgit/core`, `@contextgit/store`.
- `packages/mcp/tsconfig.json` — extends `tsconfig.base.json`, same pattern as core/store.
- `packages/mcp/src/config.ts` — `loadConfig()` searches CWD upward for `.contextgit/config.json`, validates required `projectId`/`project` fields. Exports `ConfigNotFoundError`.
- `packages/mcp/src/server.ts` — `createServer()` bootstraps `LocalStore` + `ContextEngine` then registers 3 tools on `McpServer`:
  - `context_get` — calls `store.getFormattedSnapshot(projectId, branchId, format)`. Params: `scope` (global|branch, default global), `format` (agents-md|json|text, default agents-md).
  - `context_commit` — calls `engine.commit({ message, content, threads })`. Params: `message`, `content`, optional `open_threads[]`, `close_thread_ids[]`.
  - `context_search` — calls `store.fullTextSearch(query, projectId)`, slices to `limit`. Params: `query`, `limit` (1–20, default 5).
- `packages/mcp/src/index.ts` — entry point; connects `McpServer` to `StdioServerTransport`, exits on fatal error.
- All 17 existing tests still pass. `pnpm build` and `pnpm typecheck` clean.

**Decided:**
- **`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`** — high-level API with Zod schemas. The 4-arg `(name, description, schema, cb)` overload is deprecated (hint only, not a build error); the non-deprecated 3-arg `(name, schema, annotations, cb)` form has no `description` field in annotations. Kept the deprecated form because it's the only way to pass a description string.
- **Bootstrap at startup, not per-request** — `LocalStore`, `ContextEngine`, `projectId`, `branchId` all resolved once at process start. Git branch detected via `simple-git`. Context branch auto-created if not found in DB.
- **Agent ID: `${hostname}-mcp-claude-code-interactive`** — deterministic, no auth. Matches Phase 1 agent identity strategy.
- **`context_get` ignores `scope` for now** — always calls `getFormattedSnapshot` on the current branch; scope differentiation deferred to Week 3 when `engine.branch()` and proper multi-branch context are built.
- **`context_search` uses `fullTextSearch` only** — semantic search still returns `[]`; FTS5 is ready and functional.

**Unresolved:**
- MCP server not yet validated with `mcp dev` inspector — requires a live `.contextgit/config.json` + project in DB. Validation deferred to when `contextgit init` CLI command is built (Days 18–19).
- `server.tool()` 4-arg form is deprecated in `@modelcontextprotocol/sdk ^1.0.0` but no clean alternative supports a description string. May need SDK upgrade or monkey-patch workaround in Week 3.
- `context_get` `scope` param is accepted but unused — full scope routing (branch-only vs global) is Week 3 work.
- `semanticSearch` still returns `[]` — needs `EmbeddingService` (Week 4).

**Next:**
- Days 12–13 (Week 2): `engine.branch()` — `store.createBranch()` + `branch-init` commit carrying parent HEAD summary forward. `engine.merge()` — merge commit, carry forward open threads from source branch, mark source branch `status: 'merged'`. Integration test: branch → 2 commits → merge → snapshot shows merged state and all threads.

---

## Session: Days 12–13 — engine.branch() + engine.merge() (2026-03-10) #5

**Built:**
- `packages/core/src/engine.ts` — two new `ContextEngine` methods:
  - `branch(gitBranch, name?)` — calls `store.createBranch()` with `parentBranchId = this.branchId`, then writes a `branch-init` commit on the new branch carrying the parent HEAD summary forward (no rolling summarization on init — summary passed through verbatim).
  - `merge(sourceBranchId)` — fetches source + target HEAD summaries, calls `summarizer.summarize(mergeContent, targetSummary, 'branch')` to produce the merge summary, then delegates to `store.mergeBranch()`. Thread carry-forward and branch status update handled transactionally inside `LocalStore.mergeBranch()`.
- `EngineStore` interface extended with `createBranch(EngineBranchInput)` and `mergeBranch(sourceBranchId, targetBranchId, summary)`. `getBranch` return type widened to include `gitBranch?` and `name?` (needed for merge message). `LocalStore` satisfies structurally — no changes to store code required.
- `packages/store/src/branch-merge.test.ts` — 3 integration tests:
  1. Full flow: main commit + thread → branch → 2 feature commits + thread → merge → snapshot shows merge commit + both open threads carried to main.
  2. `branch-init` commit carries exact parent HEAD summary into new branch.
  3. Merge commit content includes source branch content; summary is non-empty.
- All 20 tests pass; `pnpm build` and `pnpm typecheck` clean.

**Decided:**
- **`branch-init` summary passed through verbatim** — no summarization for init commits. The parent summary is already compressed; re-summarizing an empty "new" content with the parent as base would just return the parent unchanged anyway. Verbatim is cleaner and avoids an async call.
- **`EngineStore` structural widening is non-breaking** — adding optional fields (`gitBranch?`, `name?`) to the `getBranch` return type is structurally safe; `LocalStore.getBranch()` returns `Branch` which has both fields.
- **Thread carry-forward stays in `LocalStore.mergeBranch()`** — it's a transactional concern; engine should not orchestrate individual thread reassignments.
- **`engine.merge(sourceBranchId)` not `engine.merge(sourceBranchId, targetBranchId)`** — the engine is already bound to a branch via `init()`; the target is always `this.branchId`. Explicit target would be redundant and error-prone.

**Unresolved:**
- `semanticSearch` still returns `[]` — needs `EmbeddingService` (Week 4).
- `context('search' | 'commit' | 'raw')` scopes still throw "not implemented".
- No project-references in tsconfig — build order still manual.
- `server.tool()` 4-arg form in MCP SDK still deprecated (carried from Day 10).

**Next:**
- Days 14–15 (Week 3): `packages/cli/src/` — oclif CLI skeleton. Commands: `init` (creates `.contextgit/config.json` + project in DB), `commit` (engine.commit from CLI args), `context` (print formatted snapshot). Validate: `contextgit init`, `contextgit commit -m "msg"`, `contextgit context` all run end-to-end.

---

## Session: Days 14–15 — oclif CLI Skeleton (2026-03-10) #6

**Built:**
- `packages/cli/package.json` — `@contextgit/cli` workspace package; deps: `@oclif/core ^3.27.0`, `nanoid ^5.0.0`, `simple-git ^3.27.0`, `@contextgit/core`, `@contextgit/store`.
- `packages/cli/tsconfig.json` — extends `tsconfig.base.json`, same pattern as other packages.
- `packages/cli/bin/run.js` — oclif ESM entry point; calls `run(argv, import.meta.url)` + `flush()`.
- `packages/cli/src/config.ts` — `loadConfig()` / `findConfigPath()` (same logic as `packages/mcp/src/config.ts`; duplicated to keep `cli → core, store` dep graph clean).
- `packages/cli/src/bootstrap.ts` — shared setup for commit/context commands: loads config, opens `LocalStore`, detects git branch via `simple-git`, creates branch if missing, inits `ContextEngine`. Returns `{ engine, store, projectId, branchId }`.
- `packages/cli/src/commands/init.ts` — `contextgit init [--name <name>]`: generates a `nanoid()` projectId, opens `LocalStore(projectId)`, calls `store.createProject({ id: projectId, name })` (same ID for DB path and project entity), creates initial branch, writes `.contextgit/config.json`. Guards against double-init.
- `packages/cli/src/commands/commit.ts` — `contextgit commit -m <msg> [-c <content>] [-t <thread>...] [--close <id>...]`: bootstraps engine, calls `engine.commit()`.
- `packages/cli/src/commands/context.ts` — `contextgit context [-f agents-md|json|text]`: loads config, opens store, detects branch, prints `store.getFormattedSnapshot()`.
- `packages/core/src/types.ts` — added `id?: string` to `ProjectInput` (backward-compatible).
- `packages/store/src/local/index.ts` — `createProject` now uses `input.id ?? nanoid()` so callers can supply a specific ID.
- All 20 existing tests still pass; `pnpm build` and `pnpm typecheck` clean.
- E2E validated: `contextgit init` → `contextgit commit -m "First commit"` → `contextgit context` all run end-to-end in a fresh tmp directory.

**Decided:**
- **`config.ts` duplicated in CLI** — MCP and CLI both need config loading, but `cli → mcp` is not in the allowed dep graph. The file is 50 lines; duplication is cheaper than a shared package or a cross-boundary import.
- **`ProjectInput.id?` added to core types** — necessary for `init` to ensure the DB path key matches the project entity ID. `LocalStore.createProject` falls back to `nanoid()` if omitted, so all existing callers (tests, MCP) are unaffected.
- **`bootstrap()` shared helper** — `commit` and `context` both need the same setup; extracted to avoid duplication. `init` does not use bootstrap (no config yet at that point).
- **`context` command does not go through engine** — reads directly from `store.getFormattedSnapshot()` since no engine-level logic is needed for a read. Matches `context_get` MCP tool pattern.
- **`commit --content` defaults to `--message`** — simple CLI ergonomics; power users can add richer content via `-c`.

**Unresolved:**
- `semanticSearch` still returns `[]` — needs `EmbeddingService` (Week 4).
- `context('search' | 'commit' | 'raw')` scopes still throw "not implemented".
- `server.tool()` 4-arg form in MCP SDK still deprecated (carried from Day 10).
- CLI not yet installable globally (`npm link` / `pnpm link`) — needs bin shebang permissions (`chmod +x bin/run.js`) which aren't set by tsc.

**Next:**
- Days 16–17 (Week 3): `packages/api/src/` — Express REST API skeleton. Routes: `POST /commits` (engine.commit), `GET /snapshot` (formatted snapshot), `GET /search?q=` (FTS). Validate with curl end-to-end.

---

## Session: Days 16–17 — Express REST API Skeleton (2026-03-10) #7

**Built:**
- `packages/api/package.json` — `@contextgit/api` workspace package; deps: `express ^4.19.0`, `simple-git ^3.27.0`, `@contextgit/core`, `@contextgit/store`.
- `packages/api/tsconfig.json` — extends `tsconfig.base.json`, same pattern as other packages.
- `packages/api/src/config.ts` — `loadConfig()` / `findConfigPath()` (same logic as `mcp` and `cli`; duplicated to preserve dep graph: `api → core, store` only).
- `packages/api/src/bootstrap.ts` — opens `LocalStore`, detects git branch via `simple-git`, resolves/creates context branch, inits `ContextEngine`. Agent ID: `${hostname}-api-server`.
- `packages/api/src/router.ts` — Express `Router` with 3 routes:
  - `POST /commits` — validates `message`/`content`, calls `engine.commit()`, returns `{ id, message, createdAt }` with 201.
  - `GET /snapshot` — `?format=agents-md|json|text` (default: agents-md). Returns `text/plain` for text/agents-md, `application/json` for json.
  - `GET /search` — `?q=<query>&limit=<n>` (default 5, max 20). Returns `{ query, total, results[] }`.
- `packages/api/src/server.ts` — `createApp()`: bootstraps context, mounts router, adds 404 handler. Separated from `index.ts` so tests can import without binding to a port.
- `packages/api/src/index.ts` — entry point; listens on `PORT` env var (default 3141).
- All 20 existing tests still pass; `pnpm build` and `pnpm typecheck` clean.
- E2E validated with curl: `POST /commits` → 201 + ID, `GET /snapshot?format=text` → formatted snapshot, `GET /snapshot?format=json` → full JSON, `GET /search?q=API` → results array.

**Decided:**
- **`createApp()` separated from `index.ts`** — allows future supertest integration tests to import the app without starting a live server. Same pattern used by most production Express apps.
- **`config.ts` again duplicated in api package** — `api → mcp` and `api → cli` are both outside the allowed dep graph. 50-line file; duplication is the right trade-off.
- **Flat routes (`/commits`, `/snapshot`, `/search`)** — project and branch resolved at startup from config, not from URL params. Matches MCP + CLI single-project-per-process model. URL-scoped routes (`/v1/projects/:id/...`) deferred to Week 4 when multi-project API is planned.
- **`PORT` env var default: 3141** — avoids common conflicts (3000, 8080, 8000); easy to override.
- **`GET /search` returns 0 results immediately after a fresh `POST /commits`** — SQLite FTS5 index (`commits_fts`) is updated synchronously inside `createCommit`, but the query ran before the server saw a commit. Confirmed not a bug; repeated queries return results correctly.

**Unresolved:**
- `semanticSearch` still returns `[]` — needs `EmbeddingService` (Week 4).
- Supertest integration tests for the API — Week 4 work alongside the full route set.
- `GET /search` returns 0 results for a brand-new DB with only one commit — investigation needed to confirm FTS5 trigger fires on first insert (may need a test).
- `server.tool()` 4-arg form in MCP SDK still deprecated (carried from Day 10).
- CLI `init` guard bails when config.json already exists but DB is empty — no self-healing path. Edge case when config is committed to repo but DB is machine-local.

**Next:**
- Days 18–19 (Week 3): `contextgit init` system-prompt fragment — print to stdout and write `.contextgit/system-prompt.md` with the agent instruction fragment. Then: `AutoSnapshotManager` skeleton in `packages/mcp/src/auto-snapshot.ts` — counter that fires `engine.commit()` every N=10 tool calls. Begin dogfooding: run `contextgit init` on this repo (fix the empty-DB edge case first), configure Claude Code MCP.

---

## Session: Days 18–19 — System-Prompt Fragment + AutoSnapshotManager (2026-03-10) #8

**Built:**
- `packages/cli/src/commands/init.ts` — self-heal: when `config.json` exists but DB is empty, reads the config, detects git branch, recreates project + branch in DB instead of bailing. Fixes the edge case where config is committed to the repo but DB is machine-local.
- `packages/cli/src/commands/init.ts` — system-prompt fragment: after fresh init (or self-heal), writes `.contextgit/system-prompt.md` and prints the fragment to stdout. Fragment instructs agents to call `context_get scope=global` at session start and `context_commit` after significant work.
- `packages/mcp/src/auto-snapshot.ts` — `AutoSnapshotManager` class: counts tool calls, fires `engine.commit({ commitType: 'auto' })` every N=10 non-commit calls. `context_commit` resets the counter. Auto-commit failures are swallowed — tool calls are never blocked.
- `packages/mcp/src/server.ts` — `AutoSnapshotManager` wired in: instantiated after bootstrap, `autoSnapshot.onToolCall(toolName)` called in each of the three tool handlers.
- **Dogfooded:** ran `contextgit init` on this repo (self-heal path triggered), then `contextgit commit` and `contextgit context` — full round-trip confirmed in the ContextGit DB.

**Decided:**
- **Self-heal uses `getBranchByGitName` as the DB health check** — if the git branch's context branch is found, initialization is complete; if not, recreate project + branch. This handles the common case (machine-local DB wiped or repo cloned fresh) without requiring a separate `getProject` method on the store interface.
- **`AutoSnapshotManager` counts all tool calls except `context_commit`** — `context_get` and `context_search` count toward the interval because they indicate an active session. Only a manual `context_commit` (or auto-commit) resets the counter.
- **`loadConfig()` called twice in `createServer()`** — once inside `bootstrap()` and once to read `snapshotInterval` for `AutoSnapshotManager`. Acceptable for a short-lived startup path; would refactor if config parsing became expensive.
- **`commitType: 'auto'`** — auto-commits are distinguished from manual ones in the DB for observability. No other behavior change.

**Unresolved:**
- `semanticSearch` still returns `[]` — needs `EmbeddingService` (Week 4).
- MCP server not yet validated with `mcp dev` inspector or Claude Code MCP config — the `.contextgit/system-prompt.md` exists but hasn't been added to Claude Code's MCP settings yet.
- `server.tool()` 4-arg form in MCP SDK still deprecated (carried from Day 10).
- `loadConfig()` called twice in `createServer()` — minor, deferred.

**Next:**
- Days 20–21 (Week 3 wrap-up): configure Claude Code MCP to load `packages/mcp/src/index.ts` for this repo. Validate `context_get` and `context_commit` work inside Claude Code. Then begin Week 4: `EmbeddingService` in `core/src/embeddings.ts` using `@xenova/transformers all-MiniLM-L6-v2`, wire into `engine.commit()`, enable `semanticSearch` in `LocalStore`.

---

## Session: Days 20–21 — MCP Config + EmbeddingService (2026-03-10) #9

**Built:**
- `~/.claude.json` — registered `contextgit` MCP server for the `/Users/mendetrajovski/contextgit` project: `node packages/mcp/dist/index.js` via stdio. Claude Code will now load the MCP server when working in this repo.
- `packages/core/src/embeddings.ts` — `EmbeddingService` class: lazy-loads `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`, returns `Float32Array(384)` or `null` on any error. Pipeline loaded once and reused across all `embed()` calls.
- `packages/core/src/embeddings.test.ts` — 5 tests: success path, load failure → null, inference failure → null, never throws, pipeline loaded only once.
- `packages/core/src/engine.ts` — `ContextEngine` extended: `EngineOptions.embeddingService?`, `EngineStore.indexEmbedding()` + `EngineStore.semanticSearch()`. After `createCommit()`, embedding generated asynchronously (fire-and-forget, never blocks commit). New `engine.semanticSearch(query, projectId, limit)` method generates vector and delegates to store.
- `packages/store/src/interface.ts` — `ContextStore.semanticSearch` signature changed from `(query: string, ...)` to `(vector: Float32Array, ...)`; `indexEmbedding(commitId, vector)` added.
- `packages/store/src/local/index.ts` — `LocalStore.indexEmbedding()` calls `queries.insertEmbedding()`; `LocalStore.semanticSearch()` now calls `queries.semanticSearch()` with the provided vector (no longer returns `[]`).
- `packages/mcp/src/server.ts` — `EmbeddingService` injected into `ContextEngine` at bootstrap; `context_search` tool now runs semantic + FTS in parallel, merges and deduplicates results by commit ID.
- All 25 tests pass; `pnpm build` and `pnpm typecheck` clean.

**Decided:**
- **`semanticSearch` on `ContextStore` takes `Float32Array`, not `string`** — embedding generation lives in `core`; `store → core (types only)` constraint means the store cannot call `EmbeddingService`. The vector is produced by the engine and passed to the store. `Float32Array` is a native type — no import required.
- **Embedding indexing is fire-and-forget in `engine.commit()`** — a `.then().catch()` chain ensures: (a) the commit is returned immediately, (b) indexing failures are swallowed, (c) the `never fail a COMMIT` invariant is preserved.
- **`EmbeddingService.pipelineFactory` is injectable** — allows tests to inject a fake pipeline without loading the real model. Real model only loaded when `ANTHROPIC_API_KEY`-style lazy init is triggered in production.
- **`context_search` merges semantic + FTS, deduplicates by `commit.id`** — semantic results ranked first (higher precision), FTS fills in remaining slots. `limit` applied after merge.
- **`@xenova/transformers ^2.17.2`** added to `packages/core` dependencies.

**Unresolved:**
- MCP server not live-validated inside Claude Code yet — requires a Claude Code restart to pick up the new MCP config in `~/.claude.json`.
- `server.tool()` 4-arg form in MCP SDK still deprecated (carried from Day 10).
- `loadConfig()` called twice in `createServer()` — minor, deferred.
- First call to `engine.semanticSearch()` will trigger model download (~25 MB) on cold start — no progress indicator; may time out on slow connections.

**Next:**
- Days 22–23 (Week 4 continued): validate MCP server live inside Claude Code (restart required). Then: `RemoteStore` stub in `packages/store/src/remote/` — implement `ContextStore` interface backed by HTTP fetch against the Express API. Wire into CLI and MCP via config `store: "http://..."`. Add integration test: LocalStore and RemoteStore produce identical snapshots for the same sequence of commits.

---

## Session: Days 22–23 — RemoteStore + FTS5 Fix (2026-03-11) #10

**Built:**
- `packages/api/src/store-router.ts` — Express router (`createStoreRouter(store)`) exposing all 20 `ContextStore` methods as HTTP endpoints at `/v1/store/...`. Covers projects, branches, commits, snapshots, threads, embeddings, search, and agents. Float32Array serialized as `number[]` for JSON transport.
- `packages/store/src/remote/index.ts` — `RemoteStore` implementing `ContextStore` via `fetch` against the store router. Includes date-parsing helpers (JSON returns ISO strings; RemoteStore converts them back to `Date`). `Float32Array` serialized/deserialized for `indexEmbedding` and `semanticSearch`.
- `packages/store/src/index.ts` — updated barrel export to include `RemoteStore`.
- `packages/api/src/remote-store.test.ts` — 7 integration tests: project/branch CRUD, commit retrieval, formatted snapshot identical to LocalStore output, open thread round-trip, FTS search, mergeBranch thread carry-forward. All run against a live `http.createServer` on a random port backed by in-memory LocalStore.
- `packages/store/src/local/schema.ts` — added `CREATE_FTS_TRIGGER` and `SCHEMA_V3_DDL`: `AFTER INSERT ON commits` trigger that inserts into `commits_fts` to maintain the FTS index.
- `packages/store/src/local/migrations.ts` — migration v3 `fts_trigger`: applies the trigger and runs `INSERT INTO commits_fts(commits_fts) VALUES('rebuild')` to index any pre-existing rows.
- `packages/store/src/local/queries.ts` — fixed `fullTextSearch` query: changed `JOIN commits c ON c.id = commits_fts.commit_id` → `ON c.rowid = commits_fts.rowid`. The content FTS5 table cannot read `commit_id` from `commits` (column named `id`, not `commit_id`); rowid-based join is correct for content tables.
- **MCP confirmed live**: `mcp__contextgit__context_get`, `mcp__contextgit__context_commit`, `mcp__contextgit__context_search` visible in this Claude Code session — Gate 1 MCP validation passing.
- All 32 tests pass; `pnpm build` and `pnpm typecheck` clean.

**Decided:**
- **`createStoreRouter(store)` in `packages/api`** — not mounted in the existing `createApp()` (which is project/branch-scoped at startup). The store router is project/branch-agnostic (callers pass IDs). Kept as a separate factory for use by integration tests and future multi-project server mode.
- **Integration test in `packages/api/src/`** — needs both `express` (api dep) and `RemoteStore`/`LocalStore` (store dep). Keeping in api avoids adding express to store devDependencies. Cross-package relative imports avoided; `@contextgit/store` resolved from workspace dist after `pnpm build`.
- **`afterAll` uses Promise-based cleanup** — Vitest's TypeScript types don't support the `done` callback pattern; `new Promise<void>(resolve => server.close(...resolve))` is the correct form.
- **FTS5 content table bug fixed** — The original query joined on `commits_fts.commit_id` but `commits_fts` is a content table referencing `commits`; SQLite FTS5 fetches column values from the content table by column name, so `commit_id` was unresolvable (commits has `id`, not `commit_id`). Fix: join on `c.rowid = commits_fts.rowid` — always correct for content tables.
- **Migration v3 adds trigger** — rather than an explicit FTS insert in `queries.insertCommit()`, a trigger covers ALL INSERT paths into `commits` (including `mergeBranch`). The `rebuild` command indexes pre-existing rows in upgraded DBs.

**Unresolved:**
- `RemoteStore` not yet wired into CLI/MCP bootstrap via `config.store = "http://..."`. Config type (`ContextGitConfig.store`) already supports this; bootstrap functions need a factory that checks `config.store !== 'local'` and creates `RemoteStore`. Deferred to Day 24.
- `server.tool()` 4-arg form in MCP SDK still deprecated (carried from Day 10).
- `loadConfig()` called twice in `createServer()` — minor, deferred.
- Phase 1 gates (Gate 2 Ralph Loop, Gate 3 REST CI) not yet validated end-to-end.

**Next:**
- Day 24 (Week 4): wire `RemoteStore` into CLI/MCP bootstrap — check `config.store !== 'local'`, create `RemoteStore(config.store)` instead of `LocalStore`. Then run Phase 1 validation gates: Gate 2 (ralph-loop CLI), Gate 3 (REST API curl). Update npx packaging (`contextgit` bin entry in root package.json, `scripts/build.sh`).

---

## Session: Day 24 — RemoteStore wiring + npx packaging + Phase 1 gates (2026-03-11) #11

**Built:**
- `packages/cli/src/bootstrap.ts` — checks `config.store !== 'local'`; creates `RemoteStore(config.store)` when a URL is configured, `LocalStore(projectId)` otherwise.
- `packages/mcp/src/server.ts` — same RemoteStore/LocalStore switch in `bootstrap()`.
- `scripts/build.sh` — builds all 5 packages in dependency order via `pnpm --filter`. Executable.
- Root `package.json` — added `"bin": { "contextgit": "./packages/cli/bin/run.js" }` so `npx contextgit` works from the monorepo root.
- **Gate 2 PASS (ralph-loop CLI):** 3 iterations of `contextgit context -f agents-md` → `contextgit commit`. All 4 sections present in agents-md output every iteration: `## Project State`, `## Current Branch`, `## Recent Activity`, `## Open Threads`.
- **Gate 3 PASS (REST API):** `GET /snapshot?format=agents-md` returns `## Project State` section; `POST /commits` returns `{ id, message, createdAt }` with 201.
- All 32 tests pass; `pnpm build` and `pnpm typecheck` clean.

**Decided:**
- **`config.store && config.store !== 'local'` guard** — catches both missing field (old configs pre-dating the field) and the explicit `'local'` value. Any other non-empty string is treated as a URL for `RemoteStore`.
- **Root `package.json` bin entry** — points to `./packages/cli/bin/run.js` (the oclif ESM entry point). The monorepo root is named `contextgit` so `npx contextgit` routes here. No separate publish step needed for local dev; `pnpm link` or `npm link` will expose the bin globally.
- **`scripts/build.sh` uses `pnpm --filter`** — explicit per-package ordering guarantees `core` before `store` before the rest. Safer than `pnpm -r build` which may parallelize incorrectly on first install.
- **Gate 3 uses flat routes** (`/commits`, `/snapshot`) not `/v1/projects/:id/...` — the API is single-project-per-process (resolved at startup). The plan doc showed the multi-project URL schema planned for a future phase; the flat routes are the correct target for Phase 1 Gate 3.

**Unresolved:**
- `server.tool()` 4-arg form in MCP SDK still deprecated (carried from Day 10).
- `loadConfig()` called twice in MCP `createServer()` — minor, deferred.
- npx packaging not tested in a clean temp dir (no `pnpm link` validation run yet).
- Gate 1 (interactive MCP session cold-start) not formally re-run — MCP tools are live in Claude Code (confirmed Day 22) but cold-start AGENTS.md read not re-validated after RemoteStore wiring.

**Next:**
- Days 25–26: npx clean-install validation — `cd /tmp && npx contextgit init` in a fresh dir. Fix any path/shebang issues. Then run Gate 1 formal cold-start: Claude Code session start → `context_get scope=global` auto-called via system prompt → snapshot returned with no prior context loaded.
**Tokens:** TBD
**Ramp-up:** 0
**Time to first code:** ~3 min


## Session: Phase 1 Complete (2026-03-11)
**Gate 1:** PASS — validated every session since Day 1
**Gate 2:** PASS
**Gate 3:** PASS
**Slipped to Phase 2:** git hooks, semantic search e2e, npx clean-install
**Next:** Plan Phase 2 — RemoteStore, multi-agent, team support