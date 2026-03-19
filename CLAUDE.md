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
Call project_memory_load (or context_get) with scope=global immediately.
Do not read decisions.md. Do not ask questions first.
Read the snapshot. Then start working.
Do not ask what to work on. Start the next specific task from the snapshot.
Start the next specific task — not an entire feature or milestone.
One task per session unless it is trivially small.
If unclear, follow the current plan in the snapshot or docs/.

## What counts as a completed task (commit after EACH of these)
- One file edited with a schema/DDL change
- One migration added
- One type added or modified
- One query or store method added
- One interface method added
- One MCP tool parameter added
- One formatter change
- Any test file added or passing

Do NOT batch multiple steps into one commit. One step = one commit.
If you are working from a numbered plan, each numbered step = one commit.

## After EVERY completed task

Do not wait to be asked. Every git commit = immediate context commit.
Do not proceed to the next task until both are done.

1. `git add . && git commit -m "feat/fix: <what was done>"`
2. Call `project_memory_save` immediately after with:
   - One-line summary of what was done
   - What was decided and why
   - What was built (files changed, approach taken)
   - Open questions
   - Git branch and commit hash
   - The next concrete task

These two always go together. Never git commit without a context commit.
After each git commit, IMMEDIATELY call project_memory_save before writing any code for the next task.
Failure mode to avoid: batching multiple git commits before calling project_memory_save once.

## Commit Pairing Check

Before starting any new task, verify:
- Last git commit has a matching project_memory_save
- project_memory_save was called AFTER the git commit, not before

If using executing-plans or subagent-driven-development skills, each numbered plan step = one git commit + one project_memory_save, in that order, before the next step begins.

## Session End (do this every time)
Call project_memory_save (or context_commit) with:
- what was built
- key decisions and why
- open threads
- the first concrete task for the next session

Then:
```bash
git add .
git commit -m "<type>: <summary>"
git push
```

Do not end a session without a context commit. The next session starts blind without it.

## When scope changes mid-session
1. Write a project_memory_save with replan: prefix immediately:
   `project_memory_save "replan: <what changed and why. what is new scope. what is no longer in scope>"`
2. Then build the new scope
3. Write a normal context commit when done

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
- **`@contextgit/store`** — ContextStore interface + LocalStore (SQLite) + SupabaseStore (Postgres + pgvector)
- **`packages/mcp`** — MCP server
- **`packages/cli`** — oclif CLI
- **`packages/api`** — Express REST API

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
`Claim` tracks active task claims per agent per branch.
All types in `packages/core/src/types.ts`.

## TypeScript
All packages extend `tsconfig.base.json`. Target: ES2022, module: NodeNext, 
strict mode, declaration maps, source maps. Output: `./dist` per package.

## Tests
Vitest, in-memory SQLite. Each test file closes DB in `afterEach`.
Root vitest config collects `packages/*/src/**/*.test.ts`.

## Key Docs
- `docs/decisions.md` — session history (read this first)
- `docs/ContextGit_PHASE2_PLAN.md` — Phase 2 build plan (completed)
- `docs/ContextGit_DELTA_multiagent.md` — multi-agent delta spec
- `docs/ContextGit_ARCHITECTURE_v3.md` — full architecture
- `docs/ContextGit_PRD_v4.md` — product requirements