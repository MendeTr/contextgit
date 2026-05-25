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
})
