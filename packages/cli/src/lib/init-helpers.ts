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

Example:
\`\`\`
Implemented optimistic locking via CAS on branches table

What was decided: CAS with 3-attempt retry + jitter over queue-based serialization.
Queue deferred until high-conflict multi-agent scale. COMMIT_CONFLICT error type added.
What was built: store/src/local/queries.ts (version column), store/src/local/index.ts (retry logic), core/src/types.ts (COMMIT_CONFLICT)
Open questions: TTL behavior under high contention not yet load-tested.
Git: feat/phase2-delta1 | a3f9c12
\`\`\`

## How to call it

Use the \`project_memory_save\` MCP tool (alias: \`context_commit\`). Pass the full message as the \`message\` argument.

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
