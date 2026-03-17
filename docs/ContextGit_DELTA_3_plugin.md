# ContextGit — Delta Spec: Session Contract Enforcement

**Date:** 2026-03-17 (revised)  
**Status:** Ready for implementation  
**Target version:** 0.0.5  
**Scope:** `packages/mcp/src/server.ts` (tool descriptions) + `packages/cli/src/commands/init.ts` (CLAUDE.md + skills write)  
**Replaces:** Delta 3 "Zero-Config Init" (systemPrompt field — does not exist) AND Delta 3 "Claude Code Plugin" (plugin packaging — unnecessary complexity for current needs)

---

## Problem (revised — second pivot)

### What failed: Zero-Config Init (Delta 3 v1)

Attempted to inject a `systemPrompt` field onto the MCP server entry in `~/.claude.json`. That field does not exist in Claude Code. The agent never sees it. Dead on arrival.

### What was overengineered: Claude Code Plugin (Delta 3 v2)

The plugin approach correctly identified Claude Code's four enforcement mechanisms:

| Mechanism | How it works | Deterministic? |
|---|---|---|
| `CLAUDE.md` | Injected into every user message as `<system-reminder>` | Yes — fires every message |
| `SessionStart` hook | Shell command at session start; stdout added to context | Yes — fires at session start |
| Skills | Model-invoked when task matches skill description | No — advisory, but effective |
| MCP tool descriptions | Visible to any agent with the MCP server registered | Yes — always available |

But the plugin packaging introduced problems:

1. **SessionStart hook platform bug** — hooks don't fire for locally-installed plugins. Only works when installed from GitHub. Can't test locally during development.
2. **External dependency** — requires `claude plugin install` from a GitHub URL. Adds a distribution step that can fail and a platform dependency we don't control.
3. **Doesn't reach Superpowers subagents** — plugins install at user level, but subagents spawned by third-party plugins (e.g., Superpowers' executor/reviewer agents) don't inherit parent session skills. They run in isolated context windows with custom system prompts we can't modify.

### The actual enforcement surface

After testing both approaches, the reliable enforcement mechanisms are:

| Mechanism | Reaches interactive sessions? | Reaches subagents? | We control it? |
|---|---|---|---|
| **CLAUDE.md** | Yes — every message | No — subagents don't inherit project CLAUDE.md | Yes |
| **Project-level skills** (`.claude/skills/`) | Yes — auto-discovered | No — subagents don't auto-inherit project skills | Yes |
| **MCP tool descriptions** | Yes | **Yes** — any agent with MCP server registered sees tool descriptions | Yes |
| SessionStart hook (plugin) | Sometimes (platform bug) | No | No — Anthropic platform dependency |

**Key insight:** MCP tool descriptions are the only enforcement mechanism that reaches both interactive sessions AND third-party subagents. Any agent with the ContextGit MCP server registered will see the tool name and description when scanning available tools. This is the universal enforcement layer.

CLAUDE.md and project-level skills are the reinforcement layer for interactive sessions — they provide richer behavioral guidance but only reach agents that load them.

---

## Goal

After `contextgit init`, the developer's project is fully configured through three complementary layers:

1. **MCP tool descriptions** (universal) — self-describing tools that any agent discovers and understands, including subagents spawned by Superpowers or other orchestrators
2. **CLAUDE.md fragment** (interactive sessions) — behavioral contract visible to Claude on every message in the main session
3. **Project-level skills** (interactive sessions) — guide `context_commit` and `context_branch` discipline through Claude Code's skill system

The session contract is enforced by the tools themselves and reinforced by project-level configuration. No plugin install. No external dependencies. No platform bugs to work around.

---

## Why Not Plugin

The plugin packaging format bundles MCP server + hooks + skills + CLAUDE.md into a single installable unit. That's elegant, but:

- The SessionStart hook has a confirmed platform bug (doesn't fire for local installs)
- Plugin skills don't reach subagents (subagents run in isolated context windows)
- The MCP server is already registered independently via `~/.claude.json`
- The only things the plugin adds over `contextgit init` writing files directly are: (a) a broken hook and (b) skills that don't propagate to subagents

Everything the plugin delivers that actually works can be achieved by `contextgit init` writing files to the project directory. Simpler. No external dependencies. No platform bugs.

**Future:** If Anthropic fixes the SessionStart hook bug and adds skill inheritance for subagents, revisit the plugin approach. Until then, the direct-write approach is strictly better.

---

## Implementation

### Part 1 — MCP Tool Descriptions (`packages/mcp/src/server.ts`)

Rewrite the tool names and descriptions to be self-enforcing. The description is the one artifact visible to every consumer — interactive sessions, Superpowers subagents, custom orchestrators, any future tool.

**Design principle:** Claude has a documented tendency to "undertrigger" skills and tools. Descriptions must be assertive, not passive. State when to call the tool and why skipping it causes harm.

#### `context_get` → rename to `project_memory_load`

```typescript
server.tool(
  'project_memory_load',
  z.object({
    scope: z.enum(['global', 'branch', 'commit']).default('global')
      .describe('Retrieval scope. global = full project snapshot (default). branch = current branch only. commit = specific commit.'),
    since: z.number().optional()
      .describe('Unix timestamp ms. When provided, returns only changes after this time. Use for polling loops.'),
  }),
  `Load persistent project memory and context.

IMPORTANT: Call this tool at the START of every session — before reading files, before asking questions, before doing any work. This tool returns the project's current state including: what was built, what was decided, active tasks, claimed work, recent decisions, and open questions.

Skipping this call means you will duplicate work that was already done, re-explore approaches that already failed, and contradict decisions that were already made.

If you are a subagent working on a specific task, call this tool first to understand the full project context before starting your assigned work.`
)
```

#### `context_commit` → rename to `project_memory_save`

```typescript
server.tool(
  'project_memory_save',
  z.object({
    message: z.string()
      .describe('Structured summary: one-line summary, then what was decided, what was built, open questions, and git branch/commit hash.'),
  }),
  `Save project memory after completing work.

IMPORTANT: Call this tool BEFORE ending your session or moving to the next task. This saves what you did, what you decided, and what questions remain — so the next session (or the next agent) can pick up where you left off.

If you skip this call, the next session starts blind. Your work will be invisible to future agents. They will re-do what you already did.

Call after: completing a feature, making an architectural decision, resolving a bug, closing a thread, or finishing any meaningful unit of work. Small decisions compound — save them.`
)
```

#### `context_branch` → rename to `project_memory_branch`

```typescript
server.tool(
  'project_memory_branch',
  z.object({
    git_branch: z.string().describe('Git branch name to associate with this context branch.'),
    name: z.string().optional().describe('Display name for the context branch.'),
  }),
  `Create an isolated context branch before risky or experimental work.

Call before: trying an approach you're not sure will work, refactoring across many files, or exploring an architectural alternative. If the exploration fails, the main context is untouched.

The cost of not branching is re-explaining to the next session why you abandoned an approach you spent an hour on.`
)
```

#### `context_claim` → rename to `project_task_claim`

```typescript
server.tool(
  'project_task_claim',
  z.object({
    task: z.string().describe('Task description to claim.'),
    for_agent_id: z.string().optional().describe('Claim on behalf of this agent ID (for orchestrator pre-claiming).'),
    thread_id: z.string().optional().describe('Direct thread ID link for this claim.'),
  }),
  `Claim a task to prevent other agents from working on it simultaneously.

Call before starting work on any task visible in the project memory. Other agents will see your claim and skip this task. Claims auto-expire after 2 hours.

If you skip claiming, another agent may start the same task, producing duplicate and conflicting work.`
)
```

#### `context_unclaim` → rename to `project_task_unclaim`

```typescript
server.tool(
  'project_task_unclaim',
  z.object({
    task: z.string().describe('Task to release.'),
  }),
  `Release a previously claimed task so other agents can work on it.`
)
```

#### `context_merge` → rename to `project_memory_merge`

```typescript
server.tool(
  'project_memory_merge',
  z.object({
    source_branch_id: z.string().describe('Branch ID to merge back into parent.'),
  }),
  `Merge a context branch back into the parent branch after successful exploration.

Call after a context branch experiment succeeds and you want to preserve the findings in the main project memory.`
)
```

**Backward compatibility note:** The old tool names (`context_get`, `context_commit`, etc.) are referenced in existing CLAUDE.md files, system prompts, and orchestrator configs. Add aliases that map old names to new names for one release cycle. Emit a deprecation notice in the tool response when old names are used. Remove aliases in 0.0.6.

```typescript
// Alias for backward compatibility — remove in 0.0.6
server.tool('context_get', /* same schema */, async (params) => {
  console.warn('[contextgit] context_get is deprecated. Use project_memory_load.')
  return projectMemoryLoadHandler(params)
})
```

---

### Part 2 — CLAUDE.md Fragment (`packages/cli/src/commands/init.ts`)

After the existing init flow (project DB, config, hooks offer) completes, write the CLAUDE.md fragment.

Check for `<!-- contextgit:start -->` sentinel. If absent, append:

```markdown

<!-- contextgit:start -->
## ContextGit Memory

This project uses ContextGit for persistent AI memory across sessions.

**Session start:** Call `project_memory_load` (or `context_get`) immediately — before reading files, before asking questions, before doing any work. This loads the full project state: what was built, what was decided, active tasks, and open questions.

**After significant work:** Call `project_memory_save` (or `context_commit`) with a structured message:
- One-line summary of what was done
- What was decided and why
- What was built (files changed, approach taken)
- Open questions
- Git branch and commit hash

**Before risky exploration:** Call `project_memory_branch` (or `context_branch`) to create an isolated context workspace.

**Before starting a task:** Call `project_task_claim` (or `context_claim`) to prevent other agents from duplicating your work.

Do not skip these steps. The next session starts blind without them.
<!-- contextgit:end -->
```

**Rules:**

- If `CLAUDE.md` does not exist, create it with just this content
- If it exists but the sentinel is already present, skip (idempotent)
- If the CLAUDE.md write fails for any reason, log a warning and continue — never block project init on a CLAUDE.md write failure

---

### Part 3 — Project-Level Skills (`packages/cli/src/commands/init.ts`)

Write two skill directories into the project's `.claude/skills/` directory. These are discovered automatically by Claude Code for any interactive session in the project.

**Important:** These skills reach interactive sessions only. Subagents spawned by third-party plugins (Superpowers, etc.) do not inherit project-level skills. The MCP tool descriptions (Part 1) are the enforcement layer for subagents.

#### `.claude/skills/context-commit/SKILL.md`

```markdown
---
name: context-commit
description: "Save project memory after completing work. Use this skill whenever you have just finished implementing a feature, resolved a bug or blocker, made an architectural decision, closed a thread, completed a code review, or are about to end the session. Also trigger when you see signals like 'that's working', 'task complete', 'let's move on', 'I'm done', or after completing a git commit. IMPORTANT: Always use this skill before ending a session or moving to the next task — skipping it means the next session starts blind."
---

# ContextGit — Context Commit Discipline

## When to commit context

Call `project_memory_save` (MCP tool) after:
- Completing a feature or task (before moving to the next)
- Making an architectural decision or choosing between options
- Resolving a bug, blocker, or open question
- Closing a thread
- Before ending the session

## What makes a good commit message

A context commit message is a future-you briefing. Write it so the next agent session (or the next developer) can pick up exactly where this one left off.

Structure:
```
<one-line summary of what was done>

What was decided: <the decision and why>
What was built: <files changed, approach taken>
Open questions: <anything unresolved>
Git: <branch> | <commit hash if available>
```

Example:
```
Implemented optimistic locking via CAS on branches table

What was decided: CAS with 3-attempt retry + jitter over queue-based serialization.
Queue deferred until high-conflict multi-agent scale. COMMIT_CONFLICT error type added.
What was built: store/src/local/queries.ts (version column), store/src/local/index.ts (retry logic), core/src/types.ts (COMMIT_CONFLICT)
Open questions: TTL behavior under high contention not yet load-tested.
Git: feat/phase2-delta1 | a3f9c12
```

## How to call it

Use the `project_memory_save` MCP tool (alias: `context_commit`). Pass the full message as the `message` argument.

Do not skip this step when the work feels small. Small decisions compound. The next session starts blind without them.
```

#### `.claude/skills/context-branch/SKILL.md`

```markdown
---
name: context-branch
description: "Create an isolated context branch before risky or experimental work. Use this skill when the agent is about to explore something uncertain, experimental, or potentially breaking — trying an approach that might not work, refactoring something risky, exploring an architectural alternative, or doing anything that should be isolatable and reversible. Triggers on: 'let me try', 'what if we', 'I want to explore', 'let's experiment', 'alternative approach', or any phrasing that signals exploration rather than execution."
---

# ContextGit — Context Branch Discipline

## When to branch context

Call `project_memory_branch` (MCP tool) before:
- Trying an approach you're not sure will work
- Refactoring something that touches many files
- Exploring an architectural alternative to the current plan
- Doing anything you'd want to be able to roll back semantically (not just via git)

## Why this matters

A context branch creates an isolated snapshot workspace. If the exploration fails, you can return to the main branch context without polluting the session history with dead-end decisions.

It's cheap. It takes one tool call. The cost of not doing it is re-explaining to the next session why you abandoned the approach you just spent an hour on.

## How to call it

Use the `project_memory_branch` MCP tool (alias: `context_branch`). Pass a short descriptive name:

```
project_memory_branch name="explore-queue-based-concurrency"
```

When the exploration concludes:
- If it worked: `project_memory_save` your findings and merge back
- If it failed: `project_memory_save` a brief note ("explored X, abandoned because Y") and switch back to main branch

The failure note is as valuable as the success note. The next session needs to know not to try the same dead end.
```

**Write rules:**

- Create `.claude/skills/context-commit/SKILL.md` and `.claude/skills/context-branch/SKILL.md`
- If the directories already exist, overwrite the SKILL.md files (these are managed by contextgit)
- Add `.claude/skills/context-commit/` and `.claude/skills/context-branch/` to the project's `.gitignore` if `.gitignore` exists — these are local development aids, not team-shared config (team members run `contextgit init` themselves)
- If the skill write fails, log a warning and continue — never block project init

**Wait — gitignore decision:** Actually, these skills SHOULD be committed to version control. When a new team member clones the repo, they get the skills automatically. This is consistent with how Claude Code's docs describe project-level skills: "Commit `.claude/skills/` to version control." Do NOT add to `.gitignore`.

---

### Part 4 — Init Command Output

Update `packages/cli/src/commands/init.ts` output format:

```
✅ Project initialized          (.contextgit.json)
✅ Git hooks installed          (.git/hooks/post-commit)
✅ CLAUDE.md updated            (contextgit memory section appended)
✅ Skills installed             (.claude/skills/context-commit, .claude/skills/context-branch)

ContextGit is ready. Start a Claude Code session in this project.
The agent will load project memory automatically via MCP tool discovery.
```

Partial success (skill write failed):

```
✅ Project initialized          (.contextgit.json)
✅ Git hooks installed          (.git/hooks/post-commit)
✅ CLAUDE.md updated            (contextgit memory section appended)
⚠️  Skills not installed        (could not write to .claude/skills/ — create manually)

ContextGit is ready. MCP tools and CLAUDE.md are configured.
For full skill support, create .claude/skills/ manually.
```

---

## What This Kills

| Previous Delta 3 (Plugin) | Status |
|---|---|
| `packages/plugin/` directory | Not created — no plugin package |
| `.claude-plugin/plugin.json` manifest | Not created |
| `hooks/hooks.json` SessionStart config | Not created — hook has platform bug |
| `hooks/scripts/session-start.sh` | Not created |
| `.mcp.json` plugin MCP registration | Not needed — MCP server registered independently |
| `spawnSync('claude', ['plugin', 'install', ...])` | Not needed |
| Plugin marketplace dependency | Eliminated |

| Previous Delta 3 (Zero-Config Init) | Status |
|---|---|
| `ClientConfigManager` utility | Not created |
| `detectClients()` | Not created |
| `injectMcpServer()` | Not created |
| `systemPrompt` field | Does not exist in Claude Code |

---

## Three-Layer Enforcement Model

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: MCP Tool Descriptions (UNIVERSAL)             │
│                                                         │
│  Reaches: Interactive sessions, Superpowers subagents,  │
│  custom orchestrators, any future MCP consumer          │
│                                                         │
│  How: Tool name + description visible to any agent      │
│  with the MCP server registered. Self-describing.       │
│  "Call this tool FIRST" / "Call this tool BEFORE ending" │
└─────────────────────────────────────────────────────────┘
                          │
                  reinforced by
                          │
┌─────────────────────────────────────────────────────────┐
│  Layer 2: CLAUDE.md (INTERACTIVE SESSIONS)              │
│                                                         │
│  Reaches: Main Claude Code session, any agent that      │
│  loads from the project working directory                │
│                                                         │
│  How: Behavioral contract injected as <system-reminder> │
│  on every user message. Explicit instructions.          │
└─────────────────────────────────────────────────────────┘
                          │
                  reinforced by
                          │
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Project Skills (INTERACTIVE SESSIONS)         │
│                                                         │
│  Reaches: Main Claude Code session (auto-discovered     │
│  from .claude/skills/)                                  │
│                                                         │
│  How: context-commit skill fires when agent completes   │
│  work. context-branch skill fires when agent explores.  │
│  Teaches discipline, not just awareness.                │
└─────────────────────────────────────────────────────────┘
```

**Degradation is graceful:**
- All three layers present → full enforcement for interactive, tool descriptions for subagents
- Skills missing → CLAUDE.md + tool descriptions still work
- CLAUDE.md missing → tool descriptions still work (universal layer)
- Only MCP registered → tool descriptions alone provide baseline enforcement

---

## Implementation Order

1. Update tool names and descriptions in `packages/mcp/src/server.ts` (Part 1)
2. Add backward-compatible aliases for old tool names (Part 1)
3. Update `packages/cli/src/commands/init.ts` to write CLAUDE.md fragment (Part 2)
4. Update `packages/cli/src/commands/init.ts` to write project-level skills (Part 3)
5. Update init output format (Part 4)
6. Test: interactive Claude Code session — does agent call `project_memory_load` at start?
7. Test: interactive session — does agent call `project_memory_save` before ending?
8. Test: Superpowers subagent — does executor agent see and call `project_memory_load`?
9. Test: Superpowers subagent — does executor agent call `project_memory_save` after completing task?

**Ship gate:** Steps 6 and 7 must pass. Steps 8 and 9 are best-effort — if subagents don't call the tools despite improved descriptions, that's a known limitation documented in release notes, not a blocker.

---

## Validation Criteria

### Must pass (blocking)

1. `contextgit init` in a fresh project creates `.contextgit.json`, writes CLAUDE.md fragment, writes both skills to `.claude/skills/`
2. `contextgit init` on an already-initialized project is idempotent — no duplicate CLAUDE.md sections, no duplicate skills
3. Interactive Claude Code session: agent calls `project_memory_load` at session start without being asked
4. Interactive Claude Code session: agent calls `project_memory_save` after completing significant work
5. Old tool names (`context_get`, `context_commit`) still work with deprecation warning

### Should pass (non-blocking, document if not)

6. Superpowers executor subagent calls `project_memory_load` before starting assigned task
7. Superpowers executor subagent calls `project_memory_save` after completing assigned task

### Future (not tested in 0.0.5)

8. SessionStart hook fires reliably (blocked on Anthropic platform fix)
9. Plugin packaging for marketplace distribution
10. Skill inheritance for subagents (blocked on Claude Code platform feature)

---

## What Does NOT Change

- `.contextgit/system-prompt.md` still written during init (reference for developers)
- MCP server implementation (`packages/mcp`) unchanged beyond tool name/description updates
- Project DB, config, and hooks logic in init unchanged
- The engine, store, and API packages are untouched
- Existing CLAUDE.md conventions remain valid — the new fragment is additive

---

## Architecture Note

This delta does not change the dependency graph or package structure. All changes are in two existing files:
- `packages/mcp/src/server.ts` — tool names and descriptions
- `packages/cli/src/commands/init.ts` — CLAUDE.md write + skills write

No new packages. No new dependencies. No build changes.

---

*Append-only log. Do not edit previous entries.*
