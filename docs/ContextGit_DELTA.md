# ContextGit — Scope Delta Log

> This document records scope changes discovered during development.
> It is a log, not a plan. Entries are append-only — never delete or rewrite history.
> PRD and Architecture remain baseline truth. This doc explains how we deviated and why.

---

## 2026-03-12 — Phase 2 Delta: Coordination Primitives

**Trigger:** Pre-launch testing revealed task collision problem.

**The problem:**
Two agents call `context_get` → both see the same "next task" in the snapshot → both start building it simultaneously. This produces duplicate implementations, wasted work, and conflicting code. Write conflicts (SQLite busy_timeout) were never the real problem — task collision was.

This affects solo devs too. Two Claude Code windows on the same project hit the same issue.

**Second problem discovered:**
Phase 2 was marked complete in the snapshot. New scope was identified (claim primitive). Agent loading the snapshot would see "Phase 2 complete" and not know about the delta. No mechanism existed to propagate scope changes to other agents.

**New primitives added:**

### `contextgit claim <task>`
- Writes `{ task, agent, role, claimedAt, ttl: 2h, status: proposed|active }` to DB
- `context_get` now includes `activeClaims` in snapshot
- Other agents see claimed tasks and skip them
- Claim lifecycle: `proposed → active → released`
- Plan mode agents write `proposed` claims; approval flips to `active`
- TTL: 2 hours — expired claims auto-drop on next `context_get` call

### `contextgit unclaim <task>`
- Manual release of a claim
- Auto-release also fires on next `contextgit commit`

### `contextgit replan <reason>`
- Special commit type that flags a scope change event
- Updates the snapshot so next `context_get` reflects new reality
- Surfaces as distinct event type in snapshot (not mixed with feat/fix commits)
- Agents in plan mode should call `replan` before building new scope

**CLAUDE.md update required:**
```markdown
## When scope changes mid-session
If you identify missing primitives, new requirements, or plan gaps:
1. Call `contextgit replan "<what changed and why>"` before building
2. Then proceed with the new scope
Do not just start building. Replan first so other agents see the scope change.
```

**DB changes:**
- New `claims` table: `{ id, projectId, branchId, task, agentId, role, claimedAt, status, ttl, releasedAt }`
- New commit type: `replan` (alongside existing `feat`, `fix`, `decision`, `chore`)

**Why not in original PRD:**
Discovered during dogfooding Phase 2 on the contextgit project itself. Classic "you don't know what you need until you use it" problem. The PRD describes the vision — this doc describes reality.

**Status:** Building — Phase 2 not formally closed until claim + replan ship and pass testing.

---

## 2026-03-11 — Phase 2 Delta: Thread Sync Deferred

**Trigger:** Push/pull implementation revealed threads are embedded in CommitInput but not returned on Commit entity read.

**Decision:** Thread sync deferred to post-launch. Commits sync correctly. Threads are MVP gap, acceptable for launch.

**Status:** Documented as known limitation. Post-launch enhancement.

---

## 2026-03-11 — Rename: ContextHub → ContextGit

**Trigger:** ContextHub name was taken / unclear. ContextGit better communicates the git-like mental model.

**Changes:** npm package, repo, all docs updated to contextgit.

**Status:** Complete.

---

*Format: newest entries at top. Each entry must include trigger, problem, decision, and status.*
