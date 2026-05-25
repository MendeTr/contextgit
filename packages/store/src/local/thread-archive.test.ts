import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations, sweepStaleThreadsOnMigration } from './migrations.js'

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

  it('one-time sweep moves currently-stale threads to thread_archive on first v8 run', () => {
    // Seed scenario: a thread touched at commit c0, then 35 newer commits on the
    // same branch since touch. classifyThread sees branchCommitsSince = 35 >= 30,
    // returns 'stale', and the migration sweep attributes the reason as
    // 'stale-distance' (since branchN >= 30 in the helper's reason logic).
    const now = Date.now()
    const olderTouch = now - 60 * 60 * 1000 // 1 hour ago

    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p1', 'proj', olderTouch)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b1', 'p1', 'main', 'main', 'active', olderTouch)

    // Touch commit (the thread points here)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c0', 'b1', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', olderTouch)

    // 35 newer commits after the touch — guarantees branchCommitsSince >= 30, which
    // is the classifyThread staleness threshold for 'open' threads.
    const stmt = db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = 1; i <= 35; i++) {
      stmt.run(`c${i}`, 'b1', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', olderTouch + i * 1000)
    }

    db.prepare(
      `INSERT INTO threads (id, project_id, branch_id, description, status, kind, opened_in_commit, last_touched_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t1', 'p1', 'b1', 'old thread', 'open', 'open', 'c0', 'c0', olderTouch)

    const moved = sweepStaleThreadsOnMigration(db, now)

    expect(moved).toBeGreaterThanOrEqual(1)

    const inThreads = db.prepare(`SELECT id FROM threads WHERE id = 't1'`).get()
    const inArchive = db.prepare(`SELECT id, archived_reason FROM thread_archive WHERE id = 't1'`).get() as { id: string; archived_reason: string } | undefined
    expect(inThreads).toBeUndefined()
    expect(inArchive?.id).toBe('t1')
    expect(inArchive?.archived_reason).toBe('stale-distance')
  })

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

  it('sweepStaleThreads archives currently-decayed threads and returns counts', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    const now = Date.now()
    const olderTouch = now - 60 * 60 * 1000

    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p7', 'p7', olderTouch)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b7', 'p7', 'main', 'main', 'active', olderTouch)
    // Touch commit + 35 newer commits to guarantee branchCommitsSince >= 30.
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c0', 'b7', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', olderTouch)
    const insertCommit = db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = 1; i <= 35; i++) {
      insertCommit.run(`c${i}`, 'b7', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', olderTouch + i * 1000)
    }
    q.insertThread('old-thread', 'subject', 'p7', 'b7', 'c0', 'interactive')

    const result = q.sweepStaleThreads('p7', now)
    expect(result.archived).toBeGreaterThanOrEqual(1)

    const inThreads = db.prepare(`SELECT id FROM threads WHERE id = 'old-thread'`).get()
    expect(inThreads).toBeUndefined()
    const inArchive = db.prepare(`SELECT id FROM thread_archive WHERE id = 'old-thread'`).get()
    expect(inArchive).toBeDefined()
  })
})
