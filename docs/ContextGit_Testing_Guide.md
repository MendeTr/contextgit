# ContextGit Testing Guide

**Version:** 0.0.5 — Phase 2  
**Scope:** All patterns + pre-launch validation

Work through scenarios in order. Each builds on the previous. All must pass before the launch post goes out. If a blocker is found, fix it before moving to the next scenario.

---

## Scenarios

| # | Scenario | What It Validates |
|---|----------|-------------------|
| 1 | Clean Install | Fresh machine, npm install, zero-config init |
| 2 | Solo Dev — Basic Flow | init → commit → status → doctor → serve |
| 3 | Claim / Unclaim | Task collision prevention between agents |
| 4 | Replan (Scope Change) | Scope change propagation via `replan:` prefix |
| 5 | Two Agent Windows | Two Claude Code windows, same project, role isolation |
| 6 | Orchestrator + Subagents | One orchestrator spawning subagents via Claude Code |
| 7 | Push / Pull Sync | Two dirs acting as two machines syncing context |
| 8 | Loqally Real-World | Real project, real features, all patterns combined |

---

## Scenario 1 — Clean Install

> Test as a stranger. No prior config, no local DB, fresh npm install.

**Do this in a clean directory with no existing contextgit setup. Uninstall first if needed.**

```bash
# 1. Uninstall any existing version
npm uninstall -g contextgit

# 2. Install from npm
npm install -g contextgit

# 3. Create a fresh test directory
mkdir ~/cg-test-fresh
cd ~/cg-test-fresh
git init

# 4. Initialise ContextGit
contextgit init

# 5. Write your first commit
contextgit commit "first commit — clean install test"

# 6. Check status
contextgit status

# 7. Run doctor
contextgit doctor

# 8. Start the server
contextgit serve --port 3456
```

**Pass criteria:**
- `init` completes without errors
- `init` detects and configures MCP clients automatically — no manual paste step
- `~/.claude.json` (or equivalent) contains the `contextgit` server entry with `systemPrompt`
- `status` shows 1 commit, 1 agent
- `doctor` reports green on config, DB, git hooks
- `serve` starts and shows auth status

---

## Scenario 2 — Solo Dev Basic Flow

> Full solo workflow from init to search. Validates core primitives work end-to-end.

**No CLAUDE.md setup required.** `contextgit init` injects the system prompt into your MCP client automatically. Open Claude Code after init completes.

```bash
# 1. Init in a test project
mkdir ~/cg-test-solo
cd ~/cg-test-solo
git init
contextgit init
# Confirm output shows MCP client configured (✅ Configured Claude Code)

# 2. Open Claude Code in this directory and type: start
# The agent should call context_get scope=global immediately — no prompting

# 3. Write several commits via the agent or CLI
contextgit commit "designed data model — users and projects tables"
contextgit commit "implemented auth middleware — JWT RS256"
contextgit commit "added rate limiting — Redis, sliding window chosen"

# 4. Check status
contextgit status

# 5. Search
contextgit search "auth"

# 6. Branch and merge
contextgit branch "experiment/try-postgres-full-text"
contextgit commit "explored postgres FTS — too slow for our query patterns"
contextgit merge "main" "experiment inconclusive — sticking with pgvector"

# 7. Close Claude Code. Open a new session. Type: start
# Agent must call context_get immediately, with zero clarifying questions,
# and correctly describe what was built in the previous session.
```

**Pass criteria:**
- `init` output shows `✅ Configured Claude Code` (or equivalent client)
- First Claude Code session: agent calls `context_get` automatically before any other action
- Agent asks zero clarifying questions before starting work
- `status` shows correct commit count and agent
- `search "auth"` returns the auth middleware commit
- Branch created and merged without errors
- Second cold session: agent correctly describes previous session state from snapshot alone

---

## Scenario 3 — Claim / Unclaim

> Validates task collision prevention. Two agents must not work on the same task.

```bash
# Setup — use the project from Scenario 2
cd ~/cg-test-solo

# Simulate Agent 1 claiming a task
contextgit claim "implement user profile endpoint"

# Check snapshot — activeClaims should appear
contextgit status
# Look for activeClaims section showing the claim

# Simulate Agent 2 reading the snapshot
# In a second terminal or Claude Code window:
contextgit status
# Agent 2 should see the claim and skip that task

# Agent 1 commits — claim should auto-release
contextgit commit "implemented user profile endpoint"
contextgit status
# activeClaims section should be empty

# Manual unclaim test
contextgit claim "implement notifications"
contextgit unclaim "implement notifications"
contextgit status
# Claim should be gone

# TTL test — claim something, wait for TTL (or set a short TTL in test config)
# Next context_get should drop the expired claim automatically
```

**Pass criteria:**
- `claim` writes to DB without error
- `activeClaims` appears in `context_get` / `status` snapshot
- Claim auto-releases on `commit`
- `unclaim` releases manually
- Expired claims (TTL) are dropped on next `context_get`
- No two agents work the same claimed task in the two-window test (Scenario 5)

---

## Scenario 4 — Replan (Scope Change)

> Validates that scope changes propagate to other agents via the snapshot.

```bash
# Setup — use same project
cd ~/cg-test-solo

# Agent 1 discovers scope has changed mid-session
# Write a replan commit BEFORE building the new scope
contextgit commit "replan: claims table needs TTL index for performance. Adding migration before any further claim work."

# Check snapshot
contextgit status
# The replan commit should appear in recent commits

# Simulate Agent 2 cold-starting
# Open a new Claude Code window, type: start
# Agent 2's context_get should surface the replan commit
# Agent 2 must not start work that contradicts the replan
```

**Pass criteria:**
- `replan:` prefix commit writes successfully
- Replan commit appears in `context_get` snapshot for a second agent
- Replan commit is written BEFORE any new scope work begins (discipline check — verify commit timestamps)
- Second agent sees the replan and acts accordingly

---

## Scenario 5 — Two Agent Windows

> Two Claude Code windows open simultaneously on the same project. Role isolation and claim coordination.

**Setup:** Open two Claude Code windows, both pointed at the same project directory. In each window's MCP config, set different `agentRole` values (or pass role when claiming).

```
Window 1 — Dev agent
Window 2 — Reviewer agent
```

**Session flow:**

```
Window 1 (Dev):
  start → context_get fires → reads snapshot
  contextgit claim "build search endpoint"
  [builds feature]
  contextgit commit "search endpoint implemented — uses pgvector cosine similarity"
  [claim auto-releases]

Window 2 (Reviewer) — running in parallel:
  start → context_get fires → reads same snapshot
  [sees activeClaims: "build search endpoint" claimed by dev]
  [skips search endpoint, picks unclaimed task]
  contextgit claim "review auth middleware"
  [reviews, finds issue]
  contextgit commit "auth middleware review — missing rate limit on /refresh endpoint"
  threads.open: "rate limit missing on /refresh — dev to fix"

Window 1 (Dev) — after Window 2 commit:
  contextgit status → sees reviewer's open thread
  contextgit claim "fix rate limit on /refresh"
  [fixes]
  contextgit commit "rate limit added to /refresh"
```

**Pass criteria:**
- Both agents call `context_get` automatically on session start
- No task worked on by both agents simultaneously
- `context_get agent_role=dev` returns only dev commits
- `context_get agent_role=reviewer` returns only reviewer commits
- Open threads appear cross-role (dev sees reviewer's thread)
- No `SQLITE_BUSY` errors during concurrent writes
- Final `contextgit status` shows commits from both agents with correct role attribution

---

## Scenario 6 — Orchestrator + Subagents

> One orchestrator spawns subagents via Claude Code. No agent is manually briefed.

**Setup:** Use Claude Code's subagent / Task tool capability. The orchestrator spawns a dev subagent and a test subagent.

**Orchestrator prompt:**
```
You are an orchestrator. Do not implement anything yourself.
1. Call context_get scope=global to read current state.
2. Spawn a dev subagent to implement the next unclaimed feature from the snapshot.
3. Spawn a test subagent to test what the dev subagent built.
4. Write a final context_commit summarising the result.
```

**Pass criteria:**
- Orchestrator calls `context_get` before spawning subagents
- Dev subagent receives project context without manual briefing
- Dev subagent claims its task before starting work
- Test subagent sees dev subagent's claim and work in its own `context_get`
- No duplicate task assignments
- Orchestrator's final commit references both subagent commits
- All commits attributed correctly by role

---

## Scenario 7 — Push / Pull Sync

> Two local directories acting as two machines. Validates context sync.

```bash
# Setup — two directories, one remote configured
mkdir ~/cg-test-machine-a
mkdir ~/cg-test-machine-b

cd ~/cg-test-machine-a
git init
contextgit init
contextgit commit "machine A — initial commit"

# Push from machine A
contextgit push

# Pull from machine B
cd ~/cg-test-machine-b
git init
contextgit init
contextgit pull
contextgit status
# Should show machine A's commit

# Write on machine B, push, pull on machine A
contextgit commit "machine B — added feature"
contextgit push

cd ~/cg-test-machine-a
contextgit pull
contextgit status
# Should show both commits

# Idempotency — push again from machine A
contextgit push
# No duplicates in remote

# No remote configured — clean error
mkdir ~/cg-test-no-remote
cd ~/cg-test-no-remote
git init
contextgit init
contextgit push
# Should exit with code 1 and clear message — not a crash

# Dry run
cd ~/cg-test-machine-a
contextgit push --dry-run
# Shows what would be pushed without writing
```

**Pass criteria:**
- `push` syncs commits to remote
- `pull` brings remote commits to local
- Second `push` is idempotent — no duplicate commits in remote
- No remote configured → clean error message, exit code 1, no crash
- `--dry-run` shows output without writing

---

## Scenario 8 — Loqally Real-World

> Real project, real features, all patterns combined. This is the highest-signal test.

**Setup:**

```bash
cd ~/loqally
contextgit status
# Migration check — claims table should exist
# If status works, migration fired correctly

# Write a baseline commit describing current state
contextgit commit "baseline: PPT generator near complete. Template preview working. Chat-based fine tuning not started. Docs sparse — agents should explore codebase."
```

**The multi-agent session:**

| Dev Agent | QA / Reviewer Agent |
|-----------|---------------------|
| `context_get` → reads baseline | `context_get` → reads same baseline |
| `claim "PPT template fine tuning"` | Sees dev claim in `activeClaims` |
| Builds the fine tuning feature | `claim "test PPT preview rendering"` |
| `commit "PPT fine tuning done"` | Tests preview, writes findings |
| Claim auto-releases | `commit "preview has 2 rendering bugs"` |
| `context_get` → sees QA findings | `context_get` → sees dev commit |
| `claim "fix rendering bugs"` | Claims next unblocked task |
| Fixes and commits | Continues testing |

**Pass criteria:**
- No task worked on by both agents
- `context_get agent_role` filter works throughout
- Claims release correctly on each commit
- No `SQLITE_BUSY` errors during concurrent writes
- Final `contextgit status` shows commits from both agents

---

## Pre-Launch Checklist

All items must be checked before the launch post goes out.

### Installation
- [ ] `npm install -g contextgit` works on a clean machine
- [ ] `contextgit init` completes without errors
- [ ] `contextgit init` auto-configures detected MCP clients — no manual paste step
- [ ] `~/.claude.json` contains `contextgit` entry with correct `systemPrompt` after init
- [ ] `contextgit doctor` reports green on all checks

### Session Start Contract
- [ ] Claude Code session opened after `contextgit init`: agent calls `context_get` automatically
- [ ] Agent asks zero clarifying questions before starting work
- [ ] Cold session (second open): agent correctly describes previous session from snapshot alone

### Core Primitives
- [ ] `contextgit commit` writes to DB
- [ ] `contextgit status` shows correct data
- [ ] `contextgit search` returns relevant results
- [ ] `contextgit branch` creates without error
- [ ] `contextgit merge` succeeds
- [ ] `contextgit serve` starts and shows auth status

### Claim / Unclaim
- [ ] `contextgit claim` writes claim to DB
- [ ] `activeClaims` appears in `context_get` snapshot
- [ ] Claim auto-releases on commit
- [ ] `contextgit unclaim` releases manually
- [ ] TTL expiry removes stale claims automatically
- [ ] Two agents do not work on the same claimed task

### Replan
- [ ] `context_commit` with `replan:` prefix appears in snapshot
- [ ] Second agent sees replan on next `context_get`
- [ ] Replan commit written BEFORE building new scope

### Multi-Agent
- [ ] `context_get agent_role=dev` returns only dev commits
- [ ] `context_get agent_role=reviewer` returns only reviewer commits
- [ ] Threads appear cross-role
- [ ] No `SQLITE_BUSY` errors during concurrent writes
- [ ] Orchestrator pattern works — no duplicate task assignments

### Push / Pull
- [ ] `contextgit push` syncs commits to remote
- [ ] `contextgit pull` brings remote commits locally
- [ ] Second push is idempotent — no duplicates
- [ ] No remote configured → clean error message, exit code 1
- [ ] `--dry-run` shows output without writing

### Before Posting
- [ ] `npm publish` completed — package available on npm
- [ ] README written: what it is, problem it solves, install command, 3 commands to get started
- [ ] All 8 scenarios passed
- [ ] Loqally real-world test passed
- [ ] Launch post copy finalised
