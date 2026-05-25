# Thread Lifecycle & Close Ergonomics — Design

**Date:** 2026-05-25
**Status:** Design approved; ready for implementation plan
**Target version:** Folded into the un-published 0.2.0 (no version bump; single 0.2.x publish)
**Parent spec:** [docs/03_ContextGit_DELTA_thread_lifecycle.md](../../03_ContextGit_DELTA_thread_lifecycle.md)
**Scope:** `packages/core`, `packages/store`, `packages/mcp`, `packages/cli`

---

## Goal

Close the three defects a Claude Code audit of the built (un-published) 0.2.0 surfaced, before first npm publish:

1. **Thread graveyard.** 17 live + 108 stale threads. Decay filters them from the default load, but nothing ever empties the graveyard.
2. **Close friction.** Closing a thread needs an ID the load doesn't surface cleanly, so threads are never closed by hand — they accumulate.
3. **Saves still duplicate git.** Third audit witness that saves paraphrase commit messages despite the 0.1.10 save-rhythm rewrite.

Goal in one sentence: **make the open-thread set bounded, the close path one-step, and the save rhythm self-evident — so the agent does the right thing without ceremony.**

This is a patch, not a redesign. The 0.2.0 architecture (three tiers, decay, watch TTLs) stays exactly as it is.

---

## Decisions resolved during brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Ongoing archival timing | Sweep at the end of every `project_memory_save` | Predictable, write-event-coupled, no manual prune step. ~17 live + 108 stale at current scale → single-digit ms overhead. |
| Short handle format | First 6 chars of nanoid id | With 64-char alphabet, ~68 billion combos — collision impossible at any realistic project size. No new column, no uniqueness check. |
| Handle matching | Exact 6-char prefix | Deterministic, simple. Rejects partial matches that would invite ambiguity. |
| `closesThreads` resolution | Handle-first, fall back to subject; **error loudly on no-match** | Two queries per string is cheap. Silent no-op on close is the worst failure mode (agent thinks thread closed, it's still open). |
| `closesThreads` atomicity | Whole save fails if any close target doesn't resolve | One transaction, no partial state. Loud failure beats half-closed silently. |
| Version handling | Ship all 3 fixes as the single 0.2.0 publish | User explicitly does not want multiple publishes per day; 0.2.0 has not yet reached npm so folding the patch in costs nothing. |

---

## Data model

### New table — `thread_archive`

Migration **v8**:

```sql
CREATE TABLE thread_archive (
  -- mirrors threads exactly (same columns, same id)
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  branch_id           TEXT NOT NULL,
  description         TEXT NOT NULL,
  status              TEXT NOT NULL,   -- 'open' | 'closed' at archive time
  kind                TEXT NOT NULL,   -- 'open' | 'watch'
  workflow_type       TEXT,
  opened_in_commit    TEXT NOT NULL,
  last_touched_commit TEXT,
  closed_in_commit    TEXT,
  closed_note         TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER,
  -- archive-only
  archived_at         INTEGER NOT NULL,
  archived_reason     TEXT NOT NULL    -- 'stale-age' | 'stale-distance' | 'watch-expired' | 'manual'
);
CREATE INDEX idx_thread_archive_project ON thread_archive(project_id);
```

The `threads` schema is **unchanged**. Archival is a row move between tables, not a soft-delete column.

### One-time sweep at the end of the v8 migration

Single transaction:

1. Iterate every row in `threads` and apply `classifyThread` (already exists from 0.2.0).
2. For every row classified `stale` or `expired`: `INSERT INTO thread_archive (...) VALUES (...); DELETE FROM threads WHERE id = ?`.
3. `archived_reason` follows the classification: `stale-age`, `stale-distance`, or `watch-expired`.

After v8 runs the current ~108 stale threads are gone from `threads`; the default load shows only live threads and the `+N stale` hint reads 0.

### Type additions

`packages/core/src/types.ts`:

```ts
export type ArchivedReason = 'stale-age' | 'stale-distance' | 'watch-expired' | 'manual'

export interface ArchivedThread extends Thread {
  archivedAt: Date
  archivedReason: ArchivedReason
}
```

`project_memory_save` input gains:

```ts
closesThreads?: string[]   // handles or subjects; atomic resolution
```

---

## Sweep-on-save flow

A new store method:

```ts
sweepStaleThreads(projectId: string, now: number): {
  archived: number
  byReason: Record<'stale-age' | 'stale-distance' | 'watch-expired', number>
}
```

Called from inside `project_memory_save`'s transaction, **after** the new commit row is inserted and any thread opens/closes are processed. Same transaction:

- Save commit insert ✓
- Process `opensThreads` ✓
- Process `closesThreads` ✓
- `sweepStaleThreads` ✓
- Commit transaction ✓

If any step fails, the whole save rolls back. The sweep runs silently — its archive counts are not surfaced in the save response (would require changing `createCommit`'s return type, deferred). The agent can inspect what was swept via `project_memory_threads filter='archived'` after the save.

Sweep cost per save: one `SELECT * FROM threads WHERE project_id = ?` plus `classifyThread` per row plus an archive move for any decayed rows. At 17 live + 108 stale → first save archives 108 in one transaction; subsequent saves process ~17 rows, single-digit ms.

---

## Close + restore paths

### `project_memory_threads` tool — new flags

The existing `filter` parameter stays. New mutually-exclusive action flags:

| Flag | Behavior |
|---|---|
| `--close <handle>` | Look up by exact 6-char prefix on the current project's `threads`. Move row to `thread_archive` with `archived_reason='manual'` and `closed_in_commit=<HEAD>`. Error loudly on no match or multiple matches. |
| `--close-subject "<text>"` | Apply `normalizeThreadSubject` (already exists). Match against open threads on this project. Move to archive. Error loudly on no match. |
| `--restore <handle>` | 6-char prefix match against `thread_archive`. Move row back to `threads`, clearing `archived_at` / `archived_reason`. Error loudly on no match or multiple matches. |

The `filter` parameter gains a new value:

| `filter` | Behavior |
|---|---|
| `'archived'` | List rows from `thread_archive` with handles, reasons, and archivedAt. |

Existing filters (`'stale' | 'expired-watch' | 'live' | 'all'`) stay. After the v8 sweep + sweep-on-save logic, `'stale'` and `'expired-watch'` will normally be empty because decayed threads move to `thread_archive` immediately. They remain useful for the brief window between a thread crossing a threshold and the next save.

### `closesThreads` on `project_memory_save` — atomic resolution

For each string in the array:

1. Try as handle: 6-char prefix lookup against `threads` on this project.
2. If no handle match: normalize and try as subject against open threads.
3. If neither matches in `threads`: check `thread_archive` by handle. If the thread is **already archived** (decayed between load and save), treat as a no-op success — the agent's intent ("this thread is no longer open") is already true. The save response notes `"closesThreads: 'abc123' was already archived"`.
4. If neither matches in `threads` **and** not present in `thread_archive`: **the entire save fails** with an error listing every unresolved string —
   `closesThreads: no thread matched 'abc123' (tried as handle, subject, and archive)`.

On success, every newly-resolved thread (those still in `threads`) moves to `thread_archive` with `archived_reason='manual'` and `closed_in_commit=<this new commit's id>`, all in the same transaction as the commit insert and the sweep.

### Store interface additions

In `ContextStore` (and `LocalStore` impl):

```ts
archiveThread(threadId: string, reason: ArchivedReason, closedInCommit?: string): Promise<ArchivedThread>
restoreThread(threadId: string): Promise<Thread>
listArchivedThreads(projectId: string): Promise<ArchivedThread[]>
findOpenThreadByHandle(projectId: string, handle: string): Promise<Thread | undefined>
findArchivedThreadByHandle(projectId: string, handle: string): Promise<ArchivedThread | undefined>
sweepStaleThreads(projectId: string, now: number): Promise<{ archived: number; byReason: Record<Exclude<ArchivedReason, 'manual'>, number> }>
```

`SupabaseStore` and `RemoteStore` get stubs that throw `"not implemented in 0.2.0"` — consistent with the existing 0.2.0 "Known scope" carve-out.

---

## Short handle surface in the snapshot formatter

`packages/core/src/snapshot.ts` — both `agents-md` and `text` branches prepend a 6-char handle to each thread line.

**agents-md:**
```
## Open Threads
- [a1b2c3] [FREE] Need to add rate limiting to payment endpoints  (opened 5/21, interactive)
- [d4e5f6] [CLAIMED by studio-mcp-agent] Build invoice PDF generation  (opened 5/20, interactive)
```

**text:**
```
=== OPEN THREADS ===
[a1b2c3] [FREE] Need to add rate limiting to payment endpoints  (opened 5/21, interactive)
[d4e5f6] [CLAIMED by studio-mcp-agent] Build invoice PDF generation  (opened 5/20, interactive)
```

Handle is `thread.id.slice(0, 6)` — pure render-time derivation. No new `SessionSnapshot` field.

`project_memory_threads --archived` output uses the same `[handle]` format so restore by handle is natural.

---

## Save-rhythm strings — commit-binding model (corrects 02)

**This is a rewrite, not an insertion.** Per the upstream 03 spec amendment (commit `f9557e6`), 02's "save ~3x per session, only when state changes git can't capture" rule is **wrong** and must be **removed**. The save is bound to its commit; that binding is the value. Save **per commit**, body carries intent.

Two strings in [packages/cli/src/lib/init-helpers.ts](../../../packages/cli/src/lib/init-helpers.ts) need rewriting — `CLAUDE_MD_FRAGMENT` and `CONTEXT_COMMIT_SKILL`. (The third string mentioned in the upstream spec, `CONTEXTGIT_HOOKS`, no longer contains save-rhythm prose — the PostToolUse hook was removed in 0.1.10 and only the SessionStart hook remains, which is unrelated.)

In `CLAUDE_MD_FRAGMENT`:
- **Delete** the `## When to save context` section (the 02-rhythm 3-saves-per-session text).
- **Delete** the `## Session End (do this every time)` section.
- **Insert** a single new `## When to save context` section with the commit-binding model.
- Keep `## Session Start`, `## Before risky exploration`, `## Before starting a task (multi-agent)`, and `## When scope changes mid-session` (the latter integrates with the new model via the `replan:` prefix).

Replacement section:

```markdown
## When to save context

Save once per commit. Every git commit deserves a paired \`project_memory_save\`.
Skipping commits leaves their history blind — the diff survives, the *reason*
does not. The save's body is what makes the commit binding worth pulling in
three weeks.

What the save body carries:
- The **decision** behind the change — why this approach, not the other.
- Any **approach abandoned** along the way (use \`replan:\` prefix if scope shifted).
- The **open question** the commit raises — what is still unresolved.

The body is NOT a restatement of the diff. Git already has the diff.

Bad save: "Implemented apiFetch wrapper" — paraphrases the commit; git has it.

Good save: "apiFetch wrapper — chose X-User-Id header over cookie auth because
the extension can't share the host session cookie. Open: needs 401 handling."
```

In `CONTEXT_COMMIT_SKILL`:
- **Rewrite the `description:` frontmatter field** — currently embodies 02's rule, needs to embody commit-binding. New text:
  > `"Save project memory once per git commit. Every commit deserves a paired save; the body carries what git cannot reconstruct — the decision behind the change, any approach abandoned (use replan: prefix), the open question the commit raises. The body is never a paraphrase of the diff."`
- **Delete** the `## When to save context` section.
- **Insert** the same replacement section as in `CLAUDE_MD_FRAGMENT` above.

**Existing installs are not touched.** The user's local `.claude/skills/context-commit/SKILL.md` and `CLAUDE.md` fragment update only on the next `contextgit init` re-run. The CHANGELOG notes that explicitly.

---

## CHANGELOG entry

The existing 0.2.0 entry gains one new themed paragraph block after "Known scope":

```markdown
### Thread lifecycle and close ergonomics

**Stale threads are archived, not just hidden.** A new `thread_archive` table
stores threads that decay past staleness thresholds or whose watch TTL expires.
On the first 0.2.0 run, every currently-stale thread is swept into the archive
in a single migration transaction. Subsequent sweeps run at the end of every
`project_memory_save`. Archived threads are fully recoverable via
`project_memory_threads --restore`.

**Closing a thread is a one-step action.** Every thread in `project_memory_load`
output now carries a short 6-char handle. Close by handle, close by subject,
or pass `closesThreads: ['handle-or-subject', …]` on a save — the resolution
is atomic with the rest of the save.

**Save-rhythm rule corrected to commit-binding model.** 0.1.10 dropped the
"save every git commit" rule in favor of "save ~3x per session." A usage audit
disproved that — the save is bound to its commit, and that binding is the value.
The new rule, written into the `contextgit init` strings: save once per commit;
the body carries the decision, any abandoned approach (via `replan:`), and the
open question the commit raises — never a paraphrase of the diff. Re-run
`contextgit init` to pick up the new strings.
```

Migration list in the entry gains v8.

---

## Tests

| File | Coverage |
|---|---|
| `packages/store/src/local/thread-archive.test.ts` (new) | v8 migration sweep moves classified-stale rows; `archiveThread` / `restoreThread` / `listArchivedThreads`; handle-prefix lookup against both tables; `sweepStaleThreads` integration |
| `packages/store/src/local/local-store.test.ts` (augment) | `project_memory_save` with `closesThreads`: handle match, subject match, no-match aborts the whole save, sweep runs in same transaction |
| `packages/core/src/snapshot.test.ts` (augment) | Short handle appears before `[FREE]`/`[CLAIMED]` in both formats; handle is exactly 6 chars; handle equals `id.slice(0, 6)` |
| `packages/cli/src/lib/init-helpers.test.ts` (augment) | New "What a save is for" section present in `CLAUDE_MD_FRAGMENT`, `CONTEXT_COMMIT_SKILL`, and the hook `additionalContext`; "Bad save" and "Good save" examples both present |

No new test framework, no new fixtures — Vitest + in-memory SQLite as already established.

---

## MCP server changes

`packages/mcp/src/server.ts`:

- `project_memory_threads` tool: register `close`, `close_subject`, `restore` parameters; register `'archived'` as a valid `filter` value.
- `project_memory_save` tool: register `closes_threads: string[]` parameter; pass through to the store call; include the sweep result counts in the response payload.
- Tool descriptions updated for both.

No changes to other MCP tools.

---

## Out of scope (explicit)

- **Multi-agent claim system stays untouched.** Inert, not broken; deliberate groundwork for the parked team layer.
- **No auto-close on commit message reference.** Deferred since 0.2.0; Fix 2 makes manual close cheap enough that auto-close is no longer urgent.
- **No trace-tier changes.** 0.2.0's trace tier ships as-is.
- **No Supabase/remote backend parity.** Stubs throw "not implemented", consistent with 0.2.0's existing carve-out.
- **No retroactive update of existing `.claude/skills/context-commit/SKILL.md` or in-tree `CLAUDE.md`.** The strings update only on the next `contextgit init` re-run.

---

## Validation gate

Folded into 0.2.0 (no separate gate). Re-audit on fresh install must show:

1. First load executes the sweep — ~108 stale threads are now in `thread_archive`; default load shows no large `+N stale` hint.
2. `project_memory_load` shows a 6-char handle next to each live thread.
3. Closing a thread by handle, by subject, and via `closesThreads` on a save all work and move the row to `thread_archive`.
4. `project_memory_threads --restore <handle>` brings an archived thread back.
5. `filter='archived'` lists archived threads with handles + reasons.
6. Save-rhythm strings in a freshly `init`-ed project contain the new "What a save is for" section with both Bad/Good examples.
7. Archived threads never appear in a normal default load.

If 1–7 hold, publish 0.2.0.
