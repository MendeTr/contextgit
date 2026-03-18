-- ContextGit — Supabase schema
-- Apply once via the Supabase SQL editor.
-- TEXT primary keys (nanoid) match LocalStore — no ID translation needed on push/pull.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  github_url  TEXT,
  summary     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE branches (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  name              TEXT NOT NULL,
  git_branch        TEXT NOT NULL,
  summary           TEXT NOT NULL DEFAULT '',
  github_pr_url     TEXT,
  parent_branch_id  TEXT REFERENCES branches(id),
  head_commit_id    TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  merged_at         TIMESTAMPTZ
);

CREATE TABLE commits (
  id                       TEXT PRIMARY KEY,
  branch_id                TEXT NOT NULL REFERENCES branches(id),
  project_id               TEXT NOT NULL REFERENCES projects(id),
  parent_id                TEXT REFERENCES commits(id),
  merge_source_branch_id   TEXT REFERENCES branches(id),
  agent_id                 TEXT NOT NULL,
  agent_role               TEXT NOT NULL DEFAULT 'solo',
  tool                     TEXT NOT NULL,
  workflow_type            TEXT NOT NULL DEFAULT 'interactive',
  loop_iteration           INTEGER,
  ci_run_id                TEXT,
  pipeline_name            TEXT,
  message                  TEXT NOT NULL,
  content                  TEXT NOT NULL,
  summary                  TEXT NOT NULL,
  commit_type              TEXT NOT NULL DEFAULT 'manual',
  git_commit_sha           TEXT,
  embedding                vector(384),
  fts                      tsvector GENERATED ALWAYS AS (
                             to_tsvector('english', message || ' ' || content)
                           ) STORED,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW: works with incremental inserts; IVFFlat requires training data
CREATE INDEX ON commits USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_commits_branch  ON commits(branch_id, created_at DESC);
CREATE INDEX idx_commits_project ON commits(project_id);
CREATE INDEX idx_commits_fts     ON commits USING GIN(fts);

CREATE TABLE threads (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  branch_id        TEXT NOT NULL REFERENCES branches(id),
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  workflow_type    TEXT,
  opened_in_commit TEXT NOT NULL REFERENCES commits(id),
  closed_in_commit TEXT REFERENCES commits(id),
  closed_note      TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE claims (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  branch_id   TEXT NOT NULL REFERENCES branches(id),
  task        TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  role        TEXT NOT NULL,
  claimed_at  TIMESTAMPTZ DEFAULT NOW(),
  status      TEXT NOT NULL DEFAULT 'proposed',
  ttl         INTEGER NOT NULL,
  released_at TIMESTAMPTZ,
  thread_id   TEXT REFERENCES threads(id)
);

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  role          TEXT NOT NULL DEFAULT 'solo',
  tool          TEXT NOT NULL,
  workflow_type TEXT NOT NULL DEFAULT 'interactive',
  display_name  TEXT,
  total_commits INTEGER DEFAULT 0,
  last_seen     TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── RPC Functions ────────────────────────────────────────────────────────────

-- Semantic search: returns commits ranked by cosine similarity.
-- $1 = query_embedding, $2 = project_id, $3 = match_count
-- Fully-qualified column refs prevent shadowing by function parameter names.
CREATE OR REPLACE FUNCTION match_commits(
  query_embedding vector(384),
  project_id      TEXT,
  match_count     INT
) RETURNS TABLE(id TEXT, score FLOAT) AS $$
  SELECT commits.id, 1 - (commits.embedding <=> $1) AS score
  FROM commits
  WHERE commits.project_id = $2
    AND commits.embedding IS NOT NULL
  ORDER BY commits.embedding <=> $1
  LIMIT $3;
$$ LANGUAGE sql;

-- Active claims: applies TTL filter in SQL (interval arithmetic).
CREATE OR REPLACE FUNCTION list_active_claims(p_project_id TEXT)
RETURNS SETOF claims AS $$
  SELECT * FROM claims
  WHERE project_id = p_project_id
    AND status != 'released'
    AND claimed_at + (ttl || ' milliseconds')::interval > NOW();
$$ LANGUAGE sql;
