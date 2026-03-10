# ContextHub — Session Decisions Log

---

## Session: Day 1–4 Foundation (2026-03-10)

**Built:**
- `packages/core/package.json` + `tsconfig.json` — `@contexthub/core` package wired into monorepo
- `packages/store/package.json` + `tsconfig.json` — `@contexthub/store` with `better-sqlite3`, `sqlite-vec`, `nanoid`
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
- **DB path: `~/.contexthub/projects/<projectId>.db`** — pass `':memory:'` for tests.
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
- `packages/store/src/local/index.ts` — removed inline `formatSnapshot`; now imports and uses `SnapshotFormatter` from `@contexthub/core`.
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
- `packages/mcp/package.json` — `@contexthub/mcp` workspace package; deps: `@modelcontextprotocol/sdk ^1.0.0`, `simple-git ^3.27.0`, `zod ^3.23.0`, `@contexthub/core`, `@contexthub/store`.
- `packages/mcp/tsconfig.json` — extends `tsconfig.base.json`, same pattern as core/store.
- `packages/mcp/src/config.ts` — `loadConfig()` searches CWD upward for `.contexthub/config.json`, validates required `projectId`/`project` fields. Exports `ConfigNotFoundError`.
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
- MCP server not yet validated with `mcp dev` inspector — requires a live `.contexthub/config.json` + project in DB. Validation deferred to when `contexthub init` CLI command is built (Days 18–19).
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
- Days 14–15 (Week 3): `packages/cli/src/` — oclif CLI skeleton. Commands: `init` (creates `.contexthub/config.json` + project in DB), `commit` (engine.commit from CLI args), `context` (print formatted snapshot). Validate: `contexthub init`, `contexthub commit -m "msg"`, `contexthub context` all run end-to-end.
