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
