# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project
ContextGit is a persistent memory layer for AI agent workflows — solving the 
"amnesia problem" where agents lose context between sessions.

## Repository
GitHub: https://github.com/MendeTr/contextgit
Branch: main
Clone: git clone https://github.com/MendeTr/contextgit



## Session Start (do this every time)
Call context_get with scope=global immediately.
Do not read decisions.md. Do not ask questions first.
Read the snapshot. Then start working.
Do not ask what to work on. Start the highest priority item from the snapshot.
If unclear, follow the Phase 2 plan: docs/ContextGit_PHASE2_PLAN.md


## After EVERY completed task
git add .
git commit -m "feat/fix: <what was done>"
git push
context_commit "what was built | key decisions | next task"

Do not wait to be asked. Every completed task = immediate commit.
This applies to bug fixes, feature additions, and refactors alike.

## Session End (do this every time)
Call context_commit with:
- what was built
- key decisions and why
- open threads
- the first concrete task for the next session
Then: git add . && git commit -m "..." && git push
```

Then commit everything:
```bash
git add .
git commit -m ": "
git push
```
## When scope changes mid-session
1. Write a context_commit with replan: prefix immediately:
   context_commit "replan: <what changed and why. what is new scope. what is no longer in scope>"
2. Then build the new scope
3. Write a normal context_commit when done

Do not build first and replan after. Replan commit must come first.
Other agents are reading the snapshot in real time.
## Commit Convention
- `feat:` new functionality
- `feat(package):` scoped to a package e.g. `feat(core):`
- `fix:` bug fix
- `chore:` config, tooling, deps
- `docs:` documentation only
- `test:` tests only

## Commands
```bash
pnpm install          # install dependencies
pnpm build            # build all packages
pnpm test             # run all tests
pnpm test:watch       # watch mode
pnpm typecheck        # type check all packages

# Single package
cd packages/store && pnpm test
```

Node.js >=20 and pnpm >=9 required.

## Architecture

Strict dependency graph — no circular deps:
```
core → @anthropic-ai/sdk, @xenova/transformers, nanoid
store → core (types only), better-sqlite3, sqlite-vec
mcp → core, store, @modelcontextprotocol/sdk, simple-git
cli → core, store, @oclif/core
api → core, store, express
```

### Packages
- **`@contextgit/core`** — types, engine, summarizer, snapshot formatter, embeddings
- **`@contextgit/store`** — ContextStore interface + LocalStore (SQLite)
- **`packages/mcp`** — MCP server (Week 3)
- **`packages/cli`** — oclif CLI (Week 3)
- **`packages/api`** — Express REST API (Week 4)

### Storage layer (`packages/store/src/local/`)
| File | Role |
|------|------|
| `schema.ts` | DDL — tables, sqlite-vec, FTS5, indexes |
| `migrations.ts` | Versioned migration runner |
| `queries.ts` | All prepared statements + row→domain converters |
| `index.ts` | LocalStore implementing ContextStore |

### Key Rules (never break these)
- TEXT primary keys via `nanoid()` — never auto-increment integers
- `better-sqlite3` sync API wrapped in `Promise.resolve()` at interface boundary
- Open threads **never** passed to summarizer — immune to compression guarantee
- Never fail a COMMIT due to summarizer — graceful fallback always
- DB path: `~/.contextgit/projects/<projectId>.db` — tests use `:memory:`
- sqlite-vec loaded via `createRequire` shim — load failure degrades gracefully

### Domain Model
`Project → Branch → Commit` core hierarchy.
`Thread` tracks open questions scoped to a project.
`Agent` records active agents per project.
All types in `packages/core/src/types.ts`.

## TypeScript
All packages extend `tsconfig.base.json`. Target: ES2022, module: NodeNext, 
strict mode, declaration maps, source maps. Output: `./dist` per package.

## Tests
Vitest, in-memory SQLite. Each test file closes DB in `afterEach`.
Root vitest config collects `packages/*/src/**/*.test.ts`.

## Key Docs
- `docs/decisions.md` — session history (read this first)
- `docs/ContextGit_PHASE1_PLAN.md` — current build plan
- `docs/ContextGit_ARCHITECTURE_v3.md` — full architecture
- `docs/ContextGit_PRD_v4.md` — product requirements