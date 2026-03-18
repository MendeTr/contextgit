# ContextGit — Delta Spec: Live Claims via Supabase

**Date:** 2026-03-18
**Status:** Ready for implementation
**Target version:** 0.0.12
**Scope:** `packages/mcp/src/server.ts`, `packages/store/src/supabase/index.ts`
**Depends on:** SupabaseStore implementation (Phase 3, Step 1 — completed)

---

## Problem

Claims are coordination primitives. They prevent two agents from working on the same task simultaneously. The current implementation writes claims to the local SQLite database. This works for single-machine multi-agent scenarios (two Claude Code windows on the same project), but breaks for teams.

The failure scenario:

1. Dev A, Dev B, Dev C all pull context from Supabase. All get the same snapshot.
2. Snapshot says: "Next: Story 7.1"
3. All three agents call `project_memory_load`, all see "Next: Story 7.1"
4. All three start working on Story 7.1. Duplicate work.
5. Claims exist in each developer's local DB, invisible to the others.
6. Push/pull is too slow — by the time Dev A pushes a claim, Dev B and C are already working.

Claims need real-time visibility. Push/pull sync is appropriate for commits (history, immutable, eventual consistency is fine). Claims are ephemeral coordination signals — they need to be live.

---

## Solution

When `supabaseUrl` is configured, `project_task_claim` and `project_task_unclaim` write directly to Supabase instead of local SQLite. `project_memory_load` reads active claims from Supabase (not local) when building the snapshot.

Everything else stays local-first. Commits, threads, branches — all read/write locally, synced via push/pull. Only claims go live.

---

## Design Principle: Snapshot Stays Local, Claims Go Remote

The MCP server's primary store is always LocalStore. This delta does NOT change that. What changes:

| Operation | Without Supabase | With Supabase configured |
|---|---|---|
| `project_memory_load` — commits, threads, summary | LocalStore | LocalStore (unchanged) |
| `project_memory_load` — active claims | LocalStore | **SupabaseStore** |
| `project_memory_save` | LocalStore | LocalStore (unchanged) |
| `project_task_claim` | LocalStore | **SupabaseStore** |
| `project_task_unclaim` | LocalStore | **SupabaseStore** |
| `project_memory_branch` | LocalStore | LocalStore (unchanged) |
| `project_memory_merge` | LocalStore | LocalStore (unchanged) |
| `context_search` | LocalStore | LocalStore (unchanged) |

This is the minimum change that makes team coordination work. Only three operations touch Supabase — the two claim tools and the claims portion of the snapshot.

---

## Implementation

### 1. MCP Server — Resolve Claims Store

`packages/mcp/src/server.ts`

In `bootstrap()`, after creating the primary `LocalStore`, optionally create a `SupabaseStore` for claims:

```typescript
import { SupabaseStore } from '@contextgit/store'

// In bootstrap():
let claimsStore: ContextStore = store  // default: same as primary store

if (config.supabaseUrl) {
  const key = process.env['SUPABASE_SERVICE_KEY']
  if (key) {
    claimsStore = new SupabaseStore(config.supabaseUrl, key)
  }
}

return { engine, store, claimsStore, projectId, branchId, config, agentId }
```

Update `ServerContext` type:

```typescript
interface ServerContext {
  engine: ContextEngine
  store: ContextStore
  claimsStore: ContextStore  // NEW — Supabase when configured, LocalStore otherwise
  projectId: string
  branchId: string
  config: ContextGitConfig
  agentId: string
}
```

### 2. MCP Server — Route Claim Tools to Claims Store

In `project_task_claim` handler, replace `ctx.store` with `ctx.claimsStore`:

```typescript
// Before:
const claim = await ctx.store.claimTask(ctx.projectId, ctx.branchId, { ... })

// After:
const claim = await ctx.claimsStore.claimTask(ctx.projectId, ctx.branchId, { ... })
```

Same for `project_task_unclaim`:

```typescript
// Before:
await ctx.store.unclaimTask(claim_id)

// After:
await ctx.claimsStore.unclaimTask(claim_id)
```

### 3. MCP Server — Route Claims Read in Snapshot

In `project_memory_load` handler, the snapshot includes `activeClaims`. The `getSessionSnapshot` method on `LocalStore` internally calls `listActiveClaims`. We need to replace the claims portion with data from `claimsStore`.

Two approaches:

**Approach A (simple):** After getting the snapshot from LocalStore, overwrite the `activeClaims` field:

```typescript
const snapshot = await ctx.store.getSessionSnapshot(ctx.projectId, ctx.branchId, ...)

// If Supabase is configured, replace claims with live data
if (ctx.claimsStore !== ctx.store) {
  snapshot.activeClaims = await ctx.claimsStore.listActiveClaims(ctx.projectId)
}

const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')
```

**Approach B (cleaner but more code):** Pass `claimsStore` into the snapshot builder.

Recommendation: **Approach A.** One extra line, no interface changes, no risk to existing code.

### 4. SupabaseStore — Ensure Claim Methods Work

The SupabaseStore already implements `ContextStore`, which includes:
- `claimTask(projectId, branchId, input)` — INSERT into `claims` table
- `unclaimTask(claimId)` — UPDATE `released_at` on the claim
- `listActiveClaims(projectId)` — SELECT claims where TTL hasn't expired

Verify these work against Supabase by testing directly. The TTL filter uses:

```sql
claimed_at + (ttl || ' milliseconds')::interval > NOW()
```

If the Supabase JS client can't express this, create an RPC function:

```sql
CREATE OR REPLACE FUNCTION list_active_claims(p_project_id TEXT)
RETURNS SETOF claims AS $$
  SELECT * FROM claims
  WHERE project_id = p_project_id
    AND status != 'released'
    AND released_at IS NULL
    AND claimed_at + (ttl || ' milliseconds')::interval > NOW()
  ORDER BY claimed_at ASC;
$$ LANGUAGE sql;
```

### 5. Conflict Handling — Double Claim Attempt

When Dev B tries to claim a task already claimed by Dev A:

Option 1: Application-level check — before inserting, query `listActiveClaims`, check if task is already claimed. Return a clear error: "Task 'Story 7.1' is already claimed by dev-a-machine (claimed 3 minutes ago, expires in 1h57m)."

Option 2: Unique constraint on `(project_id, task, status)` where status = 'active' — let Postgres reject the duplicate.

Recommendation: **Option 1.** The error message is more useful and tells the agent what to do next. The agent can then pick the next unclaimed task.

Add to `claimTask` in SupabaseStore:

```typescript
async claimTask(projectId: string, branchId: string, input: ClaimInput): Promise<Claim> {
  // Check for existing active claim on same task
  const { data: existing } = await this.db
    .from('claims')
    .select('*')
    .eq('project_id', projectId)
    .eq('task', input.task)
    .neq('status', 'released')
    .is('released_at', null)

  if (existing && existing.length > 0) {
    const claim = existing[0]
    throw new Error(
      `Task "${input.task}" is already claimed by ${claim.agent_id} ` +
      `(claimed ${timeSince(claim.claimed_at)} ago). ` +
      `Pick a different task or wait for the claim to expire.`
    )
  }

  // Proceed with insert
  // ...
}
```

Note: There is a small race window between the check and the insert. For the current scale (2-5 developers), this is acceptable. If it becomes an issue, use a Postgres advisory lock or a unique partial index.

---

## The Three-Developer Workflow (After This Delta)

1. All three devs pull latest context from Supabase (commits, threads)
2. All three open Claude Code. Agents call `project_memory_load`.
3. Snapshot shows:
   ```
   Next tasks:
   - Story 7.1 [FREE]
   - Story 7.2 [FREE]
   - Story 7.3 [FREE]
   ```
4. Dev A's agent calls `project_task_claim("Story 7.1")` → writes to Supabase ✅
5. Dev B's agent (started 5 seconds later) calls `project_memory_load` → sees:
   ```
   Next tasks:
   - Story 7.1 [CLAIMED by dev-a-machine]
   - Story 7.2 [FREE]
   - Story 7.3 [FREE]
   ```
6. Dev B's agent claims Story 7.2 → writes to Supabase ✅
7. Dev C's agent sees 7.1 and 7.2 claimed → claims Story 7.3 ✅
8. Each dev works, commits context locally, pushes to Supabase when done
9. Next round: all three pull, snapshot has all three stories completed

No duplicate work. No idle developers. The claim system coordinates in real time via Supabase while everything else stays local-first.

---

## What About the "Next Task" Problem?

The context commit currently says "Next: Story 7.1" as a single task. For teams, the snapshot needs to show multiple available tasks. This is already handled by the open threads / active claims formatter — threads with `[FREE]` / `[CLAIMED]` labels.

The improvement: context commits for team projects should list multiple upcoming tasks, not just one:

```
Next tasks:
- Story 7.1: Current Status Panel (implement /api/live/status endpoint)
- Story 7.2: Real-time Price Chart (WebSocket for Tibber price stream)
- Story 7.3: Battery SOC Gauge (circular SVG gauge component)
```

This is a user education / CLAUDE.md concern, not a code change. The CLAUDE.md already says "the next concrete task" — for team projects, this should be "the next 3-5 concrete tasks" so agents have options when some are claimed.

---

## Integration with External Backlogs (Jira, Linear, Asana)

This delta does NOT build backlog integration. That's a separate concern.

ContextGit is a memory layer, not a project management tool. Teams already have sprint boards. The developer picks a ticket from Jira, tells the agent "implement PROJ-123", and the agent uses ContextGit for project knowledge — not for task assignment.

Future integration (Phase 4+):
- MCP server for Jira/Linear that reads tickets (read-only)
- Context commits that reference ticket IDs
- Search by ticket ID: "what happened with PROJ-123?"
- Dashboard showing context commits per ticket

These are additive features, not changes to the core architecture.

---

## Files Changed

| File | Change |
|---|---|
| `packages/mcp/src/server.ts` | Add `claimsStore` to `ServerContext`, resolve in `bootstrap()`, route claim tools and snapshot claims read |
| `packages/store/src/supabase/index.ts` | Add conflict check in `claimTask`, optionally add `list_active_claims` RPC function |
| `packages/store/src/supabase/schema.sql` | Add `list_active_claims` function if needed for TTL filtering |

---

## Validation Gates

| Gate | What to verify |
|---|---|
| Claim writes to Supabase | `project_task_claim` in Claude Code → check Supabase `claims` table directly |
| Second claim rejected | Two Claude Code sessions, same project, same task → second gets clear error message |
| Snapshot shows remote claims | Dev B calls `project_memory_load` → sees Dev A's claim as `[CLAIMED]` |
| Unclaim works | Dev A calls `project_task_unclaim` → Dev B's next `project_memory_load` shows `[FREE]` |
| Fallback to local | Unset `SUPABASE_SERVICE_KEY` → claims fall back to local SQLite (no crash) |
| TTL expiry | Claim with 1-minute TTL → wait 2 minutes → `project_memory_load` shows `[FREE]` |

---

## What Does NOT Change

- `project_memory_save` still writes to LocalStore
- `project_memory_load` still reads commits/threads/summary from LocalStore
- Push/pull still syncs commits and threads between LocalStore and SupabaseStore
- The claim system for single-machine multi-agent (two Claude Code windows) still uses LocalStore
- The MCP server's primary store is still LocalStore
- No new packages, no new dependencies

---

*Append-only log. Do not edit previous entries.*
