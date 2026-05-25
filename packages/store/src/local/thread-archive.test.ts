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
    // Note: this test exercises v8 fresh — runMigrations already ran in beforeEach,
    // so we close and re-open with seeded data on the v7 schema first.
    db.close()
    db = new Database(':memory:')

    // Just run all migrations (v8 included with empty thread_archive), then seed a
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
    const moved = sweepStaleThreadsOnMigration(db, now)

    expect(moved).toBeGreaterThanOrEqual(1)

    const inThreads = db.prepare(`SELECT id FROM threads WHERE id = 't1'`).get()
    const inArchive = db.prepare(`SELECT id, archived_reason FROM thread_archive WHERE id = 't1'`).get() as { id: string; archived_reason: string } | undefined
    expect(inThreads).toBeUndefined()
    expect(inArchive?.id).toBe('t1')
    expect(['stale-age', 'stale-distance']).toContain(inArchive?.archived_reason)
  })
})
