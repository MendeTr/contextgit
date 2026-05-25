# Thread Lifecycle & Close Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empty the thread graveyard via an archive table + sweep-on-save, make closing a thread a one-step action via 6-char handles + `closesThreads` on save, and add a Bad/Good save example to the save-rhythm strings — all folded into the un-published 0.2.0.

**Architecture:** New `thread_archive` SQLite table mirroring `threads` plus `archived_at` and `archived_reason` columns. Migration v8 creates the table and runs a one-time sweep that moves currently-stale rows. The same sweep logic runs at the tail end of every `project_memory_save` transaction so newly-stale threads never accumulate. The MCP `project_memory_save` tool gains a `closes_threads: string[]` parameter that resolves each entry handle-first (6-char prefix on `threads.id`), then by normalized subject, then by handle against `thread_archive` (no-op if already archived); the entire save fails atomically if any entry stays unresolved. The snapshot formatter prepends a 6-char handle to every thread line so the close path has a copy-pasteable identifier. The `project_memory_threads` MCP tool gains close-by-handle, close-by-subject, restore, and `filter='archived'`. The save-rhythm strings in `packages/cli/src/lib/init-helpers.ts` gain a "What a save is for" section with Bad/Good examples.

**Tech Stack:** TypeScript, better-sqlite3 (sync, wrapped in `Promise.resolve()` at interface boundary), nanoid for IDs, Vitest with in-memory SQLite for tests, `@modelcontextprotocol/sdk` for the MCP server, zod for tool schemas.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/types.ts` | Modify | Add `ArchivedReason` type + `ArchivedThread` interface; add `closes` field to `CommitInput.threads` accepting `string[]` (handles or subjects). |
| `packages/store/src/local/schema.ts` | Modify | Add `CREATE_THREAD_ARCHIVE`, `SCHEMA_V8_DDL`. |
| `packages/store/src/local/migrations.ts` | Modify | Register migration v8: create `thread_archive`, then run one-time sweep. |
| `packages/store/src/local/queries.ts` | Modify | Add `archiveThread`, `restoreThread`, `listArchivedThreads`, `findOpenThreadByHandle`, `findArchivedThreadByHandle`, `sweepStaleThreads`. Convert `closeThread` callers to use `archiveThread('manual', …)` instead. |
| `packages/store/src/local/thread-archive.test.ts` | Create | Unit tests for v8 migration sweep, archive/restore round-trip, handle lookups, sweep-on-save behavior. |
| `packages/store/src/local/index.ts` | Modify | `LocalStore.createCommit`: resolve `threads.closes` (handle/subject/archive), archive resolved threads, then run sweep — all in the same transaction. Add `archiveThread`, `restoreThread`, `listArchivedThreads`, `findOpenThreadByHandle`, `findArchivedThreadByHandle` pass-throughs to the interface. |
| `packages/store/src/local/local-store.test.ts` | Modify | Add cases: `createCommit` with `threads.closes` matching handle, matching subject, hitting an already-archived row, and erroring atomically on no match. |
| `packages/store/src/interface.ts` | Modify | Add the 5 new optional methods to `ContextStore`. |
| `packages/store/src/supabase/index.ts` | Modify | Stub the 5 new methods with `throw new Error('not implemented in 0.2.0')`. |
| `packages/store/src/remote/index.ts` | Modify | Same stubs as Supabase. |
| `packages/core/src/snapshot.ts` | Modify | Prepend `[<6-char-handle>]` to each thread line in both `agents-md` and `text` outputs. |
| `packages/core/src/snapshot.test.ts` | Modify | Assert handle appears, is exactly 6 chars, equals `thread.id.slice(0, 6)`. |
| `packages/cli/src/lib/init-helpers.ts` | Modify | Add "What a save is for" section to `CLAUDE_MD_FRAGMENT`, `CONTEXT_COMMIT_SKILL`, and the hook `additionalContext` strings. |
| `packages/cli/src/lib/init-helpers.test.ts` | Modify | Assert "What a save is for", "Bad save", and "Good save" appear in each of the three strings. |
| `packages/mcp/src/server.ts` | Modify | Rename `close_thread_ids` → `closes_threads` on `project_memory_save`; add `close`, `close_subject`, `restore` params and `'archived'` filter value to `project_memory_threads`. |
| `CHANGELOG.md` | Modify | Add "Thread lifecycle and close ergonomics" paragraph block under the 0.2.0 entry; list migration v8. |

---

## Task 1: Core types — `ArchivedReason`, `ArchivedThread`, `CommitInput.threads.closes`

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: covered indirectly by store tests in later tasks (this is a type-only change)

- [ ] **Step 1: Add the new types**

Open `packages/core/src/types.ts`. Locate the `Thread` interface (around line 100). Immediately after it, add:

```ts
export type ArchivedReason = 'stale-age' | 'stale-distance' | 'watch-expired' | 'manual'

export interface ArchivedThread extends Thread {
  archivedAt: Date
  archivedReason: ArchivedReason
}
```

Locate the `CommitInput` interface's `threads` field (currently `{ open?: ThreadOpenInput[]; close?: Array<{ id: string; note: string }> }`). Add a `closes?: string[]` sibling so the final shape is:

```ts
  threads?: {
    open?: ThreadOpenInput[]
    close?: Array<{ id: string; note: string }>     // legacy: direct-ID close, still works
    closes?: string[]                                // 03 DELTA: handles or subjects (atomic close)
  }
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @contextgit/core build`
Expected: clean tsc output, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add ArchivedReason, ArchivedThread, CommitInput.threads.closes"
```

---

## Task 2: Schema v8 DDL

**Files:**
- Modify: `packages/store/src/local/schema.ts`

- [ ] **Step 1: Add the DDL constants**

At the bottom of `packages/store/src/local/schema.ts`, after the `SCHEMA_V7_DDL` export, append:

```ts
// Migration v8 adds the thread_archive table — receives threads decayed past
// staleness thresholds, expired watch notes, and manually-closed threads.
// Mirrors the threads schema column-for-column, then adds archived_at and
// archived_reason. The threads table never accumulates closed/stale rows after v8.
export const CREATE_THREAD_ARCHIVE = `
CREATE TABLE IF NOT EXISTS thread_archive (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  branch_id           TEXT NOT NULL REFERENCES branches(id),
  description         TEXT NOT NULL,
  status              TEXT NOT NULL,
  kind                TEXT NOT NULL,
  workflow_type       TEXT,
  opened_in_commit    TEXT NOT NULL REFERENCES commits(id),
  last_touched_commit TEXT REFERENCES commits(id),
  closed_in_commit    TEXT REFERENCES commits(id),
  closed_note         TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER,
  archived_at         INTEGER NOT NULL,
  archived_reason     TEXT NOT NULL
)
`

export const SCHEMA_V8_DDL = [
  CREATE_THREAD_ARCHIVE,
  `CREATE INDEX IF NOT EXISTS idx_thread_archive_project ON thread_archive(project_id, archived_at DESC)`,
]
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @contextgit/store build`
Expected: clean tsc output. (The migration runner doesn't reference the new constant yet — that's Task 3.)

- [ ] **Step 3: Commit**

```bash
git add packages/store/src/local/schema.ts
git commit -m "feat(store): migration v8 schema — thread_archive table"
```

---

## Task 3: Register migration v8 (schema only, no sweep yet)

**Files:**
- Modify: `packages/store/src/local/migrations.ts`
- Test: `packages/store/src/local/thread-archive.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/store/src/local/thread-archive.test.ts`:

```ts
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from './migrations.js'

describe('thread_archive table (v8 migration)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates the thread_archive table', () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='thread_archive'`)
      .get() as { name: string } | undefined
    expect(row?.name).toBe('thread_archive')
  })

  it('records v8 in _migrations', () => {
    const versions = (
      db.prepare(`SELECT version FROM _migrations ORDER BY version`).all() as { version: number }[]
    ).map((r) => r.version)
    expect(versions).toContain(8)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts`
Expected: FAIL — both tests fail because v8 isn't registered yet.

- [ ] **Step 3: Register migration v8**

Open `packages/store/src/local/migrations.ts`. Update the import on line 2 to add `SCHEMA_V8_DDL`:

```ts
import { SCHEMA_V1_DDL, SCHEMA_V2_DDL, SCHEMA_V3_DDL, SCHEMA_V4_DDL, SCHEMA_V5_DDL, SCHEMA_V6_DDL, SCHEMA_V7_DDL, SCHEMA_V8_DDL, CREATE_COMMIT_EMBEDDINGS } from './schema.js'
```

Append a new entry to the `MIGRATIONS` array (after the v7 entry, before the closing `]`):

```ts
  {
    version: 8,
    name: 'thread_archive',
    run(db) {
      for (const sql of SCHEMA_V8_DDL) {
        db.exec(sql)
      }
      // One-time sweep is added in Task 4 — this version creates the empty table only.
    },
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/migrations.ts packages/store/src/local/thread-archive.test.ts
git commit -m "feat(store): register migration v8 — thread_archive table"
```

---

## Task 4: Migration v8 one-time sweep

**Files:**
- Modify: `packages/store/src/local/migrations.ts`
- Test: `packages/store/src/local/thread-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/store/src/local/thread-archive.test.ts` (inside the `describe` block, after the existing tests):

```ts
  it('one-time sweep moves currently-stale threads to thread_archive on first v8 run', () => {
    // Note: this test exercises v8 fresh — runMigrations already ran in beforeEach,
    // so we close and re-open with seeded data on the v7 schema first.
    db.close()
    db = new Database(':memory:')

    // Manually apply v1-v7 only (no v8) so we can seed stale rows on the v7 schema.
    // Simulate by stripping v8 from the migrations array would be brittle — instead,
    // just run all migrations (v8 included with empty thread_archive), then seed a
    // thread directly into the archive-eligible state and re-run the sweep helper.
    runMigrations(db)

    // Seed minimal project + branch + commit + thread
    const now = Date.now()
    const old = now - 365 * 24 * 60 * 60 * 1000 // a year ago — guaranteed stale-age
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p1', 'proj', old)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b1', 'p1', 'main', 'main', 'active', old)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c1', 'b1', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', old)
    db.prepare(
      `INSERT INTO threads (id, project_id, branch_id, description, status, kind, opened_in_commit, last_touched_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t1', 'p1', 'b1', 'old thread', 'open', 'open', 'c1', 'c1', old)

    // Run the standalone sweep helper that v8 invokes
    const { sweepStaleThreadsOnMigration } = require('./migrations.js') as {
      sweepStaleThreadsOnMigration: (db: Database.Database, now: number) => number
    }
    const moved = sweepStaleThreadsOnMigration(db, now)

    expect(moved).toBeGreaterThanOrEqual(1)

    const inThreads = db.prepare(`SELECT id FROM threads WHERE id = 't1'`).get()
    const inArchive = db.prepare(`SELECT id, archived_reason FROM thread_archive WHERE id = 't1'`).get() as { id: string; archived_reason: string } | undefined
    expect(inThreads).toBeUndefined()
    expect(inArchive?.id).toBe('t1')
    expect(['stale-age', 'stale-distance']).toContain(inArchive?.archived_reason)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts`
Expected: FAIL — `sweepStaleThreadsOnMigration` is not exported.

- [ ] **Step 3: Implement the sweep helper and fold it into v8**

Open `packages/store/src/local/migrations.ts`. Add this import at the top (after existing imports):

```ts
import { classifyThread } from '@contextgit/core'
import type { Thread } from '@contextgit/core'
```

Add the helper export below the `MIGRATIONS` array (before the `runMigrations` function). It takes the db and a reference `now` and is called both by the v8 migration and exposed for testing:

```ts
/**
 * One-time sweep run by migration v8: move every currently-stale or expired-watch
 * thread from `threads` into `thread_archive`. Uses the same classification logic
 * (`classifyThread` from core) the rest of the system uses.
 *
 * Exported so tests can drive the sweep against arbitrary seed data; in production
 * it's called once, inside the v8 migration transaction, with `now = Date.now()`.
 *
 * Returns the number of threads moved.
 */
export function sweepStaleThreadsOnMigration(db: Database, now: number): number {
  type ThreadRow = {
    id: string
    project_id: string
    branch_id: string
    description: string
    status: string
    kind: string
    workflow_type: string | null
    opened_in_commit: string
    last_touched_commit: string | null
    closed_in_commit: string | null
    closed_note: string | null
    created_at: number
    updated_at: number | null
  }

  const rows = db.prepare(`SELECT * FROM threads WHERE status = 'open'`).all() as ThreadRow[]

  const selectCommitTs = db.prepare(`SELECT created_at FROM commits WHERE id = ?`)
  const countProjectCommitsSince = db.prepare(
    `SELECT COUNT(*) AS n FROM commits c JOIN branches b ON c.branch_id = b.id WHERE b.project_id = ? AND c.created_at > ?`,
  )
  const countBranchCommitsSince = db.prepare(
    `SELECT COUNT(*) AS n FROM commits WHERE branch_id = ? AND created_at > ?`,
  )

  const insertArchive = db.prepare(
    `INSERT INTO thread_archive (
       id, project_id, branch_id, description, status, kind, workflow_type,
       opened_in_commit, last_touched_commit, closed_in_commit, closed_note,
       created_at, updated_at, archived_at, archived_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const deleteFromThreads = db.prepare(`DELETE FROM threads WHERE id = ?`)

  let moved = 0
  for (const row of rows) {
    const thread: Thread = {
      id: row.id,
      projectId: row.project_id,
      branchId: row.branch_id,
      description: row.description,
      status: row.status as Thread['status'],
      kind: row.kind as Thread['kind'],
      workflowType: (row.workflow_type ?? undefined) as Thread['workflowType'],
      openedInCommit: row.opened_in_commit,
      lastTouchedCommit: row.last_touched_commit ?? undefined,
      closedInCommit: row.closed_in_commit ?? undefined,
      closedNote: row.closed_note ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    }

    const touchId = thread.lastTouchedCommit ?? thread.openedInCommit
    const tsRow = selectCommitTs.get(touchId) as { created_at: number } | undefined
    const touchTs = tsRow?.created_at ?? thread.createdAt.getTime()
    const projectN = (countProjectCommitsSince.get(thread.projectId, touchTs) as { n: number }).n
    const branchN = (countBranchCommitsSince.get(thread.branchId, touchTs) as { n: number }).n

    const flag = classifyThread(thread, {
      touchTs,
      projectCommitsSince: projectN,
      branchCommitsSince: branchN,
      now,
    })

    if (flag !== 'stale' && flag !== 'expired') continue

    const reason: 'stale-age' | 'stale-distance' | 'watch-expired' =
      flag === 'expired'
        ? 'watch-expired'
        : // Age vs distance: if the commit-distance exceeds threshold use 'stale-distance',
          // otherwise it must be age-based.
          branchN > 30 || projectN > 30
          ? 'stale-distance'
          : 'stale-age'

    insertArchive.run(
      row.id,
      row.project_id,
      row.branch_id,
      row.description,
      row.status,
      row.kind,
      row.workflow_type,
      row.opened_in_commit,
      row.last_touched_commit,
      row.closed_in_commit,
      row.closed_note,
      row.created_at,
      row.updated_at,
      now,
      reason,
    )
    deleteFromThreads.run(row.id)
    moved++
  }

  return moved
}
```

Update the v8 entry in `MIGRATIONS` to invoke the helper after creating the table:

```ts
  {
    version: 8,
    name: 'thread_archive',
    run(db) {
      for (const sql of SCHEMA_V8_DDL) {
        db.exec(sql)
      }
      sweepStaleThreadsOnMigration(db, Date.now())
    },
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts`
Expected: PASS — three tests green (table-created, version-recorded, sweep-moves-stale).

- [ ] **Step 5: Run the full store test suite to confirm no regressions**

Run: `pnpm --filter @contextgit/store test`
Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/local/migrations.ts packages/store/src/local/thread-archive.test.ts
git commit -m "feat(store): migration v8 sweep — move existing stale threads to archive"
```

---

## Task 5: `archiveThread` query method

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Test: `packages/store/src/local/thread-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/store/src/local/thread-archive.test.ts`:

```ts
  it('archiveThread moves an open thread to thread_archive with the given reason', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)

    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p2', 'proj2', now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b2', 'p2', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c2', 'b2', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)
    q.insertThread('thr-1', 'subject one', 'p2', 'b2', 'c2', 'interactive')

    const archived = q.archiveThread('thr-1', 'manual', 'c2')

    expect(archived.id).toBe('thr-1')
    expect(archived.archivedReason).toBe('manual')
    expect(archived.closedInCommit).toBe('c2')
    const inThreads = db.prepare(`SELECT id FROM threads WHERE id = 'thr-1'`).get()
    expect(inThreads).toBeUndefined()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "archiveThread moves"`
Expected: FAIL — `q.archiveThread is not a function`.

- [ ] **Step 3: Implement `archiveThread`**

In `packages/store/src/local/queries.ts`:

a. Add a `TraceRow`-style row type near the other row interfaces (after `ClaimRow`, around line 117):

```ts
interface ThreadArchiveRow extends ThreadRow {
  archived_at: number
  archived_reason: string
}
```

b. Add a converter beside `toThread` (around line 184):

```ts
function toArchivedThread(row: ThreadArchiveRow): ArchivedThread {
  return {
    ...toThread(row),
    archivedAt: new Date(row.archived_at),
    archivedReason: row.archived_reason as ArchivedThread['archivedReason'],
  }
}
```

Add the `ArchivedThread` import to the existing `@contextgit/core` import block at the top of the file (line 6-23).

c. Add three prepared statements to the `stmts` object in the `Queries` constructor (in the threads block, after `reassignThreads`):

```ts
      // thread_archive (03 DELTA)
      insertThreadArchive: db.prepare(`
        INSERT INTO thread_archive
          (id, project_id, branch_id, description, status, kind, workflow_type,
           opened_in_commit, last_touched_commit, closed_in_commit, closed_note,
           created_at, updated_at, archived_at, archived_reason)
        SELECT
           id, project_id, branch_id, description, status, kind, workflow_type,
           opened_in_commit, last_touched_commit, ?, ?,
           created_at, updated_at, ?, ?
        FROM threads WHERE id = ?
      `),
      deleteThread: db.prepare(`DELETE FROM threads WHERE id = ?`),
      selectArchivedThread: db.prepare(`SELECT * FROM thread_archive WHERE id = ?`),
```

Also add their type declarations to the typed `stmts` field declaration block (after `reassignThreads: Statement<[string, string]>`):

```ts
    insertThreadArchive: Statement
    deleteThread: Statement<[string]>
    selectArchivedThread: Statement<[string]>
```

d. Add the public method on `Queries` (after the existing `closeThread` method, around line 654):

```ts
  /**
   * Move an open thread from `threads` to `thread_archive`. Single transaction.
   * `closedInCommit` is the commit triggering the archive (the save's new commit
   * for manual closes; the last-touched commit for sweep-based archival).
   */
  archiveThread(threadId: string, reason: ArchivedThread['archivedReason'], closedInCommit: string | null): ArchivedThread {
    const now = Date.now()
    this.db.transaction(() => {
      this.stmts.insertThreadArchive.run(closedInCommit, null, now, reason, threadId)
      this.stmts.deleteThread.run(threadId)
    })()
    const row = this.stmts.selectArchivedThread.get(threadId) as ThreadArchiveRow | undefined
    if (!row) throw new Error(`archiveThread: thread ${threadId} not found after move`)
    return toArchivedThread(row)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "archiveThread moves"`
Expected: PASS.

- [ ] **Step 5: Run the full store test suite**

Run: `pnpm --filter @contextgit/store test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/thread-archive.test.ts
git commit -m "feat(store): Queries.archiveThread — move thread to thread_archive"
```

---

## Task 6: `restoreThread` query method

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Test: `packages/store/src/local/thread-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
  it('restoreThread moves an archived thread back to threads', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)

    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p3', 'p3', now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b3', 'p3', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c3', 'b3', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)
    q.insertThread('thr-2', 'subj', 'p3', 'b3', 'c3', 'interactive')
    q.archiveThread('thr-2', 'manual', 'c3')

    const restored = q.restoreThread('thr-2')
    expect(restored.id).toBe('thr-2')
    expect(restored.status).toBe('open')
    const inArchive = db.prepare(`SELECT id FROM thread_archive WHERE id = 'thr-2'`).get()
    expect(inArchive).toBeUndefined()
    const inThreads = db.prepare(`SELECT id FROM threads WHERE id = 'thr-2'`).get() as { id: string } | undefined
    expect(inThreads?.id).toBe('thr-2')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "restoreThread"`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `restoreThread`**

In `packages/store/src/local/queries.ts`, add to the `stmts` block (after `selectArchivedThread`):

```ts
      restoreFromArchive: db.prepare(`
        INSERT INTO threads
          (id, project_id, branch_id, description, status, kind, workflow_type,
           opened_in_commit, last_touched_commit, closed_in_commit, closed_note,
           created_at, updated_at)
        SELECT
           id, project_id, branch_id, description, 'open', kind, workflow_type,
           opened_in_commit, last_touched_commit, NULL, NULL,
           created_at, ?
        FROM thread_archive WHERE id = ?
      `),
      deleteFromArchive: db.prepare(`DELETE FROM thread_archive WHERE id = ?`),
```

Add type declarations:

```ts
    restoreFromArchive: Statement
    deleteFromArchive: Statement<[string]>
```

Add a prepared `selectThread` statement to the `stmts` block (for the post-move lookup):

```ts
      selectThread: db.prepare(`SELECT * FROM threads WHERE id = ?`),
```

Type declaration:

```ts
    selectThread: Statement<[string]>
```

Add the public method after `archiveThread`:

```ts
  /**
   * Move a row from `thread_archive` back to `threads` with `status='open'`,
   * clearing the closed-in-commit and closed-note (the restore semantically reopens it).
   */
  restoreThread(threadId: string): Thread {
    const now = Date.now()
    this.db.transaction(() => {
      this.stmts.restoreFromArchive.run(now, threadId)
      this.stmts.deleteFromArchive.run(threadId)
    })()
    const row = this.stmts.selectThread.get(threadId) as ThreadRow | undefined
    if (!row) throw new Error(`restoreThread: thread ${threadId} not found after move`)
    return toThread(row)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "restoreThread"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/thread-archive.test.ts
git commit -m "feat(store): Queries.restoreThread — bring archived thread back to threads"
```

---

## Task 7: `listArchivedThreads` query method

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Test: `packages/store/src/local/thread-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
  it('listArchivedThreads returns archived rows for the project in archive-date order', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)

    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p4', 'p4', now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b4', 'p4', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c4', 'b4', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)
    q.insertThread('a', 'subj-a', 'p4', 'b4', 'c4', 'interactive')
    q.insertThread('b', 'subj-b', 'p4', 'b4', 'c4', 'interactive')
    q.archiveThread('a', 'manual', 'c4')
    q.archiveThread('b', 'manual', 'c4')

    const archived = q.listArchivedThreads('p4')
    expect(archived.map((t) => t.id).sort()).toEqual(['a', 'b'])
    expect(archived[0].archivedReason).toBe('manual')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "listArchivedThreads"`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `listArchivedThreads`**

In `packages/store/src/local/queries.ts`, add to the `stmts` block:

```ts
      listArchivedByProject: db.prepare(`
        SELECT * FROM thread_archive WHERE project_id = ? ORDER BY archived_at DESC
      `),
```

Type declaration:

```ts
    listArchivedByProject: Statement<[string]>
```

Public method:

```ts
  listArchivedThreads(projectId: string): ArchivedThread[] {
    const rows = this.stmts.listArchivedByProject.all(projectId) as ThreadArchiveRow[]
    return rows.map(toArchivedThread)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "listArchivedThreads"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/thread-archive.test.ts
git commit -m "feat(store): Queries.listArchivedThreads — list project's archived threads"
```

---

## Task 8: Handle-prefix lookup queries

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Test: `packages/store/src/local/thread-archive.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
  it('findOpenThreadByHandle returns the thread whose id starts with the 6-char handle', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p5', 'p5', now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b5', 'p5', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c5', 'b5', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)
    q.insertThread('abc123-rest', 's', 'p5', 'b5', 'c5', 'interactive')

    const found = q.findOpenThreadByHandle('p5', 'abc123')
    expect(found?.id).toBe('abc123-rest')

    const notFound = q.findOpenThreadByHandle('p5', 'zzzzzz')
    expect(notFound).toBeUndefined()
  })

  it('findArchivedThreadByHandle returns the archived thread whose id starts with the 6-char handle', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p6', 'p6', now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b6', 'p6', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c6', 'b6', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)
    q.insertThread('def456-rest', 's', 'p6', 'b6', 'c6', 'interactive')
    q.archiveThread('def456-rest', 'manual', 'c6')

    const found = q.findArchivedThreadByHandle('p6', 'def456')
    expect(found?.id).toBe('def456-rest')
    expect(found?.archivedReason).toBe('manual')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "Handle"`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement the lookups**

In `packages/store/src/local/queries.ts`, add to `stmts`:

```ts
      findOpenByHandle: db.prepare(`
        SELECT * FROM threads
        WHERE project_id = ? AND status = 'open' AND id LIKE ? || '%'
        LIMIT 2
      `),
      findArchivedByHandle: db.prepare(`
        SELECT * FROM thread_archive
        WHERE project_id = ? AND id LIKE ? || '%'
        LIMIT 2
      `),
```

Type declarations:

```ts
    findOpenByHandle: Statement<[string, string]>
    findArchivedByHandle: Statement<[string, string]>
```

Public methods (after `findOpenThreadByNormalizedDescription`, around line 670):

```ts
  /**
   * Resolve a 6-char handle (the first 6 chars of nanoid id) to an open thread on
   * the given project. Returns undefined if no thread matches; throws if more than
   * one thread matches the prefix (collision — extremely unlikely with nanoid).
   */
  findOpenThreadByHandle(projectId: string, handle: string): Thread | undefined {
    const rows = this.stmts.findOpenByHandle.all(projectId, handle) as ThreadRow[]
    if (rows.length === 0) return undefined
    if (rows.length > 1) {
      throw new Error(`findOpenThreadByHandle: handle '${handle}' matches ${rows.length} threads`)
    }
    const now = Date.now()
    return this.attachDecayFlags(toThread(rows[0]), now)
  }

  findArchivedThreadByHandle(projectId: string, handle: string): ArchivedThread | undefined {
    const rows = this.stmts.findArchivedByHandle.all(projectId, handle) as ThreadArchiveRow[]
    if (rows.length === 0) return undefined
    if (rows.length > 1) {
      throw new Error(`findArchivedThreadByHandle: handle '${handle}' matches ${rows.length} threads`)
    }
    return toArchivedThread(rows[0])
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "Handle"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/thread-archive.test.ts
git commit -m "feat(store): Queries handle-prefix lookups for open + archived threads"
```

---

## Task 9: `sweepStaleThreads` runtime method

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Test: `packages/store/src/local/thread-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
  it('sweepStaleThreads archives currently-decayed threads and returns counts', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    const now = Date.now()
    const old = now - 365 * 24 * 60 * 60 * 1000
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p7', 'p7', old)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b7', 'p7', 'main', 'main', 'active', old)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c7', 'b7', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', old)
    q.insertThread('old-thread', 'subject', 'p7', 'b7', 'c7', 'interactive')

    const result = q.sweepStaleThreads('p7', now)
    expect(result.archived).toBeGreaterThanOrEqual(1)

    const inThreads = db.prepare(`SELECT id FROM threads WHERE id = 'old-thread'`).get()
    expect(inThreads).toBeUndefined()
    const inArchive = db.prepare(`SELECT id FROM thread_archive WHERE id = 'old-thread'`).get()
    expect(inArchive).toBeDefined()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "sweepStaleThreads"`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `sweepStaleThreads`**

In `packages/store/src/local/queries.ts`, add a project-scoped variant of the migration sweep helper. Put it after `findArchivedThreadByHandle`:

```ts
  /**
   * Project-scoped sweep run by createCommit at the end of every save: any open
   * thread on this project that classifies as `stale` or `expired` is moved to
   * `thread_archive`. Returns counts by reason for the save response.
   *
   * Reuses `attachDecayFlags`-style classification (via classifyThread) but writes
   * archive rows in one transaction.
   */
  sweepStaleThreads(projectId: string, now: number): { archived: number; byReason: { 'stale-age': number; 'stale-distance': number; 'watch-expired': number } } {
    const threads = this.listOpenThreads(projectId)
    const byReason = { 'stale-age': 0, 'stale-distance': 0, 'watch-expired': 0 }
    let archived = 0

    for (const t of threads) {
      if (!t.stale && !t.expired) continue

      let reason: 'stale-age' | 'stale-distance' | 'watch-expired'
      if (t.expired) {
        reason = 'watch-expired'
      } else {
        // For stale 'open' threads, prefer the commit-distance signal when it's the
        // one that crossed threshold. Approximate by recomputing branch-since count.
        const touchId = t.lastTouchedCommit ?? t.openedInCommit
        const tsRow = this.stmts.selectCommitCreatedAt.get(touchId) as { created_at: number } | undefined
        const touchTs = tsRow?.created_at ?? t.createdAt.getTime()
        const branchN = (this.stmts.countBranchCommitsSince.get(t.branchId, touchTs) as { n: number }).n
        reason = branchN > 30 ? 'stale-distance' : 'stale-age'
      }

      this.stmts.insertThreadArchive.run(null, null, now, reason, t.id)
      this.stmts.deleteThread.run(t.id)
      byReason[reason]++
      archived++
    }

    return { archived, byReason }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/store/src/local/thread-archive.test.ts -t "sweepStaleThreads"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/thread-archive.test.ts
git commit -m "feat(store): Queries.sweepStaleThreads — runtime project-scoped archive sweep"
```

---

## Task 10: Extend `ContextStore` interface + stub remote/Supabase

**Files:**
- Modify: `packages/store/src/interface.ts`
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/remote/index.ts`

- [ ] **Step 1: Add methods to the interface**

In `packages/store/src/interface.ts`, update the `@contextgit/core` import block to include `ArchivedThread`:

```ts
import type {
  Agent,
  AgentInput,
  AgentRole,
  ArchivedThread,
  Branch,
  // … existing imports
```

Add a Threads-section block right after `syncThread(thread: Thread): Promise<Thread>`:

```ts
  // Thread lifecycle (03 DELTA) — optional until SupabaseStore/RemoteStore implement
  archiveThread?(threadId: string, reason: ArchivedThread['archivedReason'], closedInCommit: string | null): Promise<ArchivedThread>
  restoreThread?(threadId: string): Promise<Thread>
  listArchivedThreads?(projectId: string): Promise<ArchivedThread[]>
  findOpenThreadByHandle?(projectId: string, handle: string): Promise<Thread | undefined>
  findArchivedThreadByHandle?(projectId: string, handle: string): Promise<ArchivedThread | undefined>
  sweepStaleThreads?(projectId: string, now: number): Promise<{ archived: number; byReason: Record<'stale-age' | 'stale-distance' | 'watch-expired', number> }>
```

- [ ] **Step 2: Stub the new methods in SupabaseStore and RemoteStore**

In `packages/store/src/supabase/index.ts`, add at the end of the class body (before the closing `}`):

```ts
  archiveThread(): never {
    throw new Error('archiveThread: not implemented in 0.2.0 — LocalStore only')
  }
  restoreThread(): never {
    throw new Error('restoreThread: not implemented in 0.2.0 — LocalStore only')
  }
  listArchivedThreads(): never {
    throw new Error('listArchivedThreads: not implemented in 0.2.0 — LocalStore only')
  }
  findOpenThreadByHandle(): never {
    throw new Error('findOpenThreadByHandle: not implemented in 0.2.0 — LocalStore only')
  }
  findArchivedThreadByHandle(): never {
    throw new Error('findArchivedThreadByHandle: not implemented in 0.2.0 — LocalStore only')
  }
  sweepStaleThreads(): never {
    throw new Error('sweepStaleThreads: not implemented in 0.2.0 — LocalStore only')
  }
```

Apply identical stubs to `packages/store/src/remote/index.ts`.

- [ ] **Step 3: Type-check**

Run: `pnpm build`
Expected: clean tsc output across all packages.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass (no behavioral regressions; the new interface methods are optional).

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/interface.ts packages/store/src/supabase/index.ts packages/store/src/remote/index.ts
git commit -m "feat(store): extend ContextStore with thread-archive methods, stub remote backends"
```

---

## Task 11: LocalStore pass-throughs for new methods

**Files:**
- Modify: `packages/store/src/local/index.ts`
- Test: `packages/store/src/local/local-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/store/src/local/local-store.test.ts`, find an existing describe block (or add a new one at the bottom) and append:

```ts
  it('archiveThread + restoreThread round-trip via LocalStore', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const commit = await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'm', content: 'c', summary: 's',
      commitType: 'manual',
      threads: { open: ['subj-arch'] },
    })
    const open = await store.listOpenThreads(project.id)
    const thread = open[0]

    const archived = await store.archiveThread!(thread.id, 'manual', commit.id)
    expect(archived.archivedReason).toBe('manual')

    const list = await store.listArchivedThreads!(project.id)
    expect(list.map((t) => t.id)).toContain(thread.id)

    await store.restoreThread!(thread.id)
    const reopened = await store.listOpenThreads(project.id)
    expect(reopened.map((t) => t.id)).toContain(thread.id)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/store/src/local/local-store.test.ts -t "archiveThread + restoreThread"`
Expected: FAIL — `store.archiveThread is not a function`.

- [ ] **Step 3: Add pass-throughs in `LocalStore`**

In `packages/store/src/local/index.ts`, add (after the existing thread methods, around `listOpenThreadsByBranch`):

```ts
  archiveThread(threadId: string, reason: import('@contextgit/core').ArchivedThread['archivedReason'], closedInCommit: string | null): Promise<import('@contextgit/core').ArchivedThread> {
    try {
      return Promise.resolve(this.q.archiveThread(threadId, reason, closedInCommit))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  restoreThread(threadId: string): Promise<Thread> {
    try {
      return Promise.resolve(this.q.restoreThread(threadId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  listArchivedThreads(projectId: string): Promise<import('@contextgit/core').ArchivedThread[]> {
    try {
      return Promise.resolve(this.q.listArchivedThreads(projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  findOpenThreadByHandle(projectId: string, handle: string): Promise<Thread | undefined> {
    try {
      return Promise.resolve(this.q.findOpenThreadByHandle(projectId, handle))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  findArchivedThreadByHandle(projectId: string, handle: string): Promise<import('@contextgit/core').ArchivedThread | undefined> {
    try {
      return Promise.resolve(this.q.findArchivedThreadByHandle(projectId, handle))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  sweepStaleThreads(projectId: string, now: number): Promise<{ archived: number; byReason: Record<'stale-age' | 'stale-distance' | 'watch-expired', number> }> {
    try {
      return Promise.resolve(this.q.sweepStaleThreads(projectId, now))
    } catch (e) {
      return Promise.reject(e)
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/store/src/local/local-store.test.ts -t "archiveThread + restoreThread"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/index.ts packages/store/src/local/local-store.test.ts
git commit -m "feat(store): LocalStore exposes archive/restore/list/find/sweep"
```

---

## Task 12: Integrate `closesThreads` + sweep into `createCommit`

**Files:**
- Modify: `packages/store/src/local/index.ts`
- Test: `packages/store/src/local/local-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/store/src/local/local-store.test.ts`:

```ts
  it('createCommit closesThreads — handle match archives the thread', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'open', content: 'x', summary: 'x',
      commitType: 'manual',
      threads: { open: ['close-me'] },
    })
    const open = await store.listOpenThreads(project.id)
    const handle = open[0].id.slice(0, 6)

    await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'close', content: 'y', summary: 'y',
      commitType: 'manual',
      threads: { closes: [handle] },
    })

    const stillOpen = await store.listOpenThreads(project.id)
    expect(stillOpen.length).toBe(0)
    const archived = await store.listArchivedThreads!(project.id)
    expect(archived.length).toBe(1)
    expect(archived[0].archivedReason).toBe('manual')
  })

  it('createCommit closesThreads — subject match archives the thread', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'o', content: 'x', summary: 'x',
      commitType: 'manual',
      threads: { open: ['need to do the thing'] },
    })

    await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'c', content: 'y', summary: 'y',
      commitType: 'manual',
      threads: { closes: ['Need to do the thing'] },
    })

    const archived = await store.listArchivedThreads!(project.id)
    expect(archived.length).toBe(1)
  })

  it('createCommit closesThreads — already-archived handle is a no-op success', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const c1 = await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'o', content: 'x', summary: 'x',
      commitType: 'manual',
      threads: { open: ['will-archive-twice'] },
    })
    const open = await store.listOpenThreads(project.id)
    const handle = open[0].id.slice(0, 6)
    await store.archiveThread!(open[0].id, 'manual', c1.id)

    // Save uses the same handle; thread is already archived; save must NOT throw.
    await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'c', content: 'y', summary: 'y',
      commitType: 'manual',
      threads: { closes: [handle] },
    })
    // No second archive insert — list count remains 1.
    const archived = await store.listArchivedThreads!(project.id)
    expect(archived.length).toBe(1)
  })

  it('createCommit closesThreads — no match aborts the entire save atomically', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const before = (await store.listCommits(branch.id, { limit: 100, offset: 0 })).length

    await expect(
      store.createCommit({
        branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
        workflowType: 'interactive', message: 'c', content: 'y', summary: 'y',
        commitType: 'manual',
        threads: { closes: ['xxxxxx'] },
      }),
    ).rejects.toThrow(/closesThreads/)

    const after = (await store.listCommits(branch.id, { limit: 100, offset: 0 })).length
    expect(after).toBe(before)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/store/src/local/local-store.test.ts -t "createCommit closesThreads"`
Expected: 4 failures — `threads.closes` is not yet processed.

- [ ] **Step 3: Implement the resolution + sweep in `createCommit`**

In `packages/store/src/local/index.ts`, locate the `createCommit` transaction. Just before the `// Update branch HEAD` line, insert this `closes` handling block:

```ts
        // 03 DELTA: closesThreads — atomic resolve handle → subject → archive-handle.
        // Whole save fails if any entry stays unresolved.
        if (input.threads?.closes?.length) {
          for (const raw of input.threads.closes) {
            const candidate = raw.trim()
            const handle = candidate.slice(0, 6)

            // 1. Try as handle in open threads
            const byHandle = this.q.findOpenThreadByHandle(branch.projectId, handle)
            if (byHandle) {
              this.q.archiveThread(byHandle.id, 'manual', commitId)
              continue
            }

            // 2. Try as subject
            const normalized = normalizeThreadSubject(candidate)
            const bySubject = this.q.findOpenThreadByNormalizedDescription(branch.projectId, normalized)
            if (bySubject) {
              this.q.archiveThread(bySubject.id, 'manual', commitId)
              continue
            }

            // 3. Already archived?
            const inArchive = this.q.findArchivedThreadByHandle(branch.projectId, handle)
            if (inArchive) {
              continue // no-op success: agent's intent is already satisfied
            }

            // 4. Unresolved — abort the whole save.
            throw new Error(
              `closesThreads: no thread matched '${candidate}' (tried as handle, subject, and archive)`,
            )
          }
        }
```

The existing `input.threads?.close` legacy block (full-id `closeThread`) should be **replaced** since closing now means archiving. Replace the existing block:

```ts
        if (input.threads?.close?.length) {
          for (const { id, note } of input.threads.close) {
            this.q.closeThread(id, commitId, note)
          }
        }
```

with:

```ts
        if (input.threads?.close?.length) {
          // Legacy direct-ID close path — archive with reason='manual'. closed_note
          // from the legacy shape is currently dropped (no archive column for it,
          // and no live caller depends on it).
          for (const { id } of input.threads.close) {
            this.q.archiveThread(id, 'manual', commitId)
          }
        }
```

Now add the sweep at the end of the transaction, after `releaseClaimsByAgent`:

```ts
        // 03 DELTA: sweep newly-decayed threads on every save.
        this.q.sweepStaleThreads(branch.projectId, Date.now())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/store/src/local/local-store.test.ts -t "createCommit closesThreads"`
Expected: PASS (4/4).

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/local/index.ts packages/store/src/local/local-store.test.ts
git commit -m "feat(store): createCommit resolves closesThreads + sweeps stale threads atomically"
```

---

## Task 13: Short handle in snapshot formatter

**Files:**
- Modify: `packages/core/src/snapshot.ts`
- Test: `packages/core/src/snapshot.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/snapshot.test.ts`:

```ts
  it('agents-md prefixes each open thread with a 6-char [handle]', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 'abcdef1234567890',
          projectId: 'p', branchId: 'b',
          description: 'thread one',
          status: 'open',
          openedInCommit: 'c1',
          createdAt: new Date(),
        },
      ],
    })
    const out = formatter.format(snapshot, 'agents-md')
    expect(out).toContain('[abcdef]')
    // Confirm handle is exactly 6 chars and equals id.slice(0,6)
    const handleMatch = out.match(/\[([a-zA-Z0-9_-]+)\] \[FREE\] thread one/)
    expect(handleMatch?.[1]).toBe('abcdef')
  })

  it('text format prefixes each open thread with a 6-char [handle]', () => {
    const snapshot = makeSnapshot({
      openThreads: [
        {
          id: 'xyz789abcdef0000',
          projectId: 'p', branchId: 'b',
          description: 'thread two',
          status: 'open',
          openedInCommit: 'c1',
          createdAt: new Date(),
        },
      ],
    })
    const out = formatter.format(snapshot, 'text')
    expect(out).toContain('[xyz789]')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/snapshot.test.ts -t "6-char"`
Expected: FAIL — handle not present.

- [ ] **Step 3: Implement the handle prefix**

In `packages/core/src/snapshot.ts`, locate the agents-md thread rendering (around line 62). Change:

```ts
      const threads = uniqueThreads
        .map(
          (t) =>
            `- ${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
        )
        .join('\n')
```

to:

```ts
      const threads = uniqueThreads
        .map(
          (t) =>
            `- [${t.id.slice(0, 6)}] ${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
        )
        .join('\n')
```

Then locate the text format thread rendering (around line 92). Change:

```ts
    const threads = openThreads
      .map(
        (t) =>
          `${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
      )
      .join('\n')
```

to:

```ts
    const threads = openThreads
      .map(
        (t) =>
          `[${t.id.slice(0, 6)}] ${claimLabel(t, activeClaims)} ${t.description}  (opened ${t.createdAt.toLocaleDateString()}, ${t.workflowType ?? 'interactive'})`,
      )
      .join('\n')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/snapshot.test.ts -t "6-char"`
Expected: PASS.

- [ ] **Step 5: Run the full core test suite**

Run: `pnpm --filter @contextgit/core test`
Expected: all tests pass (existing tests don't assert exact thread-line shape).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/snapshot.ts packages/core/src/snapshot.test.ts
git commit -m "feat(core): snapshot formatter surfaces 6-char [handle] per thread"
```

---

## Task 14: Save-rhythm strings gain Bad/Good example

**Files:**
- Modify: `packages/cli/src/lib/init-helpers.ts`
- Test: `packages/cli/src/lib/init-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/lib/init-helpers.test.ts`, find the existing describe block for the strings, and append:

```ts
  it('CLAUDE_MD_FRAGMENT contains the "What a save is for" section with Bad/Good examples', () => {
    expect(CLAUDE_MD_FRAGMENT).toContain('What a save is for')
    expect(CLAUDE_MD_FRAGMENT).toContain('Bad save:')
    expect(CLAUDE_MD_FRAGMENT).toContain('Good save:')
  })

  it('CONTEXT_COMMIT_SKILL contains the "What a save is for" section with Bad/Good examples', () => {
    expect(CONTEXT_COMMIT_SKILL).toContain('What a save is for')
    expect(CONTEXT_COMMIT_SKILL).toContain('Bad save:')
    expect(CONTEXT_COMMIT_SKILL).toContain('Good save:')
  })
```

(Confirm `CLAUDE_MD_FRAGMENT` and `CONTEXT_COMMIT_SKILL` are already imported at the top of the test file — they should be from existing tests; if not, add them to the import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/lib/init-helpers.test.ts -t "What a save is for"`
Expected: FAIL — section not yet in the strings.

- [ ] **Step 3: Insert the section into both strings**

In `packages/cli/src/lib/init-helpers.ts`, in `CLAUDE_MD_FRAGMENT`, immediately after the "A context save that only paraphrases a commit message is noise." line (around line 35), insert:

```
## What a save is for

A save records what git cannot reconstruct: a decision, a reason, an
abandoned approach, an open question.

Bad save: "Implemented apiFetch wrapper" — this paraphrases the commit
message; git already has it.

Good save: "Chose X-User-Id header over cookie auth because the
extension can't share Loqally's session cookie" — the decision, not the diff.

```

(Note the blank line after the section so the next `## Session End` header is correctly separated.)

Apply the same insertion to `CONTEXT_COMMIT_SKILL` after its "A context save that only paraphrases a commit message is noise." line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cli/src/lib/init-helpers.test.ts -t "What a save is for"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/init-helpers.ts packages/cli/src/lib/init-helpers.test.ts
git commit -m "feat(cli): save-rhythm strings gain Bad/Good \"What a save is for\" example"
```

---

## Task 15: MCP `project_memory_save` — rename `close_thread_ids` → `closes_threads`

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Update the param + handler**

In `packages/mcp/src/server.ts`, in `handleProjectMemorySave` (around line 283), rename and re-shape:

Replace:

```ts
  const handleProjectMemorySave = async ({
    message,
    content,
    open_threads,
    close_thread_ids,
  }: {
    message: string
    content: string
    open_threads?: string[]
    close_thread_ids?: string[]
  }) => {
```

with:

```ts
  const handleProjectMemorySave = async ({
    message,
    content,
    open_threads,
    closes_threads,
  }: {
    message: string
    content: string
    open_threads?: string[]
    closes_threads?: string[]
  }) => {
```

Replace the `threads` assembly:

```ts
      const threads: { open?: string[]; close?: Array<{ id: string; note: string }> } = {}
      if (open_threads?.length) threads.open = open_threads
      if (close_thread_ids?.length) {
        threads.close = close_thread_ids.map(id => ({ id, note: 'Closed via context_commit' }))
      }
```

with:

```ts
      const threads: { open?: string[]; closes?: string[] } = {}
      if (open_threads?.length) threads.open = open_threads
      if (closes_threads?.length) threads.closes = closes_threads
```

Update the schema:

```ts
  const projectMemorySaveSchema = {
    message: z.string().min(1).describe('Short summary of what was accomplished (1–2 sentences).'),
    content: z.string().min(1).describe('Detailed description of the work done, decisions made, and current state.'),
    open_threads: z.array(z.string()).optional().describe(
      'New open questions or blockers to track (each max 200 chars).',
    ),
    closes_threads: z.array(z.string()).optional().describe(
      'Threads to close. Each entry can be a 6-char handle (from the load) or a thread subject (normalized match). Resolution is atomic — the whole save fails if any entry stays unresolved.',
    ),
  }
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @contextgit/mcp build`
Expected: clean tsc output.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): project_memory_save renames close_thread_ids → closes_threads (handles/subjects)"
```

---

## Task 16: MCP `project_memory_threads` — close/restore flags + `'archived'` filter

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Locate the tool**

In `packages/mcp/src/server.ts`, find the `project_memory_threads` tool registration (around line 658, marker `// ── project_memory_threads`). Read the existing handler and schema. Note the existing `filter` parameter values: `'stale' | 'expired-watch' | 'live' | 'all'`.

- [ ] **Step 2: Add new params + filter value**

Augment the schema to add three mutually-exclusive action params and the new filter value:

```ts
  const projectMemoryThreadsSchema = {
    filter: z.enum(['stale', 'expired-watch', 'live', 'all', 'archived']).optional()
      .describe(
        "Filter the result. 'stale' = open threads past decay threshold; 'expired-watch' = watch notes past TTL; 'live' = neither (what the default load returns); 'all' = everything with decay flags annotated; 'archived' = rows in thread_archive.",
      ),
    close: z.string().optional().describe(
      'Close a thread by 6-char handle. Moves it to thread_archive with reason="manual".',
    ),
    close_subject: z.string().optional().describe(
      'Close a thread by subject (normalized match). Moves it to thread_archive with reason="manual".',
    ),
    restore: z.string().optional().describe(
      'Restore an archived thread by 6-char handle. Moves it back to threads.',
    ),
  }
```

Update the handler to dispatch on the new params. Find the existing handler body and prepend an action-flag dispatch. The handler should look like:

```ts
  const handleProjectMemoryThreads = async ({
    filter,
    close,
    close_subject,
    restore,
  }: {
    filter?: 'stale' | 'expired-watch' | 'live' | 'all' | 'archived'
    close?: string
    close_subject?: string
    restore?: string
  }) => {
    try {
      // Action flags (mutually exclusive — first match wins; multiple is an error)
      const actions = [close, close_subject, restore].filter(Boolean).length
      if (actions > 1) {
        return {
          content: [{ type: 'text' as const, text: 'Error: pass at most one of close, close_subject, restore.' }],
          isError: true,
        }
      }

      if (close) {
        const open = await ctx.store.findOpenThreadByHandle!(ctx.projectId, close.slice(0, 6))
        if (!open) {
          return { content: [{ type: 'text' as const, text: `No open thread matched handle '${close}'.` }], isError: true }
        }
        // Use the branch HEAD commit as closed_in_commit
        const branch = await ctx.store.getBranch(ctx.branchId)
        await ctx.store.archiveThread!(open.id, 'manual', branch?.headCommitId ?? null)
        return { content: [{ type: 'text' as const, text: `Closed thread ${open.id.slice(0, 6)} (${open.description}).` }] }
      }

      if (close_subject) {
        // Reuse Queries.findOpenThreadByNormalizedDescription indirectly via the store — for 0.2.0 the
        // simplest path is to iterate listOpenThreads.
        const opens = await ctx.store.listOpenThreads(ctx.projectId)
        const { normalizeThreadSubject } = await import('@contextgit/core')
        const target = opens.find((t) => normalizeThreadSubject(t.description) === normalizeThreadSubject(close_subject))
        if (!target) {
          return { content: [{ type: 'text' as const, text: `No open thread matched subject '${close_subject}'.` }], isError: true }
        }
        const branch = await ctx.store.getBranch(ctx.branchId)
        await ctx.store.archiveThread!(target.id, 'manual', branch?.headCommitId ?? null)
        return { content: [{ type: 'text' as const, text: `Closed thread ${target.id.slice(0, 6)} (${target.description}).` }] }
      }

      if (restore) {
        const archived = await ctx.store.findArchivedThreadByHandle!(ctx.projectId, restore.slice(0, 6))
        if (!archived) {
          return { content: [{ type: 'text' as const, text: `No archived thread matched handle '${restore}'.` }], isError: true }
        }
        await ctx.store.restoreThread!(archived.id)
        return { content: [{ type: 'text' as const, text: `Restored thread ${archived.id.slice(0, 6)} (${archived.description}).` }] }
      }

      // Listing path (no action flag): existing logic + new 'archived' filter
      if (filter === 'archived') {
        const archived = await ctx.store.listArchivedThreads!(ctx.projectId)
        const lines = archived.map(
          (t) => `[${t.id.slice(0, 6)}] (${t.archivedReason}, ${t.archivedAt.toISOString()}) ${t.description}`,
        )
        return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : '(no archived threads)' }] }
      }

      // … existing listing implementation for stale/expired-watch/live/all
      // (copy the relevant slice from the current handler unchanged)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
    }
  }
```

Note: the implementation MUST preserve the existing listing logic for `stale`, `expired-watch`, `live`, and `all`. When making this edit, read the current handler in full and merge the action-flag branch in *before* the existing listing logic; do not delete the existing listing.

- [ ] **Step 3: Type-check + run tests**

Run: `pnpm build && pnpm test`
Expected: clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): project_memory_threads adds close/close_subject/restore + 'archived' filter"
```

---

## Task 17: CHANGELOG — fold the thread-lifecycle section into 0.2.0

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the section**

In `CHANGELOG.md`, find the 0.2.0 entry's "Known scope" subheader. Insert a new themed block immediately before it (so the 0.2.0 entry ends with Known scope as today, but gains a new section above it):

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
or pass `closes_threads: ['handle-or-subject', …]` on a save — the resolution
is atomic with the rest of the save.

**Save-rhythm guidance gets a negative example.** The CLAUDE.md fragment and
context-commit skill now show what a good save looks like vs. one that just
paraphrases the commit message. Re-run `contextgit init` to pick up the new
strings.
```

In the "Migrations" subsection of the 0.2.0 entry, change:

```
Two automatic SQLite migrations apply on first use (`v6`, `v7`). No manual step required.

- `v6` — `threads.kind` (default `'open'`) + `threads.last_touched_commit`
- `v7` — new `trace` table with indexes for windowed retrieval
```

to:

```
Three automatic SQLite migrations apply on first use (`v6`, `v7`, `v8`). No manual step required.

- `v6` — `threads.kind` (default `'open'`) + `threads.last_touched_commit`
- `v7` — new `trace` table with indexes for windowed retrieval
- `v8` — new `thread_archive` table + one-time sweep of currently-stale threads
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): add thread-lifecycle and close-ergonomics section to 0.2.0"
```

---

## Task 18: Full audit + push

**Files:** (none — verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass. Count should be roughly 163 + 14-ish new = ~177.

- [ ] **Step 2: Run the full build**

Run: `pnpm build`
Expected: clean tsc output across all 5 packages.

- [ ] **Step 3: Manual smoke-test on this very project**

The implementing agent runs:

```bash
node packages/cli/bin/contextgit-mcp.js --help  # smoke-test the binary still loads
```

Then opens a fresh Claude Code session against this project and calls `project_memory_load`. Verify:

- The `## Open Threads` section shows `[handle]` next to each thread.
- The `+N stale` line shows 0 (or close to it) — the v8 sweep ran on first open.
- `project_memory_threads filter='archived'` lists the ~108 threads that were swept, with their handles + reasons.
- A test save with `closes_threads: ['<some-real-handle>']` archives that thread and the next load no longer shows it.

If any of these fail, return to the relevant task and fix before proceeding.

- [ ] **Step 4: Push**

```bash
git push origin main
```

The branch is now ready for publish. Resume the publish checklist from your project memory:

1. `npm whoami` → confirm `mendetr`
2. `npm publish` in dependency order: core → store → api → mcp → cli
3. `git tag v0.2.0 && git push origin v0.2.0`
4. Fresh install audit (the validation gate from the design spec)

---

## Notes on task ordering

- Tasks 1–12 must run in order (each depends on the previous).
- Task 13 (snapshot formatter handles) can run any time after Task 1, but is sequenced here so it follows the store work.
- Task 14 (save-rhythm strings) is independent and can run any time.
- Tasks 15–16 (MCP server) must follow Task 12 (createCommit handles the new param shape).
- Task 17 (CHANGELOG) follows everything else.
- Task 18 (audit + push) is terminal.

Total expected commit count: 17 (one per task except 18, which is verification + push).
