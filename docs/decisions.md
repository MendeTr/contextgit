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
