---
name: context-commit
description: "MANDATORY: Save project memory after completing ANY work. Use this skill after EVERY completed task and EVERY git commit — finished implementing a feature, resolved a bug, made a decision, closed a thread, completed a review, or ending a session. Every git commit must be followed immediately by a context commit. Do not wait to be asked. Do not proceed to the next task until both git commit and context commit are done. Triggers: git commit made, task complete, 'that's working', 'let's move on', 'I'm done', session ending. Skipping this means the next session starts completely blind."
---

# ContextGit — Context Commit Discipline

## RULE: Every git commit = immediate context commit

Do not wait to be asked. Do not batch. Do not skip.
After every git commit, call `project_memory_save` immediately.
Do not proceed to the next task until both git commit and context commit are done.
These two always go together. Never git commit without a context commit.

## When to commit context

Call `project_memory_save` (MCP tool) after:
- Every git commit (mandatory — these always go together)
- Completing a feature or task (before moving to the next)
- Making an architectural decision or choosing between options
- Resolving a bug, blocker, or open question
- Closing a thread
- Before ending the session for any reason

## What makes a good commit message

A context commit message is a future-you briefing. Write it so the next agent session (or the next developer) can pick up exactly where this one left off.

Structure:
```
<one-line summary of what was done>

What was decided: <the decision and why>
What was built: <files changed, approach taken>
Open questions: <anything unresolved>
Next task: <the first concrete thing the next session should do>
Git: <branch> | <commit hash if available>
```

## How to call it

Use the `project_memory_save` MCP tool (alias: `context_commit`). Pass the full message as the `message` argument.

Do not skip this step when the work feels small. Small decisions compound. The next session starts blind without them.
