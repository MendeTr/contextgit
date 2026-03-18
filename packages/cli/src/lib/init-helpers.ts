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

## Session Start (do this every time)

Call \`project_memory_load\` immediately.
Do not ask questions first. Read the snapshot, then start working.
Start the next specific task from the snapshot — not an entire feature or milestone.
One task per session unless it is trivially small.

## After EVERY completed task

Do not wait to be asked. Every git commit = immediate context commit.
Do not proceed to the next task until both are done.

1. \`git add . && git commit -m "feat/fix: <what was done>"\`
2. Call \`project_memory_save\` immediately after with:
   - One-line summary of what was done
   - What was decided and why
   - What was built (files changed, approach taken)
   - Open questions
   - Git branch and commit hash
   - The next concrete task

These two always go together. Never git commit without a context commit.

## Session End (do this every time)

Before stopping work for any reason, call \`project_memory_save\` with:
- What was built this session
- Key decisions and why
- Open threads and blockers
- The first concrete task for the next session

Do not end a session without a context commit. The next session starts blind without it.

## Before risky exploration

Call \`project_memory_branch\` to create an isolated context workspace before trying anything uncertain.

## Before starting a task (multi-agent)

Call \`project_task_claim\` to prevent other agents from duplicating your work.

## When scope changes mid-session

Write a \`project_memory_save\` with replan: prefix BEFORE building new scope:
\`project_memory_save "replan: <what changed and why>"\`
Then build the new scope. Then write a normal context commit when done.
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
description: "MANDATORY: Save project memory after completing ANY work. Use this skill after EVERY completed task and EVERY git commit — finished implementing a feature, resolved a bug, made a decision, closed a thread, completed a review, or ending a session. Every git commit must be followed immediately by a context commit. Do not wait to be asked. Do not proceed to the next task until both git commit and context commit are done. Triggers: git commit made, task complete, 'that's working', 'let's move on', 'I'm done', session ending. Skipping this means the next session starts completely blind."
---

# ContextGit — Context Commit Discipline

## RULE: Every git commit = immediate context commit

Do not wait to be asked. Do not batch. Do not skip.
After every git commit, call \`project_memory_save\` immediately.
Do not proceed to the next task until both git commit and context commit are done.
These two always go together. Never git commit without a context commit.

## When to commit context

Call \`project_memory_save\` (MCP tool) after:
- Every git commit (mandatory — these always go together)
- Completing a feature or task (before moving to the next)
- Making an architectural decision or choosing between options
- Resolving a bug, blocker, or open question
- Closing a thread
- Before ending the session for any reason

## What makes a good commit message

A context commit message is a future-you briefing. Write it so the next agent session (or the next developer) can pick up exactly where this one left off.

Structure:
\`\`\`
<one-line summary of what was done>

What was decided: <the decision and why>
What was built: <files changed, approach taken>
Open questions: <anything unresolved>
Next task: <the first concrete thing the next session should do>
Git: <branch> | <commit hash if available>
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
