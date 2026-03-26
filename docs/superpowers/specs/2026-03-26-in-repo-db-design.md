# In-Repo Context DB

**Date:** 2026-03-26
**Status:** Approved — ready for implementation

## Problem

ContextGit currently stores its SQLite DB at `~/.contextgit/projects/<projectId>.db` — outside
the repository. This means context history is machine-local: clone the repo on a new machine,
run `contextgit init`, and you start with a blank slate. The killer onboarding moment —
"clone and instantly see 3 months of development context" — is impossible with the current layout.

## Goal

Store the context DB at `.contextgit/context.db` inside the project directory so it travels
with the repo. Clone + `contextgit init` + `contextgit status` = full history, immediately.

## Constraints

- `contextgit init` must detect an existing `.contextgit/context.db` and use it — never overwrite it
- New projects get a fresh empty DB at the local path
- The external `~/.contextgit/projects/` path remains the fallback when no local DB is present (backward compat for projects initialized before this change)
- No automatic migration of existing external DBs — that is a separate step
- All CLI commands and MCP tools read from the in-repo DB
- Tests are unaffected — they use `new LocalStore(':memory:')`

## Approach: `resolveDbPath` helper + optional `dbPath` on LocalStore

Resolution logic lives in a pure function, testable independently. `LocalStore` accepts an
explicit path when provided. Callers that know the config directory pass the resolved path;
callers that don't get the old behavior.

## Design

### 1. Path Resolution — `packages/store/src/local/resolve-db-path.ts` (new)

```ts
export function resolveDbPath(projectId: string, configDir?: string): string
```

Rules:
1. `projectId === ':memory:'` → return `':memory:'`
2. `configDir` provided → return `join(configDir, 'context.db')` — always, unconditionally.
   SQLite creates the file on first open. The directory is guaranteed to exist because `init`
   calls `mkdirSync(configDir, { recursive: true })` before touching the DB.
3. No `configDir` → return `join(homedir(), '.contextgit', 'projects', `${projectId}.db`)`
   (old behavior, unchanged)

Pure function — no filesystem side effects. Exported from `packages/store/src/index.ts`.

### 2. `LocalStore` constructor — `packages/store/src/local/index.ts`

```ts
constructor(projectId: string, dbPath?: string)
```

- If `dbPath` is provided: use it directly. Skip internal path computation and `mkdirSync`.
  Parent directory must already exist (guaranteed by `init`).
- If no `dbPath`: existing logic unchanged — computes external path, calls `mkdirSync`.
- `:memory:` sentinel remains on the `projectId` param. Tests are unaffected.

### 3. `loadConfig()` — richer return type

Both `packages/mcp/src/config.ts` and `packages/cli/src/config.ts` change their return type:

```ts
interface LoadedConfig {
  config: ContextGitConfig
  configDir: string  // absolute path of the directory containing .contextgit/config.json
}
```

`findConfigPath` already walks up to find the config file — `configDir` is `dirname(configPath)`.
One call, everything the caller needs. All call sites destructure: `const { config, configDir } = loadConfig()`.

### 4. `patchGitignore(cwd)` — `packages/cli/src/lib/init-helpers.ts` (new helper)

Ensures `.contextgit/context.db` is not ignored by git.

Logic:
- If `.gitignore` doesn't exist in `cwd` → create it with the exception entry
- If `.gitignore` exists and already contains `!.contextgit/context.db` → return `'already-present'`
- Otherwise → append:
  ```
  # ContextGit — allow in-repo context DB
  !.contextgit/context.db
  ```

Returns `'patched' | 'already-present' | 'created'`. `init.ts` logs the result in the same
style as `writeClaude` and `writeSkills`.

Note: `patchGitignore` appends to the end of the file, which is correct — git processes
`.gitignore` rules top-to-bottom, so `!.contextgit/context.db` appearing after a `*.db` rule
correctly overrides it.

### 5. `init.ts` — `packages/cli/src/commands/init.ts`

**Fresh init path:**
1. `mkdirSync(configDir, { recursive: true })` — already happens
2. `const dbPath = resolveDbPath(projectId, configDir)`
3. `new LocalStore(projectId, dbPath)` — creates `.contextgit/context.db`
4. Write `config.json` — unchanged
5. `patchGitignore(cwd)` — new step, logged with the other init results

**Re-init path (config exists):**
- `const { config, configDir } = loadConfig()`
- `const dbPath = resolveDbPath(config.projectId, configDir)`
- `new LocalStore(config.projectId, dbPath)` — opens local DB, creates it if missing

### 6. MCP server — `packages/mcp/src/server.ts`

In `bootstrap()`:

```ts
const { config, configDir } = loadConfig()
const dbPath = resolveDbPath(config.projectId, configDir)
const store = config.store && config.store !== 'local'
  ? new RemoteStore(config.store)
  : new LocalStore(config.projectId, dbPath)
```

Everything else — `claimsStore`, engine init, branch resolution — unchanged.

### 7. CLI commands — mechanical update

All 13 commands that do `new LocalStore(config.projectId)` change to:

```ts
const { config, configDir } = loadConfig()
const store = new LocalStore(config.projectId, resolveDbPath(config.projectId, configDir))
```

Affected files: `status.ts`, `search.ts`, `commit.ts`, `log.ts`, `context.ts`, `branch.ts`,
`merge.ts`, `push.ts`, `pull.ts`, `claim.ts`, `unclaim.ts`, `remote-show.ts`, `set-remote.ts`.

### 8. ContextGit repo `.gitignore`

Add exception so the ContextGit project's own context DB is committed:

```
# ContextGit — allow in-repo context DB
!.contextgit/context.db
```

## File Change Summary

| File | Change |
|------|--------|
| `packages/store/src/local/resolve-db-path.ts` | New — pure path resolver |
| `packages/store/src/local/index.ts` | Optional `dbPath` param on constructor |
| `packages/store/src/index.ts` | Export `resolveDbPath` |
| `packages/mcp/src/config.ts` | `loadConfig()` returns `{ config, configDir }` |
| `packages/mcp/src/server.ts` | Use `configDir` + `resolveDbPath` in `bootstrap()` |
| `packages/cli/src/config.ts` | `loadConfig()` returns `{ config, configDir }` |
| `packages/cli/src/commands/init.ts` | Use local DB path, call `patchGitignore` |
| `packages/cli/src/lib/init-helpers.ts` | Add `patchGitignore()` |
| `packages/cli/src/commands/*.ts` (13 files) | Destructure `{ config, configDir }`, pass `dbPath` |
| `.gitignore` | Add `!.contextgit/context.db` exception |

## Testing

**`resolveDbPath` unit tests** (pure function, no DB):
- `:memory:` → returns `:memory:`
- `configDir` provided → returns `<configDir>/context.db`
- No `configDir` → returns path under `~/.contextgit/projects/`

**`patchGitignore` unit tests** (tmp dirs):
- No `.gitignore` → creates one with exception entry
- `.gitignore` exists, no `*.db` rule → appends exception
- `.gitignore` already has exception → `'already-present'`, file unchanged
- `.gitignore` has `*.db` → appends `!.contextgit/context.db`

**`loadConfig()` tests** — add assertion that `configDir` equals `dirname` of the config file.

**Existing tests** — no changes. All use `new LocalStore(':memory:')`.

## What This Enables

```bash
git clone https://github.com/org/project
cd project
contextgit init   # detects context.db, uses it
contextgit status # 3 months of history, instantly
```
