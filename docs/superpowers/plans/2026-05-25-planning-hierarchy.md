# Planning Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-level plan→step→task hierarchy stored in a self-referential `plan_nodes` table, with `project_memory_plan` (write), `project_memory_plans` (read), and `completes_tasks` on `project_memory_save`. Planning nodes are structurally immune to decay — they leave the active view only by being `done`, never by aging out. Folds into the un-published 0.2.0 (no version bump).

**Architecture:** One new SQLite table `plan_nodes` (id, parent_id, level enum, title, status enum, position, git_commit_sha, timestamps). `level + parent_id` gives the hierarchy; depth is capped at 3 by the `level` enum. Migration v9 (v8 is 03's `thread_archive`). Read-time derivation: a plan/step's `progress = {done, total}` and effective completion are computed from children, not stored — avoids drift. The snapshot formatter renders a new `## Plan` section between `## Git` and `## Open Threads`, with `→ next` marking the first pending task. Resolution rules for `completes_tasks` mirror 03's `closes_threads`: handle-first (6-char prefix), then exact-title match, then check completed table for no-op, otherwise atomic loud error. The 03 decay sweep operates on `threads`/`thread_archive` only — plan_nodes are structurally exempt by virtue of being a different table.

**Tech Stack:** TypeScript, better-sqlite3 (sync, `Promise.resolve()` at interface boundary), nanoid for IDs, Vitest with in-memory SQLite for tests, `@modelcontextprotocol/sdk` for MCP, zod for tool schemas.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/types.ts` | Modify | Add `PlanNodeLevel`, `PlanNodeStatus`, `PlanNode`, `PlanNodeInput`, `PlanNodeUpdate` types; add `completesTasks?: string[]` to `CommitInput`; add `planTree?: PlanNode[]` to `SessionSnapshot`. |
| `packages/store/src/local/schema.ts` | Modify | Add `CREATE_PLAN_NODES`, `SCHEMA_V9_DDL`. |
| `packages/store/src/local/migrations.ts` | Modify | Register migration v9 (table creation only; no sweep — planning never decays). |
| `packages/store/src/local/queries.ts` | Modify | Add `insertPlanTree`, `getPlanTree`, `updatePlanNodeStatus`, `updatePlanNodeTitle`, `listActivePlans`, `listCompletedPlans`, `findPlanNodeByHandle`, `findPlanNodeByTitle`. |
| `packages/store/src/local/plan-nodes.test.ts` | Create | Unit tests for plan_node CRUD + hierarchy + derived-completion + handle lookup + structural-immune-to-decay invariant. |
| `packages/store/src/local/index.ts` | Modify | LocalStore pass-throughs for the new queries; integrate `completesTasks` into `createCommit` atomically (handle → title → already-completed no-op → loud error). |
| `packages/store/src/local/local-store.test.ts` | Modify | Tests for `createCommit` with `completesTasks` (handle, title, already-completed, no-match-atomic). |
| `packages/store/src/interface.ts` | Modify | Add 8 optional methods to `ContextStore`. |
| `packages/store/src/supabase/index.ts` | Modify | Stub the 8 new methods. |
| `packages/store/src/remote/index.ts` | Modify | Same stubs. |
| `packages/core/src/snapshot.ts` | Modify | Render `## Plan` section in both agents-md and text outputs. `✓` for done, `→` for next pending task (only one per load), `○` for other pending, `▸` for in_progress or partial plan/step. Progress badge `[n/m done]` on non-leaves. Completed plans not shown. |
| `packages/core/src/snapshot.test.ts` | Modify | Tests: `## Plan` section appears between `## Git` and `## Open Threads`; `→ next` marker on first pending; `[n/m done]` badge; completed plan absent. |
| `packages/store/src/local/queries.ts` (snapshot helper) | Modify | `getSessionSnapshot` populates `planTree` via `getPlanTree`. |
| `packages/mcp/src/server.ts` | Modify | New `project_memory_plan` and `project_memory_plans` tools; `completes_tasks: string[]` param on `project_memory_save`. |
| `CHANGELOG.md` | Modify | Add "Planning hierarchy" section to 0.2.0 entry; list migration v9. |

---

## Task 1: Core types

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add the types**

Open `packages/core/src/types.ts`. Locate the `ArchivedThread` interface (added in 03). Immediately after it, add:

```ts
// ============================================
// Planning hierarchy (04 DELTA)
// ============================================

export type PlanNodeLevel = 'plan' | 'step' | 'task'
export type PlanNodeStatus = 'pending' | 'in_progress' | 'done'

export interface PlanNode {
  id: string
  projectId: string
  parentId?: string
  level: PlanNodeLevel
  title: string
  status: PlanNodeStatus
  position: number
  gitCommitSha?: string
  createdAt: Date
  completedAt?: Date
  // Derived at read time, only present on plan/step nodes after getPlanTree:
  progress?: { done: number; total: number }
  children?: PlanNode[]
}

/**
 * Nested input for creating a plan tree in one call.
 * Depth determines level: input root = 'plan', children = 'step', grandchildren = 'task'.
 * Deeper than 2 throws.
 */
export interface PlanNodeInput {
  title: string
  status?: PlanNodeStatus  // defaults to 'pending'
  children?: PlanNodeInput[]
}

/** Update payload for a single existing node, identified by 6-char handle. */
export interface PlanNodeUpdate {
  handle: string
  status?: PlanNodeStatus
  title?: string
}
```

Locate `CommitInput`. Add a `completesTasks?: string[]` field at the same level as `threads`:

```ts
  gitCommitSha?: string
  threads?: { ... }
  completesTasks?: string[]   // 04 DELTA: handles or titles, atomic resolution
```

Locate `SessionSnapshot`. Add `planTree?: PlanNode[]` near the bottom of the interface (before the `// 02 DELTA additions` block or alongside):

```ts
  planTree?: PlanNode[]        // 04 DELTA: active (non-fully-done) plans with derived progress
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @contextgit/core build`
Expected: clean tsc output.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): planning hierarchy types — PlanNode, PlanNodeInput, completesTasks, planTree"
```

---

## Task 2: Schema v9 DDL

**Files:**
- Modify: `packages/store/src/local/schema.ts`

- [ ] **Step 1: Add the DDL constants**

At the bottom of `packages/store/src/local/schema.ts`, after `SCHEMA_V8_DDL`, append:

```ts
// Migration v9 adds the plan_nodes table — three-level plan→step→task hierarchy.
// One self-referential table; level + parent_id encodes the structure. Depth
// is capped at 3 by the level enum. Plan nodes are structurally exempt from
// the 03 thread-archive sweep — they live in their own table and never decay.
export const CREATE_PLAN_NODES = `
CREATE TABLE IF NOT EXISTS plan_nodes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  parent_id       TEXT REFERENCES plan_nodes(id),
  level           TEXT NOT NULL CHECK (level IN ('plan', 'step', 'task')),
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
  position        INTEGER NOT NULL,
  git_commit_sha  TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
)
`

export const SCHEMA_V9_DDL = [
  CREATE_PLAN_NODES,
  `CREATE INDEX IF NOT EXISTS idx_plan_nodes_project ON plan_nodes(project_id, level, status)`,
  `CREATE INDEX IF NOT EXISTS idx_plan_nodes_parent  ON plan_nodes(parent_id)`,
]
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @contextgit/store build`
Expected: clean tsc output.

- [ ] **Step 3: Commit**

```bash
git add packages/store/src/local/schema.ts
git commit -m "feat(store): migration v9 schema — plan_nodes table"
```

---

## Task 3: Register migration v9

**Files:**
- Modify: `packages/store/src/local/migrations.ts`
- Create: `packages/store/src/local/plan-nodes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/store/src/local/plan-nodes.test.ts`:

```ts
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from './migrations.js'

describe('plan_nodes table (v9 migration)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates the plan_nodes table', () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='plan_nodes'`)
      .get() as { name: string } | undefined
    expect(row?.name).toBe('plan_nodes')
  })

  it('records v9 in _migrations', () => {
    const versions = (
      db.prepare(`SELECT version FROM _migrations ORDER BY version`).all() as { version: number }[]
    ).map((r) => r.version)
    expect(versions).toContain(9)
  })

  it('enforces level enum via CHECK constraint', () => {
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p', 'p', 0)`).run()
    expect(() =>
      db.prepare(`
        INSERT INTO plan_nodes (id, project_id, level, title, status, position, created_at)
        VALUES ('x', 'p', 'epic', 'bad', 'pending', 0, 0)
      `).run(),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts`
Expected: all 3 tests fail because v9 isn't registered.

- [ ] **Step 3: Register migration v9**

In `packages/store/src/local/migrations.ts`:

1. Update the import on line 2 to add `SCHEMA_V9_DDL`:

```ts
import { SCHEMA_V1_DDL, SCHEMA_V2_DDL, SCHEMA_V3_DDL, SCHEMA_V4_DDL, SCHEMA_V5_DDL, SCHEMA_V6_DDL, SCHEMA_V7_DDL, SCHEMA_V8_DDL, SCHEMA_V9_DDL, CREATE_COMMIT_EMBEDDINGS } from './schema.js'
```

2. Append a new entry to the `MIGRATIONS` array (after the v8 entry, before the closing `]`):

```ts
  {
    version: 9,
    name: 'plan_nodes',
    run(db) {
      for (const sql of SCHEMA_V9_DDL) {
        db.exec(sql)
      }
      // No sweep. Planning is structurally exempt from staleness — it never decays.
    },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/migrations.ts packages/store/src/local/plan-nodes.test.ts
git commit -m "feat(store): register migration v9 — plan_nodes table"
```

---

## Task 4: `insertPlanTree` — create a plan→step→task tree

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Modify: `packages/store/src/local/plan-nodes.test.ts`

- [ ] **Step 1: Append failing test**

```ts
  it('insertPlanTree creates a full plan→step→task tree in one transaction', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p1', 'p1', 0)`).run()

    const plan = q.insertPlanTree('p1', {
      title: 'Plan 1D-α',
      children: [
        { title: 'Slice 1', children: [{ title: 'Task A' }, { title: 'Task B' }] },
        { title: 'Slice 2' },
      ],
    })

    expect(plan.level).toBe('plan')
    expect(plan.title).toBe('Plan 1D-α')
    expect(plan.children?.length).toBe(2)
    expect(plan.children?.[0].level).toBe('step')
    expect(plan.children?.[0].children?.[0].level).toBe('task')
    expect(plan.children?.[0].children?.[0].title).toBe('Task A')

    // All nodes are 'pending' by default
    const rows = db.prepare(`SELECT id, level, status FROM plan_nodes WHERE project_id = 'p1'`).all() as { id: string; level: string; status: string }[]
    expect(rows).toHaveLength(4) // 1 plan + 2 steps + 2 tasks - wait, only 1 step has children — recount
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
  })

  it('insertPlanTree rejects depth > 2 (max 3 levels)', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p2', 'p2', 0)`).run()
    expect(() =>
      q.insertPlanTree('p2', {
        title: 'too-deep',
        children: [{ title: 'step', children: [{ title: 'task', children: [{ title: 'illegal' }] }] }],
      }),
    ).toThrow(/depth/i)
  })
```

Adjust the count assertion: 1 plan + 2 steps + 2 tasks = 5 rows. Let me fix the assertion:

Replace `expect(rows).toHaveLength(4)` with `expect(rows).toHaveLength(5)` and drop the `expect(rows.length).toBeGreaterThanOrEqual(4)` line. Final assertion block:

```ts
    const rows = db.prepare(`SELECT id, level, status FROM plan_nodes WHERE project_id = 'p1'`).all() as { id: string; level: string; status: string }[]
    expect(rows).toHaveLength(5) // 1 plan + 2 steps + 2 tasks
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts -t "insertPlanTree"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `insertPlanTree` in queries.ts**

In `packages/store/src/local/queries.ts`:

a. Add `PlanNode`, `PlanNodeInput`, `PlanNodeLevel`, `PlanNodeStatus` to the existing `@contextgit/core` import block.

b. Add a row interface near the other row interfaces:

```ts
interface PlanNodeRow {
  id: string
  project_id: string
  parent_id: string | null
  level: string
  title: string
  status: string
  position: number
  git_commit_sha: string | null
  created_at: number
  completed_at: number | null
}
```

c. Add a converter near `toThread`:

```ts
function toPlanNode(row: PlanNodeRow): PlanNode {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id ?? undefined,
    level: row.level as PlanNodeLevel,
    title: row.title,
    status: row.status as PlanNodeStatus,
    position: row.position,
    gitCommitSha: row.git_commit_sha ?? undefined,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  }
}
```

d. Add prepared statement type declarations to the `stmts` field block:

```ts
    insertPlanNode: Statement
    selectPlanNode: Statement<[string]>
```

e. Add prepared statement initializations to the constructor's `stmts` object:

```ts
      // plan_nodes (04 DELTA)
      insertPlanNode: db.prepare(`
        INSERT INTO plan_nodes
          (id, project_id, parent_id, level, title, status, position, git_commit_sha, created_at, completed_at)
        VALUES
          (@id, @project_id, @parent_id, @level, @title, @status, @position, @git_commit_sha, @created_at, @completed_at)
      `),
      selectPlanNode: db.prepare(`SELECT * FROM plan_nodes WHERE id = ?`),
```

f. Add the public method on `Queries` (near the bottom, after the trace methods):

```ts
  /**
   * Insert a full plan→step→task tree atomically. Depth is capped at 3 — input
   * root is level='plan', its children are 'step', their children are 'task'.
   * Anything deeper throws.
   *
   * Returns the inserted plan with its `children` populated recursively.
   */
  insertPlanTree(projectId: string, input: PlanNodeInput): PlanNode {
    const levels: PlanNodeLevel[] = ['plan', 'step', 'task']
    const now = Date.now()

    const insertRecursive = (
      node: PlanNodeInput,
      parentId: string | null,
      depth: number,
      position: number,
    ): PlanNode => {
      if (depth >= 3) {
        throw new Error(`insertPlanTree: depth exceeds 3 levels (plan→step→task) at title '${node.title}'`)
      }
      const id = nanoid()
      const level = levels[depth]
      this.stmts.insertPlanNode.run({
        id,
        project_id: projectId,
        parent_id: parentId,
        level,
        title: node.title,
        status: node.status ?? 'pending',
        position,
        git_commit_sha: null,
        created_at: now,
        completed_at: null,
      })
      const children = node.children?.map((c, i) => insertRecursive(c, id, depth + 1, i)) ?? []
      const inserted = toPlanNode(this.stmts.selectPlanNode.get(id) as PlanNodeRow)
      if (children.length) inserted.children = children
      return inserted
    }

    const tree = this.db.transaction(() => insertRecursive(input, null, 0, 0))()
    return tree
  }
```

Make sure `nanoid` is imported at the top of queries.ts (it already is from prior tasks).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts -t "insertPlanTree"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the full store test suite**

Run: `pnpm --filter @contextgit/core build && pnpm vitest run packages/store/`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/plan-nodes.test.ts
git commit -m "feat(store): Queries.insertPlanTree — atomic plan→step→task tree creation"
```

---

## Task 5: `getPlanTree` — read the active tree with derived progress

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Modify: `packages/store/src/local/plan-nodes.test.ts`

- [ ] **Step 1: Append failing test**

```ts
  it('getPlanTree returns active plans with children and derived progress', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p3', 'p3', 0)`).run()
    const plan = q.insertPlanTree('p3', {
      title: 'P',
      children: [
        { title: 'S1', children: [{ title: 'T1' }, { title: 'T2' }] },
        { title: 'S2', children: [{ title: 'T3' }] },
      ],
    })
    // Mark T1 as done
    const t1Id = plan.children![0].children![0].id
    q.updatePlanNodeStatus(t1Id, 'done', null)

    const trees = q.getPlanTree('p3')
    expect(trees).toHaveLength(1)
    expect(trees[0].title).toBe('P')
    // P has 3 leaf tasks; 1 done → progress { done: 1, total: 3 }
    expect(trees[0].progress).toEqual({ done: 1, total: 3 })
    // S1 has 2 tasks; 1 done
    expect(trees[0].children?.[0].progress).toEqual({ done: 1, total: 2 })
    // S2 has 1 task; 0 done
    expect(trees[0].children?.[1].progress).toEqual({ done: 0, total: 1 })
  })

  it('getPlanTree excludes plans where every leaf task is done (derived-completion drops out of active view)', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p4', 'p4', 0)`).run()
    const plan = q.insertPlanTree('p4', {
      title: 'AllDone',
      children: [{ title: 'OnlyStep', children: [{ title: 'OnlyTask' }] }],
    })
    const taskId = plan.children![0].children![0].id
    q.updatePlanNodeStatus(taskId, 'done', null)

    const trees = q.getPlanTree('p4')
    expect(trees).toHaveLength(0)
  })
```

(The `updatePlanNodeStatus` call requires the method from Task 6. To keep tests TDD-clean per-task, **stub it here**: at the top of these tests, add a minimal direct-SQL update before calling getPlanTree, until Task 6 lands.)

Replace the `q.updatePlanNodeStatus(t1Id, 'done', null)` with:

```ts
db.prepare(`UPDATE plan_nodes SET status = 'done', completed_at = 0 WHERE id = ?`).run(t1Id)
```

And the same for the second test. Then in Task 6 we'll switch them back to `q.updatePlanNodeStatus(...)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts -t "getPlanTree"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `getPlanTree`**

In queries.ts:

a. Add prepared statement type declarations:

```ts
    listPlanNodesByProject: Statement<[string]>
```

b. Add prepared statement initialization:

```ts
      listPlanNodesByProject: db.prepare(`
        SELECT * FROM plan_nodes WHERE project_id = ? ORDER BY level, position
      `),
```

c. Add the public method:

```ts
  /**
   * Read the active plan tree for a project. Returns top-level plans
   * (parent_id IS NULL) with their full child trees attached. Each plan/step
   * node gets a derived `progress = { done, total }` computed from leaf tasks.
   *
   * Plans where every leaf task is `done` are excluded — they belong in
   * listCompletedPlans, not the active view.
   */
  getPlanTree(projectId: string): PlanNode[] {
    const rows = this.stmts.listPlanNodesByProject.all(projectId) as PlanNodeRow[]
    const byId = new Map<string, PlanNode>()
    const childrenByParent = new Map<string, PlanNode[]>()
    for (const row of rows) {
      const node = toPlanNode(row)
      byId.set(node.id, node)
      if (node.parentId) {
        if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, [])
        childrenByParent.get(node.parentId)!.push(node)
      }
    }
    for (const node of byId.values()) {
      const kids = childrenByParent.get(node.id)
      if (kids) {
        kids.sort((a, b) => a.position - b.position)
        node.children = kids
      }
    }

    // Compute progress (done/total leaf tasks) bottom-up
    const countLeaves = (node: PlanNode): { done: number; total: number } => {
      if (node.level === 'task') {
        return { done: node.status === 'done' ? 1 : 0, total: 1 }
      }
      let done = 0
      let total = 0
      for (const child of node.children ?? []) {
        const sub = countLeaves(child)
        done += sub.done
        total += sub.total
      }
      node.progress = { done, total }
      return { done, total }
    }

    const tops: PlanNode[] = []
    for (const node of byId.values()) {
      if (!node.parentId) {
        countLeaves(node)
        // Exclude fully-done plans from active view
        if (node.progress && node.progress.total > 0 && node.progress.done === node.progress.total) {
          continue
        }
        tops.push(node)
      }
    }
    tops.sort((a, b) => a.position - b.position)
    return tops
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts -t "getPlanTree"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/plan-nodes.test.ts
git commit -m "feat(store): Queries.getPlanTree — active plans with derived progress"
```

---

## Task 6: `updatePlanNodeStatus` + `updatePlanNodeTitle`

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Modify: `packages/store/src/local/plan-nodes.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
  it('updatePlanNodeStatus sets status and completed_at when going to done', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p5', 'p5', 0)`).run()
    db.prepare(`INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at)
      VALUES ('c5', 'b5', 'a', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', 0)`).run()
    db.prepare(`INSERT INTO branches (id, project_id, name, git_branch, status, created_at)
      VALUES ('b5', 'p5', 'main', 'main', 'active', 0)`).run()
    const plan = q.insertPlanTree('p5', {
      title: 'P', children: [{ title: 'S', children: [{ title: 'T' }] }],
    })
    const tId = plan.children![0].children![0].id

    q.updatePlanNodeStatus(tId, 'done', 'c5')

    const row = db.prepare(`SELECT status, completed_at, git_commit_sha FROM plan_nodes WHERE id = ?`).get(tId) as { status: string; completed_at: number | null; git_commit_sha: string | null }
    expect(row.status).toBe('done')
    expect(row.completed_at).not.toBeNull()
    expect(row.git_commit_sha).toBe('c5')
  })

  it('updatePlanNodeTitle changes the title', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p6', 'p6', 0)`).run()
    const plan = q.insertPlanTree('p6', { title: 'Old' })
    q.updatePlanNodeTitle(plan.id, 'New')
    const row = db.prepare(`SELECT title FROM plan_nodes WHERE id = ?`).get(plan.id) as { title: string }
    expect(row.title).toBe('New')
  })
```

After these methods are implemented, replace the direct SQL update in Task 5's tests (`db.prepare(\`UPDATE plan_nodes SET status...\`).run(t1Id)`) with `q.updatePlanNodeStatus(t1Id, 'done', null)`. Same for the second Task 5 test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts -t "updatePlanNode"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement the methods**

In queries.ts, add prepared statement type declarations:

```ts
    updatePlanNodeStatus: Statement
    updatePlanNodeTitle: Statement<[string, string]>
```

Add initializations:

```ts
      updatePlanNodeStatus: db.prepare(`
        UPDATE plan_nodes
        SET status = @status,
            completed_at = @completed_at,
            git_commit_sha = COALESCE(@git_commit_sha, git_commit_sha)
        WHERE id = @id
      `),
      updatePlanNodeTitle: db.prepare(`UPDATE plan_nodes SET title = ? WHERE id = ?`),
```

Add public methods:

```ts
  /**
   * Set a plan node's status. When transitioning to 'done', also stamps
   * `completed_at` and optionally `git_commit_sha` (the commit that completed it).
   */
  updatePlanNodeStatus(id: string, status: PlanNodeStatus, gitCommitSha: string | null): void {
    const completedAt = status === 'done' ? Date.now() : null
    this.stmts.updatePlanNodeStatus.run({ id, status, completed_at: completedAt, git_commit_sha: gitCommitSha })
  }

  updatePlanNodeTitle(id: string, title: string): void {
    this.stmts.updatePlanNodeTitle.run(title, id)
  }
```

- [ ] **Step 4: Replace direct-SQL updates in Task 5's tests**

In the two Task 5 tests (`getPlanTree returns ...` and `getPlanTree excludes ...`), find the `db.prepare(\`UPDATE plan_nodes SET status = 'done' ...\`).run(t1Id)` calls and replace them with `q.updatePlanNodeStatus(t1Id, 'done', null)`. (Same for taskId in the second test.)

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/plan-nodes.test.ts
git commit -m "feat(store): Queries.updatePlanNodeStatus + updatePlanNodeTitle"
```

---

## Task 7: `findPlanNodeByHandle` + `findPlanNodeByTitle` + `listCompletedPlans`

**Files:**
- Modify: `packages/store/src/local/queries.ts`
- Modify: `packages/store/src/local/plan-nodes.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
  it('findPlanNodeByHandle returns a node by 6-char prefix; throws on collision', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p7', 'p7', 0)`).run()
    const plan = q.insertPlanTree('p7', { title: 'My Plan' })
    const handle = plan.id.slice(0, 6)
    expect(q.findPlanNodeByHandle('p7', handle)?.id).toBe(plan.id)
    expect(q.findPlanNodeByHandle('p7', 'zzzzzz')).toBeUndefined()
  })

  it('findPlanNodeByTitle returns a node by exact title match on the project', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p8', 'p8', 0)`).run()
    q.insertPlanTree('p8', { title: 'Build StatusDot' })
    expect(q.findPlanNodeByTitle('p8', 'Build StatusDot')?.title).toBe('Build StatusDot')
    expect(q.findPlanNodeByTitle('p8', 'Nope')).toBeUndefined()
  })

  it('listCompletedPlans returns plans whose every leaf task is done', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p9', 'p9', 0)`).run()
    const plan = q.insertPlanTree('p9', {
      title: 'Shipped', children: [{ title: 'S', children: [{ title: 'T' }] }],
    })
    const taskId = plan.children![0].children![0].id
    q.updatePlanNodeStatus(taskId, 'done', null)

    const completed = q.listCompletedPlans('p9')
    expect(completed).toHaveLength(1)
    expect(completed[0].title).toBe('Shipped')
    // Active list should NOT include it
    expect(q.getPlanTree('p9')).toHaveLength(0)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts -t "findPlanNode\|listCompletedPlans"`
Expected: FAIL.

- [ ] **Step 3: Implement the methods**

Add prepared statement type declarations:

```ts
    findPlanByHandle: Statement<[string, string]>
    findPlanByTitle: Statement<[string, string]>
```

Add initializations:

```ts
      findPlanByHandle: db.prepare(`
        SELECT * FROM plan_nodes
        WHERE project_id = ? AND id LIKE ? || '%'
        LIMIT 2
      `),
      findPlanByTitle: db.prepare(`
        SELECT * FROM plan_nodes
        WHERE project_id = ? AND title = ?
        LIMIT 2
      `),
```

Add public methods:

```ts
  /**
   * Resolve a 6-char handle to a plan node on the project. Throws on prefix
   * collision (extremely unlikely with nanoid).
   */
  findPlanNodeByHandle(projectId: string, handle: string): PlanNode | undefined {
    const rows = this.stmts.findPlanByHandle.all(projectId, handle) as PlanNodeRow[]
    if (rows.length === 0) return undefined
    if (rows.length > 1) {
      throw new Error(`findPlanNodeByHandle: handle '${handle}' matches ${rows.length} plan nodes`)
    }
    return toPlanNode(rows[0])
  }

  /**
   * Resolve an exact title match to a plan node on the project. Throws when the
   * title is ambiguous (multiple matches across plans/steps/tasks).
   */
  findPlanNodeByTitle(projectId: string, title: string): PlanNode | undefined {
    const rows = this.stmts.findPlanByTitle.all(projectId, title) as PlanNodeRow[]
    if (rows.length === 0) return undefined
    if (rows.length > 1) {
      throw new Error(`findPlanNodeByTitle: title '${title}' matches ${rows.length} plan nodes`)
    }
    return toPlanNode(rows[0])
  }

  /**
   * List plans (level='plan', parent_id IS NULL) whose every leaf task is done.
   * The completed delivery record — kept indefinitely, never archived.
   */
  listCompletedPlans(projectId: string): PlanNode[] {
    const rows = this.stmts.listPlanNodesByProject.all(projectId) as PlanNodeRow[]
    const byId = new Map<string, PlanNode>()
    const childrenByParent = new Map<string, PlanNode[]>()
    for (const row of rows) {
      const node = toPlanNode(row)
      byId.set(node.id, node)
      if (node.parentId) {
        if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, [])
        childrenByParent.get(node.parentId)!.push(node)
      }
    }
    for (const node of byId.values()) {
      const kids = childrenByParent.get(node.id)
      if (kids) {
        kids.sort((a, b) => a.position - b.position)
        node.children = kids
      }
    }
    const countLeaves = (node: PlanNode): { done: number; total: number } => {
      if (node.level === 'task') return { done: node.status === 'done' ? 1 : 0, total: 1 }
      let done = 0, total = 0
      for (const c of node.children ?? []) {
        const sub = countLeaves(c)
        done += sub.done
        total += sub.total
      }
      node.progress = { done, total }
      return { done, total }
    }
    const completed: PlanNode[] = []
    for (const node of byId.values()) {
      if (!node.parentId) {
        countLeaves(node)
        if (node.progress && node.progress.total > 0 && node.progress.done === node.progress.total) {
          completed.push(node)
        }
      }
    }
    return completed
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/store/src/local/plan-nodes.test.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/queries.ts packages/store/src/local/plan-nodes.test.ts
git commit -m "feat(store): Queries plan-node handle/title lookups + listCompletedPlans"
```

---

## Task 8: ContextStore interface + Supabase/Remote stubs

**Files:**
- Modify: `packages/store/src/interface.ts`
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/remote/index.ts`

- [ ] **Step 1: Add methods to the interface**

In `packages/store/src/interface.ts`, add `PlanNode`, `PlanNodeInput`, `PlanNodeStatus` to the `@contextgit/core` import.

After the existing thread-lifecycle block (the `archiveThread?` / `restoreThread?` etc.), add:

```ts
  // Planning hierarchy (04 DELTA) — optional until SupabaseStore/RemoteStore implement
  insertPlanTree?(projectId: string, input: PlanNodeInput): Promise<PlanNode>
  getPlanTree?(projectId: string): Promise<PlanNode[]>
  listCompletedPlans?(projectId: string): Promise<PlanNode[]>
  updatePlanNodeStatus?(id: string, status: PlanNodeStatus, gitCommitSha: string | null): Promise<void>
  updatePlanNodeTitle?(id: string, title: string): Promise<void>
  findPlanNodeByHandle?(projectId: string, handle: string): Promise<PlanNode | undefined>
  findPlanNodeByTitle?(projectId: string, title: string): Promise<PlanNode | undefined>
```

- [ ] **Step 2: Stub on SupabaseStore and RemoteStore**

In `packages/store/src/supabase/index.ts`, at the end of the class body (before the closing `}`), add:

```ts
  insertPlanTree(): never {
    throw new Error('insertPlanTree: not implemented in 0.2.0 — LocalStore only')
  }
  getPlanTree(): never {
    throw new Error('getPlanTree: not implemented in 0.2.0 — LocalStore only')
  }
  listCompletedPlans(): never {
    throw new Error('listCompletedPlans: not implemented in 0.2.0 — LocalStore only')
  }
  updatePlanNodeStatus(): never {
    throw new Error('updatePlanNodeStatus: not implemented in 0.2.0 — LocalStore only')
  }
  updatePlanNodeTitle(): never {
    throw new Error('updatePlanNodeTitle: not implemented in 0.2.0 — LocalStore only')
  }
  findPlanNodeByHandle(): never {
    throw new Error('findPlanNodeByHandle: not implemented in 0.2.0 — LocalStore only')
  }
  findPlanNodeByTitle(): never {
    throw new Error('findPlanNodeByTitle: not implemented in 0.2.0 — LocalStore only')
  }
```

Apply IDENTICAL stubs to `packages/store/src/remote/index.ts`.

- [ ] **Step 3: Type-check + run tests**

Run: `pnpm build && pnpm test`
Expected: clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/store/src/interface.ts packages/store/src/supabase/index.ts packages/store/src/remote/index.ts
git commit -m "feat(store): extend ContextStore with plan-node methods, stub remote backends"
```

---

## Task 9: LocalStore pass-throughs + populate `planTree` in snapshot

**Files:**
- Modify: `packages/store/src/local/index.ts`
- Modify: `packages/store/src/local/queries.ts` (one-line change to `getSessionSnapshot`)
- Modify: `packages/store/src/local/local-store.test.ts`

- [ ] **Step 1: Append failing test**

Append to `packages/store/src/local/local-store.test.ts`:

```ts
  it('LocalStore plan-tree round-trip: insertPlanTree → getPlanTree → updatePlanNodeStatus → completed', async () => {
    const project = await store.createProject({ name: 'p' })

    const plan = await store.insertPlanTree!(project.id, {
      title: 'Plan Z',
      children: [{ title: 'Step 1', children: [{ title: 'Task A' }] }],
    })
    expect(plan.level).toBe('plan')
    expect(plan.children?.[0].children?.[0].title).toBe('Task A')

    const active = await store.getPlanTree!(project.id)
    expect(active).toHaveLength(1)

    const taskId = plan.children![0].children![0].id
    await store.updatePlanNodeStatus!(taskId, 'done', null)

    const afterActive = await store.getPlanTree!(project.id)
    expect(afterActive).toHaveLength(0)

    const completed = await store.listCompletedPlans!(project.id)
    expect(completed).toHaveLength(1)
  })

  it('SessionSnapshot.planTree is populated from getPlanTree', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await store.insertPlanTree!(project.id, {
      title: 'In-progress plan',
      children: [{ title: 'S', children: [{ title: 'T' }] }],
    })
    const snap = await store.getSessionSnapshot(project.id, branch.id)
    expect(snap.planTree).toBeDefined()
    expect(snap.planTree!.length).toBe(1)
    expect(snap.planTree![0].title).toBe('In-progress plan')
  })
```

Run; expect FAIL.

- [ ] **Step 2: Add pass-throughs to LocalStore**

In `packages/store/src/local/index.ts`, after the existing 03 thread-archive pass-throughs (around `restoreAllArchivedByReason`), add:

```ts
  insertPlanTree(projectId: string, input: import('@contextgit/core').PlanNodeInput): Promise<import('@contextgit/core').PlanNode> {
    try {
      return Promise.resolve(this.q.insertPlanTree(projectId, input))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  getPlanTree(projectId: string): Promise<import('@contextgit/core').PlanNode[]> {
    try {
      return Promise.resolve(this.q.getPlanTree(projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  listCompletedPlans(projectId: string): Promise<import('@contextgit/core').PlanNode[]> {
    try {
      return Promise.resolve(this.q.listCompletedPlans(projectId))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  updatePlanNodeStatus(id: string, status: import('@contextgit/core').PlanNodeStatus, gitCommitSha: string | null): Promise<void> {
    try {
      this.q.updatePlanNodeStatus(id, status, gitCommitSha)
      return Promise.resolve()
    } catch (e) {
      return Promise.reject(e)
    }
  }

  updatePlanNodeTitle(id: string, title: string): Promise<void> {
    try {
      this.q.updatePlanNodeTitle(id, title)
      return Promise.resolve()
    } catch (e) {
      return Promise.reject(e)
    }
  }

  findPlanNodeByHandle(projectId: string, handle: string): Promise<import('@contextgit/core').PlanNode | undefined> {
    try {
      return Promise.resolve(this.q.findPlanNodeByHandle(projectId, handle))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  findPlanNodeByTitle(projectId: string, title: string): Promise<import('@contextgit/core').PlanNode | undefined> {
    try {
      return Promise.resolve(this.q.findPlanNodeByTitle(projectId, title))
    } catch (e) {
      return Promise.reject(e)
    }
  }
```

- [ ] **Step 3: Wire `planTree` into `getSessionSnapshot`**

In `packages/store/src/local/queries.ts`, find the `getSessionSnapshot` method. Just before the final `return { ... }`, add:

```ts
    const planTree = this.getPlanTree(projectId)
```

And add `planTree` to the returned snapshot object:

```ts
    return {
      projectSummary,
      branchName: branch?.name ?? '',
      branchSummary,
      recentCommits,
      openThreads,
      activeClaims,
      isInitiated,
      staleThreadCount,
      expiredWatchCount,
      planTree,
    }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/store/src/local/local-store.test.ts -t "plan-tree round-trip\|planTree is populated"`
Expected: PASS.

Run: `pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/local/index.ts packages/store/src/local/queries.ts packages/store/src/local/local-store.test.ts
git commit -m "feat(store): LocalStore plan-node pass-throughs + planTree in SessionSnapshot"
```

---

## Task 10: Integrate `completesTasks` into `createCommit` atomically

**Files:**
- Modify: `packages/store/src/local/index.ts`
- Modify: `packages/store/src/local/local-store.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
  it('createCommit completesTasks — handle match marks the task done', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const plan = await store.insertPlanTree!(project.id, {
      title: 'P', children: [{ title: 'S', children: [{ title: 'T1' }] }],
    })
    const taskId = plan.children![0].children![0].id
    const handle = taskId.slice(0, 6)

    const commit = await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'done T1', content: 'x', summary: 'x',
      commitType: 'manual',
      completesTasks: [handle],
    })

    const completed = await store.listCompletedPlans!(project.id)
    expect(completed).toHaveLength(1)
    // The task's git_commit_sha should be set to commit.id
    // (verify via direct SQL since the API doesn't surface it directly)
    // commit recorded properly
    expect(commit.id).toBeTruthy()
  })

  it('createCommit completesTasks — title match marks the task done', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    await store.insertPlanTree!(project.id, {
      title: 'P', children: [{ title: 'S', children: [{ title: 'Specific Task Title' }] }],
    })

    await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'done', content: 'x', summary: 'x',
      commitType: 'manual',
      completesTasks: ['Specific Task Title'],
    })

    const completed = await store.listCompletedPlans!(project.id)
    expect(completed).toHaveLength(1)
  })

  it('createCommit completesTasks — already-done node is a no-op success', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const plan = await store.insertPlanTree!(project.id, {
      title: 'P', children: [{ title: 'S', children: [{ title: 'T' }] }],
    })
    const taskId = plan.children![0].children![0].id
    const handle = taskId.slice(0, 6)
    await store.updatePlanNodeStatus!(taskId, 'done', 'prior-commit')

    // Same handle on a new save — must NOT throw.
    await store.createCommit({
      branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
      workflowType: 'interactive', message: 'c', content: 'y', summary: 'y',
      commitType: 'manual',
      completesTasks: [handle],
    })
    // Still one completed plan, no error.
    expect(await store.listCompletedPlans!(project.id)).toHaveLength(1)
  })

  it('createCommit completesTasks — no match aborts the entire save atomically', async () => {
    const project = await store.createProject({ name: 'p' })
    const branch = await store.createBranch({ projectId: project.id, name: 'main', gitBranch: 'main' })
    const before = (await store.listCommits(branch.id, { limit: 100, offset: 0 })).length

    await expect(
      store.createCommit({
        branchId: branch.id, agentId: 'a', agentRole: 'solo', tool: 't',
        workflowType: 'interactive', message: 'c', content: 'y', summary: 'y',
        commitType: 'manual',
        completesTasks: ['xxxxxx-bogus'],
      }),
    ).rejects.toThrow(/completesTasks/)

    const after = (await store.listCommits(branch.id, { limit: 100, offset: 0 })).length
    expect(after).toBe(before)
  })
```

Run; expect 4 FAIL.

- [ ] **Step 2: Implement in `createCommit`**

In `packages/store/src/local/index.ts`, locate the `createCommit` transaction body. Find the existing `// 03 DELTA: closesThreads` block (around line 263). Immediately AFTER that block (and BEFORE `// Update branch HEAD`), insert:

```ts
        // 04 DELTA: completesTasks — atomic resolve handle → title → already-done no-op.
        // Whole save fails if any entry stays unresolved.
        if (input.completesTasks?.length) {
          for (const raw of input.completesTasks) {
            const candidate = raw.trim()
            const handle = candidate.slice(0, 6)

            // 1. Try as handle
            const byHandle = this.q.findPlanNodeByHandle(branch.projectId, handle)
            if (byHandle) {
              if (byHandle.status !== 'done') {
                this.q.updatePlanNodeStatus(byHandle.id, 'done', commitId)
              }
              continue
            }

            // 2. Try as exact title
            const byTitle = this.q.findPlanNodeByTitle(branch.projectId, candidate)
            if (byTitle) {
              if (byTitle.status !== 'done') {
                this.q.updatePlanNodeStatus(byTitle.id, 'done', commitId)
              }
              continue
            }

            // 3. Unresolved — abort the whole save.
            throw new Error(
              `completesTasks: no plan node matched '${candidate}' (tried as handle and title)`,
            )
          }
        }
```

Note: the "already-done no-op" case is the second check inside the byHandle/byTitle branches (`if (byHandle.status !== 'done')`). A handle that matches an already-done node skips the update and continues — no error.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run packages/store/src/local/local-store.test.ts -t "completesTasks"`
Expected: 4 PASS.

Run: `pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/store/src/local/index.ts packages/store/src/local/local-store.test.ts
git commit -m "feat(store): createCommit resolves completesTasks atomically (handle/title)"
```

---

## Task 11: Snapshot formatter — `## Plan` section

**Files:**
- Modify: `packages/core/src/snapshot.ts`
- Modify: `packages/core/src/snapshot.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
  it('agents-md renders ## Plan between ## Git and ## Open Threads when planTree is present', () => {
    const snapshot = makeSnapshot({
      headSha: 'a1b2c3d4',
      commitCount: 10,
      planTree: [
        {
          id: 'plan-1234567890',
          projectId: 'p', level: 'plan', title: 'Webapp foundation',
          status: 'pending', position: 0, createdAt: new Date(),
          progress: { done: 1, total: 3 },
          children: [
            { id: 'step-1234567890', projectId: 'p', parentId: 'plan-1234567890', level: 'step',
              title: 'Slice 1', status: 'done', position: 0, createdAt: new Date(),
              progress: { done: 1, total: 1 },
              children: [
                { id: 'task-AA12345678', projectId: 'p', parentId: 'step-1234567890', level: 'task',
                  title: 'StatusDot', status: 'done', position: 0, createdAt: new Date() },
              ],
            },
            { id: 'step-2234567890', projectId: 'p', parentId: 'plan-1234567890', level: 'step',
              title: 'Slice 2', status: 'pending', position: 1, createdAt: new Date(),
              progress: { done: 0, total: 2 },
              children: [
                { id: 'task-BB12345678', projectId: 'p', parentId: 'step-2234567890', level: 'task',
                  title: 'ProgressBar', status: 'pending', position: 0, createdAt: new Date() },
                { id: 'task-CC12345678', projectId: 'p', parentId: 'step-2234567890', level: 'task',
                  title: 'AISuggestionCard', status: 'pending', position: 1, createdAt: new Date() },
              ],
            },
          ],
        },
      ],
    })
    const out = formatter.format(snapshot, 'agents-md')
    // Section header present
    expect(out).toContain('## Plan')
    // Plan title with progress badge
    expect(out).toContain('Webapp foundation')
    expect(out).toContain('[1/3 done]')
    // Done task uses ✓
    expect(out).toContain('✓ StatusDot')
    // First pending task is marked next
    expect(out).toContain('→ ProgressBar')
    // Subsequent pending task is plain ○
    expect(out).toContain('○ AISuggestionCard')
    // Ordering: ## Plan comes before ## Open Threads
    expect(out.indexOf('## Plan')).toBeLessThan(out.indexOf('## Open Threads'))
    // Ordering: ## Git comes before ## Plan
    expect(out.indexOf('## Git')).toBeLessThan(out.indexOf('## Plan'))
  })

  it('agents-md omits ## Plan when planTree is empty or undefined', () => {
    const snapshot1 = makeSnapshot({ planTree: [] })
    expect(formatter.format(snapshot1, 'agents-md')).not.toContain('## Plan')
    const snapshot2 = makeSnapshot()
    expect(formatter.format(snapshot2, 'agents-md')).not.toContain('## Plan')
  })

  it('text format also renders === PLAN === when planTree is non-empty', () => {
    const snapshot = makeSnapshot({
      planTree: [{
        id: 'planXYZ-rest', projectId: 'p', level: 'plan', title: 'Test plan',
        status: 'pending', position: 0, createdAt: new Date(),
        progress: { done: 0, total: 0 },
      }],
    })
    const out = formatter.format(snapshot, 'text')
    expect(out).toContain('=== PLAN ===')
    expect(out).toContain('Test plan')
  })
```

Run; expect FAIL.

- [ ] **Step 2: Implement the renderer**

In `packages/core/src/snapshot.ts`, add a helper function near the top (after `gitFactsLine`):

```ts
/**
 * Render a plan tree as nested lines with status markers.
 *   ▸  in_progress or partial plan/step
 *   ✓  done
 *   →  the single "next" pending task — first pending task in document order
 *   ○  other pending
 *
 * Plan and step nodes get a `[n/m done]` progress badge when they have children.
 * Returns null when the tree is empty (no rendering).
 */
function renderPlanTree(tree: PlanNode[]): string | null {
  if (!tree || tree.length === 0) return null

  // Find the single "next" pending task (depth-first document order)
  let nextTaskId: string | null = null
  const findNext = (nodes: PlanNode[]): boolean => {
    for (const n of nodes) {
      if (n.level === 'task' && n.status === 'pending') {
        nextTaskId = n.id
        return true
      }
      if (n.children && findNext(n.children)) return true
    }
    return false
  }
  findNext(tree)

  const lines: string[] = []
  const render = (node: PlanNode, depth: number) => {
    const indent = '  '.repeat(depth)
    let marker: string
    if (node.level === 'task') {
      if (node.status === 'done') marker = '✓'
      else if (node.id === nextTaskId) marker = '→'
      else if (node.status === 'in_progress') marker = '▸'
      else marker = '○'
    } else {
      // plan or step
      if (node.progress && node.progress.total > 0 && node.progress.done === node.progress.total) marker = '✓'
      else if (node.progress && node.progress.done > 0) marker = '▸'
      else if (node.status === 'in_progress') marker = '▸'
      else marker = '○'
    }
    let line = `${indent}${marker} ${node.title}`
    if (node.level !== 'task' && node.progress && node.progress.total > 0) {
      line += `        [${node.progress.done}/${node.progress.total} done]`
    }
    if (node.id === nextTaskId) line += '          ← next'
    lines.push(line)
    for (const c of node.children ?? []) render(c, depth + 1)
  }
  for (const top of tree) render(top, 0)
  return lines.join('\n')
}
```

Add `PlanNode` to the existing `import type` at the top of the file.

In `format()`, locate the agents-md branch. Insert the `## Plan` section between `## Git` and `## Open Threads`:

```ts
      const sections: string[] = []
      if (factsLine) sections.push(`## Git`, factsLine, ``)
      const planRendered = renderPlanTree(snapshot.planTree ?? [])
      if (planRendered) sections.push(`## Plan`, planRendered, ``)
      sections.push(`## Open Threads`, threadsSection)
```

In the text format branch, insert similarly:

```ts
    const textSections: string[] = []
    if (factsLine) textSections.push(`=== GIT ===`, factsLine, ``)
    const planRenderedText = renderPlanTree(snapshot.planTree ?? [])
    if (planRenderedText) textSections.push(`=== PLAN ===`, planRenderedText, ``)
    textSections.push(`=== CURRENT BRANCH: ${branchName} ===`, branchSummary || '(no branch summary yet)')
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @contextgit/core build && pnpm vitest run packages/core/src/snapshot.test.ts`
Expected: all PASS.

Run: `pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/snapshot.ts packages/core/src/snapshot.test.ts
git commit -m "feat(core): snapshot formatter renders ## Plan section with → next marker"
```

---

## Task 12: MCP tool `project_memory_plan` (create/update)

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Locate the MCP server registration block**

In `packages/mcp/src/server.ts`, find the `project_memory_threads` tool registration block (around line 920+) and use it as a template.

- [ ] **Step 2: Add the handler + schema + registration**

After the existing `project_memory_trace` block (or any convenient location before the final `return` of the setup function), add:

```ts
  // ── project_memory_plan (04 DELTA) ──────────────────────────────────────────

  const handleProjectMemoryPlan = async ({
    create,
    update,
  }: {
    create?: { title: string; status?: 'pending' | 'in_progress' | 'done'; children?: unknown }
    update?: { handle: string; status?: 'pending' | 'in_progress' | 'done'; title?: string }
  }) => {
    try {
      if (create && update) {
        return {
          content: [{ type: 'text' as const, text: 'Error: pass either `create` or `update`, not both.' }],
          isError: true,
        }
      }

      if (create) {
        // Cast the children to PlanNodeInput recursively — the schema validated shape.
        const plan = await ctx.store.insertPlanTree!(ctx.projectId, create as import('@contextgit/core').PlanNodeInput)
        const counts = countNodes(plan)
        return {
          content: [{
            type: 'text' as const,
            text: `Created plan [${plan.id.slice(0, 6)}] '${plan.title}' (${counts.plans} plan, ${counts.steps} step(s), ${counts.tasks} task(s)).`,
          }],
        }
      }

      if (update) {
        const handle = update.handle.slice(0, 6)
        const node = await ctx.store.findPlanNodeByHandle!(ctx.projectId, handle)
        if (!node) {
          return {
            content: [{ type: 'text' as const, text: `No plan node matched handle '${update.handle}'.` }],
            isError: true,
          }
        }
        if (update.status) {
          await ctx.store.updatePlanNodeStatus!(node.id, update.status, null)
        }
        if (update.title) {
          await ctx.store.updatePlanNodeTitle!(node.id, update.title)
        }
        return {
          content: [{
            type: 'text' as const,
            text: `Updated plan node [${node.id.slice(0, 6)}] ${update.status ? `status=${update.status}` : ''}${update.title ? ` title='${update.title}'` : ''}.`,
          }],
        }
      }

      return {
        content: [{ type: 'text' as const, text: 'Error: pass either `create` or `update`.' }],
        isError: true,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
    }
  }

  // Helper: count nodes in a plan tree by level
  function countNodes(node: import('@contextgit/core').PlanNode): { plans: number; steps: number; tasks: number } {
    const acc = { plans: 0, steps: 0, tasks: 0 }
    const walk = (n: import('@contextgit/core').PlanNode) => {
      if (n.level === 'plan') acc.plans++
      else if (n.level === 'step') acc.steps++
      else acc.tasks++
      for (const c of n.children ?? []) walk(c)
    }
    walk(node)
    return acc
  }

  // Recursive zod schema for nested plan input
  const planNodeInputSchema: z.ZodType<{ title: string; status?: string; children?: any[] }> = z.lazy(() =>
    z.object({
      title: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'done']).optional(),
      children: z.array(planNodeInputSchema).optional(),
    }),
  )

  const projectMemoryPlanSchema = {
    create: planNodeInputSchema.optional().describe(
      'Create a new plan tree. Pass a nested {title, children?: [{title, children?: [{title}]}]} structure. ' +
      'Depth ≤ 3 (plan → step → task). Each node defaults to status=pending.',
    ),
    update: z.object({
      handle: z.string().min(1).describe('6-char handle of the node to update.'),
      status: z.enum(['pending', 'in_progress', 'done']).optional(),
      title: z.string().optional(),
    }).optional().describe(
      'Update an existing plan node by 6-char handle. Pass status to check it off (done) or title to rename.',
    ),
  }

  server.tool(
    'project_memory_plan',
    `Create or update plan nodes. Planning is a three-level hierarchy: plan → step → task. ` +
    `Pass {create: {title, children: [...]}} to scaffold a tree in one call, or ` +
    `{update: {handle, status: 'done'}} to check a task off. Planning nodes never decay — they ` +
    `leave the active view only by being marked done (or all children done for plans/steps).`,
    projectMemoryPlanSchema,
    handleProjectMemoryPlan,
  )
```

- [ ] **Step 3: Type-check + run tests**

Run: `pnpm --filter @contextgit/mcp build && pnpm test`
Expected: clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): project_memory_plan tool — create + update plan-node hierarchy"
```

---

## Task 13: MCP tool `project_memory_plans` (read) + `completes_tasks` on save

**Files:**
- Modify: `packages/mcp/src/server.ts`

- [ ] **Step 1: Add `project_memory_plans` read tool**

In `packages/mcp/src/server.ts`, add after the `project_memory_plan` tool:

```ts
  // ── project_memory_plans (04 DELTA — read) ──────────────────────────────────

  const handleProjectMemoryPlans = async ({
    completed,
    plan: planHandle,
  }: {
    completed?: boolean
    plan?: string
  }) => {
    try {
      if (completed) {
        const done = await ctx.store.listCompletedPlans!(ctx.projectId)
        if (done.length === 0) {
          return { content: [{ type: 'text' as const, text: '(no completed plans)' }] }
        }
        const lines = done.map((p) => `[${p.id.slice(0, 6)}] ${p.title} (${p.progress?.done ?? 0}/${p.progress?.total ?? 0} done)`)
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      }

      if (planHandle) {
        const node = await ctx.store.findPlanNodeByHandle!(ctx.projectId, planHandle.slice(0, 6))
        if (!node) {
          return { content: [{ type: 'text' as const, text: `No plan node matched handle '${planHandle}'.` }], isError: true }
        }
        // For a drilled-in plan, return the full tree (use getPlanTree to compute progress)
        const trees = await ctx.store.getPlanTree!(ctx.projectId)
        const target = trees.find((t) => t.id === node.id)
        if (!target) {
          return { content: [{ type: 'text' as const, text: `Plan node ${planHandle} found but no active tree returned (already complete?).` }] }
        }
        // Reuse the formatter helper from snapshot.ts indirectly by formatting inline
        return { content: [{ type: 'text' as const, text: JSON.stringify(target, null, 2) }] }
      }

      // Default: active plan trees
      const trees = await ctx.store.getPlanTree!(ctx.projectId)
      if (trees.length === 0) {
        return { content: [{ type: 'text' as const, text: '(no active plans)' }] }
      }
      const summary = trees.map((p) => `[${p.id.slice(0, 6)}] ${p.title} (${p.progress?.done ?? 0}/${p.progress?.total ?? 0} done)`)
      return { content: [{ type: 'text' as const, text: summary.join('\n') }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
    }
  }

  const projectMemoryPlansSchema = {
    completed: z.boolean().optional().describe('List completed plans (the project delivery record) instead of active.'),
    plan: z.string().optional().describe('Drill into a single plan by 6-char handle. Returns its full tree JSON.'),
  }

  server.tool(
    'project_memory_plans',
    `Read plan nodes. Default: returns active plans with progress. ` +
    `completed=true lists finished plans (delivery record). plan=<handle> drills into one plan's full tree.`,
    projectMemoryPlansSchema,
    handleProjectMemoryPlans,
  )
```

- [ ] **Step 2: Add `completesTasks` to `EngineCommitInput` and pass it through**

In `packages/core/src/engine.ts`, locate the `EngineCommitInput` interface (around line 73). Add `completesTasks?: string[]` to it:

```ts
export interface EngineCommitInput {
  message: string
  content: string
  commitType?: CommitType
  gitCommitSha?: string
  ciRunId?: string
  pipelineName?: string
  threads?: {
    open?: string[]
    close?: Array<{ id: string; note: string }>
    closes?: string[]  // 03 DELTA (was already used at runtime; now type-correct)
  }
  completesTasks?: string[]  // 04 DELTA
}
```

In the `commit()` method (around line 129), find the `createCommit` call (line 142). Pass `completesTasks` through:

```ts
    const commit = await this.store.createCommit({
      branchId:     this.branchId,
      agentId:      this.agentId,
      agentRole:    this.agentRole,
      tool:         this.tool,
      workflowType: this.workflowType,
      message:      input.message,
      content:      input.content,
      summary,
      commitType:   input.commitType ?? 'manual',
      gitCommitSha: input.gitCommitSha,
      ciRunId:      input.ciRunId,
      pipelineName: input.pipelineName,
      threads:      input.threads,
      completesTasks: input.completesTasks,
    })
```

- [ ] **Step 3: Add `completes_tasks` to `project_memory_save`**

Find `handleProjectMemorySave` (around line 283 area). Update the signature and threads-assembly block:

Replace:

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

with:

```ts
  const handleProjectMemorySave = async ({
    message,
    content,
    open_threads,
    closes_threads,
    completes_tasks,
  }: {
    message: string
    content: string
    open_threads?: string[]
    closes_threads?: string[]
    completes_tasks?: string[]
  }) => {
```

Replace the existing `threads` assembly to include `completesTasks`:

Find:

```ts
      const threads: { open?: string[]; closes?: string[] } = {}
      if (open_threads?.length) threads.open = open_threads
      if (closes_threads?.length) threads.closes = closes_threads

      const git = await captureGitMetadata(process.cwd())
      const commit = await ctx.engine.commit({
        message,
        content,
        gitCommitSha: git?.sha,
        ...(Object.keys(threads).length > 0 ? { threads } : {}),
      })
```

Replace with:

```ts
      const threads: { open?: string[]; closes?: string[] } = {}
      if (open_threads?.length) threads.open = open_threads
      if (closes_threads?.length) threads.closes = closes_threads

      const git = await captureGitMetadata(process.cwd())
      const commit = await ctx.engine.commit({
        message,
        content,
        gitCommitSha: git?.sha,
        ...(Object.keys(threads).length > 0 ? { threads } : {}),
        ...(completes_tasks?.length ? { completesTasks: completes_tasks } : {}),
      })
```

Update the schema to add `completes_tasks`:

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
    completes_tasks: z.array(z.string()).optional().describe(
      'Plan tasks to mark done. Each entry can be a 6-char handle (from the ## Plan section) or an exact task title. Resolution is atomic — the whole save fails if any entry stays unresolved.',
    ),
  }
```

- [ ] **Step 4: Type-check + run tests**

Run: `pnpm build && pnpm test`
Expected: clean build, all tests pass. The new `completesTasks` field flows MCP → engine → store correctly.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/server.ts packages/core/src/engine.ts
git commit -m "feat(mcp,core): project_memory_plans tool + completes_tasks plumbed through engine"
```

---

## Task 14: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the section**

In `CHANGELOG.md`, find the 0.2.0 entry's Migrations subsection (currently `v6`, `v7`, `v8`). Update it to list v9 and add a new themed paragraph block under "Thread lifecycle and close ergonomics":

Find:

```markdown
Three automatic SQLite migrations apply on first use (`v6`, `v7`, `v8`). No manual step required.

- `v6` — `threads.kind` (default `'open'`) + `threads.last_touched_commit`
- `v7` — new `trace` table with indexes for windowed retrieval
- `v8` — new `thread_archive` table + one-time sweep of currently-stale threads
```

Replace with:

```markdown
Four automatic SQLite migrations apply on first use (`v6`, `v7`, `v8`, `v9`). No manual step required.

- `v6` — `threads.kind` (default `'open'`) + `threads.last_touched_commit`
- `v7` — new `trace` table with indexes for windowed retrieval
- `v8` — new `thread_archive` table + one-time sweep of currently-stale threads
- `v9` — new `plan_nodes` table (planning hierarchy)
```

Then add a new themed paragraph block before "Save-rhythm rule corrected to commit-binding model":

```markdown
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
atomically. Existing threads stay where they are; nothing migrates automatically
— rewrite a thread as a plan only when you mean to.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): add planning hierarchy section to 0.2.0"
```

---

## Task 15: Full audit + push

**Files:** (none — verification)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all tests pass. Should be ~205+ tests (was 188 from prior batch; this plan adds roughly 17-20 new).

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: clean tsc output across all 5 packages.

- [ ] **Step 3: Manual smoke-test**

Open a fresh Claude Code session against this project. Run:
- `project_memory_plan create={title: 'Test Plan', children: [{title: 'Test Step', children: [{title: 'Task 1'}, {title: 'Task 2'}]}]}` — verify the response shows the created tree.
- `project_memory_load` — verify the `## Plan` section appears between `## Git` and `## Open Threads`, with `→ next` on Task 1.
- `project_memory_save` with `completes_tasks=['<handle-of-Task-1>']` — verify Task 1 marked done, next reload shows `→ next` on Task 2.
- After both tasks done: `project_memory_load` no longer shows the plan; `project_memory_plans completed=true` lists it.

If any of those fail, return to the relevant task and fix.

- [ ] **Step 4: Push**

```bash
git push origin main
```

The branch is ready for 0.2.0 publish (use the checklist from the existing project memory — `npm whoami`, publish core→store→api→mcp→cli, tag v0.2.0).

---

## Notes on task ordering

- Tasks 1–10 must run in order (each builds on previous).
- Task 11 (snapshot formatter) can run any time after Task 9 (planTree in snapshot) but is sequenced here so the read path is testable end-to-end.
- Tasks 12–13 (MCP surface) follow Task 10 (createCommit completesTasks).
- Task 14 (CHANGELOG) follows everything else.
- Task 15 (audit + push) is terminal.

Total expected commit count: 14 (one per task except Task 15, which is verification + push).
