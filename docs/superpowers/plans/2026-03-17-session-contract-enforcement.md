# Session Contract Enforcement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename MCP tools to self-describing names, write CLAUDE.md memory fragment + project skills during `contextgit init`, and fix the 1 failing test.

**Architecture:** Three-layer enforcement — MCP tool descriptions (universal, reaches all agents), CLAUDE.md fragment (interactive sessions), project-level skills (interactive sessions). All changes touch two existing files (`packages/mcp/src/server.ts`, `packages/cli/src/commands/init.ts`) plus one lib helper file and test files.

**Tech Stack:** TypeScript/NodeNext, oclif, @modelcontextprotocol/sdk, vitest, better-sqlite3, zod

---

## Spec Reference

`docs/ContextGit_DELTA_3_plugin.md` — read this before any task if behavior is unclear.

## Current State

- Build: passing (all packages)
- Tests: 1 failing in `packages/cli/src/lib/client-config.test.ts:45`
  - Test expects `args: ['contextgit', 'mcp']` but implementation now uses `['-y', '@contextgit/mcp']`
- Multi-agent delta (tools/schema): already implemented — do NOT re-implement
- `packages/mcp/src/server.ts` — tools are named `context_get`, `context_commit`, `context_branch`, `context_claim`, `context_unclaim`, `context_search`, `context_merge`

## File Structure

| File | Action | Purpose |
|---|---|---|
| `packages/cli/src/lib/client-config.test.ts` | Modify | Fix line 45: wrong args assertion |
| `packages/mcp/src/server.ts` | Modify | Rename tools + rewrite descriptions + add backward-compat aliases |
| `packages/cli/src/lib/init-helpers.ts` | Create | Testable helpers: `writeClaludeMd()`, `writeSkills()` |
| `packages/cli/src/lib/init-helpers.test.ts` | Create | Unit tests for CLAUDE.md write + skills write |
| `packages/cli/src/commands/init.ts` | Modify | Call helpers + update output format |

---

## Task 1: Fix the failing test

**Files:**
- Modify: `packages/cli/src/lib/client-config.test.ts:45`

- [ ] **Step 1: Run the failing test to understand it**

```bash
cd /path/to/contexthub
pnpm test -- packages/cli/src/lib/client-config.test.ts 2>&1 | grep -A 10 "FAIL"
```

Expected output: test failure saying `expected [ '-y', '@contextgit/mcp' ] to deeply equal [ 'contextgit', 'mcp' ]`

- [ ] **Step 2: Fix the test assertion**

Open `packages/cli/src/lib/client-config.test.ts`. On line 45, change:
```typescript
  expect(entry['args']).toEqual(['contextgit', 'mcp'])
```
to:
```typescript
  expect(entry['args']).toEqual(['-y', '@contextgit/mcp'])
```

- [ ] **Step 3: Run the test to verify it passes**

```bash
pnpm test -- packages/cli/src/lib/client-config.test.ts 2>&1 | tail -10
```

Expected: `Tests  10 passed (10)`

- [ ] **Step 4: Run all tests to confirm no regressions**

```bash
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/client-config.test.ts
git commit -m "fix(cli): update client-config test to expect npx -y @contextgit/mcp args"
```

---

## Task 2: Extract init helpers (prerequisite for TDD)

The CLAUDE.md write and skills write logic needs to live in a separate module so tests can import and exercise it without spawning a full CLI command.

**Files:**
- Create: `packages/cli/src/lib/init-helpers.ts`

- [ ] **Step 1: Create `packages/cli/src/lib/init-helpers.ts` with CLAUDE.md helper**

```typescript
// init-helpers.ts — testable helpers for contextgit init

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// ── CLAUDE.md ─────────────────────────────────────────────────────────────────

export const CLAUDE_MD_SENTINEL_START = '<!-- contextgit:start -->'
export const CLAUDE_MD_SENTINEL_END = '<!-- contextgit:end -->'

export const CLAUDE_MD_FRAGMENT = `
<!-- contextgit:start -->
## ContextGit Memory

This project uses ContextGit for persistent AI memory across sessions.

**Session start:** Call \`project_memory_load\` (or \`context_get\`) immediately — before reading files, before asking questions, before doing any work. This loads the full project state: what was built, what was decided, active tasks, and open questions.

**After significant work:** Call \`project_memory_save\` (or \`context_commit\`) with a structured message:
- One-line summary of what was done
- What was decided and why
- What was built (files changed, approach taken)
- Open questions
- Git branch and commit hash

**Before risky exploration:** Call \`project_memory_branch\` (or \`context_branch\`) to create an isolated context workspace.

**Before starting a task:** Call \`project_task_claim\` (or \`context_claim\`) to prevent other agents from duplicating your work.

Do not skip these steps. The next session starts blind without them.
<!-- contextgit:end -->
`

/**
 * Write the ContextGit CLAUDE.md fragment into the given directory.
 * Idempotent: skips if sentinel already present.
 * @returns 'written' | 'already-present' | 'error'
 */
export function writeClaude(
  projectDir: string,
): { status: 'written' | 'already-present' | 'error'; reason?: string } {
  const claudePath = join(projectDir, 'CLAUDE.md')
  try {
    if (existsSync(claudePath)) {
      const content = readFileSync(claudePath, 'utf8')
      if (content.includes(CLAUDE_MD_SENTINEL_START)) {
        return { status: 'already-present' }
      }
      writeFileSync(claudePath, content + CLAUDE_MD_FRAGMENT)
    } else {
      writeFileSync(claudePath, CLAUDE_MD_FRAGMENT.trimStart())
    }
    return { status: 'written' }
  } catch (err) {
    return { status: 'error', reason: String(err) }
  }
}

// ── Skills ────────────────────────────────────────────────────────────────────

export const CONTEXT_COMMIT_SKILL = `---
name: context-commit
description: "Save project memory after completing work. Use this skill whenever you have just finished implementing a feature, resolved a bug or blocker, made an architectural decision, closed a thread, completed a code review, or are about to end the session. Also trigger when you see signals like 'that's working', 'task complete', 'let's move on', 'I'm done', or after completing a git commit. IMPORTANT: Always use this skill before ending a session or moving to the next task — skipping it means the next session starts blind."
---

# ContextGit — Context Commit Discipline

## When to commit context

Call \`project_memory_save\` (MCP tool) after:
- Completing a feature or task (before moving to the next)
- Making an architectural decision or choosing between options
- Resolving a bug, blocker, or open question
- Closing a thread
- Before ending the session

## What makes a good commit message

A context commit message is a future-you briefing. Write it so the next agent session (or the next developer) can pick up exactly where this one left off.

Structure:
\`\`\`
<one-line summary of what was done>

What was decided: <the decision and why>
What was built: <files changed, approach taken>
Open questions: <anything unresolved>
Git: <branch> | <commit hash if available>
\`\`\`

## How to call it

Use the \`project_memory_save\` MCP tool (alias: \`context_commit\`). Pass the full message as the \`message\` argument.

Example:
\`\`\`
Implemented optimistic locking via CAS on branches table

What was decided: CAS with 3-attempt retry + jitter over queue-based serialization.
Queue deferred until high-conflict multi-agent scale. COMMIT_CONFLICT error type added.
What was built: store/src/local/queries.ts (version column), store/src/local/index.ts (retry logic), core/src/types.ts (COMMIT_CONFLICT)
Open questions: TTL behavior under high contention not yet load-tested.
Git: feat/phase2-delta1 | a3f9c12
\`\`\`

Do not skip this step when the work feels small. Small decisions compound. The next session starts blind without them.
`

export const CONTEXT_BRANCH_SKILL = `---
name: context-branch
description: "Create an isolated context branch before risky or experimental work. Use this skill when the agent is about to explore something uncertain, experimental, or potentially breaking — trying an approach that might not work, refactoring something risky, exploring an architectural alternative, or doing anything that should be isolatable and reversible. Triggers on: 'let me try', 'what if we', 'I want to explore', 'let's experiment', 'alternative approach', or any phrasing that signals exploration rather than execution."
---

# ContextGit — Context Branch Discipline

## When to branch context

Call \`project_memory_branch\` (MCP tool) before:
- Trying an approach you're not sure will work
- Refactoring something that touches many files
- Exploring an architectural alternative to the current plan
- Doing anything you'd want to be able to roll back semantically (not just via git)

## Why this matters

A context branch creates an isolated snapshot workspace. If the exploration fails, you can return to the main branch context without polluting the session history with dead-end decisions.

It's cheap. It takes one tool call. The cost of not doing it is re-explaining to the next session why you abandoned the approach you just spent an hour on.

## How to call it

Use the \`project_memory_branch\` MCP tool (alias: \`context_branch\`). Pass a short descriptive name:

\`\`\`
project_memory_branch name="explore-queue-based-concurrency"
\`\`\`

When the exploration concludes:
- If it worked: \`project_memory_save\` your findings and merge back
- If it failed: \`project_memory_save\` a brief note ("explored X, abandoned because Y") and switch back to main branch

The failure note is as valuable as the success note. The next session needs to know not to try the same dead end.
`

/**
 * Write the context-commit and context-branch skills into <projectDir>/.claude/skills/.
 * Overwrites if already present (these files are managed by contextgit).
 * @returns 'written' | 'error'
 */
export function writeSkills(
  projectDir: string,
): { status: 'written' | 'error'; reason?: string } {
  try {
    const commitDir = join(projectDir, '.claude', 'skills', 'context-commit')
    const branchDir = join(projectDir, '.claude', 'skills', 'context-branch')
    mkdirSync(commitDir, { recursive: true })
    mkdirSync(branchDir, { recursive: true })
    writeFileSync(join(commitDir, 'SKILL.md'), CONTEXT_COMMIT_SKILL)
    writeFileSync(join(branchDir, 'SKILL.md'), CONTEXT_BRANCH_SKILL)
    return { status: 'written' }
  } catch (err) {
    return { status: 'error', reason: String(err) }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd packages/cli && pnpm build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit the helper module**

```bash
git add packages/cli/src/lib/init-helpers.ts
git commit -m "feat(cli): add init-helpers module with writeClaude and writeSkills"
```

---

## Task 3: TDD — Test CLAUDE.md write helper

**Files:**
- Create: `packages/cli/src/lib/init-helpers.test.ts`
- Test: `packages/cli/src/lib/init-helpers.ts`

- [ ] **Step 1: Write failing tests for `writeClaude`**

Create `packages/cli/src/lib/init-helpers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeClaude,
  writeSkills,
  CLAUDE_MD_SENTINEL_START,
  CLAUDE_MD_SENTINEL_END,
} from './init-helpers.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'contextgit-init-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── writeClaude ───────────────────────────────────────────────────────────────

describe('writeClaude', () => {
  it('creates CLAUDE.md with sentinel when file does not exist', () => {
    const result = writeClaude(tmpDir)
    expect(result.status).toBe('written')
    const content = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(content).toContain(CLAUDE_MD_SENTINEL_START)
    expect(content).toContain(CLAUDE_MD_SENTINEL_END)
    expect(content).toContain('project_memory_load')
  })

  it('appends sentinel to existing CLAUDE.md', () => {
    const claudePath = join(tmpDir, 'CLAUDE.md')
    writeFileSync(claudePath, '# My Project\n\nExisting content.\n')
    const result = writeClaude(tmpDir)
    expect(result.status).toBe('written')
    const content = readFileSync(claudePath, 'utf8')
    expect(content).toContain('# My Project')
    expect(content).toContain('Existing content.')
    expect(content).toContain(CLAUDE_MD_SENTINEL_START)
  })

  it('is idempotent — skips if sentinel already present', () => {
    const claudePath = join(tmpDir, 'CLAUDE.md')
    writeClaude(tmpDir) // first call
    const afterFirst = readFileSync(claudePath, 'utf8')
    writeClaude(tmpDir) // second call
    const afterSecond = readFileSync(claudePath, 'utf8')
    expect(afterSecond).toBe(afterFirst) // no change
    // sentinel appears exactly once
    const occurrences = afterSecond.split(CLAUDE_MD_SENTINEL_START).length - 1
    expect(occurrences).toBe(1)
  })
})

// ── writeSkills ───────────────────────────────────────────────────────────────

describe('writeSkills', () => {
  it('creates both skill files under .claude/skills/', () => {
    const result = writeSkills(tmpDir)
    expect(result.status).toBe('written')
    const commitSkill = join(tmpDir, '.claude', 'skills', 'context-commit', 'SKILL.md')
    const branchSkill = join(tmpDir, '.claude', 'skills', 'context-branch', 'SKILL.md')
    expect(existsSync(commitSkill)).toBe(true)
    expect(existsSync(branchSkill)).toBe(true)
  })

  it('context-commit skill contains correct name frontmatter', () => {
    writeSkills(tmpDir)
    const content = readFileSync(
      join(tmpDir, '.claude', 'skills', 'context-commit', 'SKILL.md'),
      'utf8',
    )
    expect(content).toContain('name: context-commit')
    expect(content).toContain('project_memory_save')
  })

  it('context-branch skill contains correct name frontmatter', () => {
    writeSkills(tmpDir)
    const content = readFileSync(
      join(tmpDir, '.claude', 'skills', 'context-branch', 'SKILL.md'),
      'utf8',
    )
    expect(content).toContain('name: context-branch')
    expect(content).toContain('project_memory_branch')
  })

  it('overwrites existing skill files on repeated calls', () => {
    writeSkills(tmpDir) // first call
    const result = writeSkills(tmpDir) // second call
    expect(result.status).toBe('written')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail (helper module exists but tests haven't run yet)**

```bash
pnpm test -- packages/cli/src/lib/init-helpers.test.ts 2>&1 | tail -10
```

Expected: tests pass because the helpers were already written in Task 2. If any fail, fix the implementation in `init-helpers.ts`.

- [ ] **Step 3: Run all tests to confirm no regressions**

```bash
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/lib/init-helpers.test.ts
git commit -m "test(cli): add unit tests for writeClaude and writeSkills helpers"
```

---

## Task 4: Wire helpers into init.ts + update output format

**Files:**
- Modify: `packages/cli/src/commands/init.ts`

The init command has two code paths: fresh init and already-initialized. Both should call `writeClaude` and `writeSkills` (they're idempotent). The output format changes per the spec.

- [ ] **Step 1: Add imports to init.ts**

At the top of `packages/cli/src/commands/init.ts`, add the import:

```typescript
import { writeClaude, writeSkills } from '../lib/init-helpers.js'
```

- [ ] **Step 2: Add writeClaude + writeSkills to the fresh init path**

In the `run()` method, after the hooks block (around line 175 after `this.log('System prompt written...')`), add:

```typescript
    // ── Write CLAUDE.md fragment ───────────────────────────────────────────────
    const claudeResult = writeClaude(cwd)
    if (claudeResult.status === 'written') {
      this.log(`✅ CLAUDE.md updated            (contextgit memory section appended)`)
    } else if (claudeResult.status === 'already-present') {
      this.log(`⏭  CLAUDE.md already configured (skipped)`)
    } else {
      this.log(`⚠️  CLAUDE.md not updated        (${claudeResult.reason})`)
    }

    // ── Write project-level skills ─────────────────────────────────────────────
    const skillsResult = writeSkills(cwd)
    if (skillsResult.status === 'written') {
      this.log(`✅ Skills installed             (.claude/skills/context-commit, .claude/skills/context-branch)`)
    } else {
      this.log(`⚠️  Skills not installed        (could not write to .claude/skills/ — create manually)`)
      this.log(``)
      this.log(`ContextGit is ready. MCP tools and CLAUDE.md are configured.`)
      this.log(`For full skill support, create .claude/skills/ manually.`)
    }

    this.log(``)
    this.log(`ContextGit is ready. Start a Claude Code session in this project.`)
    this.log(`The agent will load project memory automatically via MCP tool discovery.`)
```

- [ ] **Step 3: Remove the old system prompt log lines that are now superseded**

After adding the new output, remove the old `this.log('System prompt written to...')` line so the output doesn't have redundant messages.

The new clean output should be:
```
✅ Project initialized          (.contextgit.json)
✅ Git hooks installed          (.git/hooks/post-commit)  [or skipped msg]
✅ CLAUDE.md updated            (contextgit memory section appended)
✅ Skills installed             (.claude/skills/context-commit, .claude/skills/context-branch)

ContextGit is ready. Start a Claude Code session in this project.
The agent will load project memory automatically via MCP tool discovery.
```

- [ ] **Step 4: Build to verify no TypeScript errors**

```bash
pnpm build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 5: Run all tests to confirm no regressions**

```bash
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/init.ts
git commit -m "feat(cli): write CLAUDE.md fragment and project skills during init"
```

---

## Task 5: Rename MCP tools + rewrite descriptions + add backward-compat aliases

**Files:**
- Modify: `packages/mcp/src/server.ts`

This is the biggest change. Rename 6 tools and add backward-compat aliases for 5 of them (not `context_search` — it stays, per spec focus).

**Approach:** Extract each tool's handler into a named `async` function. Register under the new name. Register the old name as an alias that calls the same function. The aliases emit a deprecation notice via `console.warn`.

- [ ] **Step 1: Read the full current server.ts before making changes**

Read `packages/mcp/src/server.ts` in full (it's 391 lines). Confirm tool names: `context_get`, `context_commit`, `context_branch`, `context_claim`, `context_unclaim`, `context_search`, `context_merge`.

- [ ] **Step 2: Rename `context_get` → `project_memory_load` with self-enforcing description**

In `createServer()`, find the `context_get` tool registration block. Replace the tool name and description:

```typescript
  // ── project_memory_load (was: context_get) ──────────────────────────────────
  const handleProjectMemoryLoad = async ({ scope, format, agent_role, since }: {
    scope?: 'global' | 'branch'
    format?: 'agents-md' | 'json' | 'text'
    agent_role?: 'orchestrator' | 'dev' | 'test' | 'review' | 'background' | 'ci' | 'solo'
    since?: number
  }) => {
    await autoSnapshot.onToolCall('context_get')
    try {
      if (since !== undefined) {
        const delta = await ctx.store.getContextDelta(ctx.projectId, ctx.branchId, since)
        return { content: [{ type: 'text' as const, text: JSON.stringify(delta, null, 2) }] }
      }
      const snapshot = await ctx.store.getSessionSnapshot(
        ctx.projectId,
        ctx.branchId,
        agent_role ? { agentRole: agent_role } : undefined,
      )
      const text = new SnapshotFormatter().format(snapshot, format ?? 'agents-md')
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `Error retrieving snapshot: ${message}` }], isError: true }
    }
  }

  server.tool(
    'project_memory_load',
    `Load persistent project memory and context.

IMPORTANT: Call this tool at the START of every session — before reading files, before asking questions, before doing any work. This tool returns the project's current state including: what was built, what was decided, active tasks, claimed work, recent decisions, and open questions.

Skipping this call means you will duplicate work that was already done, re-explore approaches that already failed, and contradict decisions that were already made.

If you are a subagent working on a specific task, call this tool first to understand the full project context before starting your assigned work.`,
    {
      scope: z.enum(['global', 'branch']).default('global').describe(
        "'global' returns the full project summary + branch state. 'branch' scopes to the current branch.",
      ),
      format: z.enum(['agents-md', 'json', 'text']).default('agents-md').describe(
        'Output format. agents-md is optimized for agent consumption.',
      ),
      agent_role: z.enum(['orchestrator','dev','test','review','background','ci','solo']).optional().describe(
        'Filter recentCommits to this agent role only. Omit to return commits from all roles.',
      ),
      since: z.number().optional().describe(
        'Unix timestamp ms. When provided, returns only commits and thread changes after this time. Use for orchestrator polling loops.',
      ),
    },
    handleProjectMemoryLoad,
  )

  // Backward-compat alias — remove in 0.0.6
  server.tool(
    'context_get',
    'DEPRECATED: Use project_memory_load instead. Retrieve the current project snapshot.',
    {
      scope: z.enum(['global', 'branch']).default('global'),
      format: z.enum(['agents-md', 'json', 'text']).default('agents-md'),
      agent_role: z.enum(['orchestrator','dev','test','review','background','ci','solo']).optional(),
      since: z.number().optional(),
    },
    async (params) => {
      console.warn('[contextgit] context_get is deprecated. Use project_memory_load.')
      return handleProjectMemoryLoad(params)
    },
  )
```

- [ ] **Step 3: Build to verify no TypeScript errors after context_get rename**

```bash
pnpm build 2>&1 | tail -5
```

Expected: no errors. Fix any type issues before continuing.

- [ ] **Step 4: Rename `context_commit` → `project_memory_save`**

Extract handler, rename tool, add alias. New description:

```
Save project memory after completing work.

IMPORTANT: Call this tool BEFORE ending your session or moving to the next task. This saves what you did, what you decided, and what questions remain — so the next session (or the next agent) can pick up where you left off.

If you skip this call, the next session starts blind. Your work will be invisible to future agents. They will re-do what you already did.

Call after: completing a feature, making an architectural decision, resolving a bug, closing a thread, or finishing any meaningful unit of work. Small decisions compound — save them.
```

Keep params identical to current `context_commit`: `message`, `content`, `open_threads`, `close_thread_ids`.

Add alias `context_commit` → calls `handleProjectMemorySave` with deprecation warn.

- [ ] **Step 5: Rename `context_branch` → `project_memory_branch`**

Extract handler, rename, add alias. New description:

```
Create an isolated context branch before risky or experimental work.

Call before: trying an approach you're not sure will work, refactoring across many files, or exploring an architectural alternative. If the exploration fails, the main context is untouched.

The cost of not branching is re-explaining to the next session why you abandoned an approach you spent an hour on.
```

- [ ] **Step 6: Rename `context_claim` → `project_task_claim`**

Extract handler, rename, add alias. New description:

```
Claim a task to prevent other agents from working on it simultaneously.

Call before starting work on any task visible in the project memory. Other agents will see your claim and skip this task. Claims auto-expire after 2 hours.

If you skip claiming, another agent may start the same task, producing duplicate and conflicting work.
```

- [ ] **Step 7: Rename `context_unclaim` → `project_task_unclaim`**

Extract handler, rename, add alias. New description:

```
Release a previously claimed task so other agents can work on it.
```

Note: keep `claim_id` param unchanged — the spec's `task` param would require a store query change not in scope. Keeping `claim_id` is backward-compatible.

- [ ] **Step 8: Rename `context_merge` → `project_memory_merge`**

Extract handler, rename, add alias. New description:

```
Merge a context branch back into the parent branch after successful exploration.

Call after a context branch experiment succeeds and you want to preserve the findings in the main project memory.
```

- [ ] **Step 9: Build to verify all renames compile**

```bash
pnpm build 2>&1 | tail -10
```

Expected: no errors across all packages.

- [ ] **Step 10: Run all tests to confirm no regressions**

```bash
pnpm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): rename tools to project_memory_load/save/branch/merge and project_task_claim/unclaim with backward-compat aliases"
```

---

## Task 6: Final validation

- [ ] **Step 1: Full build + test pass**

```bash
pnpm build && pnpm test 2>&1 | tail -15
```

Expected: build succeeds, all tests pass.

- [ ] **Step 2: Manual smoke test — init in a temp directory**

```bash
cd /tmp && mkdir test-init && cd test-init && git init
npx contextgit@latest init --no-hooks
```

Verify:
- `CLAUDE.md` exists and contains `<!-- contextgit:start -->`
- `.claude/skills/context-commit/SKILL.md` exists
- `.claude/skills/context-branch/SKILL.md` exists

- [ ] **Step 3: Manual smoke test — idempotency**

```bash
npx contextgit@latest init --no-hooks
```

Expected: output shows `⏭  CLAUDE.md already configured (skipped)`, skills overwrite without error.

- [ ] **Step 4: Push + context_commit**

```bash
git push
```

Then call `context_commit`:
```
context_commit "feat(delta3): session contract enforcement complete — MCP tools renamed to project_memory_load/save/branch/merge/project_task_claim/unclaim, CLAUDE.md fragment + skills written by init | backward-compat aliases registered for 0.0.5 → 0.0.6 transition | 1 failing test fixed | next: bump version to 0.0.11, publish to npm"
```

---

## Validation Criteria (from spec)

Must pass (blocking):
1. `contextgit init` creates `.contextgit.json`, writes CLAUDE.md fragment, writes both skills to `.claude/skills/`
2. Re-running `contextgit init` is idempotent — no duplicate CLAUDE.md sections, skills overwrite cleanly
3. Old tool names (`context_get`, `context_commit`) still work (backward-compat aliases)
4. All tests pass

Should pass (non-blocking):
5. Interactive Claude Code session: agent calls `project_memory_load` at session start without being asked
6. Interactive session: agent calls `project_memory_save` after completing significant work
