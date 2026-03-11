# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project
ContextHub is a persistent memory layer for AI agent workflows — solving the 
"amnesia problem" where agents lose context between sessions.

## Repository
GitHub: https://github.com/MendeTr/contexthub
Branch: main
Clone: git clone https://github.com/MendeTr/contexthub



## Session Start (do this every time)
1. Read `docs/decisions.md` — find the LAST entry, read **Next**
2. Read `docs/ContextHub_PHASE1_PLAN.md` — know where today fits in the full plan
3. Scan ALL previous **Decided** sections for anything relevant to today's work
4. Read the actual source files you'll be touching before writing anything
5. If unsure about architecture — read `docs/ContextHub_ARCHITECTURE_v3.md`
6. Do not re-do completed work

## Session End (do this every time)
Summarize the session and append to `docs/decisions.md` using this format:
```
## Session: <date> #<n>
**Built:** what was implemented
**Decided:** key decisions and why
**Unresolved:** open questions or blockers
**Next:** the first thing to do in the next session
**Tokens:** total tokens used this session (check Claude Code session stats)
**Ramp-up:** how many clarifying questions asked before starting real work
**Time to first code:** time from session start to first real implementation

```

Then commit everything:
```bash
git add .
git commit -m ": "
git push
```

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
- **`@contexthub/core`** — types, engine, summarizer, snapshot formatter, embeddings
- **`@contexthub/store`** — ContextStore interface + LocalStore (SQLite)
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
- DB path: `~/.contexthub/projects/<projectId>.db` — tests use `:memory:`
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
- `docs/ContextHub_PHASE1_PLAN.md` — current build plan
- `docs/ContextHub_ARCHITECTURE_v3.md` — full architecture
- `docs/ContextHub_PRD_v4.md` — product requirements