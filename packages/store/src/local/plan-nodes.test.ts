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

  // ─── Task 4: insertPlanTree ───────────────────────────────────────────────

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

    const rows = db.prepare(`SELECT id, level, status FROM plan_nodes WHERE project_id = 'p1'`).all() as { id: string; level: string; status: string }[]
    expect(rows).toHaveLength(5) // 1 plan + 2 steps + 2 tasks
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
  })

  it('insertPlanTree accepts arbitrary depth (no level-enum cap)', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p2', 'p2', 0)`).run()

    // 4 levels deep: root → child → grandchild → great-grandchild. Real project
    // trees commonly exceed plan→step→task (e.g. Phase → sub-phase → Slice → Task).
    const plan = q.insertPlanTree('p2', {
      title: 'Phase 1',
      children: [{
        title: 'Sub-phase 1D-α',
        children: [{
          title: 'Slice 3',
          children: [
            { title: 'StatusDot' },
            { title: 'Checkbox' },
          ],
        }],
      }],
    })

    expect(plan.children?.[0].children?.[0].children).toHaveLength(2)
    expect(plan.children?.[0].children?.[0].children?.[0].title).toBe('StatusDot')
    // Depth 3+ nodes get level='task' (the 'level' enum is purely cosmetic for
    // depths ≥ 2 after removing the cap).
    expect(plan.children?.[0].children?.[0].children?.[0].level).toBe('task')

    const rows = db.prepare(`SELECT id, level FROM plan_nodes WHERE project_id = 'p2'`).all() as { id: string; level: string }[]
    expect(rows).toHaveLength(5) // 1 + 1 + 1 + 2
  })

  // ─── Task 5: getPlanTree ──────────────────────────────────────────────────

  it('getPlanTree returns active plans with direct-child progress semantics', async () => {
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
    const t1Id = plan.children![0].children![0].id
    q.updatePlanNodeStatus(t1Id, 'done', null)

    const trees = q.getPlanTree('p3')
    expect(trees).toHaveLength(1)
    expect(trees[0].title).toBe('P')
    // P has 2 direct children (S1, S2). Neither is effectively-done yet
    // (S1 has 1 of 2 done; S2 has 0 of 1).
    expect(trees[0].progress).toEqual({ done: 0, total: 2 })
    // S1 has 2 direct children, 1 done.
    expect(trees[0].children?.[0].progress).toEqual({ done: 1, total: 2 })
    // S2 has 1 direct child, 0 done.
    expect(trees[0].children?.[1].progress).toEqual({ done: 0, total: 1 })
  })

  it('getPlanTree progress is depth-agnostic — rollup is correct at any depth', async () => {
    // Reproduces the user's bug: Phase 1 with 9 children (8 placeholders + 1
    // sub-phase with 6 leaf tasks, 3 done) must show [0/9 done], NOT [3/6].
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_deep', 'p_deep', 0)`).run()

    const plan = q.insertPlanTree('p_deep', {
      title: 'Phase 1',
      children: [
        // The one populated sub-phase: 6 leaf tasks, mark 3 done after insert.
        { title: 'Sub-phase 1D-α', children: [
          { title: 'Task 1' },
          { title: 'Task 2' },
          { title: 'Task 3' },
          { title: 'Task 4' },
          { title: 'Task 5' },
          { title: 'Task 6' },
        ]},
        // 8 empty placeholder sub-phases.
        { title: 'Sub-phase 1B' },
        { title: 'Sub-phase 1C' },
        { title: 'Sub-phase 1D-β' },
        { title: 'Sub-phase 1D-γ' },
        { title: 'Sub-phase 1D-δ' },
        { title: 'Sub-phase 1D-SSO' },
        { title: 'Sub-phase 1E' },
        { title: 'Sub-phase 1F' },
      ],
    })

    // Mark 3 of the 6 leaf tasks done.
    const subPhase = plan.children![0]
    for (let i = 0; i < 3; i++) {
      q.updatePlanNodeStatus(subPhase.children![i].id, 'done', null)
    }

    const trees = q.getPlanTree('p_deep')
    const phase1 = trees[0]
    // Phase 1 has 9 direct children. None is effectively-done (sub-phase 1D-α
    // is only 3/6, placeholders have no children + status=pending).
    expect(phase1.progress).toEqual({ done: 0, total: 9 })
    // Sub-phase 1D-α has 6 direct children, 3 done.
    expect(phase1.children![0].progress).toEqual({ done: 3, total: 6 })
    // Placeholder sub-phases have no children — no progress badge (undefined).
    expect(phase1.children![1].progress).toBeUndefined()
  })

  it('getPlanTree: status=done on a step is honored — the container counts as complete (0.2.2)', async () => {
    // 0.2.2 decision A — honor container status. The rule:
    //   container.complete = (status='done') OR (hasChildren AND all children complete)
    // This reverses the 0.2.1 child-derived-only rule, which left a step the user
    // explicitly marked 'done' rendering ○ and excluded from parent rollups.
    // Real-world repro (project JiraExtensionAI): steps 1A/1B/1C marked done were
    // reported as "not started" and Phase 1 rolled up as [0/9] despite shipped work.
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_empty_step', 'p_empty_step', 0)`).run()

    const plan = q.insertPlanTree('p_empty_step', {
      title: 'Phase 1',
      children: [
        // The active sub-phase with 6 tasks, 4 done (matches user's 1D-α [4/6]).
        { title: 'Sub-phase 1D-α', children: [
          { title: 'T1' }, { title: 'T2' }, { title: 'T3' },
          { title: 'T4' }, { title: 'T5' }, { title: 'T6' },
        ]},
        // 3 placeholder steps that the user later marks status='done' directly
        // (matches user's 1A/1B/1C). These MUST count as complete now.
        { title: '1A' }, { title: '1B' }, { title: '1C' },
        // 5 pending placeholder steps.
        { title: '1D-β' }, { title: '1D-γ' }, { title: '1D-δ' },
        { title: '1D-SSO' }, { title: '1E' },
      ],
    })

    // The bug specifically targets nodes stored as level='step' with no children
    // (as in the user's actual data — created under depth-based level mapping).
    // Force level='step' on the 3 placeholders so the regression covers the real
    // case: a childless container the user marks 'done' directly.
    db.prepare(`UPDATE plan_nodes SET level = 'step' WHERE project_id = 'p_empty_step' AND title IN ('1A', '1B', '1C')`).run()

    // Mark 4 of 1D-α's 6 tasks done (4/6 — matches user's number).
    for (let i = 0; i < 4; i++) {
      q.updatePlanNodeStatus(plan.children![0].children![i].id, 'done', null)
    }
    // Mark 1A, 1B, 1C steps as status='done' directly (the user's case).
    for (let i = 1; i <= 3; i++) {
      q.updatePlanNodeStatus(plan.children![i].id, 'done', null)
    }

    const trees = q.getPlanTree('p_empty_step')
    const phase1 = trees[0]

    // 3 of Phase 1's 9 direct children are complete:
    //   - 1D-α: container with 4/6 children done, status pending → incomplete
    //   - 1A/1B/1C: containers (level='step') with status='done' → complete (honor status)
    //   - 5 pending placeholders → incomplete
    expect(phase1.progress).toEqual({ done: 3, total: 9 })
    // Sub-phase 1D-α still correctly rolls up its own tasks.
    expect(phase1.children![0].progress).toEqual({ done: 4, total: 6 })
  })

  it('getPlanTree: a step status=done with mixed-status children counts as complete (0.2.2)', async () => {
    // honor-status path: a container the user marks 'done' is complete even when
    // its children are not all done — children may be deferred/abandoned/done
    // elsewhere. We do NOT cascade status to children; status is per-node.
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_mixed', 'p_mixed', 0)`).run()
    const plan = q.insertPlanTree('p_mixed', {
      title: 'P',
      children: [
        { title: 'S1', children: [{ title: 'T1' }, { title: 'T2' }] },
        { title: 'S2', children: [{ title: 'T3' }] },
      ],
    })
    const s1 = plan.children![0]
    // S1: one child done, one pending — then mark S1 itself done.
    q.updatePlanNodeStatus(s1.children![0].id, 'done', null)
    q.updatePlanNodeStatus(s1.id, 'done', null)

    const trees = q.getPlanTree('p_mixed')
    // P has 2 direct children; S1 is now complete (status='done'), S2 is not.
    expect(trees[0].progress).toEqual({ done: 1, total: 2 })
    // Children are untouched — no cascade.
    const s1now = trees[0].children!.find((c) => c.id === s1.id)!
    expect(s1now.status).toBe('done')
    expect(s1now.children![1].status).toBe('pending')
  })

  it('getPlanTree: a plan status=done with zero done children is effectively-done (0.2.2)', async () => {
    // A plan the user marks 'done' is complete regardless of children, so it
    // leaves the active view and lands in listCompletedPlans.
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_donedplan', 'p_donedplan', 0)`).run()
    const plan = q.insertPlanTree('p_donedplan', {
      title: 'Done plan',
      children: [{ title: 'S', children: [{ title: 'T' }] }],
    })
    q.updatePlanNodeStatus(plan.id, 'done', null)

    expect(q.getPlanTree('p_donedplan')).toHaveLength(0)
    expect(q.listCompletedPlans('p_donedplan')).toHaveLength(1)
  })

  it('getPlanTree: status=pending with all children done still rolls up complete (OR path intact)', async () => {
    // The pre-existing child-derived path of the OR must still work.
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_orpath', 'p_orpath', 0)`).run()
    const plan = q.insertPlanTree('p_orpath', {
      title: 'P', children: [{ title: 'S', children: [{ title: 'T1' }, { title: 'T2' }] }],
    })
    const s = plan.children![0]
    // S stays status='pending' but both its tasks are marked done.
    for (const t of s.children!) q.updatePlanNodeStatus(t.id, 'done', null)

    // S is pending but all children done → effectively-done → plan complete → excluded.
    expect(q.getPlanTree('p_orpath')).toHaveLength(0)
    expect(q.listCompletedPlans('p_orpath')).toHaveLength(1)
  })

  it('getPlanTree: a non-leaf is effectively-done when all descendants are done (propagates up)', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_prop', 'p_prop', 0)`).run()
    const plan = q.insertPlanTree('p_prop', {
      title: 'P',
      children: [
        { title: 'S1', children: [{ title: 'T1' }, { title: 'T2' }] },
        { title: 'S2', children: [{ title: 'T3' }] },
      ],
    })
    // Mark all leaf tasks done. P should be effectively-done and excluded from
    // the active tree (goes to listCompletedPlans).
    for (const s of plan.children!) {
      for (const t of s.children!) q.updatePlanNodeStatus(t.id, 'done', null)
    }
    expect(q.getPlanTree('p_prop')).toHaveLength(0)
    expect(q.listCompletedPlans('p_prop')).toHaveLength(1)
  })

  it('getPlanTree excludes plans where every leaf task is done', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p4', 'p4', 0)`).run()
    const plan = q.insertPlanTree('p4', {
      title: 'AllDone',
      children: [{ title: 'OnlyStep', children: [{ title: 'OnlyTask' }] }],
    })
    const taskId = plan.children![0].children![0].id
    q.updatePlanNodeStatus(taskId, 'done', null)

    expect(q.getPlanTree('p4')).toHaveLength(0)
  })

  // ─── Task 6: updatePlanNodeStatus + updatePlanNodeTitle ───────────────────

  it('updatePlanNodeStatus sets status and completed_at when going to done', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p5', 'p5', 0)`).run()
    db.prepare(`INSERT INTO branches (id, project_id, name, git_branch, status, created_at)
      VALUES ('b5', 'p5', 'main', 'main', 'active', 0)`).run()
    db.prepare(`INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at)
      VALUES ('c5', 'b5', 'a', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', 0)`).run()
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

  // ─── Task 7: findPlanNodeByHandle, findPlanNodeByTitle, listCompletedPlans ─

  it('findPlanNodeByHandle returns a node by 6-char prefix; undefined if no match', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p7', 'p7', 0)`).run()
    const plan = q.insertPlanTree('p7', { title: 'My Plan' })
    const handle = plan.id.slice(0, 6)
    expect(q.findPlanNodeByHandle('p7', handle)?.id).toBe(plan.id)
    expect(q.findPlanNodeByHandle('p7', 'zzzzzz')).toBeUndefined()
  })

  it('findPlanNodeByTitle returns a node by exact title match', async () => {
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
    expect(q.getPlanTree('p9')).toHaveLength(0)
  })
})
