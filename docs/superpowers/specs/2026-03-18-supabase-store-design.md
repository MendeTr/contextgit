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

**SupabaseStore is always a push/pull sync target — never a live primary store.**
The primary store for all live reads/writes (MCP server, CLI, API) is always LocalStore.
Supabase is written to via `contextgit push` and read from via `contextgit pull`.
This maps cleanly to: work locally → push to share → others pull to sync.

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

-- HNSW: works correctly with incremental inserts; IVFFlat requires training data
CREATE INDEX ON commits USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_commits_branch   ON commits(branch_id, created_at DESC);
CREATE INDEX idx_commits_project  ON commits(project_id);
CREATE INDEX idx_commits_fts      ON commits USING GIN(fts);

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

-- Semantic search: direct filter on commits.project_id, no subquery through branches.
-- Named parameters are avoided in the body to prevent shadowing commits.project_id.
-- $1 = query_embedding, $2 = project_id (TEXT), $3 = match_count (INT)
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
```

### Schema decisions

| Decision | Rationale |
|----------|-----------|
| TEXT primary keys (nanoid) | ID parity with LocalStore — push/pull requires no translation |
| TIMESTAMPTZ dates | Postgres best practice; `ContextStore` interface uses `Date` objects so both stores are transparent to callers |
| `embedding` inline on `commits` | Simpler than a separate virtual table; pgvector supports NULL so unindexed commits work fine |
| HNSW index | Works with incremental inserts from day one; IVFFlat requires a minimum training corpus |
| `project_id` on `commits` | Denormalized server-side column for query efficiency. Not mapped back to the `Commit` domain type (which has no `projectId` field). Extra column is silently ignored during row→domain mapping. Do not add `projectId` to the `Commit` type — that would break LocalStore. |
| `fts` generated tsvector column | Full-text search without a separate table; GIN index makes it fast; `GENERATED ALWAYS AS ... STORED` keeps it in sync automatically |
| Fully-qualified column references in `match_commits` | Eliminates ambiguity between the `project_id` function parameter and the `commits.project_id` column; uses positional `$1/$2/$3` in body |
| `description`, `github_url` on `projects` | Match `Project` and `ProjectInput` domain types — these fields are optional but must survive a push/pull round-trip |
| No orgs/users/RLS | Deferred — service role key used for all access until auth ships in Phase 3, Step 3 |

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

**`createCommit`** — `CommitInput` carries `branchId` but not `projectId`. `SupabaseStore` maintains a per-instance `Map<string, string>` (branchId → projectId) cache. `createCommit` checks the cache first; on miss it fetches the branch row and populates the cache. During a batch push all commits on the same branch pay one lookup — never N round-trips for N commits.

```typescript
private readonly branchProjectCache = new Map<string, string>()

private async resolveProjectId(branchId: string): Promise<string> {
  if (this.branchProjectCache.has(branchId)) return this.branchProjectCache.get(branchId)!
  const branch = await this.getBranch(branchId)
  if (!branch) throw new Error(`Branch not found: ${branchId}`)
  this.branchProjectCache.set(branchId, branch.projectId)
  return branch.projectId
}
```

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

**`fullTextSearch`** — queries the `fts` generated column using `plainto_tsquery`:
```typescript
const { data } = await this.db
  .from('commits')
  .select('*')
  .eq('project_id', projectId)
  .textSearch('fts', query, { type: 'plain', config: 'english' })
```
Returns results mapped to `SearchResult[]` with `matchType: 'fulltext'` and a fixed score of `1.0` (Supabase text search does not expose BM25 scores via the JS client; ranking is handled by the GIN index ordering).

**`mergeBranch`** — the `summary` argument is the merge commit's content/summary, not a branch row update. The `branches.summary` column is populated when `updateBranchHead` is called — the engine calls `updateBranchHead` separately after `mergeBranch` as part of the merge flow. `SupabaseStore.mergeBranch` does not write to `branches.summary`.

**`syncThread`** — uses Supabase upsert on `id` conflict. On conflict the full row is replaced (the thread may have been closed with a note since it was first pushed):
```typescript
await this.db.from('threads').upsert(row, { onConflict: 'id' })
```

**`upsertAgent`** — upserts on `id` conflict, updating `last_seen`, `total_commits`, `display_name`, and `role`:
```typescript
await this.db.from('agents').upsert(row, { onConflict: 'id' })
```
Supabase `.upsert()` replaces all columns on conflict by default, which is correct here.

**`getContextDelta` since-filter** — converts epoch ms to ISO string and uses strictly-greater-than (`>`), matching LocalStore semantics:
```typescript
.gt('created_at', new Date(since).toISOString())
```
A commit at exactly `since` ms is excluded from the delta. This matches `LocalStore`'s `> datetime(since/1000, 'unixepoch')` query.

**TTL filter on claims** (`listActiveClaims`) — claims past TTL excluded using Postgres interval arithmetic:
```sql
claimed_at + (ttl || ' milliseconds')::interval > NOW()
```
Expressed via a `.filter()` call or a Postgres RPC function if Supabase JS cannot express interval arithmetic natively.

**Error handling** — Supabase JS returns `{ data, error }`. Every method throws `new Error(error.message)` on non-null `error`. No silent failures.

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

`supabaseUrl` is a push/pull sync target, parallel to `remote` (HTTP). The two are independent:
- `config.remote` → HTTP RemoteStore for self-hosted API server
- `config.supabaseUrl` → SupabaseStore for Supabase-hosted tier

If both are set, `supabaseUrl` takes precedence for push/pull (see bootstrap below).
The `store` config field (used by MCP/API to select the live store) is not changed — LocalStore remains the live store.

### `set-remote` command

Extended to accept an optional `type` first argument:

```
contextgit set-remote supabase https://xyzproject.supabase.co   # writes supabaseUrl
contextgit set-remote https://api.example.com                   # writes remote (existing behaviour)
```

oclif args schema:
```typescript
static args = {
  typeOrUrl: Args.string({ required: true }),           // 'supabase' keyword or a URL
  url:       Args.string({ required: false }),           // URL when first arg is 'supabase'
}
```

Dispatch: if `typeOrUrl === 'supabase'`, write `supabaseUrl = url` and print setup instructions for `SUPABASE_SERVICE_KEY`. Otherwise treat `typeOrUrl` as the remote URL (existing behaviour) and write `remote`.

When `supabase` keyword is used, output:
```
Supabase remote set: https://xyzproject.supabase.co
Set SUPABASE_SERVICE_KEY in your shell to authenticate.
Run 'contextgit push' to sync commits to Supabase.
```

### Push/pull bootstrap (packages/cli/src/commands/push.ts + pull.ts)

The existing `--remote <url>` flag on `push`/`pull` overrides `config.remote` for the HTTP path and is preserved unchanged. It does not apply to Supabase — Supabase is always configured via `set-remote supabase`, never via `--remote`.

Remote store resolved in this priority order:

```typescript
function resolveRemoteStore(config: ContextGitConfig, remoteFlag?: string): ContextStore {
  // --remote flag always wins and always means HTTP RemoteStore
  if (remoteFlag) return new RemoteStore(remoteFlag)

  // Supabase takes precedence over HTTP remote when both configured
  if (config.supabaseUrl) {
    const key = process.env['SUPABASE_SERVICE_KEY']
    if (!key) throw new Error(
      'SUPABASE_SERVICE_KEY env var is required when supabaseUrl is configured.\n' +
      'Set it in your shell or Claude Code env config.'
    )
    return new SupabaseStore(config.supabaseUrl, key)
  }

  if (config.remote) return new RemoteStore(config.remote)

  throw new Error(
    'No remote configured.\n' +
    'Run: contextgit set-remote supabase <url>  (Supabase)\n' +
    '  or: contextgit set-remote <url>          (self-hosted API)'
  )
}
```

### `contextgit doctor` — Supabase check

Three explicit states:

| State | Output |
|-------|--------|
| `supabaseUrl` absent | `[ ] Supabase: not configured (optional)` |
| `supabaseUrl` present, `SUPABASE_SERVICE_KEY` absent | `[!] Supabase: URL set but SUPABASE_SERVICE_KEY missing` |
| Both present + GET to `<supabaseUrl>/rest/v1/projects?limit=1` returns 401 | `[!] Supabase: reachable but SUPABASE_SERVICE_KEY rejected` |
| Both present + GET returns 2xx or 3xx | `[✓] Supabase: connected` |

---

## Architecture Doc Updates

### Section 15 — Phase Build Plan

#### Phase 2 (shipped — corrected from original)

| Period | Deliverable |
|--------|-------------|
| Weeks 5–6 | CLI completeness: branch, merge, search, status, push, pull, keygen, doctor, claim, unclaim. Production API fix (`/v1/store` mounted). Git hooks (`git-sync.ts`). |
| Week 7 | Delta 1 — Coordination primitives: claims table, `project_task_claim`/`project_task_unclaim` MCP tools, active claims in snapshot. |
| Weeks 7–8 | Delta 2 — Multi-agent protocol: `getContextDelta`, `since` on `project_memory_load`, `for_agent_id` pre-claiming, inline `[CLAIMED]`/`[FREE]` formatter. |
| Week 8 | Delta 3 — Session contract enforcement: MCP tools renamed `project_memory_*`, CLAUDE.md fragment + skills written by `init`. |

#### Phase 3 (next — correct build order)

| Step | Deliverable |
|------|-------------|
| 1 | SupabaseStore: core tables, `SupabaseStore` implementing `ContextStore`, push/pull against Supabase, `set-remote supabase` command. |
| 2 | Web platform: React app, branch tree (D3.js), commit diff view, threads panel, search UI. Read-only, service-key-backed. |
| 3 | Auth + multi-tenancy: Supabase Auth, GitHub OAuth, API keys, RLS. Required before publishing opens. |
| 4 | Public repos: publish, clone, fork, star. Auth gates publishing; reading stays open. |
| 5 | Live team dashboard: WebSocket, workflow filter. |

### Section 8.3 — RemoteStore (Postgres + pgvector)

To be rewritten with:
- Corrected schema (TEXT PKs, HNSW index, `project_id` on commits, `fts` generated column, `description`/`github_url` on projects)
- Clarification that `SupabaseStore` implements `ContextStore` directly (not via HTTP)
- Note that RLS/orgs/users are Phase 3 Step 3 scope

---

## Implementation Order

**`packages/core/src/types.ts` must be changed first** — adding `supabaseUrl?` to `ContextGitConfig`.
This is a prerequisite for all CLI files. `resolveRemoteStore` reads `config.supabaseUrl` directly;
if any CLI file is compiled before `types.ts` is updated, TypeScript will reject the property access
and the build will fail.

Suggested order:
1. `packages/core/src/types.ts` — add `supabaseUrl?` to `ContextGitConfig`
2. `packages/store/src/supabase/schema.sql` — DDL (run in Supabase dashboard)
3. `packages/store/src/supabase/index.ts` — `SupabaseStore` implementation
4. `packages/store/package.json` — add `@supabase/supabase-js`
5. `packages/cli/src/commands/set-remote.ts` — extend for `supabase <url>`
6. `packages/cli/src/commands/push.ts` + `pull.ts` — `resolveRemoteStore`
7. `packages/cli/src/commands/doctor.ts` — Supabase check
8. `docs/ContextGit_ARCHITECTURE_v3.md` — Section 8.3 + Section 15

---

## Files Changed

| File | Change |
|------|--------|
| `packages/store/src/supabase/index.ts` | CREATE — `SupabaseStore` implementing all 20 `ContextStore` methods |
| `packages/store/src/supabase/schema.sql` | CREATE — full DDL + `match_commits` function |
| `packages/store/package.json` | ADD `@supabase/supabase-js` dependency |
| `packages/core/src/types.ts` | ADD `supabaseUrl?` to `ContextGitConfig` |
| `packages/cli/src/commands/set-remote.ts` | EXTEND — handle `supabase <url>` keyword dispatch |
| `packages/cli/src/commands/push.ts` | UPDATE — `resolveRemoteStore` with Supabase priority, `--remote` flag preserved |
| `packages/cli/src/commands/pull.ts` | UPDATE — same |
| `packages/cli/src/commands/doctor.ts` | UPDATE — three-state Supabase check |
| `docs/ContextGit_ARCHITECTURE_v3.md` | UPDATE — Section 8.3 schema, Section 15 phase table |

---

## Validation Gates

| Gate | What to verify |
|------|----------------|
| Schema applies clean | Run `schema.sql` in Supabase SQL editor — no errors |
| Push round-trip | `contextgit commit` locally → `contextgit push` → query Supabase `commits` table directly, row present with correct `project_id` |
| Pull round-trip | Delete local DB, `contextgit pull` → `contextgit context` shows the pushed commit |
| Semantic search | `indexEmbedding` → `contextgit search "..."` returns results via `match_commits` RPC |
| Full-text search | `contextgit search "keyword"` returns results via `fts` GIN index |
| Thread upsert | Push thread → close it locally → push again → Supabase row shows `status: 'closed'` |
| Missing key error | Unset `SUPABASE_SERVICE_KEY`, run `contextgit push` → clear error message |
| Doctor — not configured | No `supabaseUrl` in config → `not configured (optional)` |
| Doctor — key missing | `supabaseUrl` set, key absent → `URL set but SUPABASE_SERVICE_KEY missing` |
| Doctor — connected | Both set, reachable → `connected` |
| `--remote` flag preserved | `contextgit push --remote https://api.example.com` → uses HTTP RemoteStore, ignores `supabaseUrl` |
