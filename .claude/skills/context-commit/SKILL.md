---
name: context-commit
description: "Save project memory when project state changes in a way git does not capture: a key decision made, an approach abandoned, a thread opened or closed, scope changed (replan: prefix), or at session end. Do not save merely because a git commit happened — git is the record of what changed; a context save that only paraphrases a commit message is noise. Triggers: session ending, decision made, approach abandoned, thread opened or closed, scope changed, architectural choice."
---

# ContextGit — Context Commit Discipline

## When to save context

Call `project_memory_save` at **session end**, always — a focused summary plus the
3–5 genuinely open threads for the next session.

Call `project_memory_save` mid-session **only when project state changes in a way
git does not capture**: a decision made, an approach abandoned, a thread opened or
closed, scope changed (`replan:` prefix), an architectural choice.

Do **not** save merely because a git commit happened. Git is the record of what
changed. A context save that only paraphrases a commit message is noise.

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
