# ContextGit — Delta: Multi-Agent Coordination

**Type:** Delta spec — changes and additions on top of PRD v4 and Architecture v3  
**Status:** Ready to build  
**Scope:** Solo developer, single machine, multiple local agents, same branch, same SQLite DB

---

## What This Delta Solves

The original PRD describes multi-agent support but does not specify the coordination
mechanics. This delta closes that gap.

**The scenario:** One developer. One machine. One git branch. An orchestrator spawns
2–3 dev agents and 1–2 test agents. All run locally. All hit the same SQLite DB.

**Three problems this delta solves:**

1. **Collision** — all agents call `context_get`, see the same threads, start the same work
2. **Idle agents** — dev agents 2 and 3 see nothing to claim after agent 1 takes the first thread
3. **No handover** — test agents have no trigger, no way to know when dev work is done

---

## The Correct Workflow (Model A)

ContextGit is the **memory and coordination layer**. The orchestration framework
(Claude Code subagents, claude-flow, etc.) is the **task router**. They do not overlap.

```
Orchestrator starts
  → context_get: sees open threads [A, B, C]
  → pre-claims thread A for dev-agent-1
  → pre-claims thread B for dev-agent-2
  → pre-claims thread C for dev-agent-3
  → spawns dev-agent-1 ("your agent ID is dev-agent-1, your task is claimed")
  → spawns dev-agent-2 ("your agent ID is dev-agent-2, your task is claimed")
  → spawns dev-agent-3 ("your agent ID is dev-agent-3, your task is claimed")
  → begins polling: context_get(since=now) every 30s

Dev agent 1 starts
  → context_get: sees its own claim on thread A → starts work immediately
  → context_commit: claim auto-releases

Orchestrator polling detects new commit from dev-agent-1
  → spawns test-agent-1 ("test the work in commit XYZ, thread A")
  → test-agent-1 context_get → sees dev commit → tests → context_commit findings

Orchestrator detects test pass → closes thread A
```

No agent is manually briefed. No context is duplicated. The orchestrator reacts to
commits, not to a fixed schedule.

---

## Changes Required

### 1. `since` parameter on `context_get`

**Why:** The orchestrator needs to poll for changes without re-reading the full snapshot.

**MCP tool** (`packages/mcp/src/server.ts`) — add optional param to `context_get`:

```typescript
since: z.number().optional().describe(
  'Unix timestamp ms. When provided, returns only commits and thread changes ' +
  'after this time. Omits projectSummary and branchSummary. ' +
  'Use this for orchestrator polling loops.'
)
```

**When `since` is provided, response shape:**

```typescript
{
  newCommits: Commit[]        // commits created after `since` on this branch
  openedThreads: Thread[]     // threads opened after `since`
  closedThreads: Thread[]     // threads closed after `since`
  activeClaims: Claim[]       // always full list
  checkedAt: number           // timestamp to use as next `since` value
}
```

**When `since` is omitted:** current behaviour unchanged.

**Store queries to add** (`packages/store/src/local/queries.ts`):

```sql
-- New commits since timestamp
SELECT * FROM commits
WHERE branch_id = ? AND created_at > ?
ORDER BY created_at ASC

-- Thread changes since timestamp (opened or closed)
SELECT * FROM threads
WHERE project_id = ? AND (created_at > ? OR updated_at > ?)
ORDER BY created_at ASC
```

**Migration required** — add `updated_at` to threads table:

```sql
-- migration: add updated_at to threads
ALTER TABLE threads ADD COLUMN updated_at INTEGER;
UPDATE threads SET updated_at = created_at;

-- trigger to keep updated_at current on close
CREATE TRIGGER threads_updated_at
AFTER UPDATE ON threads
BEGIN
  UPDATE threads SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;
```

---

### 2. Pre-claiming on behalf of another agent

**Why:** The orchestrator claims threads before spawning agents. Each agent starts
and sees its own claim already waiting — no ambiguity, no collision.

**MCP tool** (`packages/mcp/src/server.ts`) — add optional param to `context_claim`:

```typescript
for_agent_id: z.string().optional().describe(
  'If set, creates the claim on behalf of this agent ID instead of the calling agent. ' +
  'Used by orchestrators to pre-assign work before spawning sub-agents.'
)
```

When `for_agent_id` is set, use it as `claim.agentId`.

**No schema change.** `agent_id` on claims is already a free-form string.

---

### 3. Agent ID override via environment variable

**Why:** Spawned agents need stable, predictable IDs so the orchestrator can
pre-claim on their behalf and track their commits.

**Change** (`packages/mcp/src/server.ts`):

```typescript
// Current: always derives from hostname
const agentId = `${hostname}-mcp-claude-code-interactive`

// New: env var override takes priority
const agentId = process.env.CONTEXTGIT_AGENT_ID
  ?? `${hostname}-mcp-claude-code-interactive`
```

**Agent ID convention for local multi-agent:**

| Agent | ID |
|---|---|
| Orchestrator | `{hostname}-orchestrator` |
| Dev agent 1 | `{hostname}-dev-1` |
| Dev agent 2 | `{hostname}-dev-2` |
| Test agent 1 | `{hostname}-test-1` |

Orchestrator sets `CONTEXTGIT_AGENT_ID` in the env of each spawned MCP process.

---

### 4. Claims surfaced inline in snapshot

**Why:** Any agent reading `context_get` must immediately see what is taken and
what is available — without parsing a separate claims list at the bottom.

**Current snapshot format (agents-md):**

```
Open threads:
  - Implement Stripe webhook
  - Fix session persistence
  - Complete V3 pipeline

Active claims:
  - dev-agent-1: Implement Stripe webhook (2h TTL)
```

**New snapshot format:**

```
Open threads:
  [CLAIMED by dev-agent-1] Implement Stripe webhook
  [FREE] Fix session persistence
  [FREE] Complete V3 pipeline
```

**Change location:** `packages/core/src/snapshot-formatter.ts`

Logic: for each open thread, check `activeClaims` for a matching task string.
If found, prefix with `[CLAIMED by {agentId}]`. If not found, prefix with `[FREE]`.

Matching: case-insensitive substring match between `thread.description` and
`claim.task`. Exact match preferred, substring fallback.

---

### 5. `thread_id` on claims (optional linkage)

**Why:** Claims currently reference tasks by description string. For orchestrator
pre-claiming, a direct thread ID link is more reliable.

**Schema change:**

```sql
ALTER TABLE claims ADD COLUMN thread_id TEXT REFERENCES threads(id);
```

**MCP tool param:**

```typescript
thread_id: z.string().optional().describe(
  'ID of the specific thread this claim is for. ' +
  'When provided, claim is linked directly to the thread row.'
)
```

**Snapshot formatter:** uses `claim.threadId` for inline status if present,
falls back to string matching if not.

---

## What Does NOT Change

- The orchestrator's task decomposition logic lives outside ContextGit — in the
  spawning framework. ContextGit does not know or care how the orchestrator
  decides what to build.
- The orchestrator does not write task assignment commits into ContextGit.
  It uses pre-claims instead. Context commits remain agent work records,
  not assignment records.
- RemoteStore is not required for this. SQLite WAL mode handles concurrent
  reads/writes from multiple local processes correctly.
- The three-thread open thread limit in snapshots stays. Orchestrators reading
  `since`-filtered results get only new commits anyway.

---

## Build Order

1. Migration: `updated_at` on threads + trigger
2. Store queries: `listCommitsSince`, `listThreadChangesSince`
3. `CONTEXTGIT_AGENT_ID` env override in MCP server
4. `for_agent_id` param on `context_claim`
5. `since` param on `context_get` (MCP + REST API)
6. Snapshot formatter: inline claim status on threads
7. `thread_id` on claims (schema + MCP param + formatter linkage)

Each step is independently testable. Steps 1–4 have no user-facing changes.
Step 5 is the orchestrator's primary dependency. Step 6 improves UX for all agents.

---

## Validation Criteria

A multi-agent test is passing when:

1. Orchestrator calls `context_get`, sees 3 free threads
2. Orchestrator pre-claims all 3 for dev-agent-1/2/3
3. Each dev agent starts, calls `context_get`, sees exactly one `[CLAIMED]` thread — its own
4. Dev agents work in parallel, each commits independently
5. Orchestrator polling via `context_get(since=T)` detects each commit as it lands
6. Orchestrator spawns test agent per completed dev commit
7. Test agents start, see dev commits in snapshot, run tests, commit findings
8. No duplicate work. No idle agents after pre-claim. No manual briefing.
