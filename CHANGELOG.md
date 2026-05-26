# Changelog

## 0.2.0 — 2026-05-22

A focused release implementing the three-tier memory model (DELTA spec `02`). Two independent audits — Claude Code usage and the GCC paper (Wu et al., arXiv:2508.00031v2) — pointed at the same defect: ContextGit stored too much of what git already knows and too little of what it doesn't. 0.2.0 fixes that.

### What changed for the user

**Open threads no longer accumulate.** Two failure modes are now structurally impossible: literal duplicates from re-saving the same subject (dedupe-on-save) and the unbounded list of months-old "watch for X" notes (TTL-expiring watch threads + commit-distance decay).

**The default load is curated, not exhaustive.** `project_memory_load` now returns only live open threads + a single honest count line:

```
(+12 stale, +7 expired-watch — call project_memory_threads to view)
```

Everything filtered out stays one tool call away via the new `project_memory_threads` tool.

**Volatile git facts are read live, never cached.** Branch, HEAD sha, and commit count are populated from `git` on every `project_memory_load`. Stale "3 commits on master" snapshots while on a feature branch 100 commits deep are impossible. The snapshot grows a `## Git` section:

```
## Git
Branch: feature/payments | HEAD: a1b2c3d4 | 47 commits
```

**The legacy `## Project State` block is removed.** The previous formatter wrapped the head commit's free-form `summary` prose under a `## Project State` heading at the top of every `project_memory_load`. That prose itself often contained its own markdown headings (`## Git`, `## Next concrete tasks`, …), producing duplicate sections and a stale top-level summary alongside the new live `## Git`. The curated load now emits only the live `## Git` facts + non-stale open threads + recent activity + active claims. The `projectSummary` field stays in `SessionSnapshot` for back-compat but is no longer rendered.

**A new fine tier for step-level reasoning.** The trace tier holds decisions considered and rejected, dead ends, "tried X, abandoned because Y" — the things that exist in no other system. It's pull-only. It is NEVER included in the default load. Two new tools:

- `project_memory_trace` — append a step-level note
- `project_memory_retrieve` (tier=`commits` | `trace`) — windowed scroll-back through either tier

**Open threads can be marked as `watch`.** Same call shape, additive:

```ts
threads.open = [
  'committed open thread',                              // → kind: 'open' (default)
  { subject: 'speculative reminder', kind: 'watch' },   // → TTL-expiring
]
```

Plain string still works — coerced to `{subject, kind:'open'}`. Watch notes drop silently from the load after their TTL (3 days or 15 branch commits, whichever first). Open threads decay to `stale` after a longer threshold (8 project commits or 30 branch commits) but stay retrievable.

### New MCP tools

| Tool | What it does |
|------|--------------|
| `project_memory_threads` | List threads with `filter='stale' \| 'expired-watch' \| 'live' \| 'all'`. Review what the default load filtered out. |
| `project_memory_retrieve` | Windowed scroll-back. `tier='commits' \| 'trace'`, `window` (default 10), `offset` (default 0). |
| `project_memory_trace` | Append a step-level reasoning note to the fine tier. Required `note`, optional `git_commit_sha`. |

### Changed MCP tools

- `project_memory_load` accepts a new optional `commit_window` (default 5; replaces the previous hardcoded 3).

### Migrations

Four automatic SQLite migrations apply on first use (`v6`, `v7`, `v8`, `v9`). No manual step required.

- `v6` — `threads.kind` (default `'open'`) + `threads.last_touched_commit`
- `v7` — new `trace` table with indexes for windowed retrieval
- `v8` — new `thread_archive` table + one-time sweep of currently-stale threads
- `v9` — new `plan_nodes` table (planning hierarchy)

### Thread lifecycle and close ergonomics

**Stale threads are archived, not just hidden.** A new `thread_archive` table
stores threads that decay past staleness thresholds or whose watch TTL expires.
On the first 0.2.0 run, every currently-stale thread is swept into the archive
in a single migration transaction. Subsequent sweeps run at the end of every
`project_memory_save`. Archived threads are fully recoverable via
`project_memory_threads --restore`.

**Closing a thread is a one-step action.** Every thread in `project_memory_load`
output now carries a short 6-char handle. Close by handle, close by subject,
or pass `closes_threads: ['handle-or-subject', …]` on a save — the resolution
is atomic with the rest of the save (handle → subject → already-archived no-op
→ atomic error if still unresolved).

**Planning hierarchy.** ContextGit was conflating two different things in one
`threads` table: unresolved questions (which legitimately decay) and intended
work (which must never decay — it is either done or pending). A real incident
exposed this when the decay sweep archived planned next-steps. The fix: a new
`plan_nodes` table that holds a three-level plan→step→task hierarchy. Plan
nodes are structurally exempt from the decay sweep — they leave the active
view only by being marked `done`, never by aging out. The snapshot grows a
`## Plan` section between `## Git` and `## Open Threads`, with `→ next`
marking the first pending task — the single most useful line for any session
start. Two new tools: `project_memory_plan` (create or update a plan node)
and `project_memory_plans` (read, with `completed=true` and `plan=<handle>`
drill-in). `project_memory_save` gains `completes_tasks: ['handle-or-title',
…]` so a session-end save can check off its finished tasks in the same call,
atomically. Existing threads stay where they are; nothing migrates
automatically — rewrite a thread as a plan only when you mean to.

**Decay calibration: AND, not OR.** The first cut of the decay rule stale'd a
thread when EITHER recency OR commit-distance crossed threshold. On a
long-lived feature branch with 200+ commits unmerged, that meant every thread
older than 30 branch commits got archived regardless of when it was last
touched in wall-clock terms — and the one-time migration sweep emptied the
`threads` table. The new rule: **stale only when BOTH age AND distance fire**.
Distance alone never condemns a thread; recency must agree. New default age
threshold: 14 days of wall-clock inactivity (`staleOpenAgeMs`). Affected
installs can recover via `project_memory_threads restore_all_stale=true`
(restores rows archived as `stale-age` or `stale-distance`; leaves `manual`
and `watch-expired` alone).

**Save-rhythm rule corrected to commit-binding model.** 0.1.10 dropped the
"save every git commit" rule in favor of "save ~3x per session." A usage audit
disproved that — the save is bound to its commit, and that binding is the value.
The new rule, written into the `contextgit init` strings: save once per commit;
the body carries the decision, any abandoned approach (via `replan:`), and the
open question the commit raises — never a paraphrase of the diff. Re-run
`contextgit init` to pick up the new strings.

### Known scope

- LocalStore (the default SQLite backend) implements everything.
- Supabase and remote backends keep building but don't yet have dedupe-on-save, decay flags, or trace methods. These ship when team/remote use re-enters scope.

---

## 0.1.10 — 2026-05-22

### Bug fixes

**`@CLAUDE.contextgit.md` include now wired automatically**
On projects with a pre-existing `CLAUDE.md`, every `project_memory_save` was writing context to `CLAUDE.contextgit.md` but never linking it into `CLAUDE.md`. The next session had no way to load it — saves were write-only. Fixed: `project_memory_save` now prepends `@CLAUDE.contextgit.md` to your `CLAUDE.md` automatically on first run (idempotent). No manual step required.

**Save-rhythm guidance corrected**
The `context-commit` skill and `CLAUDE.md` fragment previously instructed the agent to call `project_memory_save` after every git commit. This produced noise — most saves just paraphrased the commit message. Fixed: the guidance now says to save at session end (always) and mid-session only when something git doesn't capture happens — a decision made, an approach abandoned, scope changed. The `PostToolUse` hook that fired on every `git commit` is removed. The `SessionStart` hook (mandatory `project_memory_load`) remains.

Note: the corrected guidance applies to new installs and re-inits. Existing installs keep their current hooks until `contextgit init` is re-run.

---

## 0.1.9 — 2026-04-10

### Bug fixes

**Snapshot deduplication**
Open threads were appearing twice in the `agents-md` snapshot format. Fixed by deduplicating on thread `id` before rendering.

**SessionStart hook replaces UserPromptSubmit**
The Claude Code hook that triggers `project_memory_load` now fires on `SessionStart` (once per session) instead of `UserPromptSubmit` (every message). Quieter, correct.

**`@CLAUDE.contextgit.md` import guidance**
When a project has a manually-maintained `CLAUDE.md`, `init` now tells you to add `@CLAUDE.contextgit.md` as the first line (Claude Code's import directive) rather than renaming your file.
