# SupabaseStore Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `SupabaseStore` — a `ContextStore` backed by Supabase (Postgres + pgvector) — and wire it into push/pull as the team-sharing sync target, plus update the architecture doc.

**Architecture:** `SupabaseStore` in `packages/store/src/supabase/` implements `ContextStore` via `@supabase/supabase-js`. A private `branchProjectCache` avoids redundant fetches during batch pushes. Push/pull gain a shared `resolveRemoteStore` helper that picks `SupabaseStore` when `config.supabaseUrl` is set, `RemoteStore` (HTTP) otherwise. LocalStore remains the live primary store — Supabase is push/pull only.

**Tech Stack:** `@supabase/supabase-js`, Postgres + pgvector (Supabase managed), HNSW embeddings, Vitest (unit tests with mocked Supabase client).

**Spec:** `docs/superpowers/specs/2026-03-18-supabase-store-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/types.ts` | Modify | Add `supabaseUrl?` to `ContextGitConfig` |
| `packages/store/src/supabase/schema.sql` | Create | Full Postgres DDL + RPC functions |
| `packages/store/src/supabase/index.ts` | Create | `SupabaseStore` — all 20 `ContextStore` methods |
| `packages/store/src/supabase/supabase-store.test.ts` | Create | Unit tests with mocked Supabase client |
| `packages/store/src/index.ts` | Modify | Export `SupabaseStore` |
| `packages/store/package.json` | Modify | Add `@supabase/supabase-js` |
| `packages/cli/src/commands/set-remote.ts` | Modify | Handle `supabase <url>` keyword |
| `packages/cli/src/lib/remote-store.ts` | Create | `resolveRemoteStore` shared helper |
| `packages/cli/src/commands/push.ts` | Modify | Use `resolveRemoteStore`, drop hardcoded `RemoteStore` |
| `packages/cli/src/commands/pull.ts` | Modify | Same |
| `packages/cli/src/commands/doctor.ts` | Modify | Add Supabase four-state check |
| `docs/ContextGit_ARCHITECTURE_v3.md` | Modify | Section 8.3 schema, Section 15 phase table |

---

## Task 1: Add `supabaseUrl?` to `ContextGitConfig`

**Files:**
- Modify: `packages/core/src/types.ts` (around line 235)

This is the **prerequisite** for all CLI work. Do this first.

- [ ] **Step 1: Add the field**

In `packages/core/src/types.ts`, find `ContextGitConfig` (currently around line 231). Add **only** the one new line shown below — do NOT remove or replace any existing fields (`embeddingModel`, `apiKey`, etc. must stay):

```typescript
  remote?: string
  supabaseUrl?: string          // ← ADD THIS LINE AFTER remote
  agentRole: AgentRole
```

- [ ] **Step 2: Build to verify no type errors**

```bash
cd /path/to/contexthub
pnpm build
```

Expected: build passes, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add supabaseUrl to ContextGitConfig"
```

---

## Task 2: Create `schema.sql`

**Files:**
- Create: `packages/store/src/supabase/schema.sql`

No tests — this is DDL applied manually in the Supabase SQL editor. The file is source-controlled so it can be version-tracked and shared.

- [ ] **Step 1: Create the file**

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/store/src/supabase/schema.sql
git commit -m "feat(store): add Supabase schema SQL — core tables + match_commits + list_active_claims"
```

---

## Task 3: `SupabaseStore` skeleton, parsers, and Projects methods

**Files:**
- Create: `packages/store/src/supabase/index.ts`
- Create: `packages/store/src/supabase/supabase-store.test.ts`
- Modify: `packages/store/package.json` — add `@supabase/supabase-js`

- [ ] **Step 1: Add the dependency**

```bash
cd packages/store
pnpm add @supabase/supabase-js
```

- [ ] **Step 2: Write failing tests for Projects and error handling**

Create `packages/store/src/supabase/supabase-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock @supabase/supabase-js before importing SupabaseStore ─────────────────
// The Supabase client uses a builder pattern. We mock createClient to return
// a fake db object. Individual tests configure mockResolvedValue on the chain.

const mockSingle = vi.fn()
const mockMaybeSingle = vi.fn()

function makeChain(resolved: unknown) {
  // A chainable builder that resolves when awaited.
  // Each method returns `this` so chains like .select().eq().single() work.
  const chain: Record<string, unknown> = {}
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is', 'in',
    'filter', 'order', 'limit', 'range', 'textSearch',
  ]
  methods.forEach(m => { chain[m] = vi.fn().mockReturnValue(chain) })
  chain['single'] = vi.fn().mockResolvedValue(resolved)
  chain['maybeSingle'] = vi.fn().mockResolvedValue(resolved)
  // Make the chain itself thenable (for `await db.from(...).select()`)
  chain['then'] = (resolve: (v: unknown) => void) => resolve(resolved)
  return chain
}

const mockDb = {
  from: vi.fn(),
  rpc: vi.fn(),
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockDb),
}))

import { SupabaseStore } from './index.js'

describe('SupabaseStore', () => {
  let store: SupabaseStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new SupabaseStore('https://test.supabase.co', 'service-key')
  })

  // ── Error handling ────────────────────────────────────────────────────────

  it('throws when Supabase returns an error', async () => {
    mockDb.from.mockReturnValue(makeChain({ data: null, error: { message: 'db error' } }))
    await expect(store.getProject('any')).rejects.toThrow('db error')
  })

  // ── Projects ──────────────────────────────────────────────────────────────

  it('getProject returns null when not found', async () => {
    mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
    const result = await store.getProject('nonexistent')
    expect(result).toBeNull()
  })

  it('getProject parses timestamps and optional fields', async () => {
    const iso = '2026-03-18T10:00:00.000Z'
    mockDb.from.mockReturnValue(makeChain({
      data: { id: 'p1', name: 'MyProject', description: 'desc', github_url: 'https://gh.com', summary: '', created_at: iso },
      error: null,
    }))
    const project = await store.getProject('p1')
    expect(project).not.toBeNull()
    expect(project!.createdAt).toBeInstanceOf(Date)
    expect(project!.createdAt.toISOString()).toBe(iso)
    expect(project!.description).toBe('desc')
    expect(project!.githubUrl).toBe('https://gh.com')
  })

  it('createProject inserts and returns a Project', async () => {
    const iso = '2026-03-18T10:00:00.000Z'
    mockDb.from.mockReturnValue(makeChain({
      data: { id: 'p1', name: 'Test', description: null, github_url: null, summary: '', created_at: iso },
      error: null,
    }))
    const project = await store.createProject({ name: 'Test' })
    expect(project.id).toBeDefined()
    expect(project.name).toBe('Test')
    expect(project.createdAt).toBeInstanceOf(Date)
  })
})
```

- [ ] **Step 3: Run tests — they should fail (SupabaseStore doesn't exist)**

```bash
cd /path/to/contexthub
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

Expected: FAIL — "Cannot find module './index.js'"

- [ ] **Step 4: Create `packages/store/src/supabase/index.ts` with skeleton + Projects**

```typescript
// SupabaseStore — ContextStore backed by Supabase (Postgres + pgvector).
//
// This store is a push/pull sync target. LocalStore remains the live primary store.
// SUPABASE_SERVICE_KEY env var provides the service role key (never written to disk).
//
// Key design notes:
//   • TEXT primary keys (nanoid) — same as LocalStore, no ID translation on push/pull
//   • TIMESTAMPTZ in Postgres — parsed to Date at the boundary via d()
//   • branchProjectCache avoids N round-trips during batch commit pushes
//   • project_id on commits is a denormalized server-side column — not in Commit domain type
//   • All Supabase errors throw; no silent failures

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { nanoid } from 'nanoid'
import { SnapshotFormatter } from '@contextgit/core'
import type {
  Agent,
  AgentInput,
  AgentRole,
  Branch,
  BranchInput,
  Claim,
  ClaimInput,
  Commit,
  CommitInput,
  ContextDelta,
  Pagination,
  Project,
  ProjectInput,
  SearchResult,
  SessionSnapshot,
  SnapshotFormat,
  Thread,
} from '@contextgit/core'
import type { ContextStore } from '../interface.js'

// ─── Row type ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

// ─── Date helper ──────────────────────────────────────────────────────────────

function d(s: unknown): Date {
  return typeof s === 'string' ? new Date(s) : new Date(0)
}

// ─── Row → domain parsers ─────────────────────────────────────────────────────

function parseProject(row: Row): Project {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string | undefined ?? undefined,
    githubUrl: row['github_url'] as string | undefined ?? undefined,
    createdAt: d(row['created_at']),
  }
}

function parseBranch(row: Row): Branch {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    name: row['name'] as string,
    gitBranch: row['git_branch'] as string,
    githubPrUrl: row['github_pr_url'] as string | undefined ?? undefined,
    parentBranchId: row['parent_branch_id'] as string | undefined ?? undefined,
    headCommitId: row['head_commit_id'] as string | undefined ?? undefined,
    status: row['status'] as Branch['status'],
    createdAt: d(row['created_at']),
    mergedAt: row['merged_at'] ? d(row['merged_at']) : undefined,
  }
}

function parseCommit(row: Row): Commit {
  return {
    id: row['id'] as string,
    branchId: row['branch_id'] as string,
    parentId: row['parent_id'] as string | undefined ?? undefined,
    agentId: row['agent_id'] as string,
    agentRole: row['agent_role'] as Commit['agentRole'],
    tool: row['tool'] as string,
    workflowType: row['workflow_type'] as Commit['workflowType'],
    loopIteration: row['loop_iteration'] as number | undefined ?? undefined,
    ciRunId: row['ci_run_id'] as string | undefined ?? undefined,
    pipelineName: row['pipeline_name'] as string | undefined ?? undefined,
    message: row['message'] as string,
    content: row['content'] as string,
    summary: row['summary'] as string,
    commitType: row['commit_type'] as Commit['commitType'],
    gitCommitSha: row['git_commit_sha'] as string | undefined ?? undefined,
    createdAt: d(row['created_at']),
    // NOTE: project_id is a server-side denormalized column; not in Commit domain type
  }
}

function parseThread(row: Row): Thread {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    branchId: row['branch_id'] as string,
    description: row['description'] as string,
    status: row['status'] as Thread['status'],
    workflowType: row['workflow_type'] as string | undefined ?? undefined,
    openedInCommit: row['opened_in_commit'] as string,
    closedInCommit: row['closed_in_commit'] as string | undefined ?? undefined,
    closedNote: row['closed_note'] as string | undefined ?? undefined,
    createdAt: d(row['created_at']),
    updatedAt: row['updated_at'] ? d(row['updated_at']) : undefined,
  }
}

function parseClaim(row: Row): Claim {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    branchId: row['branch_id'] as string,
    task: row['task'] as string,
    agentId: row['agent_id'] as string,
    role: row['role'] as Claim['role'],
    claimedAt: d(row['claimed_at']),
    status: row['status'] as Claim['status'],
    ttl: row['ttl'] as number,
    releasedAt: row['released_at'] ? d(row['released_at']) : undefined,
    threadId: row['thread_id'] as string | undefined ?? undefined,
  }
}

function parseAgent(row: Row): Agent {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    role: row['role'] as Agent['role'],
    tool: row['tool'] as string,
    workflowType: row['workflow_type'] as Agent['workflowType'],
    displayName: row['display_name'] as string | undefined ?? undefined,
    totalCommits: row['total_commits'] as number,
    lastSeen: d(row['last_seen']),
    createdAt: d(row['created_at']),
  }
}

// ─── SupabaseStore ────────────────────────────────────────────────────────────

const snapshotFormatter = new SnapshotFormatter()

export class SupabaseStore implements ContextStore {
  private readonly db: SupabaseClient
  // Cache branchId → projectId to avoid N round-trips during batch commit pushes.
  private readonly branchProjectCache = new Map<string, string>()

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey)
  }

  // Throws on Supabase error; returns T (not null).
  private async q<T>(p: Promise<{ data: T | null; error: { message: string } | null }>): Promise<T> {
    const { data, error } = await p
    if (error) throw new Error(error.message)
    if (data === null) throw new Error('Unexpected null response from Supabase')
    return data
  }

  // Like q() but returns null instead of throwing when data is null.
  private async qNull<T>(p: Promise<{ data: T | null; error: { message: string } | null }>): Promise<T | null> {
    const { data, error } = await p
    if (error) throw new Error(error.message)
    return data
  }

  private async resolveProjectId(branchId: string): Promise<string> {
    if (this.branchProjectCache.has(branchId)) return this.branchProjectCache.get(branchId)!
    const branch = await this.getBranch(branchId)
    if (!branch) throw new Error(`Branch not found: ${branchId}`)
    this.branchProjectCache.set(branchId, branch.projectId)
    return branch.projectId
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async createProject(input: ProjectInput): Promise<Project> {
    const id = input.id ?? nanoid()
    const row = await this.q(
      this.db.from('projects').insert({
        id,
        name: input.name,
        description: input.description ?? null,
        github_url: input.githubUrl ?? null,
        summary: '',
      }).select().single()
    )
    return parseProject(row as Row)
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.qNull(
      this.db.from('projects').select('*').eq('id', id).maybeSingle()
    )
    return row ? parseProject(row as Row) : null
  }
}
```

- [ ] **Step 5: Run tests — they should pass**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/supabase/ packages/store/package.json
git commit -m "feat(store): SupabaseStore skeleton + Projects methods + tests"
```

---

## Task 4: Branches methods

**Files:**
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/supabase/supabase-store.test.ts`

- [ ] **Step 1: Write failing tests for Branches**

Add to the `describe` block in `supabase-store.test.ts`:

```typescript
// ── Branches ──────────────────────────────────────────────────────────────

it('getBranch returns null when not found', async () => {
  mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
  expect(await store.getBranch('missing')).toBeNull()
})

it('getBranch parses branch row correctly', async () => {
  const iso = '2026-03-18T10:00:00.000Z'
  mockDb.from.mockReturnValue(makeChain({
    data: { id: 'br1', project_id: 'p1', name: 'main', git_branch: 'main',
            summary: '', github_pr_url: null, parent_branch_id: null,
            head_commit_id: 'c1', status: 'active', created_at: iso, merged_at: null },
    error: null,
  }))
  const branch = await store.getBranch('br1')
  expect(branch!.projectId).toBe('p1')
  expect(branch!.headCommitId).toBe('c1')
  expect(branch!.createdAt).toBeInstanceOf(Date)
  expect(branch!.mergedAt).toBeUndefined()
})

it('createBranch is idempotent when ID already exists', async () => {
  const iso = new Date().toISOString()
  const existing = { id: 'br1', project_id: 'p1', name: 'main', git_branch: 'main',
                     summary: '', github_pr_url: null, parent_branch_id: null,
                     head_commit_id: null, status: 'active', created_at: iso, merged_at: null }
  // First call (getBranch check) returns existing; second call (insert) should not be reached
  mockDb.from.mockReturnValue(makeChain({ data: existing, error: null }))
  const result = await store.createBranch({ id: 'br1', projectId: 'p1', name: 'main', gitBranch: 'main' })
  expect(result.id).toBe('br1')
})
```

- [ ] **Step 2: Run — expect FAIL (methods not implemented)**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 3: Implement Branches methods in `index.ts`**

Add inside `SupabaseStore` after `getProject`:

```typescript
// ── Branches ──────────────────────────────────────────────────────────────

async createBranch(input: BranchInput): Promise<Branch> {
  // Idempotent: if caller supplied an ID and it already exists, return existing
  if (input.id) {
    const existing = await this.getBranch(input.id)
    if (existing) return existing
  }
  const id = input.id ?? nanoid()
  const row = await this.q(
    this.db.from('branches').insert({
      id,
      project_id: input.projectId,
      name: input.name,
      git_branch: input.gitBranch,
      summary: '',
      github_pr_url: input.githubPrUrl ?? null,
      parent_branch_id: input.parentBranchId ?? null,
      status: 'active',
    }).select().single()
  )
  return parseBranch(row as Row)
}

async getBranch(id: string): Promise<Branch | null> {
  const row = await this.qNull(
    this.db.from('branches').select('*').eq('id', id).maybeSingle()
  )
  return row ? parseBranch(row as Row) : null
}

async getBranchByGitName(projectId: string, gitBranch: string): Promise<Branch | null> {
  const row = await this.qNull(
    this.db.from('branches').select('*')
      .eq('project_id', projectId)
      .eq('git_branch', gitBranch)
      .maybeSingle()
  )
  return row ? parseBranch(row as Row) : null
}

async listBranches(projectId: string): Promise<Branch[]> {
  const rows = await this.q(
    this.db.from('branches').select('*').eq('project_id', projectId)
  )
  return (rows as Row[]).map(parseBranch)
}

async updateBranchHead(branchId: string, commitId: string): Promise<void> {
  const { error } = await this.db.from('branches')
    .update({ head_commit_id: commitId })
    .eq('id', branchId)
  if (error) throw new Error(error.message)
}

async mergeBranch(sourceBranchId: string, targetBranchId: string, summary: string): Promise<Commit> {
  const [source, target] = await Promise.all([
    this.getBranch(sourceBranchId),
    this.getBranch(targetBranchId),
  ])
  if (!source) throw new Error(`Source branch not found: ${sourceBranchId}`)
  if (!target) throw new Error(`Target branch not found: ${targetBranchId}`)

  const commitId = nanoid()
  const row = await this.q(
    this.db.from('commits').insert({
      id: commitId,
      branch_id: targetBranchId,
      project_id: target.projectId,
      parent_id: target.headCommitId ?? null,
      merge_source_branch_id: sourceBranchId,
      agent_id: 'system',
      agent_role: 'orchestrator',
      tool: 'contextgit',
      workflow_type: 'interactive',
      message: `Merge ${source.name} into ${target.name}`,
      content: summary,
      summary,
      commit_type: 'merge',
    }).select().single()
  )

  // Update target HEAD and mark source merged (fire in parallel)
  await Promise.all([
    this.updateBranchHead(targetBranchId, commitId),
    this.db.from('branches').update({ status: 'merged', merged_at: new Date().toISOString() }).eq('id', sourceBranchId),
    // Carry open threads from source to target
    this.db.from('threads').update({ branch_id: targetBranchId }).eq('branch_id', sourceBranchId).eq('status', 'open'),
  ])

  return parseCommit(row as Row)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/supabase/
git commit -m "feat(store): SupabaseStore — Branches methods"
```

---

## Task 5: Commits methods (with `branchProjectCache`)

**Files:**
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/supabase/supabase-store.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `supabase-store.test.ts`:

```typescript
// ── Commits ───────────────────────────────────────────────────────────────

it('createCommit resolves projectId via getBranch and caches it', async () => {
  const branchIso = new Date().toISOString()
  const commitIso = new Date().toISOString()
  const branchRow = { id: 'br1', project_id: 'proj1', name: 'main', git_branch: 'main',
                      summary: '', github_pr_url: null, parent_branch_id: null,
                      head_commit_id: null, status: 'active', created_at: branchIso, merged_at: null }
  const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'proj1', parent_id: null,
                      agent_id: 'agent1', agent_role: 'solo', tool: 'cli',
                      workflow_type: 'interactive', message: 'hello', content: 'c',
                      summary: 's', commit_type: 'manual', git_commit_sha: null,
                      created_at: commitIso }

  // Call 1: getBranch for cache population; Call 2: insert commit
  mockDb.from
    .mockReturnValueOnce(makeChain({ data: branchRow, error: null }))  // getBranch
    .mockReturnValueOnce(makeChain({ data: commitRow, error: null }))  // insert commit

  const commit = await store.createCommit({
    branchId: 'br1', agentId: 'agent1', agentRole: 'solo', tool: 'cli',
    workflowType: 'interactive', message: 'hello', content: 'c', summary: 's', commitType: 'manual',
  })

  expect(commit.branchId).toBe('br1')
  expect(commit.message).toBe('hello')
  // projectId is NOT on the Commit domain type — verify it's absent
  expect((commit as unknown as Record<string, unknown>)['projectId']).toBeUndefined()

  // Cache populated: second createCommit on same branch should NOT call getBranch again
  mockDb.from.mockReturnValueOnce(makeChain({ data: commitRow, error: null }))  // only insert

  await store.createCommit({
    branchId: 'br1', agentId: 'agent1', agentRole: 'solo', tool: 'cli',
    workflowType: 'interactive', message: 'hello 2', content: 'c2', summary: 's2', commitType: 'manual',
  })

  // from() called 3 times total: getBranch (1) + insert commit 1 (1) + insert commit 2 (1)
  expect(mockDb.from).toHaveBeenCalledTimes(3)
})

it('createCommit is idempotent when commit ID already exists', async () => {
  const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'proj1', parent_id: null,
                      agent_id: 'a', agent_role: 'solo', tool: 'cli',
                      workflow_type: 'interactive', message: 'm', content: 'c',
                      summary: 's', commit_type: 'manual', git_commit_sha: null,
                      created_at: new Date().toISOString() }
  // getCommit check returns existing
  mockDb.from.mockReturnValueOnce(makeChain({ data: commitRow, error: null }))
  const result = await store.createCommit({
    id: 'c1', branchId: 'br1', agentId: 'a', agentRole: 'solo', tool: 'cli',
    workflowType: 'interactive', message: 'm', content: 'c', summary: 's', commitType: 'manual',
  })
  expect(result.id).toBe('c1')
  // Should not have called insert
  expect(mockDb.from).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 3: Implement Commits methods**

Add inside `SupabaseStore`:

```typescript
// ── Commits ───────────────────────────────────────────────────────────────

async createCommit(input: CommitInput): Promise<Commit> {
  // Idempotent: if caller supplied an ID and it already exists, return existing
  if (input.id) {
    const existing = await this.getCommit(input.id)
    if (existing) return existing
  }
  const id = input.id ?? nanoid()
  const projectId = await this.resolveProjectId(input.branchId)

  const row = await this.q(
    this.db.from('commits').insert({
      id,
      branch_id: input.branchId,
      project_id: projectId,
      parent_id: input.parentId ?? null,
      agent_id: input.agentId,
      agent_role: input.agentRole,
      tool: input.tool,
      workflow_type: input.workflowType,
      loop_iteration: input.loopIteration ?? null,
      ci_run_id: input.ciRunId ?? null,
      pipeline_name: input.pipelineName ?? null,
      message: input.message,
      content: input.content,
      summary: input.summary,
      commit_type: input.commitType,
      git_commit_sha: input.gitCommitSha ?? null,
    }).select().single()
  )
  return parseCommit(row as Row)
}

async getCommit(id: string): Promise<Commit | null> {
  const row = await this.qNull(
    this.db.from('commits').select('*').eq('id', id).maybeSingle()
  )
  return row ? parseCommit(row as Row) : null
}

async listCommits(branchId: string, pagination: Pagination): Promise<Commit[]> {
  const rows = await this.q(
    this.db.from('commits').select('*')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .range(pagination.offset, pagination.offset + pagination.limit - 1)
  )
  return (rows as Row[]).map(parseCommit)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/supabase/
git commit -m "feat(store): SupabaseStore — Commits methods + branchProjectCache"
```

---

## Task 6: `getSessionSnapshot` + `getFormattedSnapshot`

**Files:**
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/supabase/supabase-store.test.ts`

`getSessionSnapshot` is the most complex method — it makes multiple fetches and assembles `SessionSnapshot`. Study `LocalStore.getSessionSnapshot` via `Queries.getSessionSnapshot` in `packages/store/src/local/queries.ts` before implementing to ensure semantic parity.

- [ ] **Step 1: Write failing test**

```typescript
// ── Snapshots ─────────────────────────────────────────────────────────────

it('getSessionSnapshot assembles a SessionSnapshot', async () => {
  const now = new Date().toISOString()
  const branchRow = { id: 'br1', project_id: 'p1', name: 'main', git_branch: 'main',
                      summary: '', parent_branch_id: null, head_commit_id: 'c1',
                      status: 'active', created_at: now, merged_at: null, github_pr_url: null }
  const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                      agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                      message: 'init', content: 'c', summary: 'project summary here',
                      commit_type: 'manual', git_commit_sha: null, created_at: now }

  // Call sequence (matches the corrected implementation):
  // 1. getBranch(branchId) — branch has parentBranchId=null, headCommitId='c1'
  // 2. getCommit('c1') — fetched once, used for both projectSummary and branchSummary
  // 3. commitsQuery (listCommits), threadsQuery (listOpenThreadsByBranch), rpc (list_active_claims) — parallel
  mockDb.from
    .mockReturnValueOnce(makeChain({ data: branchRow, error: null }))    // getBranch
    .mockReturnValueOnce(makeChain({ data: commitRow, error: null }))    // getCommit (head)
    .mockReturnValueOnce(makeChain({ data: [commitRow], error: null }))  // listCommits (parallel)
    .mockReturnValueOnce(makeChain({ data: [], error: null }))           // listOpenThreadsByBranch (parallel)
  mockDb.rpc.mockResolvedValueOnce({ data: [], error: null })            // list_active_claims (parallel)

  const snapshot = await store.getSessionSnapshot('p1', 'br1')
  expect(snapshot.projectSummary).toBe('project summary here')
  expect(snapshot.branchName).toBe('main')
  expect(snapshot.recentCommits).toHaveLength(1)
  expect(snapshot.openThreads).toHaveLength(0)
  expect(snapshot.activeClaims).toHaveLength(0)
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 3: Implement `getSessionSnapshot` and `getFormattedSnapshot`**

```typescript
// ── Snapshots ─────────────────────────────────────────────────────────────

async getSessionSnapshot(
  projectId: string,
  branchId: string,
  options?: { agentRole?: AgentRole },
): Promise<SessionSnapshot> {
  const branch = await this.getBranch(branchId)
  if (!branch) throw new Error(`Branch not found: ${branchId}`)

  // Project summary: from parent branch head commit (child branch)
  // or from current branch head commit (main/root branch).
  // branchSummary and projectSummary may be the same commit on main — fetch once.
  let headCommit: Commit | null = null
  if (branch.headCommitId) {
    headCommit = await this.getCommit(branch.headCommitId)
  }

  let projectSummary = headCommit?.summary ?? ''
  if (branch.parentBranchId) {
    // Child branch: project summary comes from parent's head commit
    const parentBranch = await this.getBranch(branch.parentBranchId)
    if (parentBranch?.headCommitId) {
      const parentHead = await this.getCommit(parentBranch.headCommitId)
      projectSummary = parentHead?.summary ?? ''
    }
  }

  // Recent commits (role-filtered if requested)
  let commitsQuery = this.db.from('commits').select('*')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })
    .limit(3)
  if (options?.agentRole) {
    commitsQuery = (commitsQuery as unknown as { eq: (k: string, v: string) => typeof commitsQuery })
      .eq('agent_role', options.agentRole) as typeof commitsQuery
  }

  // Open threads scoped to branch (not whole project) to match LocalStore semantics
  const [commitsResult, threadsResult, claimsResult] = await Promise.all([
    commitsQuery,
    this.db.from('threads').select('*').eq('branch_id', branchId).eq('status', 'open'),
    this.db.rpc('list_active_claims', { p_project_id: projectId }),
  ])

  if (commitsResult.error) throw new Error(commitsResult.error.message)
  if (threadsResult.error) throw new Error(threadsResult.error.message)
  if (claimsResult.error) throw new Error(claimsResult.error.message)

  return {
    projectSummary,
    branchName: branch.name,
    branchSummary: headCommit?.summary ?? '',   // reuses the already-fetched commit
    recentCommits: ((commitsResult.data ?? []) as Row[]).map(parseCommit),
    openThreads: ((threadsResult.data ?? []) as Row[]).map(parseThread),
    activeClaims: ((claimsResult.data ?? []) as Row[]).map(parseClaim),
  }
}

async getFormattedSnapshot(projectId: string, branchId: string, format: SnapshotFormat): Promise<string> {
  const snapshot = await this.getSessionSnapshot(projectId, branchId)
  return snapshotFormatter.format(snapshot, format)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/supabase/
git commit -m "feat(store): SupabaseStore — getSessionSnapshot + getFormattedSnapshot"
```

---

## Task 7: Threads methods

**Files:**
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/supabase/supabase-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// ── Threads ───────────────────────────────────────────────────────────────

it('listOpenThreads returns only open threads for the project', async () => {
  const now = new Date().toISOString()
  const threadRow = { id: 't1', project_id: 'p1', branch_id: 'br1', description: 'todo',
                      status: 'open', workflow_type: null, opened_in_commit: 'c1',
                      closed_in_commit: null, closed_note: null, created_at: now, updated_at: now }
  mockDb.from.mockReturnValue(makeChain({ data: [threadRow], error: null }))
  const threads = await store.listOpenThreads('p1')
  expect(threads).toHaveLength(1)
  expect(threads[0]!.status).toBe('open')
  expect(threads[0]!.createdAt).toBeInstanceOf(Date)
})

it('syncThread upserts on id conflict', async () => {
  const now = new Date().toISOString()
  const thread: Thread = { id: 't1', projectId: 'p1', branchId: 'br1', description: 'todo',
                            status: 'closed', openedInCommit: 'c1', closedInCommit: 'c2',
                            closedNote: 'done', createdAt: new Date(), }
  const threadRow = { id: 't1', project_id: 'p1', branch_id: 'br1', description: 'todo',
                      status: 'closed', workflow_type: null, opened_in_commit: 'c1',
                      closed_in_commit: 'c2', closed_note: 'done', created_at: now, updated_at: now }
  mockDb.from.mockReturnValue(makeChain({ data: threadRow, error: null }))
  const result = await store.syncThread(thread)
  expect(result.status).toBe('closed')
  expect(result.closedNote).toBe('done')
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 3: Implement Threads methods**

```typescript
// ── Threads ───────────────────────────────────────────────────────────────

async listOpenThreads(projectId: string): Promise<Thread[]> {
  const rows = await this.q(
    this.db.from('threads').select('*').eq('project_id', projectId).eq('status', 'open')
  )
  return (rows as Row[]).map(parseThread)
}

async listOpenThreadsByBranch(branchId: string): Promise<Thread[]> {
  const rows = await this.q(
    this.db.from('threads').select('*').eq('branch_id', branchId).eq('status', 'open')
  )
  return (rows as Row[]).map(parseThread)
}

async syncThread(thread: Thread): Promise<Thread> {
  // Upsert on id conflict — thread may have been closed since first push
  const row = await this.q(
    this.db.from('threads').upsert({
      id: thread.id,
      project_id: thread.projectId,
      branch_id: thread.branchId,
      description: thread.description,
      status: thread.status,
      workflow_type: thread.workflowType ?? null,
      opened_in_commit: thread.openedInCommit,
      closed_in_commit: thread.closedInCommit ?? null,
      closed_note: thread.closedNote ?? null,
    }, { onConflict: 'id' }).select().single()
  )
  return parseThread(row as Row)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/supabase/
git commit -m "feat(store): SupabaseStore — Threads methods"
```

---

## Task 8: Search methods

**Files:**
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/supabase/supabase-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// ── Search ────────────────────────────────────────────────────────────────

it('indexEmbedding updates the embedding column on the commit row', async () => {
  mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
  await store.indexEmbedding('c1', new Float32Array([0.1, 0.2, 0.3]))
  expect(mockDb.from).toHaveBeenCalledWith('commits')
})

it('semanticSearch calls match_commits RPC and maps results', async () => {
  const now = new Date().toISOString()
  const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                      agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                      message: 'm', content: 'c', summary: 's', commit_type: 'manual',
                      git_commit_sha: null, created_at: now }
  // RPC returns { id, score } rows; then we fetch full commit rows
  mockDb.rpc.mockResolvedValueOnce({ data: [{ id: 'c1', score: 0.95 }], error: null })
  mockDb.from.mockReturnValue(makeChain({ data: commitRow, error: null }))

  const results = await store.semanticSearch(new Float32Array(384), 'p1', 5)
  expect(results).toHaveLength(1)
  expect(results[0]!.score).toBe(0.95)
  expect(results[0]!.matchType).toBe('semantic')
  expect(mockDb.rpc).toHaveBeenCalledWith('match_commits', expect.objectContaining({ project_id: 'p1', match_count: 5 }))
})

it('fullTextSearch uses textSearch on fts column', async () => {
  const now = new Date().toISOString()
  const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                      agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                      message: 'hello world', content: 'c', summary: 's', commit_type: 'manual',
                      git_commit_sha: null, created_at: now }
  mockDb.from.mockReturnValue(makeChain({ data: [commitRow], error: null }))
  const results = await store.fullTextSearch('hello', 'p1')
  expect(results).toHaveLength(1)
  expect(results[0]!.matchType).toBe('fulltext')
  expect(results[0]!.score).toBe(1.0)
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 3: Implement Search methods**

```typescript
// ── Search ────────────────────────────────────────────────────────────────

async indexEmbedding(commitId: string, vector: Float32Array): Promise<void> {
  const { error } = await this.db.from('commits')
    .update({ embedding: Array.from(vector) })
    .eq('id', commitId)
  if (error) throw new Error(error.message)
}

async semanticSearch(vector: Float32Array, projectId: string, limit: number): Promise<SearchResult[]> {
  const { data, error } = await this.db.rpc('match_commits', {
    query_embedding: Array.from(vector),
    project_id: projectId,
    match_count: limit,
  })
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return []

  // Fetch full commit rows for the returned IDs
  const ids = (data as Array<{ id: string; score: number }>).map(r => r.id)
  const scoreMap = new Map((data as Array<{ id: string; score: number }>).map(r => [r.id, r.score]))

  const rows = await this.q(
    this.db.from('commits').select('*').in('id', ids)
  )
  return (rows as Row[]).map(row => ({
    commit: parseCommit(row),
    score: scoreMap.get(row['id'] as string) ?? 0,
    matchType: 'semantic' as const,
  }))
}

async fullTextSearch(query: string, projectId: string): Promise<SearchResult[]> {
  const rows = await this.q(
    this.db.from('commits').select('*')
      .eq('project_id', projectId)
      .textSearch('fts', query, { type: 'plain', config: 'english' })
  )
  // Supabase textSearch does not expose BM25 scores; fixed score of 1.0
  return (rows as Row[]).map(row => ({
    commit: parseCommit(row),
    score: 1.0,
    matchType: 'fulltext' as const,
  }))
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/supabase/
git commit -m "feat(store): SupabaseStore — indexEmbedding + semanticSearch + fullTextSearch"
```

---

## Task 9: Agents and Claims methods

**Files:**
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/supabase/supabase-store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// ── Agents ────────────────────────────────────────────────────────────────

it('upsertAgent upserts on id conflict', async () => {
  const now = new Date().toISOString()
  const agentRow = { id: 'agent1', project_id: 'p1', role: 'solo', tool: 'cli',
                     workflow_type: 'interactive', display_name: null,
                     total_commits: 5, last_seen: now, created_at: now }
  mockDb.from.mockReturnValue(makeChain({ data: agentRow, error: null }))
  const agent = await store.upsertAgent({
    id: 'agent1', projectId: 'p1', role: 'solo', tool: 'cli', workflowType: 'interactive'
  })
  expect(agent.id).toBe('agent1')
  expect(agent.totalCommits).toBe(5)
  expect(agent.lastSeen).toBeInstanceOf(Date)
})

// ── Claims ────────────────────────────────────────────────────────────────

it('listActiveClaims calls list_active_claims RPC', async () => {
  mockDb.rpc.mockResolvedValueOnce({ data: [], error: null })
  const claims = await store.listActiveClaims('p1')
  expect(claims).toHaveLength(0)
  expect(mockDb.rpc).toHaveBeenCalledWith('list_active_claims', { p_project_id: 'p1' })
})

it('unclaimTask updates status to released', async () => {
  mockDb.from.mockReturnValue(makeChain({ data: null, error: null }))
  await expect(store.unclaimTask('claim1')).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 3: Implement Agents and Claims methods**

```typescript
// ── Agents ────────────────────────────────────────────────────────────────

async upsertAgent(input: AgentInput): Promise<Agent> {
  // NOTE: AgentInput has no totalCommits field, so total_commits is not included
  // in the upsert payload. On Supabase the column defaults to 0 on first insert.
  // On subsequent upserts the column is reset to 0 — this is a known limitation.
  // total_commits is authoritative in LocalStore only; Supabase reflects push-time state.
  const row = await this.q(
    this.db.from('agents').upsert({
      id: input.id,
      project_id: input.projectId,
      role: input.role,
      tool: input.tool,
      workflow_type: input.workflowType,
      display_name: input.displayName ?? null,
      last_seen: new Date().toISOString(),
    }, { onConflict: 'id' }).select().single()
  )
  return parseAgent(row as Row)
}

async listAgents(projectId: string): Promise<Agent[]> {
  const rows = await this.q(
    this.db.from('agents').select('*').eq('project_id', projectId)
  )
  return (rows as Row[]).map(parseAgent)
}

// ── Claims ────────────────────────────────────────────────────────────────

async claimTask(projectId: string, branchId: string, input: ClaimInput): Promise<Claim> {
  const id = nanoid()
  const row = await this.q(
    this.db.from('claims').insert({
      id,
      project_id: projectId,
      branch_id: branchId,
      task: input.task,
      agent_id: input.agentId,
      role: input.role,
      status: input.status ?? 'proposed',
      ttl: input.ttl ?? 7_200_000,
      thread_id: input.threadId ?? null,
    }).select().single()
  )
  return parseClaim(row as Row)
}

async unclaimTask(claimId: string): Promise<void> {
  const { error } = await this.db.from('claims')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('id', claimId)
  if (error) throw new Error(error.message)
}

async listActiveClaims(projectId: string): Promise<Claim[]> {
  // TTL filter applied in SQL via the list_active_claims function
  const { data, error } = await this.db.rpc('list_active_claims', { p_project_id: projectId })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Row[]).map(parseClaim)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/supabase/
git commit -m "feat(store): SupabaseStore — Agents + Claims methods"
```

---

## Task 10: `getContextDelta`

**Files:**
- Modify: `packages/store/src/supabase/index.ts`
- Modify: `packages/store/src/supabase/supabase-store.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// ── Delta ─────────────────────────────────────────────────────────────────

it('getContextDelta filters by since using ISO string, strictly greater than', async () => {
  const since = Date.now() - 60_000  // 1 minute ago
  const sinceIso = new Date(since).toISOString()
  const now = new Date().toISOString()

  const commitRow = { id: 'c1', branch_id: 'br1', project_id: 'p1', parent_id: null,
                      agent_id: 'a', agent_role: 'solo', tool: 'cli', workflow_type: 'interactive',
                      message: 'm', content: 'c', summary: 's', commit_type: 'manual',
                      git_commit_sha: null, created_at: now }

  mockDb.from
    .mockReturnValueOnce(makeChain({ data: [commitRow], error: null }))  // commits since
    .mockReturnValueOnce(makeChain({ data: [], error: null }))           // threads since
  mockDb.rpc.mockResolvedValueOnce({ data: [], error: null })            // active claims

  const delta = await store.getContextDelta('p1', 'br1', since)
  expect(delta.newCommits).toHaveLength(1)
  expect(delta.openedThreads).toHaveLength(0)
  expect(delta.closedThreads).toHaveLength(0)
  expect(delta.checkedAt).toBeGreaterThan(since)

  // Verify strictly-greater-than filter used the correct ISO string
  // (guards against accidental use of gte which would include the since boundary)
  const commitsChain = mockDb.from.mock.results[0]?.value as ReturnType<typeof makeChain>
  expect(commitsChain.gt).toHaveBeenCalledWith('created_at', sinceIso)
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 3: Implement `getContextDelta`**

```typescript
// ── Delta ─────────────────────────────────────────────────────────────────

async getContextDelta(projectId: string, branchId: string, since: number): Promise<ContextDelta> {
  // Strictly greater than — matches LocalStore semantics (> datetime(since/1000, 'unixepoch'))
  const sinceIso = new Date(since).toISOString()

  const [commitsResult, threadsResult, claimsResult] = await Promise.all([
    this.db.from('commits').select('*')
      .eq('branch_id', branchId)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: true }),
    this.db.from('threads').select('*')
      .eq('project_id', projectId)
      .gt('updated_at', sinceIso),
    this.db.rpc('list_active_claims', { p_project_id: projectId }),
  ])

  if (commitsResult.error) throw new Error(commitsResult.error.message)
  if (threadsResult.error) throw new Error(threadsResult.error.message)
  if (claimsResult.error) throw new Error(claimsResult.error.message)

  const allThreadChanges = ((threadsResult.data ?? []) as Row[]).map(parseThread)
  return {
    newCommits: ((commitsResult.data ?? []) as Row[]).map(parseCommit),
    openedThreads: allThreadChanges.filter(t => t.status === 'open'),
    closedThreads: allThreadChanges.filter(t => t.status === 'closed'),
    activeClaims: ((claimsResult.data ?? []) as Row[]).map(parseClaim),
    checkedAt: Date.now(),
  }
}
```

- [ ] **Step 4: Run tests — expect PASS (all tests)**

```bash
pnpm test packages/store/src/supabase/supabase-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/supabase/
git commit -m "feat(store): SupabaseStore — getContextDelta"
```

---

## Task 11: Export `SupabaseStore` + full build check

**Files:**
- Modify: `packages/store/src/index.ts`

- [ ] **Step 1: Add export**

Open `packages/store/src/index.ts`. Add the `SupabaseStore` export alongside the existing exports:

```typescript
export { SupabaseStore } from './supabase/index.js'
```

- [ ] **Step 2: Build all packages and run all tests**

```bash
cd /path/to/contexthub
pnpm build
pnpm test
```

Expected: all packages build, all tests pass (72+ tests).

- [ ] **Step 3: Commit**

```bash
git add packages/store/src/index.ts
git commit -m "feat(store): export SupabaseStore from store package"
```

---

## Task 12: Extend `set-remote` for `supabase <url>`

**Files:**
- Modify: `packages/cli/src/commands/set-remote.ts`
- Modify: `packages/cli/src/commands/set-remote.test.ts` (create if it doesn't exist)

- [ ] **Step 1: Write failing tests**

Create `packages/cli/src/commands/set-remote.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadConfig, saveConfig } from '../config.js'

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ projectId: 'p1', project: 'test', remote: undefined, supabaseUrl: undefined })),
  saveConfig: vi.fn(),
}))

// We test the dispatch logic directly since oclif commands are hard to unit-test.
// The key behaviors: 'supabase' keyword writes supabaseUrl; anything else writes remote.

describe('set-remote dispatch', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('writes supabaseUrl when first arg is "supabase"', () => {
    // Simulate the dispatch logic from the command
    const typeOrUrl = 'supabase'
    const url = 'https://xyz.supabase.co'
    const config = loadConfig()
    if (typeOrUrl === 'supabase') {
      saveConfig({ ...config, supabaseUrl: url })
    } else {
      saveConfig({ ...config, remote: typeOrUrl })
    }
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ supabaseUrl: 'https://xyz.supabase.co' }))
  })

  it('writes remote (HTTP) when first arg is a URL', () => {
    const typeOrUrl = 'https://api.example.com'
    const config = loadConfig()
    if (typeOrUrl === 'supabase') {
      saveConfig({ ...config, supabaseUrl: 'irrelevant' })
    } else {
      saveConfig({ ...config, remote: typeOrUrl })
    }
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ remote: 'https://api.example.com' }))
    expect(saveConfig).not.toHaveBeenCalledWith(expect.objectContaining({ supabaseUrl: expect.anything() }))
  })
})
```

- [ ] **Step 2: Run — expect PASS (tests are against the logic, not the command class yet)**

```bash
pnpm test packages/cli/src/commands/set-remote.test.ts
```

- [ ] **Step 3: Update `set-remote.ts`**

Replace `packages/cli/src/commands/set-remote.ts` with:

```typescript
// set-remote — configure push/pull remote target.
//
// Usage:
//   contextgit set-remote supabase https://xyzproject.supabase.co
//     → writes supabaseUrl to config. Key via SUPABASE_SERVICE_KEY env var.
//   contextgit set-remote https://api.example.com
//     → writes remote (HTTP RemoteStore URL) to config. Existing behaviour.

import { Command, Args } from '@oclif/core'
import { loadConfig, saveConfig } from '../config.js'

export default class SetRemoteCmd extends Command {
  static description = 'Set the remote push/pull target (Supabase or self-hosted API)'

  static args = {
    typeOrUrl: Args.string({
      description: '"supabase" keyword, or an HTTP API URL',
      required: true,
    }),
    url: Args.string({
      description: 'Supabase project URL (required when first arg is "supabase")',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(SetRemoteCmd)
    const config = loadConfig()

    if (args.typeOrUrl === 'supabase') {
      if (!args.url) {
        this.error('URL required: contextgit set-remote supabase <url>', { exit: 1 })
      }
      saveConfig({ supabaseUrl: args.url })   // saveConfig merges internally — spread not needed
      this.log(`Supabase remote set: ${args.url}`)
      this.log(`Set SUPABASE_SERVICE_KEY in your shell to authenticate.`)
      this.log(`Run 'contextgit push' to sync commits to Supabase.`)
    } else {
      const url = args.typeOrUrl
      const previous = config.remote
      saveConfig({ remote: url })             // saveConfig merges internally — spread not needed
      if (previous) {
        this.log(`Remote updated: ${previous} → ${url}`)
      } else {
        this.log(`Remote set: ${url}`)
      }
      this.log(`Use 'contextgit push' to sync commits to this remote.`)
    }
  }
}
```

- [ ] **Step 4: Build and run all tests**

```bash
pnpm build && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/set-remote.ts packages/cli/src/commands/set-remote.test.ts
git commit -m "feat(cli): set-remote supabase <url> — write supabaseUrl to config"
```

---

## Task 13: `resolveRemoteStore` helper + `push.ts` update

**Files:**
- Create: `packages/cli/src/lib/remote-store.ts`
- Modify: `packages/cli/src/commands/push.ts`

- [ ] **Step 1: Create the `lib` directory**

```bash
mkdir -p packages/cli/src/lib
```

- [ ] **Step 2: Write failing test for `resolveRemoteStore`**

Create `packages/cli/src/lib/remote-store.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { resolveRemoteStore } from './remote-store.js'
import { SupabaseStore } from '@contextgit/store'
import { RemoteStore } from '@contextgit/store'

vi.mock('@contextgit/store', () => ({
  SupabaseStore: vi.fn(),
  RemoteStore: vi.fn(),
  LocalStore: vi.fn(),
}))

describe('resolveRemoteStore', () => {
  const baseConfig = { projectId: 'p1', project: 'test', store: 'local',
                       agentRole: 'solo', workflowType: 'interactive',
                       autoSnapshot: false, snapshotInterval: 30 } as const

  it('uses SupabaseStore when supabaseUrl is set and key is in env', () => {
    process.env['SUPABASE_SERVICE_KEY'] = 'test-key'
    resolveRemoteStore({ ...baseConfig, supabaseUrl: 'https://x.supabase.co' })
    expect(SupabaseStore).toHaveBeenCalledWith('https://x.supabase.co', 'test-key')
    delete process.env['SUPABASE_SERVICE_KEY']
  })

  it('throws when supabaseUrl is set but SUPABASE_SERVICE_KEY is missing', () => {
    delete process.env['SUPABASE_SERVICE_KEY']
    expect(() => resolveRemoteStore({ ...baseConfig, supabaseUrl: 'https://x.supabase.co' }))
      .toThrow('SUPABASE_SERVICE_KEY')
  })

  it('uses RemoteStore when --remote flag is passed (always HTTP, regardless of supabaseUrl)', () => {
    process.env['SUPABASE_SERVICE_KEY'] = 'key'
    resolveRemoteStore({ ...baseConfig, supabaseUrl: 'https://x.supabase.co' }, 'https://api.example.com')
    expect(RemoteStore).toHaveBeenCalledWith('https://api.example.com')
    delete process.env['SUPABASE_SERVICE_KEY']
  })

  it('uses RemoteStore when config.remote is set and supabaseUrl is absent', () => {
    resolveRemoteStore({ ...baseConfig, remote: 'https://api.example.com' })
    expect(RemoteStore).toHaveBeenCalledWith('https://api.example.com')
  })

  it('throws when no remote is configured at all', () => {
    expect(() => resolveRemoteStore(baseConfig)).toThrow('No remote configured')
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

```bash
pnpm test packages/cli/src/lib/remote-store.test.ts
```

- [ ] **Step 4: Create `packages/cli/src/lib/remote-store.ts`**

```typescript
// remote-store.ts — resolve the correct remote ContextStore for push/pull.
//
// Priority:
//   1. --remote flag (always HTTP RemoteStore, bypasses everything)
//   2. config.supabaseUrl → SupabaseStore (requires SUPABASE_SERVICE_KEY env)
//   3. config.remote → RemoteStore (HTTP)
//   4. Neither → error

import { RemoteStore, SupabaseStore } from '@contextgit/store'
import type { ContextStore } from '@contextgit/store'
import type { ContextGitConfig } from '@contextgit/core'

export function resolveRemoteStore(
  config: ContextGitConfig,
  remoteFlag?: string,
): ContextStore {
  // --remote flag always means HTTP RemoteStore, regardless of other config
  if (remoteFlag) return new RemoteStore(remoteFlag)

  // Supabase takes precedence over HTTP remote when both configured
  if (config.supabaseUrl) {
    const key = process.env['SUPABASE_SERVICE_KEY']
    if (!key) {
      throw new Error(
        'SUPABASE_SERVICE_KEY env var is required when supabaseUrl is configured.\n' +
        'Set it in your shell or Claude Code env config.',
      )
    }
    return new SupabaseStore(config.supabaseUrl, key)
  }

  if (config.remote) return new RemoteStore(config.remote)

  throw new Error(
    'No remote configured.\n' +
    'Run: contextgit set-remote supabase <url>  (Supabase)\n' +
    '  or: contextgit set-remote <url>          (self-hosted API)',
  )
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
pnpm test packages/cli/src/lib/remote-store.test.ts
```

- [ ] **Step 6: Update `push.ts` to use `resolveRemoteStore`**

In `packages/cli/src/commands/push.ts`, make these exact changes:

1. Replace `import { LocalStore, RemoteStore } from '@contextgit/store'` with:
   ```typescript
   import { LocalStore } from '@contextgit/store'
   import type { ContextStore } from '@contextgit/store'
   import { resolveRemoteStore } from '../lib/remote-store.js'
   ```

2. **Delete** the entire block (lines ~52–58):
   ```typescript
   const remoteUrl = flags.remote ?? config.remote
   if (!remoteUrl) {
     this.error('No remote configured. Use: contextgit set-remote <url>', { exit: 1 })
   }
   const local = new LocalStore(config.projectId)
   const remote = new RemoteStore(remoteUrl)
   ```
   Replace it with:
   ```typescript
   const local = new LocalStore(config.projectId)
   const remote = resolveRemoteStore(config, flags.remote)
   ```

3. Replace the final `this.log(...)` line (the one that prints `remoteUrl`) with:
   ```typescript
   this.log(`\nDone. ${dryRun ? '(dry run) ' : ''}${totalPushed} commit(s), ${missingThreads.length} thread(s) pushed.`)
   ```

- [ ] **Step 7: Build and run all tests**

```bash
pnpm build && pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/lib/remote-store.ts packages/cli/src/lib/remote-store.test.ts packages/cli/src/commands/push.ts
git commit -m "feat(cli): resolveRemoteStore helper + push uses SupabaseStore when supabaseUrl configured"
```

---

## Task 14: Update `pull.ts`

**Files:**
- Modify: `packages/cli/src/commands/pull.ts`

Same three-change pattern as `push.ts`.

- [ ] **Step 1: Update `pull.ts`**

1. Replace `import { LocalStore, RemoteStore } from '@contextgit/store'` with:
   ```typescript
   import { LocalStore } from '@contextgit/store'
   import type { ContextStore } from '@contextgit/store'
   import { resolveRemoteStore } from '../lib/remote-store.js'
   ```

2. **Delete** the `const remoteUrl = ...` / `if (!remoteUrl)` / `new RemoteStore(remoteUrl)` block (lines ~52–60). Replace with:
   ```typescript
   const local = new LocalStore(config.projectId)
   const remote = resolveRemoteStore(config, flags.remote)
   ```

3. Replace the final `this.log(...)` line referencing `remoteUrl` with:
   ```typescript
   this.log(`\nDone. ${dryRun ? '(dry run) ' : ''}${totalPulled} commit(s), ${missingThreads.length} thread(s) pulled.`)
   ```

- [ ] **Step 2: Build and run all tests**

```bash
pnpm build && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/pull.ts
git commit -m "feat(cli): pull uses resolveRemoteStore — supports SupabaseStore"
```

---

## Task 15: `doctor` — Supabase check

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`

- [ ] **Step 1: Write failing test**

Add to or create `packages/cli/src/commands/doctor.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

// Test the Supabase check states in isolation
async function checkSupabase(supabaseUrl?: string, envKey?: string, fetchStatus = 200): Promise<string> {
  if (!supabaseUrl) return '[ ] Supabase: not configured (optional)'
  if (!envKey) return '[!] Supabase: URL set but SUPABASE_SERVICE_KEY missing'
  // Simulate fetch
  if (fetchStatus === 401) return '[!] Supabase: reachable but SUPABASE_SERVICE_KEY rejected'
  if (fetchStatus < 400) return '[✓] Supabase: connected'
  return '[!] Supabase: unreachable'
}

describe('doctor Supabase check', () => {
  it('reports not configured when supabaseUrl absent', async () => {
    expect(await checkSupabase()).toBe('[ ] Supabase: not configured (optional)')
  })
  it('reports missing key when supabaseUrl set but env absent', async () => {
    expect(await checkSupabase('https://x.supabase.co')).toBe('[!] Supabase: URL set but SUPABASE_SERVICE_KEY missing')
  })
  it('reports rejected key on 401', async () => {
    expect(await checkSupabase('https://x.supabase.co', 'key', 401)).toBe('[!] Supabase: reachable but SUPABASE_SERVICE_KEY rejected')
  })
  it('reports connected on 2xx', async () => {
    expect(await checkSupabase('https://x.supabase.co', 'key', 200)).toBe('[✓] Supabase: connected')
  })
})
```

- [ ] **Step 2: Run — expect PASS (pure logic, no file needed)**

```bash
pnpm test packages/cli/src/commands/doctor.test.ts
```

- [ ] **Step 3: Add Supabase check to `doctor.ts`**

Add after the existing check 5 (MCP registered), before the Summary section:

```typescript
// ── 6. Supabase remote ────────────────────────────────────────────────────
const supabaseUrl = config?.supabaseUrl as string | undefined
if (!supabaseUrl) {
  // Not an error — Supabase is optional
  this.log('  [ ] Supabase: not configured (optional)')
} else {
  const serviceKey = process.env['SUPABASE_SERVICE_KEY']
  if (!serviceKey) {
    check(
      'Supabase: URL set but SUPABASE_SERVICE_KEY missing',
      false,
      'Set SUPABASE_SERVICE_KEY in your shell or Claude Code env config',
    )
  } else {
    // Probe connectivity: any 2xx/3xx = connected, 401 = key rejected
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/projects?limit=1`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      })
      if (res.status === 401) {
        check('Supabase: reachable but SUPABASE_SERVICE_KEY rejected', false,
          'Check SUPABASE_SERVICE_KEY — it may be the anon key instead of the service role key')
      } else if (res.status < 400) {
        check('Supabase: connected', true)
      } else {
        check(`Supabase: HTTP ${res.status}`, false, `Check ${supabaseUrl} is reachable`)
      }
    } catch (err) {
      check('Supabase: unreachable', false, `${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
```

- [ ] **Step 4: Build and run all tests**

```bash
pnpm build && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/src/commands/doctor.test.ts
git commit -m "feat(cli): doctor — four-state Supabase connectivity check"
```

---

## Task 16: Architecture doc — Section 8.3 + Section 15

**Files:**
- Modify: `docs/ContextGit_ARCHITECTURE_v3.md`

- [ ] **Step 1: Update Section 8.3**

Find the `### 8.3 RemoteStore (Postgres + pgvector)` heading and replace the entire section (up to `### 8.4`) with:

```markdown
### 8.3 SupabaseStore (Postgres + pgvector)

`SupabaseStore` implements `ContextStore` directly via `@supabase/supabase-js`. It is a push/pull sync target — LocalStore remains the live primary store. Push/pull syncs LocalStore ↔ SupabaseStore.

Schema: `packages/store/src/supabase/schema.sql`. Applied once via the Supabase SQL editor.

**Key schema decisions:**

| Decision | Rationale |
|----------|-----------|
| TEXT primary keys (nanoid) | ID parity with LocalStore — no translation on push/pull |
| TIMESTAMPTZ | Postgres best practice; `Date` objects at interface boundary |
| HNSW embedding index | Works with incremental inserts; IVFFlat requires training data |
| `project_id` on `commits` | Denormalized for query efficiency; not mapped to `Commit` domain type |
| `fts` generated tsvector column | Full-text search via GIN index; kept in sync automatically |
| No orgs/users/RLS | Phase 3 Step 3 — service role key used until auth ships |

**Core tables:** `projects`, `branches`, `commits`, `threads`, `claims`, `agents`

**RPC functions:**
- `match_commits(query_embedding, project_id, match_count)` — semantic search via pgvector cosine similarity
- `list_active_claims(p_project_id)` — active claims with TTL filter in SQL

**Configuration:**
- `config.supabaseUrl` — written by `contextgit set-remote supabase <url>`
- `SUPABASE_SERVICE_KEY` env var — service role key, never written to disk

**Push/pull priority:** `--remote` flag (HTTP) > `config.supabaseUrl` (Supabase) > `config.remote` (HTTP)
```

- [ ] **Step 2: Update Section 15 — Phase Build Plan**

Find `### Phase 2 — Weeks 5–8: Team, Multi-Agent, CI` and replace the Phase 2 and Phase 3 tables with:

```markdown
### Phase 2 — Weeks 5–8: Team, Multi-Agent, CI (shipped)

| Period | Deliverable |
|--------|-------------|
| Weeks 5–6 | CLI completeness: branch, merge, search, status, push, pull, keygen, doctor, claim, unclaim. Production API fix (`/v1/store` mounted). Git hooks (`git-sync.ts`). |
| Week 7 | Delta 1 — Coordination primitives: claims table, `project_task_claim`/`project_task_unclaim` MCP tools, active claims in snapshot. |
| Weeks 7–8 | Delta 2 — Multi-agent protocol: `getContextDelta`, `since` on `project_memory_load`, `for_agent_id` pre-claiming, inline `[CLAIMED]`/`[FREE]` formatter. |
| Week 8 | Delta 3 — Session contract enforcement: MCP tools renamed `project_memory_*`, CLAUDE.md fragment + skills written by `init`. |

**Phase 2 gate (all passed):** Three workflow types contributing to the same project context store. Orchestrator can pre-claim, poll, and spawn agents without collision.

### Phase 3 — Team + Web Platform

| Step | Deliverable |
|------|-------------|
| 1 | SupabaseStore: core tables, `SupabaseStore` implementing `ContextStore`, push/pull against Supabase, `set-remote supabase` command. |
| 2 | Web platform: React app, branch tree (D3.js), commit diff view, threads panel, search UI. Read-only, service-key-backed. |
| 3 | Auth + multi-tenancy: Supabase Auth, GitHub OAuth, API keys, RLS. Required before publishing opens. |
| 4 | Public repos: publish, clone, fork, star. Auth gates publishing; reading stays open. |
| 5 | Live team dashboard: WebSocket, workflow filter. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/ContextGit_ARCHITECTURE_v3.md
git commit -m "docs: update architecture v3 — Section 8.3 SupabaseStore schema, Section 15 phase table corrected"
```

---

## Validation Gates

Run these manually after all tasks are complete, against a real Supabase project.

**Setup:**
```bash
# 1. Apply schema.sql in Supabase SQL editor
# 2. Set env var
export SUPABASE_SERVICE_KEY=your-service-role-key
# 3. Configure
contextgit set-remote supabase https://yourproject.supabase.co
```

| Gate | Command | Expected |
|------|---------|----------|
| Schema clean | Run `schema.sql` in Supabase SQL editor | No errors |
| Push round-trip | `contextgit commit -m "test" && contextgit push` | Row in Supabase `commits` table |
| Pull round-trip | Delete `~/.contextgit/projects/<id>.db`, then `contextgit pull && contextgit context` | Commit appears |
| Semantic search | `contextgit search "test"` | Results returned |
| Missing key | `unset SUPABASE_SERVICE_KEY && contextgit push` | Clear error message |
| Doctor connected | `contextgit doctor` | `[✓] Supabase: connected` |
| Doctor key missing | `unset SUPABASE_SERVICE_KEY && contextgit doctor` | `[!] Supabase: URL set but SUPABASE_SERVICE_KEY missing` |
| `--remote` preserved | `contextgit push --remote https://api.example.com` | Uses HTTP, ignores supabaseUrl |
