# SupabaseStore Design Spec

**Date:** 2026-03-18
**Status:** Approved — ready for implementation planning
**Scope:** Phase 3, Step 1

---

## Overview

SupabaseStore implements the `ContextStore` interface backed by Supabase (Postgres + pgvector).
It is additive — nothing currently working changes. LocalStore remains the default for local dev.
Push/pull syncs LocalStore ↔ SupabaseStore. The HTTP `RemoteStore` stays for self-hosted teams.

This is the foundation for team sharing, public repos, and the web platform.

---

## What Is Not In Scope

- Organizations, users, authentication, RLS — deferred to Phase 3, Step 3
- Web platform — deferred to Phase 3, Step 2
- Public repos, fork, star — deferred to Phase 3, Step 4
- Live dashboard — deferred to Phase 3, Step 5
- PostgreSQL self-hosted alternative — enterprise concern, not now

---

## Schema

Applied once via the Supabase SQL editor. Lives at `packages/store/src/supabase/schema.sql`.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
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
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW: works correctly with incremental inserts; IVFFlat requires training data
CREATE INDEX ON commits USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_commits_branch   ON commits(branch_id, created_at DESC);
CREATE INDEX idx_commits_project  ON commits(project_id);

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

-- Semantic search function — direct filter on commits.project_id, no subquery
CREATE OR REPLACE FUNCTION match_commits(
  query_embedding vector(384),
  project_id      TEXT,
  match_count     INT
) RETURNS TABLE(id TEXT, score FLOAT) AS $$
  SELECT id, 1 - (embedding <=> query_embedding) AS score
  FROM commits
  WHERE project_id = $2
    AND embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT $3;
$$ LANGUAGE sql;
```

### Schema decisions

| Decision | Rationale |
|----------|-----------|
| TEXT primary keys (nanoid) | ID parity with LocalStore — push/pull requires no translation |
| TIMESTAMPTZ dates | Postgres best practice; `ContextStore` interface uses `Date` objects so both stores are transparent to callers |
| `embedding` inline on `commits` | Simpler than a separate virtual table; pgvector supports NULL so unindexed commits work fine |
| HNSW index | Works with incremental inserts from day one; IVFFlat requires a minimum training corpus |
| `project_id` on `commits` | Denormalized for query efficiency; avoids JOIN through branches on every semantic search |
| No orgs/users/RLS | Deferred — service role key is used for all access until auth ships in Phase 3, Step 3 |

---

## `SupabaseStore` Implementation

**Location:** `packages/store/src/supabase/index.ts`

**Dependency:** `@supabase/supabase-js` added to `packages/store/package.json`.

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { ContextStore } from '../interface.js'

export class SupabaseStore implements ContextStore {
  private readonly db: SupabaseClient

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey)
  }
  // ... all ContextStore methods
}
```

### Key implementation notes

**Timestamp parsing** — Supabase returns ISO strings. A local `d(s)` helper (identical pattern to `RemoteStore`) converts to `Date`.

**`indexEmbedding`** — updates `commits.embedding` in place:
```typescript
await this.db.from('commits').update({ embedding: Array.from(vector) }).eq('id', commitId)
```

**`semanticSearch`** — calls the `match_commits` Postgres function via Supabase RPC:
```typescript
const { data } = await this.db.rpc('match_commits', {
  query_embedding: Array.from(vector),
  project_id: projectId,
  match_count: limit,
})
```

**TTL filter on claims** — `claimed_at + (ttl || ' milliseconds')::interval > NOW()` expressed in the Supabase query via `.filter()` or a Postgres function. Claims past TTL are excluded from `listActiveClaims`.

**`getContextDelta` since filter** — converts epoch ms to TIMESTAMPTZ:
```typescript
.gt('created_at', new Date(since).toISOString())
```

**`getSessionSnapshot`** — implemented identically to `LocalStore`: fetch branch, head commit summary, recent commits (role-filtered if `options.agentRole` set), open threads, active claims. No special Supabase logic.

**Error handling** — Supabase JS returns `{ data, error }`. Every method throws on non-null `error`. No silent failures.

---

## Config + CLI Changes

### `ContextGitConfig` (packages/core/src/types.ts)

```typescript
interface ContextGitConfig {
  // ... existing fields ...
  supabaseUrl?: string   // written by `set-remote supabase <url>`
  // SUPABASE_SERVICE_KEY is read from env — never written to config
}
```

### `set-remote` command

```
contextgit set-remote supabase https://xyzproject.supabase.co
```

When first arg is `supabase`, write `supabaseUrl` to config and print:
```
Supabase remote set: https://xyzproject.supabase.co
Set SUPABASE_SERVICE_KEY in your shell to authenticate.
Run 'contextgit push' to sync commits.
```

Existing behavior (`contextgit set-remote <url>`) is unchanged — writes `config.remote` for HTTP RemoteStore.

### Push/pull bootstrap (packages/cli/src/commands/push.ts + pull.ts)

Remote store resolved in priority order:

```typescript
function resolveRemoteStore(config: ContextGitConfig): ContextStore {
  if (config.supabaseUrl) {
    const key = process.env['SUPABASE_SERVICE_KEY']
    if (!key) throw new Error('SUPABASE_SERVICE_KEY env var is required')
    return new SupabaseStore(config.supabaseUrl, key)
  }
  if (config.remote) {
    return new RemoteStore(config.remote)
  }
  throw new Error('No remote configured. Run: contextgit set-remote supabase <url>')
}
```

### `contextgit doctor` — new check

```
[ ] Supabase configured: supabaseUrl in config + SUPABASE_SERVICE_KEY in env
```

---

## Architecture Doc Updates

### Section 15 — Phase Build Plan

#### Phase 2 (shipped — corrected from original)

| Period | Deliverable |
|--------|-------------|
| Weeks 5–6 | CLI completeness: branch, merge, search, status, push, pull, keygen, doctor, claim, unclaim. Production API fix. Git hooks (`git-sync.ts`). |
| Week 7 | Delta 1 — Coordination primitives: claims table, `project_task_claim`/`project_task_unclaim` MCP tools, active claims in snapshot. |
| Weeks 7–8 | Delta 2 — Multi-agent protocol: `getContextDelta`, `since` on `project_memory_load`, `for_agent_id` pre-claiming, inline `[CLAIMED]`/`[FREE]` formatter. |
| Week 8 | Delta 3 — Session contract enforcement: MCP tools renamed `project_memory_*`, CLAUDE.md fragment + skills written by `init`. |

#### Phase 3 (next — corrected build order)

| Step | Deliverable |
|------|-------------|
| 1 | SupabaseStore: core tables, `SupabaseStore` implementing `ContextStore`, push/pull against Supabase, `set-remote supabase` command. |
| 2 | Web platform: React app, branch tree (D3.js), commit diff view, threads panel, search UI. Read-only, service key backed. |
| 3 | Auth + multi-tenancy: Supabase Auth, GitHub OAuth, API keys, RLS. Required before publishing opens. |
| 4 | Public repos: publish, clone, fork, star. Auth gates publishing; reading stays open. |
| 5 | Live team dashboard: WebSocket, workflow filter. |

### Section 8.3 — RemoteStore (Postgres + pgvector)

To be updated with the corrected schema (TEXT PKs, HNSW index, `project_id` on commits, no orgs/users/RLS in Phase 3 Step 1 scope).

---

## Files Changed

| File | Change |
|------|--------|
| `packages/store/src/supabase/index.ts` | CREATE — `SupabaseStore` implementing `ContextStore` |
| `packages/store/src/supabase/schema.sql` | CREATE — full DDL + `match_commits` function |
| `packages/store/package.json` | ADD `@supabase/supabase-js` dependency |
| `packages/core/src/types.ts` | ADD `supabaseUrl?` to `ContextGitConfig` |
| `packages/cli/src/commands/set-remote.ts` | EXTEND — handle `supabase <url>` keyword |
| `packages/cli/src/commands/push.ts` | UPDATE — `resolveRemoteStore` picks SupabaseStore |
| `packages/cli/src/commands/pull.ts` | UPDATE — same |
| `packages/cli/src/commands/doctor.ts` | ADD — Supabase config check |
| `docs/ContextGit_ARCHITECTURE_v3.md` | UPDATE — Section 8.3 schema, Section 15 phase table |

---

## Validation Gates

| Gate | What to verify |
|------|----------------|
| Schema applies clean | Run `schema.sql` in Supabase SQL editor — no errors |
| Push round-trip | `contextgit commit` locally → `contextgit push` → query Supabase table directly, row present |
| Pull round-trip | Delete local DB, `contextgit pull` → `contextgit context` shows the pushed commit |
| Semantic search | `indexEmbedding` → `contextgit search "..."` returns results via `match_commits` RPC |
| Missing key error | Unset `SUPABASE_SERVICE_KEY`, run `contextgit push` → clear error message |
| Doctor check | `contextgit doctor` reports Supabase status correctly in both configured and unconfigured states |
