import type { Database } from 'better-sqlite3'
import { SCHEMA_V1_DDL, SCHEMA_V2_DDL, SCHEMA_V3_DDL, SCHEMA_V4_DDL, SCHEMA_V5_DDL, SCHEMA_V6_DDL, SCHEMA_V7_DDL, SCHEMA_V8_DDL, CREATE_COMMIT_EMBEDDINGS } from './schema.js'
import { classifyThread } from '@contextgit/core'
import type { Thread } from '@contextgit/core'

interface MigrationRow {
  version: number
  name: string
  applied_at: number
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)
`

interface Migration {
  version: number
  name: string
  run(db: Database): void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    run(db) {
      for (const sql of SCHEMA_V1_DDL) {
        db.exec(sql)
      }
    },
  },
  {
    version: 2,
    name: 'fts5_and_vectors',
    run(db) {
      // FTS5 full-text index
      for (const sql of SCHEMA_V2_DDL) {
        db.exec(sql)
      }

      // sqlite-vec virtual table — optional, skipped if extension not loaded
      try {
        db.exec(CREATE_COMMIT_EMBEDDINGS)
      } catch {
        // sqlite-vec not loaded; semantic search will return empty results
      }
    },
  },
  {
    version: 3,
    name: 'fts_trigger',
    run(db) {
      // Add INSERT trigger to keep commits_fts in sync with commits table.
      // Then rebuild the index to pick up any rows inserted before this migration.
      for (const sql of SCHEMA_V3_DDL) {
        db.exec(sql)
      }
      try {
        db.exec(`INSERT INTO commits_fts(commits_fts) VALUES('rebuild')`)
      } catch {
        // FTS5 table not available — skip rebuild
      }
    },
  },
  {
    version: 4,
    name: 'claims_table',
    run(db) {
      for (const sql of SCHEMA_V4_DDL) {
        db.exec(sql)
      }
    },
  },
  {
    version: 5,
    name: 'multiagent_coordination',
    run(db) {
      for (const sql of SCHEMA_V5_DDL) {
        db.exec(sql)
      }
    },
  },
  {
    version: 6,
    name: 'threads_granularity',
    run(db) {
      for (const sql of SCHEMA_V6_DDL) {
        db.exec(sql)
      }
    },
  },
  {
    version: 7,
    name: 'trace_table',
    run(db) {
      for (const sql of SCHEMA_V7_DDL) {
        db.exec(sql)
      }
    },
  },
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
]

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
        : // classifyThread can return 'stale' via either projectCommitsSince (>=8) or
          // branchCommitsSince (>=30). Pick the more specific reason when commit-distance
          // crossed the branch threshold; otherwise attribute to age (project-wide cadence).
          branchN >= 30
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

export function runMigrations(db: Database): void {
  // Ensure migrations table exists
  db.exec(MIGRATIONS_TABLE)

  const getApplied = db.prepare<[], MigrationRow>(
    'SELECT version, name, applied_at FROM _migrations ORDER BY version'
  )
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)'
  )

  const applied = new Set(getApplied.all().map((r) => r.version))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue

    db.transaction(() => {
      migration.run(db)
      insertMigration.run(migration.version, migration.name, Date.now())
    })()
  }
}
