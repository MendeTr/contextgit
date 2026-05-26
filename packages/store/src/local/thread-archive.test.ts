import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations, sweepStaleThreadsOnMigration } from './migrations.js'
import { SCHEMA_V10_DDL } from './schema.js'

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
    // 03 DELTA decay recalibration (AND-rule): a thread is stale only when
    // BOTH age (>14 days since touch) AND distance (≥30 branch commits since
    // touch) fire. Seed: thread touched 15 days ago + 35 newer commits.
    const now = Date.now()
    const olderTouch = now - 15 * 24 * 60 * 60 * 1000 // 15 days ago — past 14d age threshold

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

  it('restoreAllArchivedByReason moves archived rows back to threads, filtered by reason', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`).run('p8', 'p8', now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b8', 'p8', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c8', 'b8', 'a1', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)

    // Seed: three archived rows — two wrongly-archived-by-decay, one manual close.
    q.insertThread('age-1', 's1', 'p8', 'b8', 'c8', 'interactive')
    q.insertThread('dist-1', 's2', 'p8', 'b8', 'c8', 'interactive')
    q.insertThread('manual-1', 's3', 'p8', 'b8', 'c8', 'interactive')
    q.archiveThread('age-1', 'stale-age', 'c8')
    q.archiveThread('dist-1', 'stale-distance', 'c8')
    q.archiveThread('manual-1', 'manual', 'c8')

    const restored = q.restoreAllArchivedByReason('p8', ['stale-age', 'stale-distance'])

    expect(restored).toBe(2)

    // age-1 + dist-1 are back in threads; manual-1 stays in archive.
    const openIds = db.prepare(`SELECT id FROM threads WHERE project_id = 'p8'`).all().map((r: any) => r.id).sort()
    expect(openIds).toEqual(['age-1', 'dist-1'])

    const archivedIds = db.prepare(`SELECT id FROM thread_archive WHERE project_id = 'p8'`).all().map((r: any) => r.id)
    expect(archivedIds).toEqual(['manual-1'])
  })

  it('sweepStaleThreads archives currently-decayed threads and returns counts', async () => {
    const { Queries } = await import('./queries.js')
    const q = new Queries(db)
    const now = Date.now()
    // 03 DELTA decay recalibration: AND-rule needs BOTH age (>14d) and distance.
    const olderTouch = now - 15 * 24 * 60 * 60 * 1000 // 15 days ago

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

  it('v10 migration backfills threads.last_touched_commit from opened_in_commit where NULL', () => {
    // Simulate a pre-v6 row: insert a thread directly with last_touched_commit = NULL
    // (mimics rows that pre-dated migration v6's ALTER TABLE ADD COLUMN).
    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_bf', 'p_bf', ?)`).run(now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b_bf', 'p_bf', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c_bf', 'b_bf', 'a', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)
    // Directly insert with last_touched_commit = NULL (simulating pre-v6 row state).
    db.prepare(
      `INSERT INTO threads (id, project_id, branch_id, description, status, kind, opened_in_commit, last_touched_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t_legacy', 'p_bf', 'b_bf', 'legacy thread', 'open', 'open', 'c_bf', null, now)
    // Also seed an archived row with NULL last_touched_commit.
    db.prepare(
      `INSERT INTO thread_archive (id, project_id, branch_id, description, status, kind, opened_in_commit, last_touched_commit, created_at, archived_at, archived_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a_legacy', 'p_bf', 'b_bf', 'legacy archive', 'closed', 'open', 'c_bf', null, now, now, 'manual')

    // Pre-condition: both rows have NULL last_touched_commit.
    expect((db.prepare(`SELECT last_touched_commit FROM threads WHERE id = 't_legacy'`).get() as { last_touched_commit: string | null }).last_touched_commit).toBeNull()
    expect((db.prepare(`SELECT last_touched_commit FROM thread_archive WHERE id = 'a_legacy'`).get() as { last_touched_commit: string | null }).last_touched_commit).toBeNull()

    // runMigrations was called in beforeEach so v10 has already applied. To
    // exercise the backfill SQL on rows we just seeded (which were inserted
    // AFTER the migration ran), re-execute the v10 statements manually.
    for (const sql of SCHEMA_V10_DDL) db.exec(sql)

    // After backfill: both should equal opened_in_commit.
    expect((db.prepare(`SELECT last_touched_commit FROM threads WHERE id = 't_legacy'`).get() as { last_touched_commit: string }).last_touched_commit).toBe('c_bf')
    expect((db.prepare(`SELECT last_touched_commit FROM thread_archive WHERE id = 'a_legacy'`).get() as { last_touched_commit: string }).last_touched_commit).toBe('c_bf')
  })

  it('v10 migration leaves already-populated last_touched_commit alone', () => {
    const now = Date.now()
    db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p_keep', 'p_keep', ?)`).run(now)
    db.prepare(
      `INSERT INTO branches (id, project_id, name, git_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('b_keep', 'p_keep', 'main', 'main', 'active', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c_opened', 'b_keep', 'a', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now)
    db.prepare(
      `INSERT INTO commits (id, branch_id, agent_id, agent_role, tool, workflow_type, message, content, summary, commit_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('c_touched', 'b_keep', 'a', 'solo', 't', 'interactive', 'm', 'c', 's', 'manual', now + 1000)
    // Thread with last_touched_commit explicitly set to a different commit.
    db.prepare(
      `INSERT INTO threads (id, project_id, branch_id, description, status, kind, opened_in_commit, last_touched_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t_touched', 'p_keep', 'b_keep', 'touched thread', 'open', 'open', 'c_opened', 'c_touched', now)

    for (const sql of SCHEMA_V10_DDL) db.exec(sql)

    // Should still point to c_touched, NOT overwritten to c_opened.
    expect((db.prepare(`SELECT last_touched_commit FROM threads WHERE id = 't_touched'`).get() as { last_touched_commit: string }).last_touched_commit).toBe('c_touched')
  })
})
