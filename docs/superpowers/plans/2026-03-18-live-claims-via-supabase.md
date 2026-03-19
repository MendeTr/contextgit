# Live Claims via Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `project_task_claim`, `project_task_unclaim`, and the claims portion of `project_memory_load` to SupabaseStore when `supabaseUrl` is configured — enabling real-time claim visibility across multiple developers/machines.

**Architecture:** The MCP server grows a second store reference (`claimsStore`) that defaults to `LocalStore` but becomes `SupabaseStore` when `SUPABASE_SERVICE_KEY` is set. Only three operations touch Supabase: claim, unclaim, and the claims read in the snapshot. Everything else remains local-first. `SupabaseStore.claimTask` gains an application-level conflict check before inserting.

**Tech Stack:** TypeScript, `@supabase/supabase-js`, `@contextgit/store` (SupabaseStore already implemented), `@modelcontextprotocol/sdk`, Vitest

---

## File Map

| File | Change |
|---|---|
| `packages/store/src/supabase/index.ts` | Add conflict check in `claimTask` before INSERT |
| `packages/store/src/supabase/supabase-store.test.ts` | Add 2 tests: conflict throws, success still works |
| `packages/mcp/src/server.ts` | Add `claimsStore` to `ServerContext`, resolve in `bootstrap()`, route 3 operations |

No new files. No new dependencies.

---

## Task 1: SupabaseStore — Conflict Check in `claimTask`

**Files:**
- Modify: `packages/store/src/supabase/index.ts:522-538`
- Test: `packages/store/src/supabase/supabase-store.test.ts`

**Background:** `claimTask` currently does a bare INSERT. If two agents try to claim the same task, both succeed — the race condition this whole delta exists to fix. We add a pre-insert active-claims query and throw a clear error if the task is already taken.

A helper `msSince(date)` formats a human-readable "X minutes ago" / "X hours ago" string inline — no new import needed.

- [ ] **Step 1: Write failing test — double claim throws**

In `supabase-store.test.ts`, add two tests inside the existing `describe('claims')` block (or create it if absent):

```typescript
it('claimTask throws when same task is already actively claimed', async () => {
  // listActiveClaims uses this.db.rpc('list_active_claims', ...)
  // Mock rpc to return an existing active claim for the same task
  const existingClaim = {
    id: 'claim-existing',
    project_id: 'proj-1',
    branch_id: 'branch-1',
    task: 'Story 7.1',
    agent_id: 'dev-a-machine',
    role: 'solo',
    status: 'active',
    ttl: 7_200_000,
    claimed_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 minutes ago
    released_at: null,
    thread_id: null,
  }
  mockDb.rpc.mockResolvedValueOnce({ data: [existingClaim], error: null })

  await expect(
    store.claimTask('proj-1', 'branch-1', {
      task: 'Story 7.1',
      agentId: 'dev-b-machine',
      role: 'solo',
      status: 'active',
      ttl: 7_200_000,
    })
  ).rejects.toThrow('already claimed by dev-a-machine')
})

it('claimTask succeeds when no active claim exists for the task', async () => {
  // listActiveClaims: rpc returns empty list (no conflicts)
  mockDb.rpc.mockResolvedValueOnce({ data: [], error: null })

  // INSERT chain: from → insert → select → single
  const newClaimRow = {
    id: 'claim-new',
    project_id: 'proj-1',
    branch_id: 'branch-1',
    task: 'Story 7.1',
    agent_id: 'dev-b-machine',
    role: 'solo',
    status: 'active',
    ttl: 7_200_000,
    claimed_at: new Date().toISOString(),
    released_at: null,
    thread_id: null,
  }
  mockDb.from.mockReturnValueOnce({
    insert: () => ({
      select: () => ({
        single: () => ({ data: newClaimRow, error: null }),
      }),
    }),
  })

  const claim = await store.claimTask('proj-1', 'branch-1', {
    task: 'Story 7.1',
    agentId: 'dev-b-machine',
    role: 'solo',
    status: 'active',
    ttl: 7_200_000,
  })
  expect(claim.task).toBe('Story 7.1')
  expect(claim.agentId).toBe('dev-b-machine')
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/store && pnpm test -- --reporter=verbose 2>&1 | grep -E "claimTask|FAIL|PASS" | head -20
```

Expected: FAIL — `claimTask throws when same task is already actively claimed` fails because no conflict check exists yet.

- [ ] **Step 3: Add `msSince` helper and conflict check to `claimTask`**

In `packages/store/src/supabase/index.ts`, add the `msSince` helper just above `SupabaseStore` class:

```typescript
function msSince(date: Date): string {
  const ms = Date.now() - date.getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hour${hours !== 1 ? 's' : ''} ago`
}
```

Then replace the current `claimTask` method (lines 522–538 approx) with:

```typescript
async claimTask(projectId: string, branchId: string, input: ClaimInput): Promise<Claim> {
  // Use listActiveClaims (RPC-backed, TTL-aware) to check for conflicts.
  // This reuses the already-tested TTL expiry path and avoids duplicating
  // the SQL `claimed_at + (ttl || ' milliseconds')::interval > NOW()` logic.
  const active = await this.listActiveClaims(projectId)
  const conflict = active.find(c => c.task === input.task)

  if (conflict) {
    throw new Error(
      `Task "${input.task}" is already claimed by ${conflict.agentId} ` +
      `(claimed ${msSince(conflict.claimedAt)}). ` +
      `Pick a different task or wait for the claim to expire.`
    )
  }

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
```

**Why `listActiveClaims` instead of a raw query:** `listActiveClaims` calls the `list_active_claims` Postgres RPC, which applies `claimed_at + (ttl || ' milliseconds')::interval > NOW()`. A raw `.select().neq('status','released')` query would NOT apply TTL expiry — an expired claim would still block new claims, breaking the auto-expiry guarantee.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/store && pnpm test -- --reporter=verbose 2>&1 | grep -E "claimTask|FAIL|PASS" | head -20
```

Expected: both new tests PASS; all existing tests still PASS.

- [ ] **Step 5: Build and commit**

```bash
cd /Users/mendetrajovski/contexthub && pnpm build
git add packages/store/src/supabase/index.ts packages/store/src/supabase/supabase-store.test.ts
git commit -m "feat(store): add conflict check to SupabaseStore.claimTask"
git push
```

---

## Task 2: MCP Server — `claimsStore` Plumbing

**Files:**
- Modify: `packages/mcp/src/server.ts:67-108` (ServerContext + bootstrap)
- Modify: `packages/mcp/src/server.ts:390-427` (project_task_claim handler)
- Modify: `packages/mcp/src/server.ts:462-476` (project_task_unclaim handler)
- Modify: `packages/mcp/src/server.ts:125-159` (project_memory_load handler)

**Background:** Currently all operations hit `ctx.store` (LocalStore). We need a `claimsStore` that is `SupabaseStore` when configured, or falls back to the same `LocalStore`. Three handler changes required.

- [ ] **Step 1: Update `ServerContext` interface**

In `packages/mcp/src/server.ts`, replace the `ServerContext` interface:

```typescript
// Before:
interface ServerContext {
  engine: ContextEngine
  store: ContextStore
  projectId: string
  branchId: string
  config: ContextGitConfig
  agentId: string
}

// After:
interface ServerContext {
  engine: ContextEngine
  store: ContextStore
  claimsStore: ContextStore  // Supabase when configured, LocalStore otherwise
  projectId: string
  branchId: string
  config: ContextGitConfig
  agentId: string
}
```

- [ ] **Step 2: Verify `SupabaseStore` is exported from the store package, then add the import**

First, confirm the barrel export exists:

```bash
grep "SupabaseStore" packages/store/src/index.ts
```

Expected: `export { SupabaseStore } from './supabase/index.js'`

If that line is missing, add it to `packages/store/src/index.ts` before proceeding. If present, continue.

In the imports section at the top of `server.ts`, update the store import line:

```typescript
// Before:
import { LocalStore, RemoteStore } from '@contextgit/store'

// After:
import { LocalStore, RemoteStore, SupabaseStore } from '@contextgit/store'
```

- [ ] **Step 3: Resolve `claimsStore` in `bootstrap()`**

Replace the `return` statement at the end of `bootstrap()`:

```typescript
// Before:
return { engine, store, projectId, branchId, config, agentId }

// After:
let claimsStore: ContextStore = store  // default: same as primary store

if (config.supabaseUrl) {
  const key = process.env['SUPABASE_SERVICE_KEY']
  if (key) {
    claimsStore = new SupabaseStore(config.supabaseUrl, key)
  }
}

return { engine, store, claimsStore, projectId, branchId, config, agentId }
```

- [ ] **Step 4: Route `project_task_claim` to `claimsStore`**

In `handleProjectTaskClaim`, replace `ctx.store.claimTask` with `ctx.claimsStore.claimTask`:

```typescript
// Before:
const claim = await ctx.store.claimTask(ctx.projectId, ctx.branchId, {

// After:
const claim = await ctx.claimsStore.claimTask(ctx.projectId, ctx.branchId, {
```

- [ ] **Step 5: Route `project_task_unclaim` to `claimsStore`**

In `handleProjectTaskUnclaim`, replace `ctx.store.unclaimTask` with `ctx.claimsStore.unclaimTask`:

```typescript
// Before:
await ctx.store.unclaimTask(claim_id)

// After:
await ctx.claimsStore.unclaimTask(claim_id)
```

- [ ] **Step 6: Override `activeClaims` in `project_memory_load` from `claimsStore`**

In `handleProjectMemoryLoad`, after the `getSessionSnapshot` call and before `SnapshotFormatter().format(...)`:

```typescript
// Before:
const snapshot = await ctx.store.getSessionSnapshot(
  ctx.projectId,
  ctx.branchId,
  agent_role ? { agentRole: agent_role } : undefined,
)
const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')

// After:
const snapshot = await ctx.store.getSessionSnapshot(
  ctx.projectId,
  ctx.branchId,
  agent_role ? { agentRole: agent_role } : undefined,
)

// If claimsStore is different (Supabase configured), replace claims with live data
if (ctx.claimsStore !== ctx.store) {
  snapshot.activeClaims = await ctx.claimsStore.listActiveClaims(ctx.projectId)
}

const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')

// Note: the `since` (delta) path at line 138 returns via ctx.store.getContextDelta().
// For the mixed case (LocalStore primary + SupabaseStore claims), the delta path
// is not overridden here — known gap, acceptable since agents use the non-delta
// path for initial task coordination snapshots.
```

- [ ] **Step 7: Build to verify TypeScript compiles**

```bash
cd /Users/mendetrajovski/contexthub && pnpm build 2>&1 | tail -20
```

Expected: no TypeScript errors. All packages compile.

- [ ] **Step 8: Run full test suite**

```bash
pnpm test 2>&1 | tail -20
```

Expected: all tests pass (currently 92 passing).

- [ ] **Step 9: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): route claim tools and snapshot claims to claimsStore (Supabase when configured)"
git push
```

---

## Task 3: Context Commit

After both tasks are committed and pushed, call `project_memory_save` with:
- What was built: `claimsStore` added to MCP server, conflict check in `SupabaseStore.claimTask`
- Key decision: Approach A (overwrite `activeClaims` post-snapshot) — minimal interface change
- Files changed: `server.ts`, `supabase/index.ts`, `supabase-store.test.ts`
- Next task: Manual validation gates (see spec section "Validation Gates"), then Phase 3 Step 2 web platform

---

## Validation Gates (Manual — After Both Tasks)

Run these manually after implementation to confirm end-to-end behavior:

| Gate | How to verify |
|---|---|
| Claim writes to Supabase | Run `project_task_claim` in Claude Code with `SUPABASE_SERVICE_KEY` set → check Supabase `claims` table |
| Second claim rejected | Two Claude Code sessions, same project, same task → second gets "already claimed" error |
| Snapshot shows remote claims | Dev B calls `project_memory_load` → sees Dev A's claim as `[CLAIMED]` |
| Unclaim works | Dev A calls `project_task_unclaim` → Dev B's next load shows `[FREE]` |
| Fallback to local | Unset `SUPABASE_SERVICE_KEY` → claims use LocalStore, no crash |
| TTL expiry | Claim with 1-minute TTL → wait 2 minutes → snapshot shows `[FREE]` |
