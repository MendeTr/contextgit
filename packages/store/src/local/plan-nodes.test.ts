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

  // ─── Task 5: getPlanTree ──────────────────────────────────────────────────

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
    const t1Id = plan.children![0].children![0].id
    q.updatePlanNodeStatus(t1Id, 'done', null)

    const trees = q.getPlanTree('p3')
    expect(trees).toHaveLength(1)
    expect(trees[0].title).toBe('P')
    expect(trees[0].progress).toEqual({ done: 1, total: 3 })
    expect(trees[0].children?.[0].progress).toEqual({ done: 1, total: 2 })
    expect(trees[0].children?.[1].progress).toEqual({ done: 0, total: 1 })
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
