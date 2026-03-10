import type { Database } from 'better-sqlite3'
import { SCHEMA_V1_DDL, SCHEMA_V2_DDL, CREATE_COMMIT_EMBEDDINGS } from './schema.js'

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
]

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
