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
