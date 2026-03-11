// DDL for LocalStore (SQLite + sqlite-vec)
// Dates stored as INTEGER (Unix milliseconds).
// All primary keys are TEXT (nanoid).

export const CREATE_PROJECTS = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  github_url  TEXT,
  created_at  INTEGER NOT NULL
)
`

export const CREATE_BRANCHES = `
CREATE TABLE IF NOT EXISTS branches (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  name             TEXT NOT NULL,
  git_branch       TEXT NOT NULL,
  github_pr_url    TEXT,
  parent_branch_id TEXT REFERENCES branches(id),
  head_commit_id   TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       INTEGER NOT NULL,
  merged_at        INTEGER
)
`

export const CREATE_COMMITS = `
CREATE TABLE IF NOT EXISTS commits (
  id                     TEXT PRIMARY KEY,
  branch_id              TEXT NOT NULL REFERENCES branches(id),
  parent_id              TEXT REFERENCES commits(id),
  merge_source_branch_id TEXT REFERENCES branches(id),
  agent_id               TEXT NOT NULL,
  agent_role             TEXT NOT NULL DEFAULT 'solo',
  tool                   TEXT NOT NULL,
  workflow_type          TEXT NOT NULL DEFAULT 'interactive',
  loop_iteration         INTEGER,
  ci_run_id              TEXT,
  pipeline_name          TEXT,
  message                TEXT NOT NULL,
  content                TEXT NOT NULL,
  summary                TEXT NOT NULL,
  commit_type            TEXT NOT NULL DEFAULT 'manual',
  git_commit_sha         TEXT,
  created_at             INTEGER NOT NULL
)
`

export const CREATE_THREADS = `
CREATE TABLE IF NOT EXISTS threads (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  branch_id        TEXT NOT NULL REFERENCES branches(id),
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  workflow_type    TEXT,
  opened_in_commit TEXT NOT NULL REFERENCES commits(id),
  closed_in_commit TEXT REFERENCES commits(id),
  closed_note      TEXT,
  created_at       INTEGER NOT NULL
)
`

export const CREATE_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  role          TEXT NOT NULL DEFAULT 'solo',
  tool          TEXT NOT NULL,
  workflow_type TEXT NOT NULL DEFAULT 'interactive',
  display_name  TEXT,
  total_commits INTEGER NOT NULL DEFAULT 0,
  last_seen     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
)
`

// sqlite-vec virtual table — created only when sqlite-vec extension is loaded.
// Migration runner wraps this in try/catch and skips gracefully if unavailable.
export const CREATE_COMMIT_EMBEDDINGS = `
CREATE VIRTUAL TABLE IF NOT EXISTS commit_embeddings USING vec0(
  commit_id TEXT PRIMARY KEY,
  embedding FLOAT[384]
)
`

// FTS5 full-text search — migration v2 (added in Week 4)
export const CREATE_COMMITS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS commits_fts USING fts5(
  commit_id UNINDEXED,
  message,
  content,
  summary,
  content='commits',
  content_rowid='rowid'
)
`

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_commits_branch    ON commits(branch_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_commits_workflow  ON commits(branch_id, workflow_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_threads_project   ON threads(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_branches_git      ON branches(project_id, git_branch)`,
]

// Ordered list used by migration v1
export const SCHEMA_V1_DDL = [
  CREATE_PROJECTS,
  CREATE_BRANCHES,
  CREATE_COMMITS,
  CREATE_THREADS,
  CREATE_AGENTS,
  ...CREATE_INDEXES,
]

// Trigger to keep commits_fts in sync when rows are inserted into commits.
// The FTS5 content table does NOT auto-index — the index must be maintained explicitly.
export const CREATE_FTS_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS commits_ai AFTER INSERT ON commits BEGIN
  INSERT INTO commits_fts(rowid, commit_id, message, content, summary)
  VALUES (new.rowid, new.id, new.message, new.content, new.summary);
END
`

// Migration v2 adds FTS5 + the vec0 table (attempted separately)
export const SCHEMA_V2_DDL = [
  CREATE_COMMITS_FTS,
]

// Migration v3 adds the FTS trigger and rebuilds the index for any pre-existing rows
export const SCHEMA_V3_DDL = [
  CREATE_FTS_TRIGGER,
]
